/**
 * End-to-end coverage for the orphan-refusal path inside
 * `lib/loop/handlers.ts::handleTick` — the gate that protects against
 * orphaned Loop ticks firing agentic work against the user's Claude
 * subscription when the supervising `openloomi.app` is gone (#516).
 *
 * What we're asserting:
 *
 *   1. When `checkSupervisor()` reports `ok: false`, `handleTick` MUST
 *      NOT import or invoke the real `tick.ts::run` or
 *      `watcher.ts::runOnce` modules — those are the modules that
 *      burn tokens.
 *   2. The returned `JobExecutionResult` must carry `status: "success"`
 *      (the cron executor uses this to record a clean run, not a
 *      spurious error) and the JSON-encoded output must include
 *      `orphanSupervisor` + zero-yield counters (`scanned:0,
 *      surfaced:0, muted:0, newDecisions:[], errors:[]`).
 *   3. The handler MUST disable Loop in preferences (`writePreferences({
 *      enabled: false })`) so subsequent cron ticks no-op.
 *   4. The handler MUST remove the three loop cron rows via
 *      `removeLoopJobs(userId)` so even if the user re-enables Loop
 *      via the API before the supervisor comes back, there are no
 *      rows to fire.
 *   5. The handler MUST write `status.json` with the `orphanSupervisor`
 *      field so the UI / `state()` surface can show "Loop disabled —
 *      supervisor gone" on next read.
 *
 * The "unbound" path (no `OPENLOOMI_BOOT_ID`, dev/CLI) is intentionally
 * NOT covered here — that's the happy path. The orphan states
 * (`stamp_missing`, `stamp_stale`, `stamp_mismatch`) all share the
 * exact same refusal branch, so we exercise one of them and trust the
 * `parent-watch.test.ts` matrix to cover the other transitions.
 *
 * Mocks strategy:
 *
 *   - `tick.ts` and `watcher.ts` are mocked with throwing spies — if
 *     handleTick reaches them, the test fails loudly rather than
 *     silently passing.
 *   - `preferences.writePreferences`, `scheduler.removeLoopJobs`, and
 *     `store.writeStatus` are mocked with vi.fn() so the test can
 *     assert on the calls (call args, call count).
 *   - `parent-watch.ts` uses its existing `_setParentWatchOverrides`
 *     test hook — no `process.env` mutation needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above imports, so the spies are in place by the
// time the handlers module (and its transitive imports) load. We mock
// the *user-facing* siblings of handlers.ts so a regression that
// *skips* writing status / prefs / removing cron rows fails this test.

// Spies we observe from handleTick's refusal path. `run` and
// `runOnce` are the "tokens burn here" surfaces — they must not be
// reached.
const writePreferencesSpy = vi.fn();
const removeLoopJobsSpy = vi.fn(async () => {});
const runTickSpy = vi.fn(() => {
  throw new Error("tick.run must NOT be called when supervisor is gone");
});
const runWatcherSpy = vi.fn(async () => {
  throw new Error("watcher.runOnce must NOT be called when supervisor is gone");
});
const writeStatusSpy = vi.fn();
const readStatusSpy = vi.fn(() => ({}));
const logSpy = vi.fn();

vi.mock("@/lib/loop/preferences", () => ({
  writePreferences: (patch: unknown) => writePreferencesSpy(patch),
}));

vi.mock("@/lib/loop/scheduler", () => ({
  removeLoopJobs: (uid: string | undefined) => removeLoopJobsSpy(uid),
}));

vi.mock("@/lib/loop/tick", () => ({
  run: (args: unknown) => runTickSpy(args),
  setActiveUser: (uid: string | null) => {
    // not exercised in the orphan path; safe to no-op
    void uid;
  },
}));

vi.mock("@/lib/loop/watcher", () => ({
  runOnce: (args: unknown) => runWatcherSpy(args),
}));

vi.mock("@/lib/loop/store", () => ({
  // handleTick imports log statically + writeStatus/readStatus dynamically.
  log: (...args: unknown[]) => logSpy(...args),
  writeStatus: (status: unknown) => writeStatusSpy(status),
  readStatus: () => readStatusSpy(),
}));

// `lib/cron/executor.ts` transitively imports `@/lib/ai`, which fails
// to resolve through the vitest alias config for unrelated reasons
// (it pulls in the agent runtime graph and breaks test setup). We
// only need two symbols from the executor — the `customJobHandlers`
// registry and the `registerCustomHandler` setter — so we mock the
// whole module with a minimal in-memory replacement. `registerLoopHandlers`
// will populate our mock registry exactly the way it does the real one.
const mockRegistry: Record<
  string,
  (ctx: unknown) => Promise<unknown>
> = {};
vi.mock("@/lib/cron/executor", () => ({
  customJobHandlers: mockRegistry,
  registerCustomHandler: (
    name: string,
    handler: (ctx: unknown) => Promise<unknown>,
  ) => {
    mockRegistry[name] = handler;
  },
}));

// Now the real imports — handlers registers the four loop.* handlers
// into our (mocked) cron executor registry, then we pull `loop.tick`
// back out via the same `mockRegistry` reference the mock closed over.
const { registerLoopHandlers } = await import("@/lib/loop/handlers");
const { _setParentWatchOverrides } = await import("@/lib/loop/parent-watch");

const FAKE_USER_ID = "user-orphan-test";
const FAKE_STAMP_PATH = "/tmp/loomi-orphan-test-nonexistent/alive";
const FAKE_BOOT_ID = "boot-orphan-123";

/**
 * Look up a handler from `mockRegistry` and throw a clear error if
 * it's missing. Avoids biome's `noNonNullAssertion` while still
 * surfacing a real diagnostic when the test setup forgot to register.
 */
function requireHandler(name: string) {
  const h = mockRegistry[name];
  if (!h) {
    throw new Error(`handler not registered: ${name}`);
  }
  return h;
}

const fakeContext = {
  userId: FAKE_USER_ID,
  jobId: "job-loop-tick-orphan",
  executionId: "exec-orphan",
  triggeredBy: "scheduler" as const,
};

beforeEach(() => {
  // Force handleTick down the orphan branch: the supervisor boot id
  // is set, but the stamp file at our temp path doesn't exist.
  _setParentWatchOverrides({ bootId: FAKE_BOOT_ID, stampPath: FAKE_STAMP_PATH });
  // Register handlers — idempotent in handlers.ts; safe to call.
  registerLoopHandlers();
});

afterEach(() => {
  _setParentWatchOverrides(null);
  writePreferencesSpy.mockClear();
  removeLoopJobsSpy.mockClear();
  runTickSpy.mockClear();
  runWatcherSpy.mockClear();
  writeStatusSpy.mockClear();
  readStatusSpy.mockClear();
  logSpy.mockClear();
});

describe("handleTick — orphan refusal (#516)", () => {
  it("refuses the tick, never imports tick/watcher, and emits a zero-yield result", async () => {
    const handler = requireHandler("loop.tick");
    expect(handler, "loop.tick handler must be registered").toBeTypeOf(
      "function",
    );

    const result = await handler(fakeContext);

    // 1. Result shape — success (so the cron executor logs a clean run)
    //    with the orphan state surfaced in the JSON-encoded output.
    expect(result.status).toBe("success");
    expect((result as { error?: string }).error).toBeUndefined();
    expect(typeof (result as { output?: string }).output).toBe("string");
    const parsed = JSON.parse((result as { output: string }).output);
    expect(parsed).toMatchObject({
      scanned: 0,
      surfaced: 0,
      muted: 0,
      newDecisions: [],
      errors: [],
      orphanSupervisor: "stamp_missing",
    });

    // 2. The expensive modules MUST NOT have been touched.
    expect(runTickSpy).not.toHaveBeenCalled();
    expect(runWatcherSpy).not.toHaveBeenCalled();

    // 3. Defensive side effects all happened.
    expect(writePreferencesSpy).toHaveBeenCalledTimes(1);
    expect(writePreferencesSpy).toHaveBeenCalledWith({ enabled: false });

    expect(removeLoopJobsSpy).toHaveBeenCalledTimes(1);
    expect(removeLoopJobsSpy).toHaveBeenCalledWith(FAKE_USER_ID);

    expect(writeStatusSpy).toHaveBeenCalledTimes(1);
    const statusArg = writeStatusSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(statusArg).toMatchObject({
      lastSignalCount: 0,
      lastDecisionCount: 0,
      orphanSupervisor: "stamp_missing",
    });
    // lastError must echo the supervisor reason so a support read of
    // status.json can see *why* Loop shut itself off without trawling
    // through logs.
    expect(typeof statusArg.lastError).toBe("string");
    expect((statusArg.lastError as string).length).toBeGreaterThan(0);
    expect(typeof statusArg.lastTickAt).toBe("string");

    // 4. The handler must log the refusal so an operator looking at
    //    loop.log sees the #516 reason next to the zero-yield result.
    const refusedLog = logSpy.mock.calls.find((args) =>
      String(args[0] ?? "").includes("tick refused"),
    );
    expect(refusedLog, "handler must log the refusal").toBeDefined();
  });

  it("is resilient to writePreferences failures — still removes cron rows + writes status", async () => {
    // Simulate the prefs write failing (e.g. permissions, disk full).
    // The handler wraps it in try/catch, so the cron-removal path must
    // still run. Otherwise the user could end up with the loop rows
    // still firing even though prefs were not flipped.
    writePreferencesSpy.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const handler = requireHandler("loop.tick");
    const result = await handler(fakeContext);

    expect(result.status).toBe("success");
    expect(writePreferencesSpy).toHaveBeenCalledTimes(1);
    expect(removeLoopJobsSpy).toHaveBeenCalledTimes(1);
    expect(removeLoopJobsSpy).toHaveBeenCalledWith(FAKE_USER_ID);
    expect(writeStatusSpy).toHaveBeenCalledTimes(1);
    // Tick + watcher still must not have been touched.
    expect(runTickSpy).not.toHaveBeenCalled();
    expect(runWatcherSpy).not.toHaveBeenCalled();
  });

  it("is resilient to removeLoopJobs failures — still surfaces orphan status", async () => {
    // Inverse of the previous test: cron-row removal fails (e.g. FK
    // violation, transient DB error). The handler must NOT throw and
    // MUST still record the orphan so the UI surfaces the reason.
    removeLoopJobsSpy.mockImplementationOnce(async () => {
      throw new Error("FK violation");
    });

    const handler = requireHandler("loop.tick");
    const result = await handler(fakeContext);

    expect(result.status).toBe("success");
    expect(removeLoopJobsSpy).toHaveBeenCalledTimes(1);
    expect(writeStatusSpy).toHaveBeenCalledTimes(1);
    expect(writePreferencesSpy).toHaveBeenCalledWith({ enabled: false });
    expect(runTickSpy).not.toHaveBeenCalled();
    expect(runWatcherSpy).not.toHaveBeenCalled();
  });
});
