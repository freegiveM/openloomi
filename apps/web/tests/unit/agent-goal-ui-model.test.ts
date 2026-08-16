import { describe, expect, test } from "vitest";

import type {
  AgentGoalCommandResponse,
  AgentGoalDetailResponse,
  PublicAgentGoal,
  PublicGoalSummary,
} from "@/lib/ai/runtime-instructions/api";
import {
  activateGoalWithChatFallback,
  canCreateNewGoal,
  canResumeGoal,
  createGoalCommandIdempotencyKeys,
  createGoalStartSingleFlight,
  displayGoalStatus,
  goalStepsView,
  parseGoalCommand,
  resolveGoalComposerSubmission,
  shouldPollGoal,
} from "@/lib/ai/runtime-instructions/goal-ui-model";

const now = "2026-08-06T08:00:00.000Z";
const runId = "10000000-0000-4000-8000-000000000011";

function step(id: string, required = true) {
  return {
    id,
    description: id,
    required,
    verification: { type: "model_evidence" as const },
  };
}

const goal: PublicAgentGoal = {
  id: "10000000-0000-4000-8000-000000000001",
  runtimeSessionId: "chat/a",
  slot: "primary",
  revision: 2,
  objective: "Ship the Goal UI",
  successCriteria: [step("tests")],
  constraints: [],
  contextRefs: [],
  priority: 50,
  status: "active",
  completionPolicy: "model_evaluator",
  source: { type: "user" },
  createdAt: now,
  updatedAt: now,
};

function summary(status: PublicAgentGoal["status"]): PublicGoalSummary {
  return {
    goal: { ...goal, status },
    latestRun: null,
    latestDelivery: null,
    progress: {
      completedCriteria: 0,
      totalCriteria: 1,
      turnsUsed: 3,
      tokensUsed: 400,
      timeUsedSeconds: 20,
    },
  };
}

function detail(
  successCriteria: PublicAgentGoal["successCriteria"],
  satisfied: string[] = [],
  status: PublicAgentGoal["status"] = "active",
): AgentGoalDetailResponse {
  return {
    ...summary(status),
    runtimeSessionId: goal.runtimeSessionId,
    live: status === "active",
    goal: { ...goal, status, successCriteria },
    evidence: satisfied.map((criterionId, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      goalId: goal.id,
      goalRunId: runId,
      goalRevision: goal.revision,
      criterionId,
      type: "evaluation",
      sourceEventId: `evaluation-${index}`,
      summary: `${criterionId} completed`,
      success: true,
      observedAt: now,
    })),
  };
}

describe("Goal UI model", () => {
  test("parses only the exact /goal composer command", () => {
    expect(parseGoalCommand("/goal ship the UI")).toBe("ship the UI");
    expect(parseGoalCommand("  /goal\nship it  ")).toBe("ship it");
    expect(parseGoalCommand("/goal")).toBe("");
    expect(parseGoalCommand("/goalkeeper ship it")).toBeNull();
    expect(parseGoalCommand("please /goal ship it")).toBeNull();
  });

  test("routes bare, objective, attachment, and ordinary composer submits", () => {
    expect(resolveGoalComposerSubmission("/goal", 0)).toEqual({
      kind: "open",
    });
    expect(resolveGoalComposerSubmission("/goal ship it", 0)).toEqual({
      kind: "start",
      objective: "ship it",
    });
    expect(resolveGoalComposerSubmission("/goal ship it", 1)).toEqual({
      kind: "reject_attachments",
    });
    expect(resolveGoalComposerSubmission("/goalkeeper ship it", 1)).toEqual({
      kind: "chat",
    });
  });

  test("only polls active Goals", () => {
    expect(shouldPollGoal(summary("active"))).toBe(true);
    for (const status of ["blocked", "completed", "budget_limited"] as const) {
      expect(shouldPollGoal(summary(status))).toBe(false);
    }
  });

  test("shows all-required plans as a strict completed prefix", () => {
    const criteria = [step("tests"), step("review"), step("ship")];

    expect(goalStepsView(detail(criteria, ["tests", "review"]))).toMatchObject({
      completed: 2,
      total: 3,
      percent: 67,
      steps: [
        { id: "tests", state: "completed" },
        { id: "review", state: "completed" },
        { id: "ship", state: "current" },
      ],
    });
    expect(goalStepsView(detail(criteria, ["ship"]))).toMatchObject({
      completed: 0,
      percent: 0,
      steps: [{ state: "current" }, { state: "pending" }, { state: "pending" }],
    });
  });

  test("keeps legacy optional criteria independent from required progress", () => {
    const criteria = [
      step("tests"),
      step("optional-review", false),
      step("optional-notes", false),
      step("ship"),
    ];
    const active = goalStepsView(detail(criteria, ["tests", "optional-notes"]));

    expect(active).toMatchObject({
      completed: 1,
      total: 2,
      percent: 50,
      steps: [
        { state: "completed" },
        { state: "pending" },
        { state: "completed" },
        { state: "current" },
      ],
    });
    expect(
      goalStepsView(detail(criteria.slice(0, 2), [], "completed")),
    ).toMatchObject({
      completed: 1,
      total: 1,
      percent: 100,
      steps: [{ state: "completed" }, { state: "pending" }],
    });
  });

  test("maps legacy blocked Goals to resumable pauses", () => {
    for (const status of ["paused", "blocked"] as const) {
      expect(canResumeGoal(status)).toBe(true);
    }
    for (const status of ["active", "completed", "expired"] as const) {
      expect(canResumeGoal(status)).toBe(false);
    }
    expect(displayGoalStatus("blocked")).toBe("paused");
    expect(displayGoalStatus("budget_limited")).toBe("budget_limited");
  });

  test("allows a second Goal only after the primary Goal is terminal", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      expect(canCreateNewGoal([summary(status)])).toBe(true);
    }
    for (const status of ["active", "paused"] as const) {
      expect(canCreateNewGoal([summary(status)])).toBe(false);
    }
  });

  test("keeps idempotency keys isolated across concurrent requests", () => {
    let sequence = 0;
    const keys = createGoalCommandIdempotencyKeys(() => `key-${++sequence}`);
    const chatA = { runtimeSessionId: "chat-a", objective: "Ship A" };
    const chatB = { runtimeSessionId: "chat-b", objective: "Ship B" };

    expect(keys.keyFor("activate", chatA)).toBe("key-1");
    expect(keys.keyFor("activate", chatB)).toBe("key-2");
    expect(keys.keyFor("activate", chatA)).toBe("key-1");

    keys.clear("activate", chatB);
    expect(keys.keyFor("activate", chatB)).toBe("key-3");
    expect(keys.keyFor("activate", chatA)).toBe("key-1");
  });

  test("runs the same pending Goal start only once per chat", async () => {
    let resolveStart!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => {
      resolveStart = resolve;
    });
    const starts: string[] = [];
    const pending: Array<string | undefined> = [];
    const singleFlight = createGoalStartSingleFlight<string>();
    const start = () => {
      starts.push("started");
      return deferred;
    };

    const first = singleFlight.run({
      runtimeSessionId: "chat-a",
      objective: "Ship it",
      start,
      onPendingChange: (objective) => pending.push(objective),
    });
    const duplicate = singleFlight.run({
      runtimeSessionId: "chat-a",
      objective: "Ship it",
      start,
    });

    expect(duplicate).toBe(first);
    expect(pending).toEqual(["Ship it"]);
    await Promise.resolve();
    expect(starts).toEqual(["started"]);
    resolveStart("done");
    await expect(first).resolves.toBe("done");
    expect(pending).toEqual(["Ship it", undefined]);
  });

  test("releases planning after activation without waiting for fallback execution", async () => {
    let rejectExecution!: (error: Error) => void;
    const execution = new Promise<void>((_resolve, reject) => {
      rejectExecution = reject;
    });
    const response: AgentGoalCommandResponse = {
      goal,
      instruction: {
        id: "10000000-0000-4000-8000-000000000002",
        sequence: 1,
        kind: "goal.activate",
        goalRevision: goal.revision,
        issuedAt: now,
      },
      deduplicated: false,
      dispatch: {
        status: "unavailable",
        runtimeSessionId: goal.runtimeSessionId,
        instructionId: "10000000-0000-4000-8000-000000000002",
      },
    };
    const pending: Array<string | undefined> = [];
    const failures: unknown[] = [];
    let activations = 0;
    let refreshes = 0;
    let executions = 0;
    const singleFlight =
      createGoalStartSingleFlight<AgentGoalCommandResponse>();
    const start = () =>
      activateGoalWithChatFallback({
        activate: async () => {
          activations += 1;
          return response;
        },
        refresh: () => {
          refreshes += 1;
        },
        startFallback: () => {
          executions += 1;
          return execution;
        },
        onFallbackError: (error) => failures.push(error),
      });

    const first = singleFlight.run({
      runtimeSessionId: goal.runtimeSessionId,
      objective: goal.objective,
      start,
      onPendingChange: (objective) => pending.push(objective),
    });
    const duplicate = singleFlight.run({
      runtimeSessionId: goal.runtimeSessionId,
      objective: goal.objective,
      start,
    });

    expect(duplicate).toBe(first);
    await expect(first).resolves.toBe(response);
    expect({ activations, refreshes, executions }).toEqual({
      activations: 1,
      refreshes: 1,
      executions: 1,
    });
    expect(pending).toEqual([goal.objective, undefined]);

    const executionError = new Error("runtime start failed");
    rejectExecution(executionError);
    await Promise.resolve();
    expect(failures).toEqual([executionError]);
  });

  test("isolates pending Goal starts by chat and releases them after failure", async () => {
    const singleFlight = createGoalStartSingleFlight<string>();
    let rejectA!: (error: Error) => void;
    const startA = new Promise<string>((_resolve, reject) => {
      rejectA = reject;
    });
    const firstA = singleFlight.run({
      runtimeSessionId: "chat-a",
      objective: "Goal A",
      start: () => startA,
    });
    const conflict = new Error("busy");

    await expect(
      singleFlight.run({
        runtimeSessionId: "chat-a",
        objective: "Different Goal",
        start: async () => "unexpected",
        conflictError: () => conflict,
      }),
    ).rejects.toBe(conflict);
    await expect(
      singleFlight.run({
        runtimeSessionId: "chat-b",
        objective: "Goal B",
        start: async () => "done-b",
      }),
    ).resolves.toBe("done-b");

    rejectA(new Error("failed"));
    await expect(firstA).rejects.toThrow("failed");
    await expect(
      singleFlight.run({
        runtimeSessionId: "chat-a",
        objective: "Goal A",
        start: async () => "retried",
      }),
    ).resolves.toBe("retried");
  });
});
