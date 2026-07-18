import {
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  test,
  expect,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

vi.mock("dotenv", () => ({
  config: () => ({ parsed: {} }),
  parse: () => ({}),
}));

vi.mock("@/app/(auth)/auth", () => ({
  auth: async () => ({ user: { id: "user-1", type: "regular" } }),
}));

// `with-auto-guest` transitively pulls in `lib/db/queries` which fails to
// resolve under the test runner (it tries to import a path that doesn't
// exist on disk). The route's PATCH handler wraps with this — bypass it
// for the POST handlers under test by routing the wrapper straight
// through to the inner handler.
vi.mock("@/lib/auth/with-auto-guest", () => ({
  withAutoGuest: <T>(handler: T) => handler,
}));

// `@/lib/loop` is a barrel that re-exports `lib/cron/service`, which in
// turn imports `lib/ai/index.ts`. Under the test runner that path fails
// to resolve (`packages/ai/src/agent/index.ts/ai` — alias ordering
// bug). Stub the bits the route's POST handler imports
// (`applyDecisionAction`, `decisions`, `getDecision`, `log`) so the
// barrel is never transitively loaded. The real implementations come
// from `@/lib/loop/server` and `@/lib/loop/store` via `vi.importActual`
// on the SPECIFIC subpath modules — those don't pull in cron/ai.
vi.mock("@/lib/loop", async () => {
  const server =
    await vi.importActual<typeof import("@/lib/loop/server")>(
      "@/lib/loop/server",
    );
  const store =
    await vi.importActual<typeof import("@/lib/loop/store")>(
      "@/lib/loop/store",
    );
  return {
    applyDecisionAction: server.applyDecisionAction,
    decisions: store.decisions,
    getDecision: server.getDecision,
    log: store.log,
  };
});

vi.mock("@/lib/env/constants", () => ({
  isTauriMode: () => false,
}));

vi.mock("@/lib/ai/native-agent/provider-env", () => ({
  getConfiguredDefaultAgentProvider: () => "claude",
}));

const userLlmSettings = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/db/queries", () => ({
  getUserLlmApiSettings: vi.fn(async () => userLlmSettings.rows),
}));

// Mutable per-test agent response. The runner POSTs to /api/native/agent
// and parses the SSE stream — we mirror that contract here. Hoisted as
// an object (not a primitive) so each test can swap the `current` field.
const agentResponse = vi.hoisted(() => ({
  current: null as unknown as {
    ok: boolean;
    status?: number;
    text?: string;
    result?: unknown;
    events?: unknown[];
    error?: string;
  },
}));

const fetchSpy = vi.fn(async () => {
  const r = agentResponse.current;
  if (!r || r.ok === false) {
    return new Response(r?.error ?? "stub", { status: r?.status ?? 500 });
  }
  const events: unknown[] = Array.isArray(r.events) ? [...r.events] : [];
  if (r.result !== undefined) {
    events.push({ type: "result", content: r.result });
  }
  if (r.text) events.unshift({ type: "text", content: r.text });
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
});

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  fetchSpy.mockClear();
  // Reset to the "no response" sentinel so a test that forgets to set
  // `agentResponse` surfaces as a transport error, not a stale value.
  // (We deliberately keep the originalFetch restore in afterEach below.)
});

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

const { POST } = await import("@/app/api/loop/decision/[id]/route");
const { decisions } = await import("@/lib/loop/store");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-dec-route-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
  mkdirSync(LOOP_HOME, { recursive: true });
  userLlmSettings.rows = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRequest(url: string, init?: RequestInit) {
  const req = new Request(url, init) as unknown as Parameters<
    typeof POST
  >[0] & {
    nextUrl?: URL;
  };
  try {
    (req as { nextUrl?: URL }).nextUrl = new URL(url);
  } catch {
    /* ignore */
  }
  return req as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/loop/decision/[id] — execution outcome (#358)", () => {
  test("serialises `execution` for an executed decision", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP for tomorrow",
      action: { kind: "calendar_rsvp", params: { eventId: "evt-1" } },
    });
    if (!dec) throw new Error("decision.add returned null");
    agentResponse.current = {
      ok: true,
      result: {
        outcome: "executed",
        reason: "Calendar event created",
        evidence: { eventId: "evt-99" },
      },
    };
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "run" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.execution).toBeDefined();
    expect(body.execution.outcome).toBe("executed");
    expect(body.execution.evidence.eventId).toBe("evt-99");
    expect(body.decision.execution.outcome).toBe("executed");
    expect(body.decision.status).toBe("done");
  });

  test("serialises `execution` for a refused/skipped decision", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — refused",
      action: { kind: "calendar_rsvp", params: { eventId: "evt-2" } },
    });
    if (!dec) throw new Error("decision.add returned null");
    agentResponse.current = {
      ok: true,
      text: "I can't execute this without the user's OAuth consent.",
      result: null,
    };
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "run" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution.outcome).toBe("skipped");
    expect(body.decision.status).toBe("done");
    expect(body.decision.execution.outcome).toBe("skipped");
  });

  test("keeps blocked/failed decisions in pending and surfaces the reason", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — connector fail",
      action: { kind: "calendar_rsvp", params: { eventId: "evt-3" } },
    });
    if (!dec) throw new Error("decision.add returned null");
    agentResponse.current = {
      ok: true,
      result: {
        outcome: "failed",
        reason: "401 unauthorized, please reconnect Google Calendar",
      },
    };
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "run" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    // 400 because the runner reports ok=false for blocked/failed.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("pending");
    expect(body.execution.outcome).toBe("failed");
    expect(body.decision.status).toBe("pending");
    expect(body.decision.context.last_error).toMatch(/401 unauthorized/i);
  });

  test("resurrect action moves a done decision back to pending", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — done then resurrect",
      action: { kind: "calendar_rsvp", params: { eventId: "evt-4" } },
    });
    if (!dec) throw new Error("decision.add returned null");
    // First, drive the decision into `done / skipped`.
    agentResponse.current = {
      ok: true,
      result: { outcome: "skipped", reason: "no consent" },
    };
    const runRes = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "run" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(runRes.status).toBe(200);

    // Now resurrect.
    const resRes = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "resurrect" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(resRes.status).toBe(200);
    const body = await resRes.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.decision.status).toBe("pending");
    expect(body.decision.execution).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // #363 — rsvp_attend / rsvp_decline actions
  // ---------------------------------------------------------------------
  // The runner pre-sets `action.params.response` to the user's intent
  // (`"accepted"` / `"declined"`), then delegates to `runDecision`. The
  // existing #358 verdict pipeline decides status transitions. These
  // tests pin the three behaviours the issue cares about:
  //   1. response is set on the on-disk record before the agent runs;
  //   2. an executed verdict moves the decision to `done`;
  //   3. a not_actionable decision refuses (no external write).

  test("rsvp_attend pre-sets response=accepted and routes through the agent", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — attend",
      action: {
        kind: "calendar_rsvp",
        params: { eventId: "evt-attend-1" },
      },
    });
    if (!dec) throw new Error("decision.add returned null");
    agentResponse.current = {
      ok: true,
      result: {
        outcome: "executed",
        reason: "Calendar event accepted",
        evidence: { eventId: "evt-attend-1" },
      },
    };
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "rsvp_attend" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.execution.outcome).toBe("executed");
    expect(body.decision.status).toBe("done");
    expect(body.decision.action.params.response).toBe("accepted");
  });

  test("rsvp_decline pre-sets response=declined and routes through the agent", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — decline",
      action: {
        kind: "calendar_rsvp",
        params: { eventId: "evt-decline-1" },
      },
    });
    if (!dec) throw new Error("decision.add returned null");
    agentResponse.current = {
      ok: true,
      result: {
        outcome: "executed",
        reason: "Calendar event declined",
        evidence: { eventId: "evt-decline-1" },
      },
    };
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "rsvp_decline" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.execution.outcome).toBe("executed");
    expect(body.decision.status).toBe("done");
    expect(body.decision.action.params.response).toBe("declined");
  });

  test("rsvp_attend on a not_actionable decision refuses without running the agent", async () => {
    // Self-owned event with no other guests → readiness === not_actionable.
    // The runner's existing gate (#359) must keep the agent from being
    // called at all (no fetch) and surface the existing 400 error.
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — self-owned, no guests",
      action: {
        kind: "calendar_rsvp",
        params: {
          eventId: "evt-self",
          organizerIsSelf: true,
          attendeesCount: 0,
          start: "2026-07-17T10:00:00Z",
          organizer: "me",
        },
      },
    });
    if (!dec) throw new Error("decision.add returned null");
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "rsvp_attend" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("pending");
    expect(body.error).toMatch(/not_actionable/i);
    // Crucially, the runner never invoked the agent, so the fetchSpy
    // should not have recorded an agent call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rsvp_attend on a non-RSVP decision refuses with a type error", async () => {
    const dec = decisions.add({
      type: "email_reply",
      title: "Draft a reply",
      action: { kind: "email_reply", params: { to: "sam@example.com" } },
    });
    if (!dec) throw new Error("decision.add returned null");
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "rsvp_attend" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/non-rsvp/i);
  });

  test("rsvp_decline keeps the decision in pending when the agent fails (#358)", async () => {
    const dec = decisions.add({
      type: "rsvp",
      title: "RSVP — decline, agent fails",
      action: {
        kind: "calendar_rsvp",
        params: { eventId: "evt-decline-fail" },
      },
    });
    if (!dec) throw new Error("decision.add returned null");
    agentResponse.current = {
      ok: true,
      result: {
        outcome: "failed",
        reason: "401 unauthorized, please reconnect Google Calendar",
      },
    };
    const res = await POST(
      makeRequest(`http://localhost/api/loop/decision/${dec.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "rsvp_decline" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: dec.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.decision.status).toBe("pending");
    expect(body.execution.outcome).toBe("failed");
    // The user's intent is persisted even when the agent fails so a
    // retry reuses the same response instead of asking again.
    expect(body.decision.action.params.response).toBe("declined");
  });
});
