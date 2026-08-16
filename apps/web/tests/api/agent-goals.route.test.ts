import { beforeEach, describe, expect, test, vi } from "vitest";

import { AgentGoalStateError } from "@/lib/ai/runtime-instructions/goal-state-error";
import { RuntimeSessionPersistenceError } from "@/lib/ai/runtime-instructions/runtime-session-persistence";
import {
  AgentGoalApiService,
  type AgentGoalApiDependencies,
} from "@/lib/ai/runtime-instructions/api/service";
import { GoalPlanningError } from "@/lib/ai/runtime-instructions/api/goal-planner-port";

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
    activateResolved: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    update: vi.fn(),
    resume: vi.fn(),
    upsertContext: vi.fn(),
    removeContext: vi.fn(),
  },
  queries: { listBySession: vi.fn(), getById: vi.fn() },
  liveSessions: { resolve: vi.fn() },
  runtimeSessions: { get: vi.fn(), ensure: vi.fn() },
  planner: { plan: vi.fn() },
  resolveNewRuntimeProvider: vi.fn(),
  sessionOwnership: {
    getOwner: vi.fn(),
    ensureOwnedChat: vi.fn(),
    listOwnedChatIds: vi.fn(),
    deleteOwnedChat: vi.fn(),
  },
} satisfies AgentGoalApiDependencies;

const goalInput = { objective: "Complete the frontend" };
const plannedSteps = ["The production build succeeds"];
let resolvedGoalInput: unknown;

function runtimeSession(provider: "claude" | "codex", state = "idle") {
  return {
    id: runtimeSessionId,
    ownerId: "user-a",
    provider,
    state: state as "idle" | "interrupted",
    runEpoch: state === "interrupted" ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
}

const collectionRoute = await import("@/app/api/agent-goals/route");
const activeRoute = await import("@/app/api/agent-goals/active/route");
const goalRoute = await import("@/app/api/agent-goals/[goalId]/route");
const resumeRoute = await import("@/app/api/agent-goals/[goalId]/resume/route");
const pauseRoute = await import("@/app/api/agent-goals/[goalId]/pause/route");
const contextRoute =
  await import("@/app/api/agent-goals/[goalId]/context/route");

function postGoal(extra: Record<string, unknown> = {}, withKey = true) {
  return collectionRoute.POST(
    request(
      "POST",
      "/api/agent-goals",
      { runtimeSessionId, objective: goalInput.objective, ...extra },
      withKey,
    ),
  );
}

beforeEach(() => {
  resolvedGoalInput = undefined;
  authState.user = { id: "user-a" };
  modeState.tauri = true;
  for (const mock of [
    ...Object.values(dependencies.goals),
    ...Object.values(dependencies.queries),
    dependencies.liveSessions.resolve,
    dependencies.runtimeSessions.get,
    dependencies.runtimeSessions.ensure,
    dependencies.planner.plan,
    dependencies.resolveNewRuntimeProvider,
    dependencies.sessionOwnership.getOwner,
    dependencies.sessionOwnership.ensureOwnedChat,
    dependencies.sessionOwnership.listOwnedChatIds,
  ]) {
    mock.mockReset();
  }
  dependencies.sessionOwnership.getOwner.mockResolvedValue("user-a");
  dependencies.sessionOwnership.ensureOwnedChat.mockResolvedValue(true);
  dependencies.sessionOwnership.listOwnedChatIds.mockResolvedValue([
    runtimeSessionId,
  ]);
  dependencies.liveSessions.resolve.mockResolvedValue({});
  dependencies.runtimeSessions.get.mockResolvedValue(null);
  dependencies.runtimeSessions.ensure.mockResolvedValue(
    runtimeSession("claude"),
  );
  dependencies.planner.plan.mockResolvedValue(plannedSteps);
  dependencies.resolveNewRuntimeProvider.mockReturnValue("claude");
  dependencies.goals.activateResolved.mockImplementation(
    async (_input, resolveGoal) => {
      resolvedGoalInput = await resolveGoal();
      return acceptedCommand;
    },
  );
  dependencies.goals.update.mockResolvedValue(acceptedCommand);
  dependencies.goals.pause.mockResolvedValue(acceptedCommand);
  dependencies.goals.cancel.mockResolvedValue(acceptedCommand);
  dependencies.goals.resume.mockResolvedValue(acceptedCommand);
  dependencies.goals.upsertContext.mockResolvedValue(acceptedCommand);
  dependencies.goals.removeContext.mockResolvedValue(acceptedCommand);
  dependencies.sessionOwnership.deleteOwnedChat.mockResolvedValue(undefined);
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
    const unavailable = await postGoal();

    expect(unauthorized.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(dependencies.sessionOwnership.getOwner).not.toHaveBeenCalled();
    expect(dependencies.goals.activateResolved).not.toHaveBeenCalled();
  });

  test("does not reveal missing or foreign Chats", async () => {
    dependencies.sessionOwnership.getOwner.mockResolvedValue(null);
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

  test("lists current Goals across the owner's Chats", async () => {
    const older = {
      goal: {
        ...persistedGoal,
        goal: {
          ...persistedGoal.goal,
          id: "10000000-0000-4000-8000-000000000005",
          status: "paused" as const,
          updatedAt: "2026-08-06T07:00:00.000Z",
        },
      },
      latestRun: null,
      latestDelivery: null,
      progress: {
        completedCriteria: 0,
        totalCriteria: 1,
        turnsUsed: 0,
        tokensUsed: 0,
        timeUsedSeconds: 0,
      },
    };
    const current = {
      ...older,
      goal: {
        ...older.goal,
        runtimeSessionId: "runtime-session-b",
        goal: {
          ...older.goal.goal,
          id: goalId,
          status: "active" as const,
          updatedAt: now,
        },
      },
    };
    const terminal = {
      ...older,
      goal: {
        ...older.goal,
        goal: { ...older.goal.goal, status: "completed" as const },
      },
    };
    dependencies.sessionOwnership.listOwnedChatIds.mockResolvedValue([
      runtimeSessionId,
      "runtime-session-b",
    ]);
    dependencies.queries.listBySession
      .mockResolvedValueOnce([older, terminal])
      .mockResolvedValueOnce([current]);

    const response = await activeRoute.GET(
      request("GET", "/api/agent-goals/active"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      body.goals.map((item: { goal: { id: string } }) => item.goal.id),
    ).toEqual([goalId, older.goal.goal.id]);
    expect(dependencies.queries.listBySession).toHaveBeenCalledTimes(2);
  });

  test("cancels an unfinished Goal before deleting its Chat", async () => {
    dependencies.queries.listBySession.mockResolvedValueOnce([
      {
        goal: persistedGoal,
        latestRun: goalRun,
        latestDelivery: null,
        progress: {
          completedCriteria: 0,
          totalCriteria: 1,
          turnsUsed: 1,
          tokensUsed: 42,
          timeUsedSeconds: 0,
        },
      },
    ]);

    await apiState.service.deleteSession("user-a", runtimeSessionId);

    expect(dependencies.goals.cancel).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId,
      goalId,
      expectedRevision: 1,
      idempotencyKey: `chat-delete:${goalId}:1`,
      source: { type: "user", authority: "user" },
      reason: "The owning chat was deleted",
    });
    expect(
      dependencies.goals.cancel.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dependencies.sessionOwnership.deleteOwnedChat.mock.invocationCallOrder[0],
    );
  });

  test("activates with server-owned provenance and strict input", async () => {
    const accepted = await postGoal();
    const spoofed = await postGoal({
      ownerId: "other-user",
      allowedTools: ["shell"],
    });
    const missingKey = await postGoal({}, false);

    expect(accepted.status).toBe(201);
    expect(spoofed.status).toBe(400);
    expect(missingKey.status).toBe(400);
    expect(dependencies.goals.activateResolved).toHaveBeenCalledTimes(1);
    expect(dependencies.goals.activateResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-a",
        idempotencyKey: "request-1",
        source: { type: "user", authority: "user" },
        idempotencyPayload: { objective: goalInput.objective },
      }),
      expect.any(Function),
    );
    expect(resolvedGoalInput).toEqual({
      objective: goalInput.objective,
      successCriteria: [
        {
          id: "step-1",
          description: "The production build succeeds",
          verification: { type: "agent_report" },
          required: true,
        },
      ],
      constraints: [],
      contextRefs: [],
      priority: 50,
      completionPolicy: "tool_evidence",
      source: { type: "user" },
    });
  });

  test("plans before creating a missing Chat and pins its Runtime", async () => {
    dependencies.sessionOwnership.getOwner.mockResolvedValue(null);
    dependencies.resolveNewRuntimeProvider.mockReturnValue("codex");

    const response = await postGoal();

    expect(response.status).toBe(201);
    expect(dependencies.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex" }),
    );
    expect(dependencies.sessionOwnership.ensureOwnedChat).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId,
      title: goalInput.objective,
    });
    expect(dependencies.runtimeSessions.ensure).toHaveBeenCalledWith(
      "user-a",
      runtimeSessionId,
      { provider: "codex", initialState: "idle" },
    );
    expect(dependencies.planner.plan.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.sessionOwnership.ensureOwnedChat.mock.invocationCallOrder[0],
    );
    expect(
      dependencies.sessionOwnership.ensureOwnedChat.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dependencies.runtimeSessions.ensure.mock.invocationCallOrder[0],
    );
  });

  test("rejects a foreign Chat before planning", async () => {
    dependencies.sessionOwnership.getOwner.mockResolvedValue("other-user");

    const response = await postGoal();

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "runtime_session_not_found",
    });
    expect(dependencies.planner.plan).not.toHaveBeenCalled();
    expect(dependencies.goals.activateResolved).not.toHaveBeenCalled();
    expect(
      dependencies.sessionOwnership.ensureOwnedChat,
    ).not.toHaveBeenCalled();
  });

  test("does not activate when another owner wins Chat creation", async () => {
    dependencies.sessionOwnership.getOwner.mockResolvedValue(null);
    dependencies.sessionOwnership.ensureOwnedChat.mockResolvedValue(false);

    const response = await postGoal();

    expect(response.status).toBe(404);
    expect(dependencies.planner.plan).toHaveBeenCalledOnce();
    expect(dependencies.runtimeSessions.ensure).not.toHaveBeenCalled();
  });

  test("does not recreate an existing Chat deleted while planning", async () => {
    dependencies.sessionOwnership.getOwner
      .mockResolvedValueOnce("user-a")
      .mockResolvedValueOnce(null);

    const response = await postGoal();

    expect(response.status).toBe(404);
    expect(dependencies.planner.plan).toHaveBeenCalledOnce();
    expect(
      dependencies.sessionOwnership.ensureOwnedChat,
    ).not.toHaveBeenCalled();
    expect(dependencies.runtimeSessions.ensure).not.toHaveBeenCalled();
  });

  test("does not expose or recreate a replay whose Chat was deleted", async () => {
    dependencies.sessionOwnership.getOwner.mockResolvedValue(null);
    dependencies.runtimeSessions.get.mockResolvedValue(
      runtimeSession("claude"),
    );
    dependencies.goals.activateResolved.mockResolvedValueOnce({
      ...acceptedCommand,
      deduplicated: true,
    });

    const response = await postGoal();

    expect(response.status).toBe(404);
    expect(dependencies.planner.plan).not.toHaveBeenCalled();
    expect(
      dependencies.sessionOwnership.ensureOwnedChat,
    ).not.toHaveBeenCalled();
    expect(dependencies.goals.activateResolved).not.toHaveBeenCalled();
  });

  test("accepts a replay after a concurrent request creates the Chat", async () => {
    dependencies.sessionOwnership.getOwner
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("user-a");
    dependencies.goals.activateResolved.mockResolvedValueOnce({
      ...acceptedCommand,
      deduplicated: true,
    });

    const response = await postGoal();

    expect(response.status).toBe(200);
    expect(dependencies.planner.plan).not.toHaveBeenCalled();
    expect(
      dependencies.sessionOwnership.ensureOwnedChat,
    ).not.toHaveBeenCalled();
  });

  test("starts a trusted Loop Goal with isolated connector provenance", async () => {
    dependencies.goals.upsertContext.mockResolvedValueOnce({
      ...acceptedCommand,
      goal: {
        ...persistedGoal,
        goal: { ...persistedGoal.goal, revision: 2 },
      },
    });

    const result = await apiState.service.startTrusted({
      ownerId: "user-a",
      runtimeSessionId,
      objective: "Prepare the connector follow-up",
      idempotencyKey: "loop:decision-1",
      sourceId: "decision-1",
      connectorContext: {
        id: "connector-record-1",
        kind: "connector_record",
        refId: "record-1",
        origin: "connector",
        sourceRef: "github:issue-1",
        summary: "Untrusted connector payload",
      },
    });

    expect(result.goal.goal.revision).toBe(2);
    expect(dependencies.goals.activateResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          type: "automation",
          authority: "automation",
          sourceRef: "decision-1",
        },
        idempotencyPayload: {
          objective: "Prepare the connector follow-up",
          source: { type: "loop", id: "decision-1" },
        },
      }),
      expect.any(Function),
    );
    expect(resolvedGoalInput).toMatchObject({
      objective: "Prepare the connector follow-up",
      source: { type: "loop", id: "decision-1" },
    });
    expect(dependencies.goals.upsertContext).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        source: {
          type: "connector",
          authority: "untrusted_data",
          sourceRef: "github:issue-1",
        },
        contextRef: expect.objectContaining({
          origin: "connector",
          sourceRef: "github:issue-1",
        }),
      }),
    );
  });

  test("rejects an invalid trusted source before planning or creating a Chat", async () => {
    await expect(
      apiState.service.startTrusted({
        ownerId: "user-a",
        runtimeSessionId,
        objective: "Prepare the follow-up",
        idempotencyKey: "loop:decision-1",
        sourceId: " ",
      }),
    ).rejects.toMatchObject({ code: "invalid_command" });

    expect(dependencies.planner.plan).not.toHaveBeenCalled();
    expect(
      dependencies.sessionOwnership.ensureOwnedChat,
    ).not.toHaveBeenCalled();
  });

  test("uses the selected provider for a new session and the pinned provider thereafter", async () => {
    dependencies.resolveNewRuntimeProvider.mockReturnValue("codex");
    dependencies.runtimeSessions.ensure.mockResolvedValueOnce(
      runtimeSession("codex"),
    );

    expect((await postGoal()).status).toBe(201);
    expect(dependencies.runtimeSessions.ensure).toHaveBeenCalledWith(
      "user-a",
      runtimeSessionId,
      { provider: "codex", initialState: "idle" },
    );
    expect(dependencies.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex" }),
    );
    dependencies.runtimeSessions.get.mockResolvedValue(
      runtimeSession("claude"),
    );
    dependencies.runtimeSessions.ensure.mockClear();
    dependencies.planner.plan.mockClear();
    dependencies.resolveNewRuntimeProvider.mockClear();

    expect((await postGoal()).status).toBe(201);
    expect(dependencies.runtimeSessions.ensure).toHaveBeenCalledWith(
      "user-a",
      runtimeSessionId,
    );
    expect(dependencies.planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude" }),
    );
    expect(dependencies.resolveNewRuntimeProvider).not.toHaveBeenCalled();
  });

  test("uses idempotent status codes and hides transport errors", async () => {
    dependencies.goals.activateResolved.mockResolvedValueOnce({
      ...acceptedCommand,
      deduplicated: true,
    });
    const retry = await postGoal();
    dependencies.goals.activateResolved.mockResolvedValueOnce({
      ...acceptedCommand,
      dispatch: {
        status: "transport_failed",
        runtimeSessionId,
        instructionId,
        error: new Error("private runtime path"),
      },
    });
    const deferred = await postGoal();
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
    dependencies.runtimeSessions.get.mockResolvedValueOnce(
      runtimeSession("claude", "interrupted"),
    );
    dependencies.runtimeSessions.ensure.mockRejectedValueOnce(
      new RuntimeSessionPersistenceError(
        "runtime_session_recovery_required",
        "restart recovery is required",
      ),
    );

    const response = await postGoal();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "runtime_session_recovery_required",
    });
    expect(dependencies.planner.plan).not.toHaveBeenCalled();
  });

  test("does not activate a partial Goal when planning fails", async () => {
    dependencies.sessionOwnership.getOwner.mockResolvedValueOnce(null);
    dependencies.planner.plan.mockRejectedValueOnce(
      new GoalPlanningError("The selected Runtime did not return a plan"),
    );

    const response = await postGoal();

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "goal_planning_failed",
    });
    expect(dependencies.runtimeSessions.ensure).not.toHaveBeenCalled();
    expect(
      dependencies.sessionOwnership.ensureOwnedChat,
    ).not.toHaveBeenCalled();
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

  test("resumes a paused or blocked Goal without requiring a live Runtime", async () => {
    dependencies.liveSessions.resolve.mockResolvedValueOnce(undefined);
    const response = await resumeRoute.POST(
      request("POST", `/api/agent-goals/${goalId}/resume`, {
        runtimeSessionId,
        expectedRevision: 2,
        reason: "  Continue after resolving the blocker  ",
      }),
      goalContext(),
    );

    expect(response.status).toBe(200);
    expect(dependencies.goals.resume).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId,
      goalId,
      expectedRevision: 2,
      idempotencyKey: "request-1",
      source: { type: "user", authority: "user" },
      reason: "Continue after resolving the blocker",
    });
    expect(dependencies.runtimeSessions.ensure).not.toHaveBeenCalled();
  });

  test("pauses an active Goal through the authenticated lifecycle boundary", async () => {
    const response = await pauseRoute.POST(
      request("POST", `/api/agent-goals/${goalId}/pause`, {
        runtimeSessionId,
        expectedRevision: 1,
        reason: "User requested a pause",
      }),
      goalContext(),
    );

    expect(response.status).toBe(200);
    expect(dependencies.goals.pause).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId,
      goalId,
      expectedRevision: 1,
      idempotencyKey: "request-1",
      source: { type: "user", authority: "user" },
      reason: "User requested a pause",
    });
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
