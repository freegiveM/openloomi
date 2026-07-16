import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutable tmp dir reference for the mocked paths module. Each beforeEach
// creates a fresh dir and rewrites LOOP_HOME so test runs are isolated
// from each other AND from the user's real ~/.openloomi/loop.
let LOOP_HOME = "";

vi.mock("@/lib/loop/paths", async () => {
  const { join } = await import("node:path");
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
    customTypes: join(LOOP_HOME, "custom-types.json"),
    customChannels: join(LOOP_HOME, "custom-channels.json"),
    classifierRules: join(LOOP_HOME, "classifier-rules.json"),
    activationState: join(LOOP_HOME, "activation_state.json"),
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
    migrate: () => null,
  };
});

const {
  computeActivationState,
  readActivationState,
  recordEvent,
  writeActivationState,
  ACTIVATION_SCHEMA_VERSION,
} = await import("@/lib/loop/activation");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-activation-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
  mkdirSync(LOOP_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConnectorsSnapshot(
  entries: Array<{ id: string; connected: boolean }>,
) {
  writeFileSync(
    join(LOOP_HOME, "connectors.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      connectors: entries,
    }),
  );
}

function writeSignalsLine() {
  writeFileSync(
    join(LOOP_HOME, "signals.jsonl"),
    '{"ts":"now","source":"gmail"}\n',
  );
}

function writeDecisions(buckets: {
  pending?: unknown[];
  done?: unknown[];
  dismissed?: unknown[];
}) {
  writeFileSync(join(LOOP_HOME, "decisions.json"), JSON.stringify(buckets));
}

describe("computeActivationState", () => {
  it("reports uninitialized when nothing exists and coreReady is false", () => {
    const s = computeActivationState({ coreReady: false });
    expect(s.activationStage).toBe("uninitialized");
    expect(s.coreReady).toBe(false);
    expect(s.dataSourceReady).toBe(false);
    expect(s.firstTickCompleted).toBe(false);
    expect(s.firstDecisionSeen).toBe(false);
    expect(s.recommendedNextAction).toBe("finish_setup");
    expect(s.setupUrl).toBe("/connectors");
  });

  it("reports setup_pending when progress exists but coreReady is false", () => {
    writeConnectorsSnapshot([{ id: "gmail", connected: true }]);
    const s = computeActivationState({ coreReady: false });
    expect(s.activationStage).toBe("setup_pending");
    expect(s.dataSourceReady).toBe(true);
    expect(s.recommendedNextAction).toBe("finish_setup");
  });

  it("reports runtime_ready when core is ready but no data source", () => {
    const s = computeActivationState({ coreReady: true });
    expect(s.activationStage).toBe("runtime_ready");
    expect(s.coreReady).toBe(true);
    expect(s.dataSourceReady).toBe(false);
    expect(s.recommendedNextAction).toBe("connect_source");
  });

  it("reports source_pending when a source is connected but no tick has run", () => {
    writeConnectorsSnapshot([{ id: "gmail", connected: true }]);
    const s = computeActivationState({ coreReady: true });
    expect(s.activationStage).toBe("source_pending");
    expect(s.dataSourceReady).toBe(true);
    expect(s.firstTickCompleted).toBe(false);
    expect(s.recommendedNextAction).toBe("run_first_check");
  });

  it("reports check_pending after a tick with zero pending decisions", () => {
    writeConnectorsSnapshot([{ id: "gmail", connected: true }]);
    writeSignalsLine();
    writeDecisions({ pending: [], done: [], dismissed: [] });
    const s = computeActivationState({ coreReady: true });
    expect(s.activationStage).toBe("check_pending");
    expect(s.firstTickCompleted).toBe(true);
    expect(s.recommendedNextAction).toBe("run_first_check");
  });

  it("reports decision_pending when a decision is pending and points at it", () => {
    writeConnectorsSnapshot([{ id: "gmail", connected: true }]);
    writeSignalsLine();
    writeDecisions({
      pending: [{ id: "dec-1", type: "rsvp", title: "Reply to Alice" }],
      done: [],
      dismissed: [],
    });
    const s = computeActivationState({ coreReady: true });
    expect(s.activationStage).toBe("decision_pending");
    expect(s.firstTickCompleted).toBe(true);
    expect(s.firstDecisionSeen).toBe(false);
    expect(s.recommendedNextAction).toBe("review_first_decision");
    expect(s.topPendingDecisionId).toBe("dec-1");
  });

  it("reports activated after the first decision is acted on", () => {
    writeConnectorsSnapshot([{ id: "gmail", connected: true }]);
    writeSignalsLine();
    writeDecisions({
      pending: [],
      done: [{ id: "dec-1", completed_at: "2026-07-16T00:00:00Z" }],
      dismissed: [],
    });
    const s = computeActivationState({ coreReady: true });
    expect(s.activationStage).toBe("activated");
    expect(s.firstDecisionSeen).toBe(true);
    expect(s.recommendedNextAction).toBeNull();
    expect(s.topPendingDecisionId).toBeNull();
  });

  it("treats dismissed the same as done for activation purposes", () => {
    writeDecisions({
      pending: [],
      done: [],
      dismissed: [{ id: "dec-2" }],
    });
    const s = computeActivationState({ coreReady: true });
    expect(s.activationStage).toBe("activated");
    expect(s.firstDecisionSeen).toBe(true);
  });

  it("preserves sticky progress flags across recomputes when files are emptied", () => {
    // First pass: tick ran, a decision was seen — but then user
    // emptied decisions.json. Activation should NOT regress.
    writeConnectorsSnapshot([{ id: "gmail", connected: true }]);
    writeSignalsLine();
    writeDecisions({
      pending: [],
      done: [{ id: "dec-1" }],
      dismissed: [],
    });
    const first = computeActivationState({ coreReady: true });
    expect(first.activationStage).toBe("activated");
    writeActivationState(first);

    // Now empty decisions.json and signals — empty buckets shouldn't
    // roll the user back to "runtime_ready".
    writeDecisions({ pending: [], done: [], dismissed: [] });
    writeFileSync(join(LOOP_HOME, "signals.jsonl"), "");
    const second = computeActivationState({ coreReady: true });
    expect(second.firstTickCompleted).toBe(true);
    expect(second.firstDecisionSeen).toBe(true);
    // Stage stays activated because the decision was already seen.
    expect(second.activationStage).toBe("activated");
  });

  it("respects dataSourceReady override from caller", () => {
    const s = computeActivationState({
      coreReady: true,
      dataSourceReady: true,
    });
    expect(s.dataSourceReady).toBe(true);
    expect(s.activationStage).toBe("source_pending");
  });

  it("builds setupUrl from baseUrl when provided", () => {
    const s = computeActivationState({
      coreReady: true,
      baseUrl: "http://127.0.0.1:3414",
    });
    expect(s.setupUrl).toBe("http://127.0.0.1:3414/connectors");
  });
});

describe("recordEvent", () => {
  it("flips firstTickCompleted on tick and persists", () => {
    expect(readActivationState()).toBeNull();
    const after = recordEvent("tick", { coreReady: true });
    expect(after.firstTickCompleted).toBe(true);
    const persisted = readActivationState();
    expect(persisted?.firstTickCompleted).toBe(true);
  });

  it("flips firstDecisionSeen on decision_seen", () => {
    const after = recordEvent("decision_seen", { coreReady: true });
    expect(after.firstDecisionSeen).toBe(true);
    const persisted = readActivationState();
    expect(persisted?.firstDecisionSeen).toBe(true);
  });

  it("schemaVersion is 1", () => {
    expect(ACTIVATION_SCHEMA_VERSION).toBe(1);
    const after = recordEvent("tick", { coreReady: true });
    expect(after.schemaVersion).toBe(1);
  });
});
