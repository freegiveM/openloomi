/**
 * Loop cron handlers — registered into the cron executor's custom-handler
 * registry so the existing local-scheduler (lib/cron/local-scheduler.ts)
 * drives our tick / brief / wrap / action jobs the same way it drives
 * character agent-tasks. We intentionally do NOT maintain our own
 * Croner/setInterval loop here; the schedule for each job is configured
 * on the corresponding ScheduledJob row in `scheduled_jobs`
 * (handler: "loop.tick" / "loop.brief" / "loop.wrap" / "loop.action"),
 * and lib/loop/scheduler.ts ensures the recurring rows exist. One-shot
 * `loop.action` rows are inserted on-demand by
 * /api/loop/action/schedule when the user clicks a card button.
 */

import { log } from "./store";
import { registerCustomHandler } from "@/lib/cron/executor";
import type { JobExecutionContext, JobExecutionResult } from "@/lib/cron/types";

/**
 * Wrap an arbitrary loop operation into the JobExecutionResult shape the
 * cron executor expects. We never throw — failures are turned into
 * `{status: "error", error}` so the executor can log them and write a
 * jobExecutions row in a consistent way. `duration` is set here too so
 * the result conforms to the type without the executor overwriting it.
 */
async function runAsJob(
  op: () => Promise<unknown>,
  context: JobExecutionContext,
): Promise<JobExecutionResult> {
  const t0 = Date.now();
  try {
    const result = await op();
    const summary =
      result && typeof result === "object"
        ? JSON.stringify(result).slice(0, 2_000)
        : String(result ?? "");
    log(`[handler] job=${context.jobId} ok: ${summary}`);
    return { status: "success", output: summary, duration: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[handler] job=${context.jobId} error: ${msg}`);
    return { status: "error", error: msg, duration: Date.now() - t0 };
  }
}

/** Handler for `loop.tick` — pull signals, classify, enqueue new decisions. */
async function handleTick(
  context: JobExecutionContext,
): Promise<JobExecutionResult> {
  // Lazy import to avoid pulling the whole tick graph (and its DB / signal
  // pullers) into the executor's main module graph at registration time.
  // tick.ts exports the function as `run`; we call it directly. Its return
  // is synchronous (LoopTickResult), so we wrap with Promise.resolve to
  // satisfy the runAsJob contract.
  const { run, setActiveUser } = await import("./tick");
  const { runOnce: runWatcher } = await import("./watcher");
  return runAsJob(async () => {
    // First, have the watcher pull any new events from connected
    // integrations. The watch pass appends directly to signals.jsonl, and
    // the tick's 2h lookback will pick up everything we just wrote.
    setActiveUser(context.userId);
    const watchResult = await runWatcher({ userId: context.userId });
    const tickResult = await run({ userId: context.userId });
    // #288 — fire-and-forget desktop notifications only for fresh,
    // actionable decisions. Pet bubble is the primary surface; this is
    // opt-in via LoopPreferences.desktopNotifications. Errors are
    // swallowed and logged by notifyForDecisions.
    if (tickResult.newDecisions && tickResult.newDecisions.length > 0) {
      const { notifyForDecisions } = await import("./notifications");
      await notifyForDecisions(tickResult.newDecisions);
    }
    return { ...tickResult, watch: watchResult };
  }, context);
}

/** Handler for `loop.brief` — build a morning brief card and enqueue it. */
async function handleBrief(
  context: JobExecutionContext,
): Promise<JobExecutionResult> {
  // brief.ts exports `buildAndEnqueue` as its native name; it's async because
  // the narrative enrichment runs fire-and-forget after the card is enqueued.
  // The function returns once the card is queued; the background agent call
  // completes (or times out) on its own and is captured by the
  // `kickOffBackgroundEnrichment` helper — it MUST NOT throw, so a slow /
  // failed agent never causes a cron row to error.
  const { buildAndEnqueue } = await import("./brief");
  return runAsJob(async () => {
    const out = await buildAndEnqueue({ force: true });
    return {
      card: out.card?.id ?? null,
      narrative: !!out.snapshot.narrative,
    };
  }, context);
}

/** Handler for `loop.wrap` — build an evening wrap card and enqueue it. */
async function handleWrap(
  context: JobExecutionContext,
): Promise<JobExecutionResult> {
  const { buildAndEnqueue } = await import("./wrap");
  return runAsJob(async () => {
    const out = await buildAndEnqueue({ force: true });
    return {
      card: out.card?.id ?? null,
      narrative: !!out.snapshot.narrative,
    };
  }, context);
}

/**
 * Handler for `loop.action` — execute a single Loop decision action
 * scheduled by the pet card (or any other UI surface) via
 * /api/loop/action/schedule.
 *
 * The ScheduledJob's `jobConfig.payload` carries:
 *   { decision_id: string, action: 'run'|'dry'|'dismiss', body?: object }
 *
 * We delegate to `applyDecisionAction` (the same entry point
 * /api/loop/decision/[id] uses) so the existing tooling — runner.ts,
 * dismissDecision, the agent SSE call — is exercised once. The handler
 * never throws; failures are wrapped into `{status: "error"}` so the
 * executor can write a jobExecutions row consistently.
 *
 * After the decision moves, the watcher picks up the new
 * decisions.jsonl state on its next poll and emits `loop:decision` to
 * the bubble + card webviews — that's how the card learns the action
 * completed. No need for a bespoke completion event.
 *
 * #364 — per-decision action lock + immutable history. Before we
 * execute we re-read `context.pending_action` and refuse if it points
 * at a *different* action_id; this catches the case where a user
 * cancelled an old "No" job and scheduled a new "Yes" job in the
 * gap between our schedule-route lock release and the cron firing
 * the old row. After execution we clear the lock and append to
 * `context.sub_actions` so every attempt (including supersedes and
 * cancelled runs from the cancel route) is visible on the card.
 */
async function handleAction(
  context: JobExecutionContext,
): Promise<JobExecutionResult> {
  const { applyDecisionAction } = await import("./server");
  const { decisions } = await import("./store");
  return runAsJob(async () => {
    const cfg =
      typeof context.jobConfig === "string"
        ? JSON.parse(context.jobConfig)
        : (context.jobConfig ?? {});
    const payload = cfg?.payload ?? {};
    const decisionId = String(payload.decision_id ?? "").trim();
    const action = String(payload.action ?? "").trim();
    if (!decisionId) {
      throw new Error("missing decision_id in jobConfig.payload");
    }
    if (!action) {
      throw new Error("missing action in jobConfig.payload");
    }
    // #364 — pre-fire lock check. If the decision's `pending_action`
    // points at a *different* job than the one we're about to fire,
    // refuse. This is the last-line-of-defence against two
    // contradictory actions reaching the agent: the schedule route
    // writes the lock, the cancel route clears it, and supersede
    // cancels-then-overwrites. If anything slipped past (clock
    // skew, manual deletion), this catches it before any external
    // write.
    const locked = readPendingAction(decisionId);
    if (locked && locked.action_id !== context.jobId) {
      throw new Error(
        `stale_action: pending_action=${locked.action_id} expected=${context.jobId}`,
      );
    }

    // Stash the per-click sub-action body (e.g. { response: "yes" }
    // for RSVP, { verdict: "approve" } for PR review) on the
    // decision's context. The runner's buildPrompt already
    // serializes `context` into the JSON the agent reads, so the
    // agent gets the user's specific sub-action without us having to
    // fork the prompt template.
    if (action === "run" && payload.body && typeof payload.body === "object") {
      const current = decisions.get(decisionId);
      if (current) {
        decisions.update(decisionId, {
          context: {
            ...(current.context ?? {}),
            sub_action: payload.body,
          },
        });
      }
    }
    // #364 — RSVP verbs (`rsvp_attend` / `rsvp_decline` / `rsvp_maybe`)
    // route through the RSVP-specific runner so `action.params.response`
    // is set on the decision BEFORE the agent sees the prompt. Without
    // this branch the handler would call `applyDecisionAction("rsvp_attend")`
    // → `runDecision` and the prompt would re-ask the user the
    // accept/decline question instead of carrying the chosen verdict
    // forward (`runner.ts:runDecisionWithRsvpResponse` is the only path
    // that writes `params.response` and is what `buildPrompt` keys on
    // for the "User has already chosen" block).
    if (action.startsWith("rsvp_")) {
      const responseMap: Record<string, "accepted" | "declined" | "tentative"> =
        {
          rsvp_attend: "accepted",
          rsvp_decline: "declined",
          rsvp_maybe: "tentative",
        };
      const rsvpResponse = responseMap[action];
      // Lazy require — mirrors the decision-lock pattern below so the
      // cron executor can wire this handler without pulling the runner
      // graph (and its native-agent plumbing) into boot.
      const { runDecisionWithRsvpResponse } =
        require("./runner") as typeof import("./runner");
      const rsvpResult = await runDecisionWithRsvpResponse(
        decisionId,
        rsvpResponse,
      );
      // Map the runner result onto the same `out` shape the rest of the
      // handler expects so `finalizeAttempt` records the attempt and the
      // success/error branching stays uniform.
      const out = {
        ok: rsvpResult.ok,
        status: rsvpResult.status,
        ...(rsvpResult.error ? { error: rsvpResult.error } : {}),
        ...(rsvpResult.execution ? { execution: rsvpResult.execution } : {}),
      };
      finalizeAttempt(decisionId, context.jobId, action, out);
      if (!out.ok) {
        throw new Error(out.error ?? `${action} failed`);
      }
      return {
        decision_id: decisionId,
        action,
        status: out.status,
        ...(rsvpResult.result !== undefined
          ? { result: rsvpResult.result }
          : {}),
      };
    }
    const out = await applyDecisionAction(decisionId, {
      action: action as "run" | "dry" | "dismiss" | "promote",
    });
    // #364 — record the outcome in the immutable history. The
    // runner's verdict (#358) flows back as `out.execution`; we map
    // it onto the record so a card reload shows the exact outcome
    // of *this* attempt, not the latest overwrite.
    finalizeAttempt(decisionId, context.jobId, action, out);
    if (!out.ok) {
      throw new Error(out.error ?? `${action} failed`);
    }
    return {
      decision_id: decisionId,
      action,
      status: out.status,
      ...(out.result !== undefined ? { result: out.result } : {}),
    };
  }, context);
}

// ---------------------------------------------------------------------------
// #364 — pending-action read + history append helpers
// ---------------------------------------------------------------------------

/**
 * Read the current `pending_action` lock from the decision context.
 * Re-exported from `decision-lock.ts` so this file stays a thin
 * wrapper around the lifecycle helpers (and so the lock rule lives
 * in one place — see #364's "One active intent per decision").
 */
function readPendingAction(decisionId: string) {
  // `require` keeps this handler lazy-loadable (the cron executor
  // can wire it up without pulling the lock helpers into the boot
  // graph); the import is cheap and the resolution is cached.
  const { readPendingAction: read } =
    require("./decision-lock") as typeof import("./decision-lock");
  return read(decisionId);
}

/**
 * Persist the outcome of a handler execution: clear the lock (when
 * it still matches the job that fired) and append an immutable
 * history record. Wraps the shared `decision-lock` helpers so the
 * schedule route, the cancel route, and this handler all agree on
 * the record shape and the lock rule.
 */
function finalizeAttempt(
  decisionId: string,
  jobId: string,
  action: string,
  out: {
    ok: boolean;
    status: string;
    error?: string;
    execution?: {
      outcome?: "executed" | "skipped" | "blocked" | "failed";
      reason?: string;
    };
  },
): void {
  const {
    buildAttemptRecord,
    clearPendingActionAndRecord,
    readPendingAction: readPending,
  } = require("./decision-lock") as typeof import("./decision-lock");
  const pending = readPending(decisionId);
  const scheduledAt =
    pending && pending.action_id === jobId
      ? pending.scheduled_at
      : new Date().toISOString();
  const subAction =
    pending && pending.action_id === jobId ? pending.sub_action : undefined;
  clearPendingActionAndRecord(
    decisionId,
    buildAttemptRecord(jobId, action, {
      ok: out.ok,
      scheduled_at: scheduledAt,
      ...(subAction ? { sub_action: subAction } : {}),
      ...(out.execution ? { execution: out.execution } : {}),
      ...(out.error ? { error: out.error } : {}),
    }),
  );
}

let registered = false;

/**
 * Idempotently register all three handlers into the cron executor registry.
 * Safe to call multiple times — only the first call has side effects.
 */
export function registerLoopHandlers(): void {
  if (registered) return;
  registerCustomHandler("loop.tick", handleTick);
  registerCustomHandler("loop.brief", handleBrief);
  registerCustomHandler("loop.wrap", handleWrap);
  registerCustomHandler("loop.action", handleAction);
  registered = true;
}

export const LOOP_HANDLER_NAMES = [
  "loop.tick",
  "loop.brief",
  "loop.wrap",
  "loop.action",
] as const;
export type LoopHandlerName = (typeof LOOP_HANDLER_NAMES)[number];
