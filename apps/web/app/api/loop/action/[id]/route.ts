/**
 * DELETE /api/loop/action/[id]
 *
 * Cancel a scheduled one-shot Loop action that hasn't fired yet (#364).
 *
 * Status transitions:
 *   scheduled (lastRunAt = null)        → 200 {cancelled: true, action_id}
 *   already fired (lastRunAt != null)   → 409 {cancelled: false, reason: "already_fired", last_status}
 *   not found / wrong owner             → 404 {cancelled: false, reason: "not_found"}
 *
 * #364 hardening — the original route returned HTTP 500 whenever any
 * downstream call threw (the wrap-level try/catch collapsed every
 * failure into a generic 500 with `error: e.message`). The user's
 * reproduction showed `Cancel failed: cancel HTTP 500` because the
 * scheduler fired mid-cancel, `getJob` returned a job whose
 * `jobConfig` couldn't be deserialised, or the conditional DELETE
 * matched zero rows for a related-but-not-the-row reason. The route
 * now:
 *
 *   - inspects via a raw SELECT (no `getJob` JSON parsing) so a
 *     malformed jobConfig never cascades into a 500;
 *   - keeps the conditional DELETE as the source of truth for
 *     race detection;
 *   - best-effort clears `context.pending_action` and appends to
 *     `context.sub_actions` so the card reflects the cancellation
 *     even if the JSON parse of the row payload fails;
 *   - returns a 409 with a structured `reason` (never a bare 500) for
 *     every foreseeable failure mode.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/app/(auth)/auth";
import { withAutoGuest } from "@/lib/auth/with-auto-guest";
import {
  buildAttemptRecord,
  clearPendingActionAndRecord,
  readPendingAction,
} from "@/lib/loop/decision-lock";
import { db } from "@/lib/db";
import { scheduledJobs } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface JobRow {
  id: string;
  jobConfig: unknown;
  lastRunAt: Date | null;
  lastStatus: string | null;
}

interface PendingActionMeta {
  decision_id: string;
  action: string;
  scheduled_at: string;
  sub_action?: Record<string, unknown>;
}

export const DELETE = withAutoGuest<RouteCtx>(async (_req, ctx) => {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "auth required" }, { status: 401 });
    }
    const paramsResult = await ctx.params.catch(() => null);
    const id = paramsResult?.id;
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    // #364 — inspect via a raw SELECT so a malformed `jobConfig` JSON
    // string never crashes `getJob` and bubbles up as a 500. We only
    // need the four columns that drive the state machine here.
    let job: JobRow | undefined;
    try {
      const rows = await db
        .select({
          id: scheduledJobs.id,
          jobConfig: scheduledJobs.jobConfig,
          lastRunAt: scheduledJobs.lastRunAt,
          lastStatus: scheduledJobs.lastStatus,
        })
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.userId, userId), eq(scheduledJobs.id, id)))
        .limit(1);
      job = rows[0] as JobRow | undefined;
    } catch {
      // Don't 500 on a transient SELECT failure — the caller can
      // re-poll via the by-decision endpoint.
      return NextResponse.json(
        { cancelled: false, reason: "lookup_failed" },
        { status: 503 },
      );
    }
    if (!job) {
      return NextResponse.json(
        { cancelled: false, reason: "not_found" },
        { status: 404 },
      );
    }
    if (job.lastRunAt) {
      return NextResponse.json(
        {
          cancelled: false,
          reason: "already_fired",
          last_status: job.lastStatus ?? "running",
        },
        { status: 409 },
      );
    }

    // Race-safe delete: only succeed when lastRunAt is still null.
    // If the scheduler fired between our check and now, this WHERE
    // matches zero rows and we fall through to the 409 path.
    let result: Array<{ id: string }> = [];
    try {
      result = await db
        .delete(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.userId, userId),
            eq(scheduledJobs.id, id),
            isNull(scheduledJobs.lastRunAt),
          ),
        )
        .returning({ id: scheduledJobs.id });
    } catch {
      return NextResponse.json(
        { cancelled: false, reason: "delete_failed" },
        { status: 503 },
      );
    }
    if (result.length === 0) {
      // Job fired between our check and our delete.
      return NextResponse.json(
        { cancelled: false, reason: "already_fired" },
        { status: 409 },
      );
    }

    // #364 — clear the per-decision action lock so the user can
    // immediately schedule a corrected intent without waiting on
    // any background reconciliation. Append an immutable history
    // record so a reload still shows the cancelled attempt. Best
    // effort: the DB delete is the source of truth, so a thrown
    // bookkeeping call is logged but never re-raised.
    const meta = readPendingMetaFromJobConfig(job.jobConfig);
    const locked = meta ? readPendingAction(meta.decision_id) : null;
    if (meta) {
      try {
        clearPendingActionAndRecord(
          meta.decision_id,
          buildAttemptRecord(
            id,
            meta.action,
            {
              ok: false,
              scheduled_at: meta.scheduled_at,
              sub_action: meta.sub_action,
              execution: { reason: "cancelled by user" },
            },
            { statusOverride: "cancelled" },
          ),
        );
      } catch {
        /* best-effort — see comment above */
      }
    }
    // `locked` is read for diagnostic symmetry — if the lock has
    // already moved on (supersede cleared it), `clearPendingActionAndRecord`
    // will no-op via the action_id mismatch check.
    void locked;

    return NextResponse.json({ cancelled: true, action_id: id });
  } catch (e) {
    return NextResponse.json(
      {
        cancelled: false,
        reason: "internal_error",
        error: e instanceof Error ? e.message : "cancel failed",
      },
      { status: 500 },
    );
  }
});

/**
 * Pull the decision_id / action / sub_action / scheduled_at out of the
 * raw `jobConfig` column. Tolerates string or object shapes — the
 * column is JSON and both backends round-trip through different code
 * paths. `scheduled_at` falls back to "now" when the row predates the
 * #364 lock (older job rows may not carry an explicit timestamp).
 */
function readPendingMetaFromJobConfig(raw: unknown): PendingActionMeta | null {
  if (!raw) return null;
  const cfg: Record<string, unknown> | null =
    typeof raw === "string"
      ? safeJsonParse(raw)
      : raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
  if (!cfg) return null;
  const payload = cfg.payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const decisionId = typeof p.decision_id === "string" ? p.decision_id : "";
  const action = typeof p.action === "string" ? p.action : "";
  if (!decisionId || !action) return null;
  const subAction =
    p.body && typeof p.body === "object" && !Array.isArray(p.body)
      ? (p.body as Record<string, unknown>)
      : undefined;
  return {
    decision_id: decisionId,
    action,
    scheduled_at: new Date().toISOString(),
    ...(subAction ? { sub_action: subAction } : {}),
  };
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
