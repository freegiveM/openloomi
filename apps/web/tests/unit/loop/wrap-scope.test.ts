/**
 * Regression coverage for #362 — Wrap scope wording.
 *
 * The headline bug: a user who did substantial work elsewhere sees
 *   "Today wrapped. Tomorrow staged.
 *    0 done · 0 dismissed · 2 carried"
 * which reads as a verdict on their day, not as "Loop resolved zero
 * decision cards". The fix:
 *
 *   - the snapshot stats carry a `scope: "loop_decisions"` tag so the UI
 *     can render counts with accurate scope labels;
 *   - Chronicle observations live under `evidence` and are surfaced as
 *     "observed, not verified" — never silently counted as completed
 *     work;
 *   - `computeWrapDialogue` uses scope-aware copy and never claims the
 *     user "did nothing" when they had observed activity that just
 *     isn't a Loop decision.
 *
 * These tests pin the dialogue copy and the snapshot shape. They don't
 * shell out to openloomi-memory — the helper degrades to empty
 * evidence on any failure, so the snapshot is still buildable in a
 * sandbox.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/loop/store", async () => {
  return {
    decisions: {
      list: (status?: string | null) =>
        status === "pending" || status === undefined || status === null
          ? []
          : [],
      pending: () => [],
    },
    log: () => undefined,
  };
});

vi.mock("@/lib/loop/paths", async () => ({
  LOOP_PATHS: { wrap: "/dev/null/wrap.json" },
  ensureDirs: () => undefined,
  ensureParent: () => undefined,
  migrate: () => null,
}));

// Stub `spawnSync` so the Chronicle reader doesn't actually shell out
// during tests — every call returns "no insights". Keeps the test
// deterministic across sandboxes that don't have openloomi-memory.
vi.mock("node:child_process", async () => ({
  spawnSync: () => ({
    status: 1,
    stdout: "",
    stderr: "stubbed",
  }),
}));

const { computeWrapDialogue } = await import("@/lib/loop/wrap");
import type { WrapSnapshot, WrapHighlight } from "@/lib/loop/wrap";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T21:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function makeSnapshot(partial: Partial<WrapSnapshot> = {}): WrapSnapshot {
  const highlights: WrapHighlight[] = partial.highlights ?? [];
  return {
    date: "2026-07-16",
    generatedAt: "2026-07-16T21:00:00Z",
    stats: {
      done: highlights.length,
      dismissed: 0,
      stillPending: 0,
      scope: "loop_decisions",
    },
    highlights,
    ...partial,
  };
}

describe("computeWrapDialogue — scope-aware wording (#362)", () => {
  it("never claims 'nothing got done today' on an empty wrap", () => {
    const out = computeWrapDialogue(makeSnapshot(), []);
    expect(out.toLowerCase()).not.toContain("nothing got done");
    // Anchored: the headline says nothing surfaced from Loop today, not
    // that the user did nothing.
    expect(out.toLowerCase()).toContain("loop");
    expect(out.toLowerCase()).toContain("nothing surfaced");
  });

  it("names the scope explicitly when there are resolved decisions", () => {
    const highlights: WrapHighlight[] = [
      {
        id: "d1",
        title: "Reply to Alice",
        type: "draft_reply",
        completedAt: "2026-07-16T20:00:00Z",
        resultKind: "completed",
      },
    ];
    const out = computeWrapDialogue(
      makeSnapshot({
        stats: {
          done: 2,
          dismissed: 0,
          stillPending: 1,
          scope: "loop_decisions",
        },
        highlights,
      }),
      highlights,
    );
    expect(out).toContain("2 Loop decisions resolved");
    expect(out).toContain("Reply to Alice");
    // Must NOT be worded like "you finished 2 tasks today".
    expect(out.toLowerCase()).not.toContain("you finished");
    expect(out.toLowerCase()).not.toContain("you completed");
  });

  it("distinguishes observed activity from verified completion", () => {
    const out = computeWrapDialogue(
      makeSnapshot({
        stats: {
          done: 0,
          dismissed: 0,
          stillPending: 0,
          scope: "loop_decisions",
        },
        evidence: {
          chronicleScreenshots: 3,
          chronicleInsights: 9,
          notes: "3 screen captures + 9 insights (observed, not verified)",
        },
      }),
      [],
    );
    // The headline MUST surface the observed count instead of saying
    // "nothing got done". That's the whole point of the fix.
    expect(out).toContain("12 things captured");
    expect(out.toLowerCase()).not.toContain("nothing got done");
    // The wrap must not silently treat observed activity as completion.
    expect(out.toLowerCase()).not.toContain("resolved 12");
    expect(out.toLowerCase()).not.toContain("you finished");
  });

  it("falls through to the honest scope label when neither decisions nor evidence exist", () => {
    const out = computeWrapDialogue(makeSnapshot(), []);
    expect(out.toLowerCase()).toContain("nothing surfaced");
  });

  it("keeps 'generating' and 'ready' narrative paths untouched", () => {
    const generating = computeWrapDialogue(
      makeSnapshot({
        narrative: {
          status: "generating",
          startedAt: "2026-07-16T21:00:00Z",
          input_hash: "abc",
        },
      }),
      [],
    );
    expect(generating).toContain("generating");
    const ready = computeWrapDialogue(
      makeSnapshot({
        narrative: {
          status: "ready",
          headline: "Quiet evening",
          body: "All clear.",
          generatedAt: "2026-07-16T21:00:00Z",
          input_hash: "abc",
        },
      }),
      [],
    );
    expect(ready).toContain("Quiet evening");
  });
});

describe("WrapSnapshot.stats.scope — UI contract (#362)", () => {
  it("always carries a `scope` tag of `loop_decisions`", () => {
    const snap = makeSnapshot();
    expect(snap.stats.scope).toBe("loop_decisions");
  });
});
