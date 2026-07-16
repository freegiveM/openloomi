/**
 * Regression coverage for `lib/loop/decision-lock.ts` (#364) — the pure
 * lock-and-history helpers that fix the "two opposite RSVP actions both
 * execute" bug.
 *
 * The acceptance criteria from #364:
 *   1. Cancel before dispatch → no external mutation (lock cleared,
 *      history row records `cancelled`).
 *   2. Cancel after dispatch → UI tells the user "already_fired"
 *      (lock is gone, history row records `completed`/`skipped`).
 *   3. A second schedule while one is queued is refused by default;
 *      `supersede: true` cancels-then-reschedules atomically and
 *      the cancelled row is preserved in `sub_actions`.
 *   4. Two rapid opposite clicks cannot both reach the agent — the
 *      schedule route stamps the lock; the handler refuses to fire
 *      a job whose id no longer matches the lock.
 *   5. Reload preserves the full lifecycle — `context.sub_actions`
 *      is append-only and the lock survives across the schedule →
 *      cancel → supersede chain.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendHistory,
  buildAttemptRecord,
  clearPendingActionAndRecord,
  readPendingAction,
  readSubActions,
  setPendingAction,
  statusFromOutcome,
} from "@/lib/loop/decision-lock";
import { decisions } from "@/lib/loop/store";
import { LOOP_PATHS } from "@/lib/loop/paths";

let decisionId = "";

beforeEach(() => {
  // #364 follow-up — wipe the on-disk decisions.json so the new
  // eventId-based dedup gate (`store.ts::decisions.add`) doesn't see
  // a stale `evt-1` from a prior test run and refuse the add. The
  // pre-#364 code had no dedup so the same eventId across runs was
  // harmless; with the gate in place it isn't. Cheap: in-process
  // JSON file, no real I/O outside the loop home dir.
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(LOOP_PATHS.decisions)) {
      fs.writeFileSync(
        LOOP_PATHS.decisions,
        JSON.stringify({ pending: [], done: [], dismissed: [] }),
      );
    }
  } catch {
    /* best-effort — test isolation is observability, not correctness */
  }
  const dec = decisions.add({
    type: "rsvp",
    title: "RSVP for tomorrow",
    action: {
      kind: "calendar_rsvp",
      params: { eventId: "evt-1", start: "2026-07-17T10:00:00Z" },
    },
  });
  if (!dec) throw new Error("decision.add returned null");
  decisionId = dec.id;
});

afterEach(() => {
  // `decisions.add` is JSON-backed; clearing the bucket is enough
  // for test isolation. We never delete across tests because the
  // store is in-process and shared.
});

// ---------------------------------------------------------------------------
// Read / write the lock
// ---------------------------------------------------------------------------

describe("readPendingAction / setPendingAction", () => {
  it("returns null when no action is queued", () => {
    expect(readPendingAction(decisionId)).toBeNull();
  });

  it("returns the stamped lock after setPendingAction", () => {
    const now = new Date().toISOString();
    setPendingAction(decisionId, {
      action_id: "job-1",
      scheduled_at: now,
      action: "run",
      sub_action: { response: "no" },
    });
    const lock = readPendingAction(decisionId);
    expect(lock).not.toBeNull();
    expect(lock?.action_id).toBe("job-1");
    expect(lock?.action).toBe("run");
    expect(lock?.sub_action).toEqual({ response: "no" });
  });

  it("overwrites a stale lock (schedule route after the row is gone)", () => {
    setPendingAction(decisionId, {
      action_id: "job-1",
      scheduled_at: new Date().toISOString(),
      action: "run",
    });
    setPendingAction(decisionId, {
      action_id: "job-2",
      scheduled_at: new Date().toISOString(),
      action: "run",
      sub_action: { response: "yes" },
    });
    expect(readPendingAction(decisionId)?.action_id).toBe("job-2");
  });

  // #364 follow-up — the floating pet card now schedules RSVP clicks
  // as `rsvp_attend` / `rsvp_decline` / `rsvp_maybe` (instead of the
  // historical `run` + `{response}` body hack). The lock helpers
  // must round-trip the new verb verbatim so the cancel route can
  // read `pending_action_verb` and the UI can render the right
  // banner. We pin all three verbs here — `accepted` / `declined` /
  // `tentative` map from the runner side; the lock layer is verb-
  // agnostic and just persists the string.
  it("round-trips the new rsvp_* verbs through the lock", () => {
    const verbs = ["rsvp_attend", "rsvp_decline", "rsvp_maybe"] as const;
    for (const verb of verbs) {
      setPendingAction(decisionId, {
        action_id: `job-${verb}`,
        scheduled_at: new Date().toISOString(),
        action: verb,
      });
      const lock = readPendingAction(decisionId);
      expect(lock?.action).toBe(verb);
      expect(lock?.action_id).toBe(`job-${verb}`);
    }
  });
});

// ---------------------------------------------------------------------------
// History append-only semantics
// ---------------------------------------------------------------------------

describe("appendHistory", () => {
  it("appends records in order without mutating the previous array", () => {
    const ctx: Record<string, unknown> = {};
    const a = appendHistory(ctx, sample("job-1", "run", "cancelled"));
    // `appendHistory` is pure: callers thread the returned array back
    // into the context so the next call sees the previous records.
    ctx.sub_actions = a;
    const b = appendHistory(ctx, sample("job-2", "run", "completed"));
    // a and b must be distinct arrays — no in-place mutation.
    expect(a).not.toBe(b);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    // The first array is unchanged after the second append.
    expect(a[0]?.action_id).toBe("job-1");
  });

  it("caps at 50 entries, trimming oldest first", () => {
    const ctx: Record<string, unknown> = {};
    let arr: import("@/lib/loop/types").DecisionSubActionRecord[] = [];
    for (let i = 0; i < 55; i++) {
      arr = appendHistory(ctx, sample(`job-${i}`, "run", "cancelled"));
      ctx.sub_actions = arr;
    }
    expect(arr).toHaveLength(50);
    expect(arr[0]?.action_id).toBe("job-5");
    expect(arr[49]?.action_id).toBe("job-54");
  });
});

// ---------------------------------------------------------------------------
// clearPendingActionAndRecord — the cancel + supersede core
// ---------------------------------------------------------------------------

describe("clearPendingActionAndRecord (#364 headline fix)", () => {
  it("clears the lock AND appends the cancelled record", () => {
    setPendingAction(decisionId, {
      action_id: "job-1",
      scheduled_at: new Date().toISOString(),
      action: "run",
      sub_action: { response: "no" },
    });
    clearPendingActionAndRecord(
      decisionId,
      sample("job-1", "run", "cancelled", { response: "no" }),
    );
    expect(readPendingAction(decisionId)).toBeNull();
    const history = readSubActions(decisionId);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("cancelled");
    expect(history[0]?.sub_action).toEqual({ response: "no" });
  });

  it("appends to history WITHOUT clearing when the action_id doesn't match", () => {
    // Simulates a supersede path where the schedule route already
    // cleared the lock before our cancel arrived.
    setPendingAction(decisionId, {
      action_id: "job-2",
      scheduled_at: new Date().toISOString(),
      action: "run",
    });
    clearPendingActionAndRecord(
      decisionId,
      sample("job-1", "run", "superseded", { response: "no" }),
    );
    // Lock is preserved (we didn't own it).
    expect(readPendingAction(decisionId)?.action_id).toBe("job-2");
    // History grew.
    const history = readSubActions(decisionId);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("superseded");
  });

  it("preserves earlier attempts across the schedule → cancel → reschedule chain", () => {
    // Step 1 — user picks No, lock is stamped.
    setPendingAction(decisionId, {
      action_id: "job-1",
      scheduled_at: "2026-07-16T10:00:00Z",
      action: "run",
      sub_action: { response: "no" },
    });
    // Step 2 — user cancels before dispatch. Routes pass
    // statusOverride:"cancelled" so the lifecycle status reflects the
    // user intent rather than the verdict-based default (which would
    // be "failed" for ok=false + no verdict).
    clearPendingActionAndRecord(
      decisionId,
      buildAttemptRecord(
        "job-1",
        "run",
        {
          ok: false,
          scheduled_at: "2026-07-16T10:00:00Z",
          sub_action: { response: "no" },
          execution: { reason: "cancelled by user" },
        },
        { statusOverride: "cancelled" },
      ),
    );
    // Step 3 — user picks Yes, lock is stamped on a new job.
    setPendingAction(decisionId, {
      action_id: "job-2",
      scheduled_at: "2026-07-16T10:00:01Z",
      action: "run",
      sub_action: { response: "yes" },
    });
    // Step 4 — the Yes job fires successfully and clears the lock.
    clearPendingActionAndRecord(
      decisionId,
      buildAttemptRecord("job-2", "run", {
        ok: true,
        scheduled_at: "2026-07-16T10:00:01Z",
        sub_action: { response: "yes" },
        execution: {
          outcome: "executed",
          reason: "Calendar event accepted",
        },
      }),
    );
    const history = readSubActions(decisionId);
    expect(history.map((r) => `${r.action_id}:${r.status}`)).toEqual([
      "job-1:cancelled",
      "job-2:completed",
    ]);
    expect(history[0]?.sub_action).toEqual({ response: "no" });
    expect(history[1]?.sub_action).toEqual({ response: "yes" });
    expect(readPendingAction(decisionId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// statusFromOutcome — pure mapping helper
// ---------------------------------------------------------------------------

describe("statusFromOutcome", () => {
  it("maps executed + ok → completed (the success terminal state)", () => {
    expect(statusFromOutcome(true, "executed")).toBe("completed");
  });

  it("maps skipped + ok → skipped", () => {
    expect(statusFromOutcome(true, "skipped")).toBe("skipped");
  });

  it("maps blocked / failed + !ok → blocked / failed", () => {
    expect(statusFromOutcome(false, "blocked")).toBe("blocked");
    expect(statusFromOutcome(false, "failed")).toBe("failed");
  });

  it("falls back to failed when not ok and no verdict", () => {
    expect(statusFromOutcome(false, undefined)).toBe("failed");
  });

  it("falls back to completed when ok and no verdict", () => {
    expect(statusFromOutcome(true, undefined)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sample(
  actionId: string,
  action: string,
  status: import("@/lib/loop/types").DecisionSubActionStatus,
  subAction?: Record<string, unknown>,
): import("@/lib/loop/types").DecisionSubActionRecord {
  return {
    action_id: actionId,
    scheduled_at: "2026-07-16T10:00:00Z",
    completed_at: "2026-07-16T10:00:01Z",
    action,
    ...(subAction ? { sub_action: subAction } : {}),
    status,
  };
}
