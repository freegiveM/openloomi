import { AppError } from "@melandlabs/shared/errors";

import { applyTimezoneToUserJobs } from "@/lib/cron/service";
import {
  executeTransaction,
  getUserTimezonePreference,
  updateUserProfile,
} from "@/lib/db/queries";
import { isValidTimezone } from "@/lib/utils/timezone";

import { type HourCycle, isHourCycle } from "./constants";
import { pickEffectiveTimezone } from "./pick-effective-timezone";

export interface UpdateUserTimezoneInput {
  userId: string;
  /** IANA timezone identifier, e.g. "Asia/Shanghai"; null follows browser. */
  timezone: string | null;
  /** Browser/request-detected timezone used when the preference is null. */
  detectedTimezone?: string | null;
  /**
   * Optional hour-cycle preference. `undefined` leaves the stored value as-is;
   * `null` clears it back to the locale default.
   */
  hourCycle?: HourCycle | null;
  /** Injectable clock for deterministic next-run recomputation in tests. */
  now?: Date;
}

export interface UpdateUserTimezoneResult {
  timezone: string | null;
  effectiveTimezone: string;
  /**
   * The hour cycle this call set: a value/null when explicitly provided, or
   * `undefined` when the input omitted it (stored value left unchanged).
   */
  hourCycle?: HourCycle | null;
  /** How many of the user's scheduled jobs were re-aligned to the new timezone. */
  recomputedJobCount: number;
}

/**
 * Command: change a user's timezone preference.
 *
 * 1. Validates the IANA timezone preference (or accepts null = follow browser).
 * 2. Persists the user-level preference (timezone + optional hour cycle).
 * 3. Re-aligns jobs that inherit the user preference so their next execution
 *    time stays correct under the new effective timezone.
 *
 * Steps 2 and 3 run in a single transaction so the preference and the job
 * re-alignment commit together (or roll back together on PostgreSQL). Side
 * effects are confined here; the pure recomputation lives in
 * `recompute-jobs-for-timezone`.
 */
export async function updateUserTimezone(
  input: UpdateUserTimezoneInput,
): Promise<UpdateUserTimezoneResult> {
  if (input.timezone !== null && !isValidTimezone(input.timezone)) {
    throw new AppError(
      "bad_request:api",
      `Invalid IANA timezone: ${String(input.timezone)}`,
    );
  }

  const hourCycleProvided = input.hourCycle !== undefined;
  const normalizedHourCycle =
    input.hourCycle != null && isHourCycle(input.hourCycle)
      ? input.hourCycle
      : null;
  const now = input.now ?? new Date();
  const previousPreference = await getUserTimezonePreference(input.userId);
  const previousEffectiveTimezone = pickEffectiveTimezone(
    previousPreference.timezone,
    input.detectedTimezone,
  );
  const effectiveTimezone = pickEffectiveTimezone(
    input.timezone,
    input.detectedTimezone,
  );

  const recomputedJobCount = await executeTransaction(async (tx) => {
    // 1 + 2: persist the preference. Only touch hourCycle when provided.
    await updateUserProfile(
      input.userId,
      {
        timezone: input.timezone,
        ...(hourCycleProvided ? { hourCycle: normalizedHourCycle } : {}),
      },
      tx,
    );

    // 3: keep existing scheduled jobs consistent with the new timezone.
    return applyTimezoneToUserJobs(
      input.userId,
      effectiveTimezone,
      now,
      tx,
      previousEffectiveTimezone,
    );
  });

  return {
    timezone: input.timezone,
    effectiveTimezone,
    // Report only what this call actually changed (undefined = left as-is).
    hourCycle: hourCycleProvided ? normalizedHourCycle : undefined,
    recomputedJobCount,
  };
}
