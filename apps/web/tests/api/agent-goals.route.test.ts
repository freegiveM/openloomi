import { beforeEach, describe, expect, test, vi } from "vitest";

import { AgentGoalStateError } from "@/lib/ai/runtime-instructions/goal-state-error";
import { RuntimeSessionPersistenceError } from "@/lib/ai/runtime-instructions/runtime-session-persistence";
import {
  AgentGoalApiService,
  type AgentGoalApiDependencies,
} from "@/lib/ai/runtime-instructions/api/service";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  user: { id: "user-a" } as object | null,
}));
const modeState = vi.hoisted(() => ({ tauri: true }));
const apiState = vi.hoisted(() => ({
  service: undefined as unknown as AgentGoalApiService,
}));

vi.mock("@/lib/auth/dual-auth", () => ({
  getAuthUser: vi.fn(async () => authState.user),
}));
vi.mock("@/lib/env/constants", () => ({
  isTauriMode: vi.fn(() => modeState.tauri),
}));
vi.mock("@/lib/ai/runtime-instructions/api/server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/ai/runtime-instructions/api/server")
  >()),
  getAgentGoalApiService: () => apiState.service,
}));

const goalId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const instructionId = "10000000-0000-4000-8000-000000000003";
const runtimeSessionId = "runtime-session-a";
const now = "2026-08-06T08:00:00.000Z";

const persistedGoal = {
  ownerId: "user-a",
  runtimeSessionId,
  slot: "primary" as const,
  goal: {
    id: goalId,
    revision: 1,
    objective: "Complete the frontend",
    successCriteria: [
      {
        id: "build",
        description: "The production build succeeds",
        verification: { type: "model_evidence" as const },
        required: true,
      },
    ],
    constraints: [],
    contextRefs: [],
    priority: 50,
    status: "active" as const,
    maxTurns: 20,
    completionPolicy: "model_evaluator" as const,
    source: { type: "user" as const },
    createdAt: now,
    updatedAt: now,
  },
};

const acceptedCommand = {
  goal: persistedGoal,
  instruction: {
    schemaVersion: "2" as const,
    id: instructionId,
    sequence: 1,
    goalId,
    goalRevision: 1,
    kind: "goal.activate" as const,
    deliveryMode: "steer" as const,
    targetSessionId: runtimeSessionId,
    payload: { goal: persistedGoal.goal },
    source: { type: "user" as const, authority: "user" as const },
    idempotencyKey: "request-1",
    issuedAt: now,
  },
  deduplicated: false,
  dispatch: {
    status: "accepted" as const,
    instructionId,
    receipt: {
      instructionId,
      runtimeSessionId,
      state: "queued" as const,
      recordedAt: now,
    },
  },
};

const goalRun = {
  id: runId,
  ownerId: "user-a",
  goalId,
  goalRevision: 1,
  runtimeSessionId,
  providerSessionId: "private-claude-session",
  runEpoch: 0,
  status: "running" as const,
  turnsUsed: 1,
  tokensUsed: 42,
  startedAt: now,
  lastActivityAt: now,
  lastEvaluation: {
    completed: false,
    confidence: 0.8,
    satisfiedCriteria: [],
    missingCriteria: ["build"],
    evidence: [],
    reason: "The build still needs to run",
    nextInstruction: "private continuation prompt",
  },
};

const goalEvidence = {
  id: "10000000-0000-4000-8000-000000000004",
  goalId,
  goalRunId: runId,
  goalRevision: 1,
  instructionId,
  type: "tool_result" as const,
  sourceEventId: "tool-event-1",
  summary: "The production build succeeded",
  success: true,
  payload: { privateOutput: "not for the UI" },
  observedAt: now,
};

const dependencies = {
  goals: {
    activate: vi.fn(),
    update: vi.fn(),
    upsertContext: vi.fn(),
    removeContext: vi.fn(),
  },
  queries: { listBySession: vi.fn(), getById: vi.fn() },
  liveSessions: { resolve: vi.fn() },
  runtimeSessions: { ensure: vi.fn() },
  sessionOwnership: { isOwnedChat: vi.fn() },
} satisfies AgentGoalApiDependencies;

const goalInput = {
  objective: "Complete the frontend",
  successCriteria: persistedGoal.goal.successCriteria,
  constraints: [
    {
      id: "privacy",
      description: "Keep the change privacy preserving",
    },
  ],
  priority: 50,
  maxTurns: 20,
  completionPolicy: "model_evaluator",
};

const collectionRoute = await import("@/app/api/agent-goals/route");
const goalRoute = await import("@/app/api/agent-goals/[goalId]/route");
const contextRoute =
  await import("@/app/api/agent-goals/[goalId]/context/route");

beforeEach(() => {
  authState.user = { id: "user-a" };
  modeState.tauri = true;
  for (const mock of [
    ...Object.values(dependencies.goals),
    ...Object.values(dependencies.queries),
    dependencies.liveSessions.resolve,
    dependencies.runtimeSessions.ensure,
    dependencies.sessionOwnership.isOwnedChat,
  ]) {
    mock.mockReset();
  }
  dependencies.sessionOwnership.isOwnedChat.mockResolvedValue(true);
  dependencies.liveSessions.resolve.mockResolvedValue({});
  dependencies.runtimeSessions.ensure.mockResolvedValue({});
  dependencies.goals.activate.mockResolvedValue(acceptedCommand);
  dependencies.goals.update.mockResolvedValue(acceptedCommand);
  dependencies.goals.upsertContext.mockResolvedValue(acceptedCommand);
  dependencies.goals.removeContext.mockResolvedValue(acceptedCommand);
  dependencies.queries.listBySession.mockResolvedValue([]);
  dependencies.queries.getById.mockResolvedValue(null);
  apiState.service = new AgentGoalApiService(dependencies);
});

describe("Agent Goal API", () => {
  test("fails closed before reading Goal state", async () => {
    authState.user = null;
    const unauthorized = await collectionRoute.GET(
      request("GET", `/api/agent-goals?runtimeSessionId=${runtimeSessionId}`),
    );
    authState.user = { id: "user-a" };
    modeState.tauri = false;
    const unavailable = await collectionRoute.POST(
      request("POST", "/api/agent-goals", {
        runtimeSessionId,
        goal: goalInput,
      }),
    );

    expect(unauthorized.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(dependencies.sessionOwnership.isOwnedChat).not.toHaveBeenCalled();
    expect(dependencies.goals.activate).not.toHaveBeenCalled();
  });

  test("does not reveal missing or foreign Chats", async () => {
    dependencies.sessionOwnership.isOwnedChat.mockResolvedValue(false);
    const response = await goalRoute.GET(
      request(
        "GET",
        `/api/agent-goals/${goalId}?runtimeSessionId=${runtimeSessionId}`,
      ),
      goalContext(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "runtime_session_not_found",
    });
    expect(dependencies.queries.getById).not.toHaveBeenCalled();
  });

  test("returns UI read models without runtime-private fields", async () => {
    const summary = {
      goal: persistedGoal,
      latestRun: goalRun,
      latestDelivery: {
        instructionId,
        sequence: 1,
        kind: "goal.activate" as const,
        goalRevision: 1,
        state: "observed" as const,
        attempt: 1,
        issuedAt: now,
        updatedAt: now,
      },
      progress: {
        completedCriteria: 0,
        totalCriteria: 1,
        turnsUsed: 1,
        tokensUsed: 42,
        timeUsedSeconds: 0,
      },
    };
    dependencies.queries.listBySession.mockResolvedValue([summary]);
    dependencies.queries.getById.mockResolvedValue({
      ...summary,
      evidence: [goalEvidence],
    });

    const collection = await collectionRoute.GET(
      request("GET", `/api/agent-goals?runtimeSessionId=${runtimeSessionId}`),
    );
    const detail = await goalRoute.GET(
      request(
        "GET",
        `/api/agent-goals/${goalId}?runtimeSessionId=${runtimeSessionId}`,
      ),
      goalContext(),
    );
    const collectionBody = await collection.json();
    const detailBody = await detail.json();

    expect(collection.status).toBe(200);
    expect(collection.headers.get("cache-control")).toBe("no-store");
    expect(collectionBody).toMatchObject({ activeGoalId: goalId, live: true });
    expect(detailBody.goal.ownerId).toBeUndefined();
    expect(detailBody.latestRun.ownerId).toBeUndefined();
    expect(detailBody.latestRun.providerSessionId).toBeUndefined();
    expect(detailBody.latestRun.lastEvaluation.nextInstruction).toBeUndefined();
    expect(detailBody.evidence[0].payload).toBeUndefined();
  });

  test("activates with server-owned provenance and strict input", async () => {
    const accepted = await collectionRoute.POST(
      request("POST", "/api/agent-goals", {
        runtimeSessionId,
        goal: goalInput,
      }),
    );
    const spoofed = await collectionRoute.POST(
      request("POST", "/api/agent-goals", {
        runtimeSessionId,
        ownerId: "other-user",
        goal: { ...goalInput, allowedTools: ["shell"] },
      }),
    );
    const missingKey = await collectionRoute.POST(
      request(
        "POST",
        "/api/agent-goals",
        { runtimeSessionId, goal: goalInput },
        false,
      ),
    );

    expect(accepted.status).toBe(201);
    expect(spoofed.status).toBe(400);
    expect(missingKey.status).toBe(400);
    expect(dependencies.goals.activate).toHaveBeenCalledTimes(1);
    expect(dependencies.runtimeSessions.ensure).toHaveBeenCalledWith(
      "user-a",
      runtimeSessionId,
    );
    expect(dependencies.goals.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-a",
        idempotencyKey: "request-1",
        source: { type: "user", authority: "user" },
        goal: expect.objectContaining({
          contextRefs: [],
          source: { type: "user" },
          constraints: [
            expect.objectContaining({
              id: "privacy",
              enforcement: "model_guidance",
              authority: "user",
            }),
          ],
        }),
      }),
    );
  });

  test("uses idempotent status codes and hides transport errors", async () => {
    dependencies.goals.activate.mockResolvedValueOnce({
      ...acceptedCommand,
      deduplicated: true,
    });
    const retry = await collectionRoute.POST(
      request("POST", "/api/agent-goals", {
        runtimeSessionId,
        goal: goalInput,
      }),
    );
    dependencies.goals.activate.mockResolvedValueOnce({
      ...acceptedCommand,
      dispatch: {
        status: "transport_failed",
        runtimeSessionId,
        instructionId,
        error: new Error("private runtime path"),
      },
    });
    const deferred = await collectionRoute.POST(
      request("POST", "/api/agent-goals", {
        runtimeSessionId,
        goal: goalInput,
      }),
    );
    const deferredBody = await deferred.json();

    expect(retry.status).toBe(200);
    expect(deferred.status).toBe(202);
    expect(deferredBody.dispatch).toEqual({
      status: "transport_failed",
      runtimeSessionId,
      instructionId,
      code: "transport_failed",
    });
    expect(JSON.stringify(deferredBody)).not.toContain("private runtime path");
  });

  test("fails closed when an unfinished SQLite session needs recovery", async () => {
    dependencies.runtimeSessions.ensure.mockRejectedValueOnce(
      new RuntimeSessionPersistenceError(
        "runtime_session_recovery_required",
        "restart recovery is required",
      ),
    );

    const response = await collectionRoute.POST(
      request("POST", "/api/agent-goals", {
        runtimeSessionId,
        goal: goalInput,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "runtime_session_recovery_required",
    });
    expect(dependencies.goals.activate).not.toHaveBeenCalled();
  });

  test("forces user authority on updates and maps revision conflicts", async () => {
    const update = {
      runtimeSessionId,
      expectedRevision: 1,
      update: {
        constraints: [
          { id: "privacy", description: "Do not retain customer data" },
        ],
      },
    };
    const accepted = await goalRoute.PATCH(
      request("PATCH", `/api/agent-goals/${goalId}`, update),
      goalContext(),
    );
    dependencies.goals.update.mockRejectedValueOnce(
      new AgentGoalStateError("revision_conflict", "conflicting revision"),
    );
    const conflict = await goalRoute.PATCH(
      request("PATCH", `/api/agent-goals/${goalId}`, update),
      goalContext(),
    );

    expect(accepted.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(dependencies.goals.update).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          constraints: [
            expect.objectContaining({
              enforcement: "model_guidance",
              authority: "user",
            }),
          ],
        },
      }),
    );
  });

  test("routes context changes with user provenance", async () => {
    const upsert = await contextRoute.PUT(
      request("PUT", `/api/agent-goals/${goalId}/context`, {
        runtimeSessionId,
        expectedRevision: 1,
        contextRef: {
          id: "requirements",
          kind: "document",
          refId: "document-1",
          summary: "Frontend requirements",
        },
      }),
      goalContext(),
    );
    const removal = await contextRoute.DELETE(
      request("DELETE", `/api/agent-goals/${goalId}/context`, {
        runtimeSessionId,
        expectedRevision: 2,
        contextRefId: "requirements",
      }),
      goalContext(),
    );

    expect(upsert.status).toBe(200);
    expect(removal.status).toBe(200);
    expect(dependencies.goals.upsertContext).toHaveBeenCalledWith(
      expect.objectContaining({
        contextRef: expect.objectContaining({ origin: "user" }),
        source: { type: "user", authority: "user" },
      }),
    );
    expect(dependencies.goals.removeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        contextRefId: "requirements",
        source: { type: "user", authority: "user" },
      }),
    );
  });
});

function request(
  method: string,
  path: string,
  body?: unknown,
  withIdempotencyKey = true,
) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (withIdempotencyKey) headers.set("idempotency-key", "request-1");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function goalContext() {
  return { params: Promise.resolve({ goalId }) };
}
