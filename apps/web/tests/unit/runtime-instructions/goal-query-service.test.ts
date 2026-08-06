import type {
  AgentGoalRun,
  GoalEvidence,
  PersistedAgentGoal,
  RuntimeInstruction,
  RuntimeInstructionDelivery,
} from "@openloomi/ai/agent/runtime-instructions";
import { describe, expect, it, vi } from "vitest";

import {
  AgentGoalQueryService,
  type AgentGoalReadSource,
} from "@/lib/ai/runtime-instructions/goal-query-service";

const ownerId = "query-owner";
const runtimeSessionId = "query-session";
const goalId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const instructionId = "10000000-0000-4000-8000-000000000003";
const startedAt = "2026-08-06T08:00:00.000Z";

const goal: PersistedAgentGoal = {
  ownerId,
  runtimeSessionId,
  slot: "primary",
  goal: {
    id: goalId,
    revision: 2,
    objective: "Expose Goal progress to the UI",
    successCriteria: [
      {
        id: "api-ready",
        description: "The Goal API is ready",
        verification: { type: "model_evidence" },
        required: true,
      },
    ],
    constraints: [],
    contextRefs: [],
    priority: 50,
    status: "active",
    completionPolicy: "model_evaluator",
    source: { type: "user" },
    createdAt: startedAt,
    updatedAt: startedAt,
  },
};

const run: AgentGoalRun = {
  id: runId,
  ownerId,
  goalId,
  goalRevision: 2,
  runtimeSessionId,
  runEpoch: 0,
  status: "running",
  turnsUsed: 2,
  tokensUsed: 30,
  startedAt,
  lastActivityAt: startedAt,
  lastEvaluation: {
    completed: false,
    confidence: 0.8,
    satisfiedCriteria: ["api-ready"],
    missingCriteria: [],
    evidence: [],
    reason: "The API is ready for review",
  },
};

const instruction: RuntimeInstruction = {
  schemaVersion: "2",
  id: instructionId,
  sequence: 2,
  goalId,
  goalRevision: 2,
  kind: "goal.update",
  deliveryMode: "steer",
  targetSessionId: runtimeSessionId,
  payload: { goal: goal.goal, previousRevision: 1 },
  source: { type: "user", authority: "user" },
  idempotencyKey: "query-update",
  issuedAt: startedAt,
};

const delivery: RuntimeInstructionDelivery = {
  id: "10000000-0000-4000-8000-000000000004",
  ownerId,
  runtimeSessionId,
  instructionId,
  goalRunId: runId,
  state: "observed",
  attempt: 1,
  createdAt: startedAt,
  updatedAt: startedAt,
};

const evidence: GoalEvidence = {
  id: "10000000-0000-4000-8000-000000000005",
  goalId,
  goalRunId: runId,
  goalRevision: 2,
  instructionId,
  type: "agent_report",
  sourceEventId: "assistant-1",
  summary: "The API is ready",
  payload: {},
  observedAt: startedAt,
};

describe("AgentGoalQueryService", () => {
  it("builds the owner-scoped UI summary and bounded detail view", async () => {
    const source = {
      listGoals: vi.fn(async () => [goal]),
      getGoal: vi.fn(async () => goal),
      listRuns: vi.fn(async () => [run]),
      listInstructions: vi.fn(async () => [instruction]),
      listDeliveries: vi.fn(async () => [delivery]),
      listEvidence: vi.fn(async () => [evidence]),
    } satisfies AgentGoalReadSource;
    const service = new AgentGoalQueryService(source, {
      now: () => new Date("2026-08-06T08:00:10.000Z"),
    });

    const [summary] = await service.listBySession(ownerId, runtimeSessionId);
    const detail = await service.getById({
      ownerId,
      runtimeSessionId,
      goalId,
    });

    expect(summary).toMatchObject({
      latestRun: { id: runId },
      latestDelivery: { instructionId, kind: "goal.update", state: "observed" },
      progress: {
        completedCriteria: 1,
        totalCriteria: 1,
        turnsUsed: 2,
        tokensUsed: 30,
        timeUsedSeconds: 10,
      },
    });
    expect(detail).toMatchObject({
      evidence: [{ id: evidence.id, sourceEventId: "assistant-1" }],
      progress: { lastEvidenceAt: startedAt },
    });
    expect(source.getGoal).toHaveBeenCalledWith(
      ownerId,
      runtimeSessionId,
      goalId,
    );
    expect(source.listEvidence).toHaveBeenCalledWith(
      ownerId,
      runtimeSessionId,
      runId,
      100,
    );
  });
});
