import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutable tmp dir reference for the mocked paths module. Each beforeEach
// creates a fresh dir and rewrites LOOP_HOME so test runs are isolated
// from each other AND from the user's real ~/.openloomi/loop.
let LOOP_HOME = "";

vi.mock("@/lib/loop/paths", async () => {
  const { join } = await import("node:path");
  // Build the paths object dynamically on each property access so the
  // mocked module sees the *current* LOOP_HOME, not the one captured at
  // module load time.
  const buildPaths = () => ({
    home: LOOP_HOME,
    signals: join(LOOP_HOME, "signals.jsonl"),
    decisions: join(LOOP_HOME, "decisions.json"),
    status: join(LOOP_HOME, "status.json"),
    brief: join(LOOP_HOME, "brief.json"),
    wrap: join(LOOP_HOME, "wrap.json"),
    connectors: join(LOOP_HOME, "connectors.json"),
    config: join(LOOP_HOME, "config.json"),
    mutes: join(LOOP_HOME, "mutes.json"),
    migrated: join(LOOP_HOME, "migrated.json"),
    log: join(LOOP_HOME, "loop.log"),
    inbox: join(LOOP_HOME, "inbox"),
    syncState: join(LOOP_HOME, "sync-state.json"),
  });
  const pathsProxy = new Proxy(
    {},
    {
      get: (_t, prop: string) => (buildPaths() as Record<string, string>)[prop],
    },
  );
  return {
    get LOOP_HOME() {
      return LOOP_HOME;
    },
    LOOP_PATHS: pathsProxy,
    ensureDirs: () => {
      mkdirSync(LOOP_HOME, { recursive: true });
      mkdirSync(join(LOOP_HOME, "inbox", ".processed"), { recursive: true });
      mkdirSync(join(LOOP_HOME, "inbox", ".failed"), { recursive: true });
    },
    ensureParent: (p: string) => {
      const { dirname } = require("node:path") as typeof import("node:path");
      mkdirSync(dirname(p), { recursive: true });
    },
  };
});

const { isNoopDecision, decisions } = await import("@/lib/loop/store");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-dec-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isNoopDecision", () => {
  it("rejects type=noop", () => {
    expect(isNoopDecision({ type: "noop", title: "anything" })).toBe(true);
  });
  it("rejects type=tick_summary", () => {
    expect(isNoopDecision({ type: "tick_summary", title: "x" })).toBe(true);
  });
  // #378 — `unknown` is treated as non-actionable at ingest so a burst of
  // passive GitHub notifications never becomes a Run card.
  it("rejects type=unknown", () => {
    expect(isNoopDecision({ type: "unknown", title: "GitHub update" })).toBe(
      true,
    );
  });
  it("rejects '0 new decisions' titles", () => {
    expect(isNoopDecision({ type: "todo", title: "0 new decisions." })).toBe(
      true,
    );
    expect(
      isNoopDecision({ type: "todo", title: "  0 New Decisions today" }),
    ).toBe(true);
  });
  it("rejects context.source === 'loop_tick'", () => {
    expect(
      isNoopDecision({
        type: "todo",
        title: "Real title",
        context: { source: "loop_tick" },
      }),
    ).toBe(true);
  });
  it("rejects context.noop === true", () => {
    expect(
      isNoopDecision({
        type: "rsvp",
        title: "Yes",
        context: { noop: true },
      }),
    ).toBe(true);
  });
  it("accepts normal actionable decisions", () => {
    expect(isNoopDecision({ type: "rsvp", title: "Reply to Alice" })).toBe(
      false,
    );
  });
});

describe("decisions.add() filter", () => {
  it("returns null and does not write pending for noop records", () => {
    const before = decisions.list("pending").length;
    const dec = decisions.add({
      type: "noop",
      title: "Tick clean. 0 new decisions.",
      action: { kind: "todo", params: {} },
    });
    expect(dec).toBeNull();
    expect(decisions.list("pending").length).toBe(before);
  });

  it("returns null for tick_summary", () => {
    const dec = decisions.add({
      type: "tick_summary",
      title: "Tick result",
      action: { kind: "todo", params: {} },
    });
    expect(dec).toBeNull();
  });

  it("still persists a real brief card", () => {
    const dec = decisions.add({
      type: "brief",
      title: "Morning brief · 2026-07-10",
      action: { kind: "brief", params: { date: "2026-07-10" } },
    });
    expect(dec).not.toBeNull();
    expect(dec?.type).toBe("brief");
  });

  // #378 — `unknown` decisions are now non-actionable and rejected at
  // ingest. Previously they were accepted and turned into Run cards.
  it("rejects type=unknown at ingest (#378)", () => {
    const before = decisions.list("pending").length;
    const dec = decisions.add({
      type: "unknown",
      title: "GitHub notification",
      action: { kind: "todo", params: {} },
    });
    expect(dec).toBeNull();
    expect(decisions.list("pending").length).toBe(before);
  });
});

describe("readDecisions() migration (#378)", () => {
  // #378 — upgrade path: a pre-aggregator `decisions.json` may have a
  // burst of pending `unknown` records on disk. The first `decisions.list()`
  // after upgrade must move those to `dismissed` with a `filtered_reason`
  // stamp instead of leaving them as Run cards.
  it("migrates pre-existing pending unknown cards to dismissed", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    // The paths mock ensures the directory exists via ensureDirs(), but
    // our test imports `node:fs` directly so we create the directory
    // ourselves before writing.
    mkdirSync(LOOP_HOME, { recursive: true });
    const decisionPath = join(LOOP_HOME, "decisions.json");
    const nowIso = new Date().toISOString();
    const state = {
      pending: [
        {
          id: "stale_unknown_1",
          ts: nowIso,
          status: "pending",
          type: "unknown",
          title: "GitHub notification",
          action: { kind: "todo", params: {} },
        },
        {
          id: "stale_unknown_2",
          ts: nowIso,
          status: "pending",
          type: "unknown",
          title: "Another notification",
          action: { kind: "todo", params: {} },
        },
      ],
      done: [],
      dismissed: [],
    };
    writeFileSync(decisionPath, JSON.stringify(state));
    const pending = decisions.list("pending");
    const dismissed = decisions.list("dismissed");
    expect(pending.find((d) => d.id === "stale_unknown_1")).toBeUndefined();
    expect(pending.find((d) => d.id === "stale_unknown_2")).toBeUndefined();
    expect(dismissed.find((d) => d.id === "stale_unknown_1")).toBeDefined();
    expect(dismissed.find((d) => d.id === "stale_unknown_2")).toBeDefined();
    const migrated = dismissed.find((d) => d.id === "stale_unknown_1");
    expect(migrated?.status).toBe("dismissed");
    expect(
      (migrated?.context as Record<string, unknown> | undefined)
        ?.filtered_reason,
    ).toBe("non_actionable_migrated");
  });

  it("preserves actionable pending cards across migration", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(LOOP_HOME, { recursive: true });
    const decisionPath = join(LOOP_HOME, "decisions.json");
    const nowIso = new Date().toISOString();
    const state = {
      pending: [
        {
          id: "real_rsvp_1",
          ts: nowIso,
          status: "pending",
          type: "rsvp",
          title: "Real meeting",
          action: { kind: "calendar_rsvp", params: { eventId: "evt-1" } },
        },
        {
          id: "stale_unknown_x",
          ts: nowIso,
          status: "pending",
          type: "unknown",
          title: "Old noise",
          action: { kind: "todo", params: {} },
        },
      ],
      done: [],
      dismissed: [],
    };
    writeFileSync(decisionPath, JSON.stringify(state));
    const pending = decisions.list("pending");
    const dismissed = decisions.list("dismissed");
    expect(pending.find((d) => d.id === "real_rsvp_1")).toBeDefined();
    expect(pending.find((d) => d.id === "stale_unknown_x")).toBeUndefined();
    expect(dismissed.find((d) => d.id === "stale_unknown_x")).toBeDefined();
  });
});
