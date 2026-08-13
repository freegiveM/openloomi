import {
  AgentGoalSchema,
  createAgentGoal,
  goalStepCompletionMarker,
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
  it("completes an agent-planned step from the selected Runtime's durable completion marker", async () => {
    const agentGoal = goal([criterion("step-1", { type: "agent_report" })]);
    const semantic = { evaluate: vi.fn() };
    const reportEvidence = evidence(
      "30000000-0000-4000-8000-000000000099",
      agentGoal,
      {
        type: "agent_report",
        summary: "The selected Runtime completed step 1",
        payload: {
          outputPreview: `${goalStepCompletionMarker("step-1")}\nImplemented and verified the requested result.`,
        },
      },
    );

    await expect(
      new GoalEvaluator(semantic).evaluate({
        goal: agentGoal,
        run: run(agentGoal),
        evidence: [reportEvidence],
      }),
    ).resolves.toMatchObject({
      completed: true,
      satisfiedCriteria: ["step-1"],
      missingCriteria: [],
      evidence: [{ criterionId: "step-1", evidenceIds: [reportEvidence.id] }],
    });
    expect(semantic.evaluate).not.toHaveBeenCalled();
  });

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

  it("retains satisfied model criteria across evaluations of the same run", async () => {
    const agentGoal = goal(
      [
        criterion("behavior-a", { type: "model_evidence" }),
        criterion("behavior-b", { type: "model_evidence" }),
      ],
      "model_evaluator",
    );
    const evidenceA = evidence(
      "30000000-0000-4000-8000-000000000010",
      agentGoal,
      {
        type: "test_result",
        success: true,
        summary: "Behavior A passed",
        payload: { assertion: "behavior-a" },
      },
    );
    const evidenceB = evidence(
      "30000000-0000-4000-8000-000000000011",
      agentGoal,
      {
        type: "test_result",
        success: true,
        summary: "Behavior B passed",
        payload: { assertion: "behavior-b" },
      },
    );
    const semantic = {
      evaluate: vi.fn(async () => ({
        completed: true,
        confidence: 0.95,
        satisfiedCriteria: ["behavior-b"],
        missingCriteria: [],
        evidence: [
          {
            criterionId: "behavior-b",
            evidenceIds: [evidenceB.id],
          },
        ],
        reason: "Behavior B is now verified.",
      })),
    } satisfies GoalSemanticEvaluatorPort;
    const evaluator = new GoalEvaluator(semantic);
    const second = await evaluator.evaluate({
      goal: agentGoal,
      run: {
        ...run(agentGoal),
        lastEvaluation: {
          completed: false,
          confidence: 0.95,
          satisfiedCriteria: ["behavior-a"],
          missingCriteria: ["behavior-b"],
          evidence: [
            {
              criterionId: "behavior-a",
              evidenceIds: [evidenceA.id],
            },
          ],
          reason: "Behavior A is verified; behavior B remains.",
        },
      },
      evidence: [evidenceA, evidenceB],
    });

    expect(semantic.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: [expect.objectContaining({ id: "behavior-b" })],
        satisfiedCriteria: ["behavior-a"],
      }),
    );
    expect(second).toMatchObject({
      completed: true,
      satisfiedCriteria: ["behavior-a", "behavior-b"],
      missingCriteria: [],
      evidence: [
        { criterionId: "behavior-a", evidenceIds: [evidenceA.id] },
        { criterionId: "behavior-b", evidenceIds: [evidenceB.id] },
      ],
    });
  });

  it("re-evaluates prior model satisfaction when its evidence is unavailable", async () => {
    const agentGoal = goal(
      [criterion("behavior-correct", { type: "model_evidence" })],
      "model_evaluator",
    );
    const semantic = {
      evaluate: vi.fn(async () => ({
        completed: false,
        confidence: 1,
        satisfiedCriteria: [],
        missingCriteria: ["behavior-correct"],
        evidence: [],
        reason: "The prior evidence is not in the current snapshot.",
      })),
    } satisfies GoalSemanticEvaluatorPort;
    const previous = {
      completed: true,
      confidence: 1,
      satisfiedCriteria: ["behavior-correct"],
      missingCriteria: [],
      evidence: [
        {
          criterionId: "behavior-correct",
          evidenceIds: ["30000000-0000-4000-8000-000000000099"],
        },
      ],
      reason: "Previously satisfied.",
    };

    await new GoalEvaluator(semantic).evaluate({
      goal: agentGoal,
      run: { ...run(agentGoal), lastEvaluation: previous },
      evidence: [],
    });

    expect(semantic.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: [expect.objectContaining({ id: "behavior-correct" })],
        satisfiedCriteria: [],
      }),
    );
  });

  it("fails closed when semantic evaluation is unavailable or throws", async () => {
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
    });
  });

  it("carries already-proven scoped progress when semantic evaluation fails", async () => {
    const agentGoal = goal(
      [
        criterion("tests-pass", {
          type: "command_result",
          expectedExitCode: 0,
        }),
        criterion("behavior-correct", { type: "model_evidence" }),
      ],
      "model_evaluator",
    );
    const commandEvidence = evidence(
      "30000000-0000-4000-8000-000000000023",
      agentGoal,
      {
        type: "test_result",
        success: true,
        summary: "The required command passed",
        payload: { exitCode: 0 },
      },
    );
    const evaluator = new GoalEvaluator({
      evaluate: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });

    await expect(
      evaluator.evaluate({
        goal: agentGoal,
        run: run(agentGoal),
        evidence: [commandEvidence],
      }),
    ).rejects.toMatchObject({
      code: "semantic_evaluator_failed",
      partialEvaluation: {
        completed: false,
        confidence: 0,
        satisfiedCriteria: ["tests-pass"],
        missingCriteria: ["behavior-correct"],
        evidence: [
          { criterionId: "tests-pass", evidenceIds: [commandEvidence.id] },
        ],
        reason: expect.any(String),
      },
    } satisfies Partial<GoalEvaluatorError>);
  });

  it("accepts lifecycle-era evidence within the semantic revision floor only", async () => {
    const created = goal([
      criterion("tests-pass", {
        type: "command_result",
        commandPattern: "vitest",
        expectedExitCode: 0,
      }),
    ]);
    const agentGoal = AgentGoalSchema.parse({
      ...created,
      revision: 5,
      updatedAt: new Date(NOW.getTime() + 4_000).toISOString(),
    });
    const beforeFloor = evidence(
      "30000000-0000-4000-8000-000000000020",
      agentGoal,
      {
        type: "test_result",
        success: true,
        summary: "Test passed before the current semantic scope",
        payload: { command: "pnpm vitest run", exitCode: 0 },
        goalRevision: 2,
      },
    );
    const lifecycleEra = evidence(
      "30000000-0000-4000-8000-000000000021",
      agentGoal,
      {
        type: "test_result",
        success: true,
        summary: "Test passed before a pause and resume",
        payload: { command: "pnpm vitest run", exitCode: 0 },
        goalRevision: 3,
      },
    );
    const future = evidence("30000000-0000-4000-8000-000000000022", agentGoal, {
      type: "test_result",
      success: true,
      summary: "Test belongs to a future Goal revision",
      payload: { command: "pnpm vitest run", exitCode: 0 },
      goalRevision: 6,
    });

    const result = await new GoalEvaluator().evaluate({
      goal: agentGoal,
      run: run(agentGoal),
      evidence: [beforeFloor, lifecycleEra, future],
      evidenceRevisionFloor: 3,
    });

    expect(result).toMatchObject({
      completed: true,
      satisfiedCriteria: ["tests-pass"],
      missingCriteria: [],
      evidence: [{ criterionId: "tests-pass", evidenceIds: [lifecycleEra.id] }],
    });
  });

  it("does not accept a later step before the current semantic step", async () => {
    const agentGoal = goal(
      [
        criterion("behavior-correct", { type: "model_evidence" }),
        criterion("tests-pass", { type: "model_evidence" }),
      ],
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
    const semantic = {
      evaluate: vi.fn(async () => ({
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
      })),
    } satisfies GoalSemanticEvaluatorPort;
    const foreignEvidence = new GoalEvaluator(semantic);
    const result = await foreignEvidence.evaluate({
      goal: agentGoal,
      run: run(agentGoal),
      evidence: [reportEvidence],
    });

    expect(result).toMatchObject({
      completed: false,
      satisfiedCriteria: [],
      missingCriteria: ["behavior-correct", "tests-pass"],
      evidence: [],
    });
    expect(semantic.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: [expect.objectContaining({ id: "behavior-correct" })],
      }),
    );
    expect(result.reason).toContain(
      "affected criteria remain unsatisfied: behavior-correct",
    );
  });

  it("requires one unambiguous scoped evidence association per satisfied criterion", async () => {
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
    const evaluator = new GoalEvaluator({
      evaluate: async () => ({
        completed: true,
        confidence: 1,
        satisfiedCriteria: ["behavior-correct"],
        missingCriteria: [],
        evidence: [
          {
            criterionId: "behavior-correct",
            evidenceIds: [reportEvidence.id],
          },
          {
            criterionId: "behavior-correct",
            evidenceIds: [reportEvidence.id],
          },
        ],
        reason: "The criterion has duplicate evidence associations.",
      }),
    });

    await expect(
      evaluator.evaluate({
        goal: agentGoal,
        run: run(agentGoal),
        evidence: [reportEvidence],
      }),
    ).resolves.toMatchObject({
      completed: false,
      satisfiedCriteria: [],
      missingCriteria: ["behavior-correct"],
      evidence: [],
    });
  });

  it("ignores semantic evidence associated with a missing criterion", async () => {
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
          {
            criterionId: "criterion-outside-delegation",
            evidenceIds: [reportEvidence.id],
          },
        ],
        reason: "A missing criterion must not receive evidence associations.",
      }),
    });
    await expect(
      evidenceForMissingCriterion.evaluate(input),
    ).resolves.toMatchObject({
      completed: false,
      satisfiedCriteria: [],
      missingCriteria: ["behavior-correct"],
      evidence: [],
      reason: expect.stringContaining(
        "Invalid semantic evidence associations outside the delegated criteria were ignored",
      ),
    });
  });
});
