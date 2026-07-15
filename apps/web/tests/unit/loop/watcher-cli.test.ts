/**
 * Unit tests for the CLI invocation + record-extraction path of
 * `lib/loop/watcher.ts` — issue #348.
 *
 * The watcher polls user-defined `customChannels` via the user's
 * local `composio` CLI. Two contract changes broke it on packaged
 * desktop builds:
 *
 *   1. The legacy CLI shape
 *        `composio <toolkit> <action> --json '<args>'`
 *      no longer exists — current Composio CLI (>0.2.0) requires
 *        `composio execute <TOOL_SLUG> -d '<args>'`.
 *      The watcher must call the new shape (with the legacy shape
 *      as a fallback for users on old CLI installs).
 *
 *   2. Current tools wrap record lists under tool-specific keys:
 *        Gmail        → data.messages
 *        Google Cal.  → data.items
 *        GitHub       → data.notifications
 *      The legacy `data` / `records` / `items` top-level sweep
 *      silently returned 0 records and turned the tick into
 *      `scanned=0 surfaced=0`.
 *
 * The tests below pin the new behavior so it can't regress.
 *
 * Why we use the `execImpl` test seam instead of mocking
 * `node:child_process` directly:
 *   The production code path is `promisify(execFile)`, but Node's
 *   default `util.promisify` expects callback-style APIs and never
 *   resolves a vi.fn() that returns a Promise directly. The watcher
 *   thread an `execImpl` dependency through `WatcherOptions.execImpl`
 *   so unit tests can inject a fake `(...args) => Promise<{stdout,
 *   stderr}>` without ever invoking `util.promisify`.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("@/lib/loop/paths", async () => {
  const { join: j } = await import("node:path");
  const buildPaths = () => ({
    home: LOOP_HOME,
    signals: j(LOOP_HOME, "signals.jsonl"),
    decisions: j(LOOP_HOME, "decisions.json"),
    status: j(LOOP_HOME, "status.json"),
    brief: j(LOOP_HOME, "brief.json"),
    wrap: j(LOOP_HOME, "wrap.json"),
    connectors: j(LOOP_HOME, "connectors.json"),
    config: j(LOOP_HOME, "config.json"),
    mutes: j(LOOP_HOME, "mutes.json"),
    migrated: j(LOOP_HOME, "migrated.json"),
    log: j(LOOP_HOME, "loop.log"),
    inbox: j(LOOP_HOME, "inbox"),
    syncState: j(LOOP_HOME, "sync-state.json"),
    customTypes: j(LOOP_HOME, "custom-types.json"),
    customChannels: j(LOOP_HOME, "custom-channels.json"),
    classifierRules: j(LOOP_HOME, "classifier-rules.json"),
  });
  return {
    get LOOP_HOME() {
      return LOOP_HOME;
    },
    LOOP_PATHS: new Proxy(
      {},
      { get: (_t, p: string) => (buildPaths() as Record<string, string>)[p] },
    ),
    ensureDirs: () => mkdirSync(LOOP_HOME, { recursive: true }),
    // The store's appendJsonl() calls ensureParent(dirname(p)) before
    // appendFileSync — without this, signals.append() throws inside
    // pullChannel's record loop and every test gets 0 records appended.
    ensureParent: (p: string) => mkdirSync(dirname(p), { recursive: true }),
  };
});

let LOOP_HOME = "";
let tmp: string;

beforeAll(() => {
  // No module-level mock resets needed — the execImpl seam bypasses
  // promisify entirely. This file uses fake functions, not vi.fn().
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-watcher-cli-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
  mkdirSync(LOOP_HOME, { recursive: true });
});

afterEach(() => {
  if (tmp && existsSync(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Build a fake `execImpl` whose behavior is a queue of pre-canned
 * responses — each call consumes the next entry, falling back to
 * a default once the queue is empty.
 */
function buildExecImpl(
  queue: Array<
    | { ok: true; stdout: string; stderr?: string }
    | { ok: false; error: unknown }
  >,
  defaultResp: { ok: true; stdout: string; stderr?: string } | null = null,
): (
  bin: string,
  args: string[],
  opts?: unknown,
) => Promise<{ stdout: string; stderr: string }> {
  return async (_bin: string, _args: string[], _opts?: unknown) => {
    const next = queue.shift() ?? defaultResp;
    if (!next) throw new Error("execImpl queue exhausted");
    if (next.ok) {
      return { stdout: next.stdout, stderr: next.stderr ?? "" };
    }
    throw next.error;
  };
}

/**
 * Build a recording fake — returns the queue answer AND records every
 * invocation so a test can assert on the args the watcher produced.
 */
function buildRecordingExecImpl(
  queue: Array<
    | { ok: true; stdout: string; stderr?: string }
    | { ok: false; error: unknown }
  >,
): {
  execImpl: (
    bin: string,
    args: string[],
    opts?: unknown,
  ) => Promise<{ stdout: string; stderr: string }>;
  calls: Array<{ bin: string; args: string[] }>;
} {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const execImpl = async (
    bin: string,
    args: string[],
    _opts?: unknown,
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ bin, args });
    const next = queue.shift();
    if (!next) throw new Error("execImpl queue exhausted");
    if (next.ok) {
      return { stdout: next.stdout, stderr: next.stderr ?? "" };
    }
    throw next.error;
  };
  return { execImpl, calls };
}

// --------------------------------------------------------------------------
// Tests — pure envelope extraction (no CLI needed)
// --------------------------------------------------------------------------

describe("extractRecords envelope walker (issue #348)", () => {
  it("walks `data.messages` to surface Gmail records", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    const got = extractRecords({
      data: { messages: [{ id: "m1" }, { id: "m2" }] },
    });
    expect(got).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("walks `data.items` to surface Google Calendar records", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    const got = extractRecords({
      data: { items: [{ id: "ev1" }, { id: "ev2" }, { id: "ev3" }] },
    });
    expect(got).toHaveLength(3);
    expect(got[0]).toEqual({ id: "ev1" });
  });

  it("walks `data.notifications` to surface GitHub records", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    const got = extractRecords({
      data: { notifications: [{ id: "n1" }] },
    });
    expect(got).toEqual([{ id: "n1" }]);
  });

  it("walks `data.data.<key>` for double-wrapped envelopes", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    expect(
      extractRecords({ data: { data: { messages: [{ id: "x" }] } } }),
    ).toEqual([{ id: "x" }]);
  });

  it("falls back to a top-level `data` array for older envelopes", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    expect(extractRecords({ data: [{ id: "old1" }, { id: "old2" }] })).toEqual([
      { id: "old1" },
      { id: "old2" },
    ]);
  });

  it("wraps a single-record envelope into a 1-element array", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    expect(extractRecords({ id: "single1", type: "x" })).toEqual([
      { id: "single1", type: "x" },
    ]);
  });

  it("returns [] when the envelope has no array and no `id`/`type`", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    expect(extractRecords({ data: { hello: "world" } })).toEqual([]);
    expect(extractRecords(null)).toEqual([]);
    expect(extractRecords("not-an-object")).toEqual([]);
  });

  it("returns the raw array when the response itself is an array", async () => {
    const { extractRecords } = await import("@/lib/loop/watcher");
    expect(extractRecords([{ id: "a" }, { id: "b" }])).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });
});

// --------------------------------------------------------------------------
// Tests — CLI invocation shape (with `execImpl` seam)
// --------------------------------------------------------------------------

describe("callComposioTool CLI invocation (issue #348)", () => {
  it("uses `composio execute <TOOL_SLUG> -d '<args>'` on the current shape", async () => {
    const { callComposioTool } = await import("@/lib/loop/watcher");
    const { execImpl, calls } = buildRecordingExecImpl([
      {
        ok: true,
        stdout: JSON.stringify({ data: { messages: [{ id: "m1" }] } }),
      },
    ]);
    const channel = {
      id: "gmail_inbox",
      label: "Gmail inbox",
      toolkit: "gmail",
      toolSlug: "GMAIL_FETCH_EMAILS",
      pollIntervalSec: 60,
      signalType: "email",
      createdAt: new Date().toISOString(),
    };
    const res = await callComposioTool(channel, {}, execImpl as never);
    expect(res.ok).toBe(true);
    expect(res.records).toEqual([{ id: "m1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("composio");
    expect(calls[0].args[0]).toBe("execute");
    expect(calls[0].args[1]).toBe("GMAIL_FETCH_EMAILS");
    expect(calls[0].args[2]).toBe("-d");
    expect(() => JSON.parse(calls[0].args[3])).not.toThrow();
  });

  it("passes args as JSON via `-d`, NOT the legacy `--json`", async () => {
    const { callComposioTool } = await import("@/lib/loop/watcher");
    const { execImpl, calls } = buildRecordingExecImpl([
      { ok: true, stdout: JSON.stringify({ data: { records: [] } }) },
    ]);
    const channel = {
      id: "stripe_charges",
      label: "Stripe charges",
      toolkit: "stripe",
      toolSlug: "STRIPE_LIST_CHARGES",
      pollIntervalSec: 60,
      signalType: "stripe_charge",
      createdAt: new Date().toISOString(),
    };
    await callComposioTool(channel, {}, execImpl as never);
    const args = calls[0].args;
    expect(args).not.toContain("--json");
    expect(args).toContain("-d");
  });

  it("falls back to legacy `<toolkit> <action> --json` on `unknown command`", async () => {
    const { callComposioTool } = await import("@/lib/loop/watcher");
    const { execImpl, calls } = buildRecordingExecImpl([
      // First call: current shape rejected with the legacy-CLI refusal.
      {
        ok: false,
        error: {
          code: 1,
          stderr:
            "error: unknown command 'gmail' — try 'composio execute <slug>'",
          stdout: "",
          message: "Command failed",
        },
      },
      // Second call: legacy shape succeeds.
      {
        ok: true,
        stdout: JSON.stringify({
          data: { messages: [{ id: "legacy1" }, { id: "legacy2" }] },
        }),
      },
    ]);
    const channel = {
      id: "gmail_inbox",
      label: "Gmail inbox",
      toolkit: "gmail",
      toolSlug: "GMAIL_FETCH_EMAILS",
      pollIntervalSec: 60,
      signalType: "email",
      createdAt: new Date().toISOString(),
    };
    const res = await callComposioTool(channel, {}, execImpl as never);
    expect(res.ok).toBe(true);
    expect(res.records).toEqual([{ id: "legacy1" }, { id: "legacy2" }]);
    expect(calls).toHaveLength(2);
    // First call: current shape
    expect(calls[0].args).toEqual([
      "execute",
      "GMAIL_FETCH_EMAILS",
      "-d",
      "{}",
    ]);
    // Second call: legacy shape — derive <action> from toolSlug by
    // stripping the toolkit prefix and lowercasing.
    expect(calls[1].args[0]).toBe("gmail");
    expect(calls[1].args[1]).toBe("fetch_emails");
    expect(calls[1].args).toContain("--json");
  });

  it("surfaces a non-fallback error directly without retrying", async () => {
    const { callComposioTool } = await import("@/lib/loop/watcher");
    const { execImpl, calls } = buildRecordingExecImpl([
      // Real "toolkit not linked" failure — must NOT be retried.
      {
        ok: false,
        error: {
          code: 1,
          stderr: "toolkit not linked: run `composio link gmail` first",
          stdout: "",
          message: "Command failed",
        },
      },
    ]);
    const channel = {
      id: "gmail_inbox",
      label: "Gmail",
      toolkit: "gmail",
      toolSlug: "GMAIL_FETCH_EMAILS",
      pollIntervalSec: 60,
      signalType: "email",
      createdAt: new Date().toISOString(),
    };
    const res = await callComposioTool(channel, {}, execImpl as never);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("toolkit not linked");
    expect(calls).toHaveLength(1); // No retry
  });

  it("returns 0 records on `ENOENT` and does not crash", async () => {
    const { callComposioTool } = await import("@/lib/loop/watcher");
    const execImpl = buildExecImpl(
      [
        {
          ok: false,
          error: {
            code: "ENOENT",
            stderr: "",
            stdout: "",
            message: "spawn composio ENOENT",
          },
        },
      ],
      null,
    );
    const channel = {
      id: "gmail_inbox",
      label: "Gmail",
      toolkit: "gmail",
      toolSlug: "GMAIL_FETCH_EMAILS",
      pollIntervalSec: 60,
      signalType: "email",
      createdAt: new Date().toISOString(),
    };
    const res = await callComposioTool(channel, {}, execImpl as never);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/composio CLI not on/i);
  });
});

// --------------------------------------------------------------------------
// Tests — pullChannel / runOnce flow (integration-shaped)
// --------------------------------------------------------------------------

describe("runOnce pulls every channel and respects totals", () => {
  const addChannels = async () => {
    const { customChannels } = await import("@/lib/loop/custom-channels");
    const createdAt = new Date().toISOString();
    customChannels.invalidate();
    customChannels.upsert({
      id: "gmail_inbox",
      label: "Gmail",
      toolkit: "gmail",
      toolSlug: "GMAIL_FETCH_EMAILS",
      pollIntervalSec: 60,
      signalType: "email",
      createdAt,
    });
    customChannels.upsert({
      id: "cal_events",
      label: "Cal",
      toolkit: "googlecalendar",
      toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
      pollIntervalSec: 60,
      signalType: "calendar_event",
      createdAt,
    });
    customChannels.upsert({
      id: "gh_notifs",
      label: "GH",
      toolkit: "github",
      toolSlug: "GITHUB_LIST_NOTIFICATIONS",
      pollIntervalSec: 60,
      signalType: "github_pr",
      createdAt,
    });
  };

  it("surfaces 3 signals when Gmail returns 3 messages in its envelope", async () => {
    const { signals } = await import("@/lib/loop/store");
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: true,
        stdout: JSON.stringify({
          data: {
            messages: [
              { id: "m1", subject: "a" },
              { id: "m2", subject: "b" },
              { id: "m3", subject: "c" },
            ],
          },
        }),
      },
      // Error for calendar + github (default below).
      {
        ok: false,
        error: {
          code: 1,
          stderr: "skip",
          stdout: "",
          message: "skip",
        },
      },
      {
        ok: false,
        error: {
          code: 1,
          stderr: "skip",
          stdout: "",
          message: "skip",
        },
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(3);
    expect(signals.list()).toHaveLength(3);
  });

  it("surfaces 2 signals from `data.items` (Calendar envelope)", async () => {
    const { signals } = await import("@/lib/loop/store");
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: false,
        error: {
          code: 1,
          stderr: "skip",
          stdout: "",
          message: "skip",
        },
      },
      {
        ok: true,
        stdout: JSON.stringify({
          data: {
            items: [
              { id: "ev1", summary: "standup" },
              { id: "ev2", summary: "1:1" },
            ],
          },
        }),
      },
      {
        ok: false,
        error: {
          code: 1,
          stderr: "skip",
          stdout: "",
          message: "skip",
        },
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(2);
    expect(signals.list()).toHaveLength(2);
  });

  it("surfaces 3 signals from `data.notifications` (GitHub envelope)", async () => {
    const { signals } = await import("@/lib/loop/store");
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
      {
        ok: true,
        stdout: JSON.stringify({
          data: {
            notifications: [
              { id: "n1", subject: { title: "PR opened" } },
              { id: "n2", subject: { title: "Review requested" } },
              { id: "n3", subject: { title: "Mentioned" } },
            ],
          },
        }),
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(3);
    expect(signals.list()).toHaveLength(3);
  });

  it("surfaces 2 signals from the legacy top-level `data` array", async () => {
    const { signals } = await import("@/lib/loop/store");
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: true,
        stdout: JSON.stringify({ data: [{ id: "old1" }, { id: "old2" }] }),
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(2);
    expect(signals.list()).toHaveLength(2);
  });

  it("wraps a single-record envelope into 1 signal", async () => {
    const { signals } = await import("@/lib/loop/store");
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: true,
        stdout: JSON.stringify({ id: "single1", type: "x" }),
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(1);
    expect(signals.list()).toHaveLength(1);
  });

  it("produces 0 signals when every envelope lacks an array", async () => {
    const { signals } = await import("@/lib/loop/store");
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: true,
        stdout: JSON.stringify({ data: { hello: "world" } }),
      },
      {
        ok: true,
        stdout: JSON.stringify({ data: { nothing: "here" } }),
      },
      {
        ok: true,
        stdout: JSON.stringify({ data: { empty: "envelope" } }),
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(0);
    expect(signals.list()).toHaveLength(0);
  });

  it("persists per-channel lastError on failure but never throws", async () => {
    await addChannels();
    const execImpl = buildExecImpl([
      {
        ok: false,
        error: {
          code: 1,
          stderr: "toolkit not linked: run `composio link gmail` first",
          stdout: "",
          message: "Command failed",
        },
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
      {
        ok: false,
        error: { code: 1, stderr: "skip", stdout: "", message: "skip" },
      },
    ]);
    const { runOnce } = await import("@/lib/loop/watcher");
    const result = await runOnce({
      force: true,
      execImpl: execImpl as never,
    });
    expect(result.totalAppended).toBe(0);
    // sync-state.json should now contain lastError for each channel.
    const { readFileSync } = await import("node:fs");
    const syncPath = join(LOOP_HOME, "sync-state.json");
    expect(existsSync(syncPath)).toBe(true);
    const sync = JSON.parse(readFileSync(syncPath, "utf8")) as Record<
      string,
      { lastError?: string }
    >;
    expect(sync.gmail_inbox?.lastError).toContain("toolkit not linked");
  });
});
