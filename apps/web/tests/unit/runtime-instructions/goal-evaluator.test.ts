import {
  createAgentGoal,
  type AgentGoal,
  type AgentGoalRun,
  type GoalCompletionPolicy,
  type GoalEvidence,
  type GoalSuccessCriterion,
} from "@openloomi/ai/agent/runtime-instructions";
import { describe, expect, it, vi } from "vitest";

import {
  GoalEvaluator,
  type GoalEvaluatorError,
  type GoalSemanticEvaluatorPort,
} from "@/lib/ai/runtime-instructions/goal-evaluator";

const NOW = new Date("2026-08-03T09:00:00.000Z");
const GOAL_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";

function criterion(
  id: string,
  verification: GoalSuccessCriterion["verification"],
  required = true,
): GoalSuccessCriterion {
  return {
    id,
    description: `Satisfy ${id}`,
    verification,
    required,
  };
}

function goal(
  successCriteria: GoalSuccessCriterion[],
  completionPolicy: GoalCompletionPolicy = "tool_evidence",
): AgentGoal {
  return createAgentGoal({
    id: GOAL_ID,
    now: NOW,
    input: {
      objective: "Evaluate the Goal from scoped evidence",
      successCriteria,
      constraints: [],
      contextRefs: [],
      priority: 80,
      maxTurns: 5,
      completionPolicy,
      source: { type: "user" },
    },
  });
}

function run(agentGoal: AgentGoal): AgentGoalRun {
  return {
    id: RUN_ID,
    ownerId: "owner-goal-evaluator",
    goalId: agentGoal.id,
    goalRevision: agentGoal.revision,
    runtimeSessionId: "runtime-goal-evaluator",
    runEpoch: 0,
    status: "running",
    turnsUsed: 1,
    tokensUsed: 100,
    startedAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
  };
}

function evidence(
  id: string,
  agentGoal: AgentGoal,
  input: Pick<GoalEvidence, "type" | "payload" | "summary"> &
    Partial<Pick<GoalEvidence, "criterionId" | "success">> & {
      goalRevision?: number;
    },
): GoalEvidence {
  return {
    id,
    goalId: agentGoal.id,
    goalRunId: RUN_ID,
    goalRevision: input.goalRevision ?? agentGoal.revision,
    type: input.type,
    sourceEventId: `event-${id.slice(-4)}`,
    summary: input.summary,
    ...(input.criterionId === undefined
      ? {}
      : { criterionId: input.criterionId }),
    ...(input.success === undefined ? {} : { success: input.success }),
    payload: input.payload,
    observedAt: NOW.toISOString(),
  };
}

describe("GoalEvaluator", () => {
  it("completes from matching command and tool evidence while optional criteria do not block", async () => {
    const agentGoal = goal([
      criterion("tests-pass", {
        type: "command_result",
        commandPattern: "vitest",
        expectedExitCode: 0,
      }),
      criterion("manifest-loaded", {
        type: "tool_result",
        toolName: "read",
        expectedOutcome: "manifest loaded",
      }),
      criterion("optional-review", { type: "manual" }, false),
    ]);
    const commandEvidence = evidence(
      "30000000-0000-4000-8000-000000000001",
      agentGoal,
      {
        type: "test_result",
        success: true,
        summary: "Test command succeeded",
        payload: { command: "pnpm vitest run" },
      },
    );
    const toolEvidence = evidence(
      "30000000-0000-4000-8000-000000000002",
      agentGoal,
      {
        type: "tool_result",
        success: true,
        summary: "Tool mcp__filesystem__read succeeded",
        payload: {
          toolName: "mcp__filesystem__read",
          outputPreview: "Project manifest loaded successfully",
        },
      },
    );

    const result = await new GoalEvaluator().evaluate({
      goal: agentGoal,
      run: run(agentGoal),
      evidence: [commandEvidence, toolEvidence],
    });

    expect(result).toMatchObject({
      completed: true,
      confidence: 1,
      satisfiedCriteria: ["tests-pass", "manifest-loaded"],
      missingCriteria: [],
    });
    expect(result.evidence).toEqual([
      {
        criterionId: "tests-pass",
        evidenceIds: [commandEvidence.id],
      },
      {
        criterionId: "manifest-loaded",
        evidenceIds: [toolEvidence.id],
      },
    ]);
  });

  it("ignores stale evidence and does not infer a non-zero exit code from failure", async () => {
    const agentGoal = goal([
      criterion("expected-exit", {
        type: "command_result",
        commandPattern: "lint",
        expectedExitCode: 2,
      }),
    ]);

    const result = await new GoalEvaluator().evaluate({
      goal: agentGoal,
      run: run(agentGoal),
      evidence: [
        evidence("30000000-0000-4000-8000-000000000003", agentGoal, {
          type: "command_result",
          success: false,
          summary: "Command failed",
          payload: { command: "pnpm lint" },
        }),
        evidence("30000000-0000-4000-8000-000000000004", agentGoal, {
          type: "command_result",
          success: false,
          summary: "Command failed with the expected exit code",
          payload: { command: "pnpm lint", exitCode: 2 },
          goalRevision: agentGoal.revision + 1,
        }),
      ],
    });

    expect(result).toMatchObject({
      completed: false,
      satisfiedCriteria: [],
      missingCriteria: ["expected-exit"],
    });
  });

  it("never completes manual criteria or a manual completion policy automatically", async () => {
    const semantic = {
      evaluate: vi.fn(),
    } satisfies GoalSemanticEvaluatorPort;
    const manualCriterionGoal = goal(
      [criterion("human-approval", { type: "manual" })],
      "model_evaluator",
    );
    const manualCriterionResult = await new GoalEvaluator(semantic).evaluate({
      goal: manualCriterionGoal,
      run: run(manualCriterionGoal),
      evidence: [
        evidence("30000000-0000-4000-8000-000000000005", manualCriterionGoal, {
          type: "manual_attestation",
          criterionId: "human-approval",
          success: true,
          summary: "An attestation exists",
          payload: { approved: true },
        }),
      ],
    });
    expect(manualCriterionResult).toMatchObject({
      completed: false,
      missingCriteria: ["human-approval"],
    });

    const manualPolicyGoal = goal(
      [
        criterion("command-finished", {
          type: "command_result",
          expectedExitCode: 0,
        }),
      ],
      "manual",
    );
    const manualPolicyResult = await new GoalEvaluator(semantic).evaluate({
      goal: manualPolicyGoal,
      run: run(manualPolicyGoal),
      evidence: [
        evidence("30000000-0000-4000-8000-000000000006", manualPolicyGoal, {
          type: "command_result",
          success: true,
          summary: "Command succeeded",
          payload: { exitCode: 0 },
        }),
      ],
    });
    expect(manualPolicyResult).toMatchObject({
      completed: false,
      satisfiedCriteria: ["command-finished"],
      missingCriteria: [],
    });
    expect(semantic.evaluate).not.toHaveBeenCalled();
  });

  it("does not delegate model criteria under the tool-evidence policy", async () => {
    const semantic = {
      evaluate: vi.fn(),
    } satisfies GoalSemanticEvaluatorPort;
    const agentGoal = goal(
      [criterion("model-only", { type: "model_evidence" })],
      "tool_evidence",
    );

    await expect(
      new GoalEvaluator(semantic).evaluate({
        goal: agentGoal,
        run: run(agentGoal),
        evidence: [],
      }),
    ).resolves.toMatchObject({
      completed: false,
      satisfiedCriteria: [],
      missingCriteria: ["model-only"],
    });
    expect(semantic.evaluate).not.toHaveBeenCalled();
  });

  it("delegates only unresolved required model criteria and validates cited evidence", async () => {
    const agentGoal = goal(
      [
        criterion("tests-pass", {
          type: "command_result",
          expectedExitCode: 0,
        }),
        criterion("behavior-correct", { type: "model_evidence" }),
        criterion("optional-polish", { type: "model_evidence" }, false),
      ],
      "model_evaluator",
    );
    const commandEvidence = evidence(
      "30000000-0000-4000-8000-000000000007",
      agentGoal,
      {
        type: "command_result",
        success: true,
        summary: "Command succeeded",
        payload: { exitCode: 0 },
      },
    );
    const reportEvidence = evidence(
      "30000000-0000-4000-8000-000000000008",
      agentGoal,
      {
        type: "agent_report",
        success: true,
        summary: "The required runtime behavior was observed",
        payload: { report: "behavior correct" },
      },
    );
    const semantic = {
      evaluate: vi.fn(async () => ({
        completed: true,
        confidence: 0.9,
        satisfiedCriteria: ["behavior-correct"],
        missingCriteria: [],
        evidence: [
          {
            criterionId: "behavior-correct",
            evidenceIds: [reportEvidence.id],
          },
        ],
        reason: "The scoped agent report demonstrates the required behavior.",
      })),
    } satisfies GoalSemanticEvaluatorPort;

    const result = await new GoalEvaluator(semantic).evaluate({
      goal: agentGoal,
      run: run(agentGoal),
      evidence: [commandEvidence, reportEvidence],
    });

    expect(semantic.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: [expect.objectContaining({ id: "behavior-correct" })],
        satisfiedCriteria: ["tests-pass"],
      }),
    );
    expect(result).toMatchObject({
      completed: true,
      confidence: 0.9,
      satisfiedCriteria: ["tests-pass", "behavior-correct"],
      missingCriteria: [],
    });

    const lowConfidence = new GoalEvaluator({
      evaluate: async () => ({
        completed: true,
        confidence: 0.79,
        satisfiedCriteria: ["behavior-correct"],
        missingCriteria: [],
        evidence: [
          {
            criterionId: "behavior-correct",
            evidenceIds: [reportEvidence.id],
          },
        ],
        reason: "The evidence is plausible but below the completion threshold.",
      }),
    });
    await expect(
      lowConfidence.evaluate({
        goal: agentGoal,
        run: run(agentGoal),
        evidence: [commandEvidence, reportEvidence],
      }),
    ).resolves.toMatchObject({
      completed: false,
      confidence: 0.79,
      satisfiedCriteria: ["tests-pass"],
      missingCriteria: ["behavior-correct"],
    });
  });

  it("fails closed when semantic evaluation is unavailable, throws, or references foreign evidence", async () => {
    const agentGoal = goal(
      [criterion("behavior-correct", { type: "model_evidence" })],
      "model_evaluator",
    );
    const reportEvidence = evidence(
      "30000000-0000-4000-8000-000000000009",
      agentGoal,
      {
        type: "agent_report",
        success: true,
        summary: "A scoped report",
        payload: {},
      },
    );
    const input = {
      goal: agentGoal,
      run: run(agentGoal),
      evidence: [reportEvidence],
    };

    await expect(new GoalEvaluator().evaluate(input)).rejects.toMatchObject({
      code: "semantic_evaluator_unavailable",
    } satisfies Partial<GoalEvaluatorError>);

    const throwing = new GoalEvaluator({
      evaluate: async () => {
        throw new Error("provider unavailable");
      },
    });
    await expect(throwing.evaluate(input)).rejects.toMatchObject({
      code: "semantic_evaluator_failed",
    } satisfies Partial<GoalEvaluatorError>);

    const foreignEvidence = new GoalEvaluator({
      evaluate: async () => ({
        completed: true,
        confidence: 0.8,
        satisfiedCriteria: ["behavior-correct"],
        missingCriteria: [],
        evidence: [
          {
            criterionId: "behavior-correct",
            evidenceIds: ["40000000-0000-4000-8000-000000000001"],
          },
        ],
        reason: "Referenced evidence is outside the snapshot.",
      }),
    });
    await expect(foreignEvidence.evaluate(input)).rejects.toMatchObject({
      code: "invalid_semantic_evaluation",
    } satisfies Partial<GoalEvaluatorError>);

    const evidenceForMissingCriterion = new GoalEvaluator({
      evaluate: async () => ({
        completed: false,
        confidence: 0.8,
        satisfiedCriteria: [],
        missingCriteria: ["behavior-correct"],
        evidence: [
          {
            criterionId: "behavior-correct",
            evidenceIds: [reportEvidence.id],
          },
        ],
        reason: "A missing criterion must not receive evidence associations.",
      }),
    });
    await expect(
      evidenceForMissingCriterion.evaluate(input),
    ).rejects.toMatchObject({
      code: "invalid_semantic_evaluation",
    } satisfies Partial<GoalEvaluatorError>);
  });
});
