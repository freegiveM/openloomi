/**
 * Aggregate per-user token usage from the `llm_usage` table.
 *
 * Replaces the per-user JSONL file scanner that the previous revision
 * used. The DB now owns storage, so this module is a thin aggregator:
 * one `SELECT SUM/COUNT/MIN/MAX` over rows that match the user and the
 * `providerSince` cutoff. Results are cached per-userId for
 * {@link LLM_USAGE_SUMMARY_TTL_MS} so the SSE recorder can invalidate
 * after a successful insert and the summary endpoint can serve repeated
 * card refreshes without re-querying.
 *
 * Provider context (earliest `created_at` of an enabled `user_llm_api_settings`
 * row, plus the most recently updated provider) is supplied by the caller
 * — see `getUserLlmProviderEarliestEnabledSince` in `lib/db/queries.ts`.
 * Keeping the summary module DB-agnostic at the level of the provider
 * config means the same code path works for both server and Tauri modes.
 */

import { and, count, eq, gte, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/adapters";
import { llmUsage } from "@/lib/db/schema";
import { isTauriMode } from "@/lib/env";

import { onUsageRecorded } from "./recorder";
import {
  LLM_USAGE_SUMMARY_TTL_MS,
  LLM_USAGE_TRACKED_ENDPOINTS,
  type LlmUsageSummary,
} from "./types";

/**
 * Resolved provider config start, supplied by the caller (queries.ts).
 * The summary module itself stays DB-agnostic so it can be tested in
 * isolation.
 */
export interface ProviderContext {
  providerSince: Date | null;
  currentProvider?: {
    providerType: string;
    model: string | null;
    enabledSince: Date;
  };
}

interface CachedSummary {
  summary: LlmUsageSummary;
  expiresAt: number;
}

const cache = new Map<string, CachedSummary>();

// Subscribe to recorder writes so inserts drop the matching cache entry.
onUsageRecorded((userId) => {
  cache.delete(userId);
});

/**
 * Compute (or return cached) usage summary for a user. The provider
 * context is required so the response always knows whether the user has
 * ever configured a provider — the card uses that to pick between
 * "unconfigured" and "0 since ..." copy.
 *
 * The function never throws on DB errors; it returns a summary with
 * `error: "usage_unavailable"` so the card can render an error state
 * without breaking the whole request.
 */
export async function getUserUsageSummary(
  userId: string,
  providerContext: ProviderContext,
): Promise<LlmUsageSummary> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.summary;
  }

  const summary = await computeSummary(userId, providerContext, new Date(now));
  cache.set(userId, { summary, expiresAt: now + LLM_USAGE_SUMMARY_TTL_MS });
  return summary;
}

/**
 * Forcefully drop a user's cache entry. Useful when the caller knows the
 * provider config just changed (so even an unconfigured → configured flip
 * is reflected without waiting for the TTL).
 */
export function invalidateSummaryCache(userId: string): void {
  cache.delete(userId);
}

interface AggregateRow {
  inputTokens: number | null;
  outputTokens: number | null;
  runCount: number | null;
  /**
   * Earliest / latest `ts` seen in the window. Dialect-dependent shape:
   *   - Postgres: `Date` (Drizzle maps `timestamp with time zone`)
   *   - SQLite: `number` (Unix epoch seconds from `MIN/MAX(integer)`)
   * Normalized to ISO-8601 by {@link tsToIso}.
   */
  firstRunAt: Date | number | null;
  lastRunAt: Date | number | null;
  /**
   * Distinct providers seen in the window. Dialect-dependent shape:
   *   - Postgres: `string[]` from `array_agg(DISTINCT ...)`
   *   - SQLite: `string` from `GROUP_CONCAT(DISTINCT ...)` (CSV), parsed
   *     via {@link parseProviders} before being returned to the caller.
   */
  providers: string[] | string | null;
}

async function computeSummary(
  userId: string,
  providerContext: ProviderContext,
  asOf: Date,
): Promise<LlmUsageSummary> {
  const asOfIso = asOf.toISOString();
  const trackedEndpoints = [...LLM_USAGE_TRACKED_ENDPOINTS];

  if (!providerContext.providerSince) {
    return {
      configured: false,
      providerSince: null,
      totals: zeroTotals(),
      runCount: 0,
      firstRunAt: null,
      lastRunAt: null,
      trackedEndpoints,
      trackedProviders: [],
      asOf: asOfIso,
    };
  }

  const providerSince = providerContext.providerSince;
  const currentProviderPayload = providerContext.currentProvider
    ? {
        providerType: providerContext.currentProvider.providerType,
        model: providerContext.currentProvider.model,
        enabledSince:
          providerContext.currentProvider.enabledSince.toISOString(),
      }
    : undefined;

  const base = {
    configured: true,
    providerSince: providerSince.toISOString(),
    currentProvider: currentProviderPayload,
    trackedEndpoints,
  } as const;

  try {
    const db = getDb();
    // SUM/COUNT/MIN/MAX work on both SQLite and Postgres. The distinct
    // providers list is dialect-specific because SQLite has no
    // `array_agg`. We use `GROUP_CONCAT(DISTINCT ...)` on SQLite (returns
    // a CSV string) and `array_agg(DISTINCT ...)` on Postgres (returns a
    // real array). {@link parseProviders} normalizes both shapes.
    const providersExpr = isTauriMode()
      ? sql<string | null>`GROUP_CONCAT(DISTINCT ${llmUsage.providerType})`
      : sql<
          string[] | null
        >`array_agg(DISTINCT ${llmUsage.providerType}) FILTER (WHERE ${llmUsage.providerType} IS NOT NULL)`;

    const rows = (await db
      .select({
        inputTokens: sql<number>`COALESCE(SUM(${llmUsage.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${llmUsage.outputTokens}), 0)`,
        runCount: count(llmUsage.id),
        firstRunAt: sql<Date | number | null>`MIN(${llmUsage.ts})`,
        lastRunAt: sql<Date | number | null>`MAX(${llmUsage.ts})`,
        providers: providersExpr,
      })
      .from(llmUsage)
      .where(
        and(eq(llmUsage.userId, userId), gte(llmUsage.ts, providerSince)),
      )) as unknown as AggregateRow[];

    const row = rows[0];
    if (!row) {
      return {
        ...base,
        totals: zeroTotals(),
        runCount: 0,
        firstRunAt: null,
        lastRunAt: null,
        trackedProviders: [],
        asOf: asOfIso,
      };
    }

    const inputTokens = toPositiveInt(row.inputTokens);
    const outputTokens = toPositiveInt(row.outputTokens);
    const runCount = toPositiveInt(row.runCount) ?? 0;

    return {
      ...base,
      totals: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      runCount,
      firstRunAt: tsToIso(row.firstRunAt),
      lastRunAt: tsToIso(row.lastRunAt),
      trackedProviders: parseProviders(row.providers),
      asOf: asOfIso,
    };
  } catch (error) {
    console.warn("[llm-usage] failed to aggregate usage rows:", error);
    return {
      ...base,
      totals: zeroTotals(),
      runCount: 0,
      firstRunAt: null,
      lastRunAt: null,
      trackedProviders: [],
      asOf: asOfIso,
      error: "usage_unavailable",
    };
  }
}

function zeroTotals(): LlmUsageSummary["totals"] {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Normalize the dialect-specific `providers` projection into the
 * `string[]` shape the API contract advertises. Postgres returns an
 * array; SQLite returns a CSV string (via `GROUP_CONCAT`). Anything
 * else — null, undefined, malformed input — collapses to `[]` so the
 * card's UI never blows up on a missing field.
 */
function parseProviders(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

function toPositiveInt(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

/**
 * Normalize the dialect-portable `MIN(ts)` / `MAX(ts)` projection into an
 * ISO-8601 string. Postgres' `timestamp with time zone` column type
 * returns a JS Date directly. SQLite's `mode: "timestamp"` column stores
 * Unix epoch SECONDS, and Drizzle's raw-SQL projection passes that
 * integer through unchanged — so the value lands here as a number. We
 * detect that by magnitude (current epoch in seconds is ~1.7e9, well
 * below 1e11; anything ≥ 1e11 ms is unambiguously milliseconds) and
 * scale seconds up before constructing the Date.
 */
function tsToIso(
  value: Date | number | string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

/**
 * Test-only helper: drop all cached summaries. The DB now owns write
 * serialization, so there's nothing else to reset — the recorder's
 * `__resetRecorderForTests` clears the in-process subscriber set.
 */
export function __resetSummaryForTests(): void {
  cache.clear();
}
