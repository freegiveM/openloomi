/**
 * #364 — per-decision action lock + immutable attempt history.
 *
 * Loop actions (Run / Dismiss / Dry / Promote / RSVP) are scheduled as
 * one-shot cron jobs via `/api/loop/action/schedule` and executed by
 * the `loop.action` handler. Before #364, two opposite responses
 * ("No" then "Yes") could both fire against the same decision because
 * nothing prevented the second schedule and `context.sub_action`
 * overwrote on every run, hiding the earlier attempt.
 *
 * This module owns the bookkeeping that fixes both gaps:
 *
 *   1. **One active intent per decision** — `context.pending_action`
 *      points at the currently-scheduled `scheduled_jobs.id`. The
 *      schedule route stamps it; the cancel route clears it; the
 *      handler refuses to fire when its `jobId` doesn't match.
 *
 *   2. **Immutable attempt history** — `context.sub_actions` is an
 *      append-only array of `DecisionSubActionRecord` rows. Every
 *      schedule (superseded), every cancel (cancelled), and every
 *      handler outcome (completed / skipped / blocked / failed) gets
 *      a row. The card UI surfaces this so a contradictory earlier
 *      execution is never hidden by the latest overwrite.
 *
 * All operations are best-effort: they never throw out of the route
 * layer. A failed `decisions.update` means the next schedule will
 * overwrite any stale lock via `setPendingAction`, and the missing
 * history row only means the UI shows one fewer attempt — neither
 * failure mode is user-visible beyond a missing toast.
 */

import { decisions } from "./store";
import type {
  DecisionPendingAction,
  DecisionSubActionRecord,
  DecisionSubActionStatus,
} from "./types";

const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readContext(decisionId: string): Record<string, unknown> {
  const dec = decisions.get(decisionId);
  if (!dec) return {};
  return asRecord(dec.context) ?? {};
}

/**
 * Read the current `pending_action` lock on a decision. Returns `null`
 * when no action is queued (or when the decision is missing).
 *
 * The return shape mirrors `DecisionPendingAction` exactly so the
 * schedule route can surface the action_id without re-parsing.
 */
export function readPendingAction(
  decisionId: string,
): DecisionPendingAction | null {
  const ctx = readContext(decisionId);
  const pending = asRecord(ctx.pending_action);
  if (!pending) return null;
  if (
    typeof pending.action_id !== "string" ||
    typeof pending.action !== "string"
  ) {
    return null;
  }
  const subAction = asRecord(pending.sub_action) ?? undefined;
  return {
    action_id: pending.action_id,
    scheduled_at:
      typeof pending.scheduled_at === "string"
        ? pending.scheduled_at
        : new Date().toISOString(),
    action: pending.action,
    ...(subAction ? { sub_action: subAction } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

/**
 * Stamp the lock on a decision. Used by the schedule route after
 * creating a `scheduled_jobs` row. Overwrites any existing
 * `pending_action` — the schedule route's earlier lock-check
 * guarantees we never silently drop a queued action.
 */
export function setPendingAction(
  decisionId: string,
  value: DecisionPendingAction,
): void {
  const dec = decisions.get(decisionId);
  if (!dec) return;
  const ctx = readContext(decisionId);
  decisions.update(decisionId, {
    context: { ...ctx, pending_action: value },
  });
}

/**
 * Clear the lock when it matches the action id we're cancelling /
 * finalising, and append an immutable history record. No-ops when
 * the lock doesn't match (a newer supersede already cleared it).
 *
 * `appendHistory` is exported so the schedule route can use it for
 * the supersede path without re-implementing the cap.
 */
export function clearPendingActionAndRecord(
  decisionId: string,
  record: DecisionSubActionRecord,
): void {
  const ctx = readContext(decisionId);
  const pending = asRecord(ctx.pending_action);
  const matches = pending && pending.action_id === record.action_id;
  const history = appendHistory(ctx, record);
  const nextContext: Record<string, unknown> = { ...ctx };
  if (matches) nextContext.pending_action = undefined;
  nextContext.sub_actions = history;
  decisions.update(decisionId, { context: nextContext });
}

/**
 * Append-only history insert. Caps the array at MAX_HISTORY entries
 * so a long-lived decision can't grow without bound; trims from the
 * front (oldest) when the cap is exceeded.
 */
export function appendHistory(
  ctx: Record<string, unknown>,
  record: DecisionSubActionRecord,
): DecisionSubActionRecord[] {
  const raw = ctx.sub_actions;
  const prev: DecisionSubActionRecord[] = Array.isArray(raw)
    ? (raw as DecisionSubActionRecord[])
    : [];
  const next = [...prev, record];
  if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
  return next;
}

// ---------------------------------------------------------------------------
// Outcome mapping (handler-side)
// ---------------------------------------------------------------------------

/**
 * Map the (ok, verdict) pair from `applyDecisionAction` onto the
 * lifecycle status used in `DecisionSubActionRecord.status`. An
 * executed verdict is the success terminal state; a skipped verdict
 * is intentional; blocked / failed surface as-is; missing verdicts
 * fall back by the ok flag. Kept here so the rule lives in one
 * place — the schedule route, the cancel route, and the handler all
 * agree on what "completed" means.
 */
export function statusFromOutcome(
  ok: boolean,
  verdict: "executed" | "skipped" | "blocked" | "failed" | undefined,
): DecisionSubActionStatus {
  if (!ok) {
    return verdict === "blocked" || verdict === "failed" ? verdict : "failed";
  }
  if (verdict === "skipped") return "skipped";
  return "completed";
}

/**
 * Build the history record from a finished attempt. Pure — caller is
 * responsible for persisting via `clearPendingActionAndRecord`.
 *
 * `statusOverride` lets the cancel / supersede paths pin the status
 * (`cancelled` / `superseded`) instead of inheriting the verdict-
 * based mapping, which would otherwise report "failed" for a cancel
 * that never reached the runner.
 */
export function buildAttemptRecord(
  jobId: string,
  action: string,
  outcome: {
    ok: boolean;
    execution?: {
      outcome?: "executed" | "skipped" | "blocked" | "failed";
      reason?: string;
    };
    error?: string;
    scheduled_at?: string;
    sub_action?: Record<string, unknown>;
  },
  options: { statusOverride?: DecisionSubActionStatus; now?: string } = {},
): DecisionSubActionRecord {
  const verdict = outcome.execution?.outcome;
  const reason = outcome.execution?.reason ?? outcome.error;
  const now = options.now ?? new Date().toISOString();
  return {
    action_id: jobId,
    scheduled_at: outcome.scheduled_at ?? now,
    completed_at: now,
    action,
    ...(outcome.sub_action ? { sub_action: outcome.sub_action } : {}),
    status: options.statusOverride ?? statusFromOutcome(outcome.ok, verdict),
    ...(verdict ? { verdict } : {}),
    ...(reason ? { reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read history
// ---------------------------------------------------------------------------

export function readSubActions(decisionId: string): DecisionSubActionRecord[] {
  const ctx = readContext(decisionId);
  const raw = ctx.sub_actions;
  return Array.isArray(raw) ? (raw as DecisionSubActionRecord[]) : [];
}
