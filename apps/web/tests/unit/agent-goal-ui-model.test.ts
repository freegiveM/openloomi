import { describe, expect, test } from "vitest";

import type {
  AgentGoalDetailResponse,
  PublicAgentGoal,
  PublicGoalSummary,
} from "@/lib/ai/runtime-instructions/api";
import {
  canCreateNewGoal,
  canResumeGoal,
  createGoalCommandIdempotencyKeys,
  displayGoalStatus,
  goalStepsView,
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
      steps: [
        { state: "current" },
        { state: "pending" },
        { state: "pending" },
      ],
    });
  });

  test("keeps legacy optional criteria independent from required progress", () => {
    const criteria = [
      step("tests"),
      step("optional-review", false),
      step("optional-notes", false),
      step("ship"),
    ];
    const active = goalStepsView(
      detail(criteria, ["tests", "optional-notes"]),
    );

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

  test("reuses idempotency keys until success or input changes", () => {
    let sequence = 0;
    const keys = createGoalCommandIdempotencyKeys(() => `key-${++sequence}`);
    const first = { expectedRevision: 2 };

    expect(keys.keyFor("update", first)).toBe("key-1");
    expect(keys.keyFor("update", first)).toBe("key-1");
    expect(keys.keyFor("update", { expectedRevision: 3 })).toBe("key-2");
    keys.clear("update", { expectedRevision: 3 });
    expect(keys.keyFor("update", { expectedRevision: 3 })).toBe("key-3");
  });
});
