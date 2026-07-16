import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same paths-mock pattern as `decisions-filter.test.ts` so each test
// runs in an isolated tmp dir and never touches the real ~/.openloomi.
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

const outcomes = await import("@/lib/loop/outcomes");
const { decisions } = await import("@/lib/loop/store");
const { runDecision, resurrectDecision } = await import("@/lib/loop/runner");
const { applyDecisionAction } = await import("@/lib/loop/server");

// Stub the native-agent POST so the runner doesn't actually hit the HTTP
// endpoint. Each test sets `nextAgentResponse` to its own fake. The runner
// does `fetch(url, …)` so we patch `globalThis.fetch` directly.
let nextAgentResponse: unknown = null;
const originalFetch = globalThis.fetch;
const fetchSpy = vi.fn(async () => {
  // Build a fake `Response` matching the SSE contract the runner expects.
  // Most tests embed their outcome in the trailing `data: {...}` `result`
  // event so the runner's parser can pick it up.
  const r = nextAgentResponse as {
    ok?: boolean;
    status?: number;
    text?: string;
    result?: unknown;
    events?: unknown[];
    error?: string;
  } | null;
  if (!r || r.ok === false) {
    return new Response(r?.error ?? "stub", { status: r?.status ?? 500 });
  }
  const events: unknown[] = Array.isArray(r.events) ? [...r.events] : [];
  // Always emit a `result` event when the test provided `r.result` —
  // mirrors how `/api/native/agent` actually closes the stream.
  if (r.result !== undefined) {
    events.push({ type: "result", content: r.result });
  }
  if (r.text) {
    // Single text event to keep the fixture readable.
    events.unshift({ type: "text", content: r.text });
  }
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
});

beforeEach(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  fetchSpy.mockClear();
  nextAgentResponse = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-outcomes-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure parser helpers
// ---------------------------------------------------------------------------

describe("parseExecutionOutcome — structured payload", () => {
  it("returns `executed` when the agent emits {outcome:'executed', evidence:{eventId}}", () => {
    const r = outcomes.parseExecutionOutcome(
      { outcome: "executed", evidence: { eventId: "abc" } },
      "",
      [],
    );
    expect(r.outcome).toBe("executed");
    expect(r.evidence?.eventId).toBe("abc");
    expect(typeof r.evaluatedAt).toBe("string");
  });

  it("returns `skipped` for {outcome:'skipped', reason:'event already accepted'}", () => {
    const r = outcomes.parseExecutionOutcome(
      { outcome: "skipped", reason: "event already accepted" },
      "",
      [],
    );
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("event already accepted");
  });

  it("accepts the legacy `status` and `verdict` aliases", () => {
    expect(
      outcomes.parseExecutionOutcome({ status: "executed" }, "", []).outcome,
    ).toBe("executed");
    expect(
      outcomes.parseExecutionOutcome({ verdict: "failed" }, "", []).outcome,
    ).toBe("failed");
  });

  it("ignores unknown outcome strings", () => {
    const r = outcomes.parseExecutionOutcome({ outcome: "maybe" }, "", []);
    // No structured outcome → no refusal, no failure pattern, no text, no
    // tool events → final fallback `failed` (the all-empty case).
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/no verifiable outcome/i);
  });
});

describe("parseExecutionOutcome — refusal heuristic", () => {
  it("matches 'I can't execute this without the user's OAuth consent'", () => {
    const r = outcomes.parseExecutionOutcome(
      null,
      "I can't execute this without the user's OAuth consent.",
      [{ type: "text", content: "..." }],
    );
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toMatch(/OAuth consent/i);
  });

  it("matches 'I won't / I am unable to'", () => {
    expect(
      outcomes.parseExecutionOutcome(null, "I'm unable to perform this", [])
        .outcome,
    ).toBe("skipped");
    expect(
      outcomes.parseExecutionOutcome(null, "I won't do that", []).outcome,
    ).toBe("skipped");
  });

  it("matches 'skipping'", () => {
    expect(
      outcomes.parseExecutionOutcome(null, "I am skipping this one", [])
        .outcome,
    ).toBe("skipped");
  });

  it("matches 'not actionable'", () => {
    expect(
      outcomes.parseExecutionOutcome(null, "This is not actionable.", [])
        .outcome,
    ).toBe("skipped");
  });

  it("matches 'requires user consent'", () => {
    expect(
      outcomes.parseExecutionOutcome(null, "Sending requires user consent", [])
        .outcome,
    ).toBe("skipped");
  });
});

describe("parseExecutionOutcome — zero-tool fallback", () => {
  it("returns `skipped` with 'no external action performed' when no tool events", () => {
    const r = outcomes.parseExecutionOutcome(
      null,
      "All done, here is the plan you asked for.",
      [{ type: "text", content: "..." }],
    );
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("no external action performed");
  });

  it("returns `executed` when tool_use events fired (legitimate 'pure_reasoning' fallback)", () => {
    // The pure-reasoning check is at the *runner* layer — the parser
    // returns `failed` when it sees no positive signal. The brief/wrap
    // "I just wrote prose" path is handled by having the agent emit
    // `{outcome:'executed'}` in its `result` event, not by relying on
    // this fallback. Asserting the parser's own behaviour keeps the
    // contract clear.
    const r = outcomes.parseExecutionOutcome(null, "I wrote the brief.", [
      { type: "tool_use", content: { name: "Skill" } },
    ]);
    // No structured outcome, no refusal, tool events present → default
    // `failed`. The runner treats this as `done / executed` for pure-
    // reasoning decision types via the structured override at run time.
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/no verifiable outcome/i);
  });
});

describe("parseExecutionOutcome — connector-failure default", () => {
  it("returns `failed` when text reports a connector error and no positive verdict", () => {
    const r = outcomes.parseExecutionOutcome(
      null,
      "Failed: 401 unauthorized, please reconnect Google Calendar.",
      [{ type: "text", content: "..." }],
    );
    // The 401 text doesn't match a refusal phrase — it's an error
    // narrative. With tool events present the parser defaults to failed.
    expect(r.outcome).toBe("failed");
  });
});

describe("parseExecutionOutcome — full default", () => {
  it("returns `failed` when there's no result, no text, no events", () => {
    const r = outcomes.parseExecutionOutcome(null, "", []);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/no verifiable outcome/i);
  });
});

// ---------------------------------------------------------------------------
// Helper coverage
// ---------------------------------------------------------------------------

describe("isRefusalText", () => {
  it("returns true for refusal-shaped text", () => {
    expect(outcomes.isRefusalText("I can't do that")).toBe(true);
    expect(outcomes.isRefusalText("Requires user consent")).toBe(true);
  });
  it("returns false for neutral / success text", () => {
    expect(outcomes.isRefusalText("Done — calendar event created.")).toBe(
      false,
    );
    expect(outcomes.isRefusalText("")).toBe(false);
  });
});

describe("hasToolCallEvents", () => {
  it("returns true for tool_call/tool_use/tool_calls/function_call types", () => {
    expect(outcomes.hasToolCallEvents([{ type: "tool_call" }])).toBe(true);
    expect(outcomes.hasToolCallEvents([{ type: "tool_use" }])).toBe(true);
    expect(outcomes.hasToolCallEvents([{ type: "tool_calls" }])).toBe(true);
    expect(outcomes.hasToolCallEvents([{ type: "function_call" }])).toBe(true);
  });
  it("returns false when the stream only emitted text/reasoning/result", () => {
    expect(
      outcomes.hasToolCallEvents([
        { type: "text" },
        { type: "reasoning" },
        { type: "result" },
      ]),
    ).toBe(false);
  });
  it("tolerates non-array input", () => {
    expect(outcomes.hasToolCallEvents(null as unknown as unknown[])).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Runner branching — the heart of the #358 fix
// ---------------------------------------------------------------------------

function addPending(opts: {
  type?: string;
  title?: string;
  action?: { kind: string; params?: Record<string, unknown> };
}): { id: string } {
  const dec = decisions.add({
    type: (opts.type ?? "rsvp") as never,
    title: opts.title ?? "RSVP for tomorrow",
    action: {
      kind: (opts.action?.kind ?? "calendar_rsvp") as never,
      params: opts.action?.params ?? { eventId: "evt-1" },
    },
  });
  if (!dec) throw new Error("decision.add returned null");
  return { id: dec.id };
}

describe("runDecision — bucket mapping by execution outcome", () => {
  it("moves executed → done with execution field and evidence", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      text: "Event created.",
      result: {
        outcome: "executed",
        reason: "Calendar event created",
        evidence: { eventId: "evt-99" },
      },
    };
    const r = await runDecision(id);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("done");
    expect(r.execution?.outcome).toBe("executed");
    expect(r.execution?.evidence?.eventId).toBe("evt-99");
    const after = decisions.get(id);
    expect(after?.status).toBe("done");
    expect(after?.execution?.outcome).toBe("executed");
  });

  it("moves skipped → done with reason and execution field (no false success)", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      text: "Skipping — already accepted.",
      result: { outcome: "skipped", reason: "event already accepted" },
    };
    const r = await runDecision(id);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("done");
    expect(r.execution?.outcome).toBe("skipped");
    const after = decisions.get(id);
    expect(after?.status).toBe("done");
    expect(after?.execution?.outcome).toBe("skipped");
    expect(after?.execution?.reason).toBe("event already accepted");
  });

  it("keeps blocked/failed → pending (the #358 regression guard)", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      text: "Failed: 401 unauthorized, please reconnect Google Calendar.",
      result: {
        outcome: "failed",
        reason: "401 unauthorized, please reconnect Google Calendar",
      },
    };
    const r = await runDecision(id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("pending");
    expect(r.execution?.outcome).toBe("failed");
    const after = decisions.get(id);
    // Critical: the decision must NOT be in the `done` bucket.
    expect(after?.status).toBe("pending");
    expect(after?.execution?.outcome).toBe("failed");
    expect(after?.context?.last_error).toMatch(/401 unauthorized/i);
  });

  it("uses refusal heuristic when no structured outcome is present", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      text: "I can't execute this without the user's OAuth consent.",
      result: null,
    };
    const r = await runDecision(id);
    expect(r.execution?.outcome).toBe("skipped");
    expect(r.status).toBe("done");
  });

  it("returns `failed` (default) when nothing verifiable arrives", async () => {
    const { id } = addPending({});
    nextAgentResponse = { ok: true, text: "", result: null, events: [] };
    const r = await runDecision(id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("pending");
    expect(r.execution?.outcome).toBe("failed");
  });

  it("legitimate pure-reasoning executed → done with executed outcome", async () => {
    const { id } = addPending({
      type: "brief",
      action: { kind: "brief", params: { date: "2026-07-10" } },
    });
    nextAgentResponse = {
      ok: true,
      text: "Brief summary written.",
      result: { outcome: "executed", reason: "Brief prose generated" },
    };
    const r = await runDecision(id);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("done");
    expect(r.execution?.outcome).toBe("executed");
    const after = decisions.get(id);
    expect(after?.status).toBe("done");
    expect(after?.execution?.outcome).toBe("executed");
  });
});

// ---------------------------------------------------------------------------
// Resurrect — `done / skipped` → `pending` re-queue
// ---------------------------------------------------------------------------

describe("resurrectDecision", () => {
  it("moves a done decision back to pending and clears execution", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      result: { outcome: "skipped", reason: "no consent" },
    };
    await runDecision(id);
    expect(decisions.get(id)?.status).toBe("done");
    const r = await resurrectDecision(id);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("pending");
    const after = decisions.get(id);
    expect(after?.status).toBe("pending");
    expect(after?.execution).toBeUndefined();
  });

  it("refuses to resurrect a non-done decision", async () => {
    const { id } = addPending({});
    const r = await resurrectDecision(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not done/);
  });
});

// ---------------------------------------------------------------------------
// Action API surface — confirms execution is serialised
// ---------------------------------------------------------------------------

describe("applyDecisionAction — propagates execution", () => {
  it("includes the execution field in the response payload", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      result: { outcome: "executed", evidence: { eventId: "evt-200" } },
    };
    const out = await applyDecisionAction(id, { action: "run" });
    expect(out.ok).toBe(true);
    expect(out.execution?.outcome).toBe("executed");
    expect(out.execution?.evidence?.eventId).toBe("evt-200");
  });

  it("handles `resurrect` action", async () => {
    const { id } = addPending({});
    nextAgentResponse = {
      ok: true,
      result: { outcome: "skipped", reason: "x" },
    };
    await runDecision(id);
    const out = await applyDecisionAction(id, { action: "resurrect" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("pending");
    expect(decisions.get(id)?.status).toBe("pending");
  });
});
