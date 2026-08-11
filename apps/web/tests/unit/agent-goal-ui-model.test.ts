import { describe, expect, test } from "vitest";

import type {
  PublicAgentGoal,
  PublicGoalSummary,
} from "@/lib/ai/runtime-instructions/api";
import {
  blankGoalDraft,
  createGoalCommandIdempotencyKeys,
  goalDraft,
  goalInputFromDraft,
  goalProgressPercent,
  goalUpdateFromDraft,
  shouldPollGoal,
  validateGoalDraft,
} from "@/lib/ai/runtime-instructions/goal-ui-model";

const now = "2026-08-06T08:00:00.000Z";

const goal: PublicAgentGoal = {
  id: "10000000-0000-4000-8000-000000000001",
  runtimeSessionId: "chat/a",
  slot: "primary",
  revision: 2,
  objective: "Ship the Goal UI",
  successCriteria: [
    {
      id: "tests",
      description: "Focused tests pass",
      required: true,
      verification: { type: "model_evidence" },
    },
  ],
  constraints: [
    {
      id: "scope",
      description: "Do not add lifecycle controls",
      enforcement: "model_guidance",
      authority: "user",
    },
  ],
  contextRefs: [],
  priority: 70,
  status: "active",
  maxTurns: 12,
  maxTokens: 10_000,
  maxDurationSeconds: 900,
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
      completedCriteria: 1,
      totalCriteria: 2,
      turnsUsed: 3,
      tokensUsed: 400,
      timeUsedSeconds: 20,
    },
  };
}

describe("Goal UI model", () => {
  test("validates the required objective, criteria, and execution boundary", () => {
    const draft = blankGoalDraft();
    expect(validateGoalDraft(draft)).toBe("objective");

    draft.objective = "Ship it";
    expect(validateGoalDraft(draft)).toBe("criteria");

    firstCriterion(draft).description = "Tests pass";
    draft.maxTurns = "";
    expect(validateGoalDraft(draft)).toBe("budget");

    draft.deadline = "2026-08-07T12:00";
    expect(validateGoalDraft(draft, false)).toBeNull();
  });

  test("builds a safe user Goal payload from the form", () => {
    const draft = blankGoalDraft();
    draft.objective = "  Ship it  ";
    firstCriterion(draft).description = "  Tests pass  ";
    draft.constraints = [{ id: "privacy", description: "  Avoid PII  " }];
    draft.maxTokens = "5000";

    expect(goalInputFromDraft(draft)).toEqual({
      objective: "Ship it",
      successCriteria: [
        {
          id: "criterion-1",
          description: "Tests pass",
          verification: { type: "model_evidence" },
          required: true,
        },
      ],
      constraints: [
        {
          id: "privacy",
          description: "Avoid PII",
          enforcement: "model_guidance",
        },
      ],
      priority: 50,
      maxTurns: 12,
      maxTokens: 5000,
      completionPolicy: "model_evaluator",
    });
  });

  test("preserves server identifiers and makes cleared optional budgets explicit", () => {
    const draft = goalDraft(goal);
    draft.maxTokens = "";
    draft.maxDurationSeconds = "";

    const update = goalUpdateFromDraft(draft);
    expect(update.successCriteria).toBeUndefined();
    expect(update.constraints).toBeUndefined();
    expect(update.maxTokens).toBeNull();
    expect(update.maxDurationSeconds).toBeNull();
    expect(update.maxTurns).toBe(12);
  });

  test("computes progress and only polls non-terminal Goals", () => {
    expect(goalProgressPercent(summary("active"))).toBe(50);
    expect(shouldPollGoal(summary("active"))).toBe(true);
    expect(shouldPollGoal(summary("blocked"))).toBe(false);
    expect(shouldPollGoal(summary("completed"))).toBe(false);
    expect(shouldPollGoal(summary("budget_limited"))).toBe(false);
  });

  test("reuses a command key until success and rotates it when input changes", () => {
    let sequence = 0;
    const keys = createGoalCommandIdempotencyKeys(() => `key-${++sequence}`);
    const first = { expectedRevision: 2, update: { objective: "Ship it" } };

    expect(keys.keyFor("update", first)).toBe("key-1");
    expect(keys.keyFor("update", first)).toBe("key-1");

    const revised = { ...first, expectedRevision: 3 };
    expect(keys.keyFor("update", revised)).toBe("key-2");

    keys.clear("update", revised);
    expect(keys.keyFor("update", revised)).toBe("key-3");
  });
});

function firstCriterion(draft: ReturnType<typeof blankGoalDraft>) {
  const criterion = draft.criteria[0];
  if (!criterion) throw new Error("Expected the default success criterion");
  return criterion;
}
