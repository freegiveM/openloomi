/**
 * POST /api/loop/action/schedule
 *
 * Schedule a Loop decision action as a one-shot cron job. Used by the
 * pet card (and any other UI surface) so that every Run / Dismiss /
 * Dry / Promote click:
 *   - gets an execution record (jobExecutions row in the existing
 *     `jobExecutions` table)
 *   - is cancellable before fire (DELETE /api/loop/action/[id])
 *   - survives UI reloads (the row lives in the DB, not in memory)
 *   - fires asynchronously without blocking the user's interaction
 *
 * Body:
 *   { decision_id: string, action: 'run'|'dry'|'dismiss'|'promote'|'rsvp_attend'|'rsvp_decline'|'rsvp_maybe', body?: object, supersede?: boolean }
 *
 * Response (200):
 *   { action_id: string, fire_at: ISOString, decision_id: string, action }
 *
 * #364 — per-decision action lock. The decision record carries a
 * `context.pending_action` slot pointing at the currently-scheduled
 * `scheduled_jobs.id`. Before creating a new job we check it; if set
 * we either:
 *   - refuse with 409 `{error: "pending_action", pending_action_id}` so
 *     the UI can prompt the user to cancel the old action first; OR
 *   - if the caller passed `supersede: true`, atomically cancel the
 *     previous job and schedule the new one. The cancel-then-schedule
 *     sequence is best-effort: a partial failure (cancel OK, schedule
 *     fails) leaves the decision with no pending action, which the
 *     user can recover from by re-clicking.
 *
 * Why a 30s grace period before fire?
 *   The local-scheduler polls every 60s, so a `scheduledAt = now+30s`
 *   job will be picked up 30–90s after creation. That window is long
 *   enough for the user to read the "Scheduled" banner and tap Cancel,
 *   but short enough that the action still feels live. Without the
 *   grace, the job could fire on the very next 60s tick and the user
 *   would see no feedback between click and effect.
 *
 * Why stuff the payload into jobConfig?
 *   The cron's JobConfig type only declares a few fields (handler,
 *   modelConfig, characterId) — but the underlying column is JSON, so
 *   arbitrary keys are accepted at the storage layer. We cast through
 *   `unknown` to add a `payload` slot without modifying the cron types,
 *   and the loop.action handler reads it back. This keeps the payload
 *   inside the row's natural JSON envelope (no stringly-typed hack on
 *   the description column).
 */

import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { withAutoGuest } from "@/lib/auth/with-auto-guest";
import {
  createJob,
  decisions,
  deleteJob,
  registerLoopHandlers,
} from "@/lib/loop";
import {
  buildAttemptRecord,
  clearPendingActionAndRecord,
  readPendingAction,
  setPendingAction,
} from "@/lib/loop/decision-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GRACE_MS = 30_000;
// RSVP verbs are accepted so the floating pet card can route Yes/No/Maybe
// through the lock + history pipeline (#364) instead of pretending to be
// a generic `run` with a `{response}` body. The handler (`loop.action`)
// sees the verb, maps it to `accepted`/`declined`/`tentative`, and
// delegates to `runDecisionWithRsvpResponse` so the on-disk
// `action.params.response` is set before the agent sees the prompt.
const ALLOWED_ACTIONS = new Set([
  "run",
  "dry",
  "dismiss",
  "promote",
  "rsvp_attend",
  "rsvp_decline",
  "rsvp_maybe",
]);

/** Human-friendly verb per action, used in the scheduled-job name. */
const ACTION_VERB: Record<string, string> = {
  run: "Run",
  dry: "Dry-run",
  dismiss: "Dismiss",
  promote: "Promote",
  rsvp_attend: "RSVP Attend",
  rsvp_decline: "RSVP Decline",
  rsvp_maybe: "RSVP Maybe",
};

export const POST = withAutoGuest(async (req: Request) => {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "auth required" }, { status: 401 });
    }
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }
    const decisionId = String(body.decision_id ?? "").trim();
    const action = String(body.action ?? "").trim();
    const subActionBody =
      body.body && typeof body.body === "object" && !Array.isArray(body.body)
        ? (body.body as Record<string, unknown>)
        : undefined;
    const supersede = body.supersede === true;
    if (!decisionId) {
      return NextResponse.json(
        { error: "decision_id required" },
        { status: 400 },
      );
    }
    if (!ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json(
        { error: `action must be one of ${[...ALLOWED_ACTIONS].join("|")}` },
        { status: 400 },
      );
    }
    // Make sure the loop.action handler is registered before we
    // schedule a job that uses it. Idempotent.
    registerLoopHandlers();

    // #364 — enforce one active intent per decision. If the caller
    // didn't opt into supersede, refuse with a clear 409 so the UI
    // can prompt them to cancel before re-trying.
    const existingPending = readPendingAction(decisionId);
    if (existingPending && !supersede) {
      return NextResponse.json(
        {
          error: "pending_action",
          pending_action_id: existingPending.action_id,
          pending_action_verb: existingPending.action,
        },
        { status: 409 },
      );
    }
    if (existingPending && supersede) {
      // Best-effort cancel of the previous job. `deleteJob` is a
      // no-op when the row is already gone (the cron fired in the
      // gap) so the worst-case is the new action runs against a
      // decision the runner then refuses via its own lock check.
      try {
        await deleteJob(userId, existingPending.action_id);
      } catch {
        /* best-effort */
      }
      try {
        markSuperseded(
          decisionId,
          existingPending.action_id,
          existingPending.scheduled_at,
          existingPending.action,
          existingPending.sub_action,
        );
      } catch {
        /* best-effort */
      }
    }

    const fireAt = new Date(Date.now() + GRACE_MS);
    const payload = {
      decision_id: decisionId,
      action,
      body: subActionBody ?? null,
    };
    // Look up the decision so the scheduled-jobs list shows a name a
    // human can actually read. Fall back to the bare id when the
    // decision is gone (stale row, manual payload, etc.) — the handler
    // will still surface a useful error at fire time.
    const dec = decisions.get(decisionId);
    const decisionTitle = (dec?.title ?? "").trim() || decisionId;
    const verb = ACTION_VERB[action] ?? action;
    // Cast through unknown so we can add a `payload` slot to JobConfig
    // without forking the cron types. The DB column accepts arbitrary
    // JSON; loop.action reads `jobConfig.payload` back at fire time.
    const jobConfig = {
      type: "custom",
      handler: "loop.action",
      payload,
    } as unknown as Parameters<typeof createJob>[1]["job"];

    const job = await createJob(userId, {
      name: `${verb} "${decisionTitle}"`,
      description: `${decisionTitle} · fires in ${Math.round(GRACE_MS / 1000)}s`,
      schedule: { type: "once", at: fireAt },
      job: jobConfig,
      enabled: true,
    });

    // #364 — stamp the lock on the decision so the next schedule call
    // (without supersede) refuses and the cancel route knows which
    // scheduled_jobs row belongs to which decision. Best-effort: a
    // failure here means the runner's pre-fire lock check is the
    // last line of defence.
    try {
      setPendingAction(decisionId, {
        action_id: job.id,
        scheduled_at: new Date().toISOString(),
        action,
        ...(subActionBody ? { sub_action: subActionBody } : {}),
      });
    } catch {
      /* best-effort */
    }

    return NextResponse.json({
      action_id: job.id,
      fire_at: fireAt.toISOString(),
      decision_id: decisionId,
      action,
      superseded_action_id:
        existingPending && supersede ? existingPending.action_id : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "schedule failed" },
      { status: 500 },
    );
  }
});

// ---------------------------------------------------------------------------
// Lock + history helpers (#364)
// ---------------------------------------------------------------------------

/**
 * Mark the currently-locked action as superseded and clear the lock.
 * Delegates to `decision-lock.ts` so the rule ("only the holder of
 * the action_id can clear the lock") lives in one place.
 */
function markSuperseded(
  decisionId: string,
  actionId: string,
  scheduledAt: string,
  action: string,
  subAction: Record<string, unknown> | undefined,
): void {
  clearPendingActionAndRecord(
    decisionId,
    buildAttemptRecord(
      actionId,
      action,
      {
        ok: false,
        scheduled_at: scheduledAt,
        ...(subAction ? { sub_action: subAction } : {}),
        execution: { reason: "superseded by new schedule" },
      },
      { statusOverride: "superseded" },
    ),
  );
}
