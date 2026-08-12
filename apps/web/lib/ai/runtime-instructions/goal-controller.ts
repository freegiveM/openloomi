import {
  AgentGoalSchema,
  GoalEvaluationResultSchema,
  RUNTIME_INSTRUCTION_SCHEMA_VERSION,
  RuntimeInstructionSchema,
  formatRuntimeInstruction,
  type AgentGoal,
  type AgentGoalEvaluationStatePort,
  type AgentGoalStatePort,
  type GoalCommandIdentity,
  type GoalEvaluationResult,
  type GoalStatus,
  type RuntimeClockPort,
  type RuntimeIdGeneratorPort,
  type RuntimeInstruction,
  type RuntimeInstructionDraft,
  type RuntimeInstructionTransportPort,
} from "@openloomi/ai/agent/runtime-instructions";

import { createGoalCommandFingerprint } from "./command-fingerprint";
import { GoalEvaluatorError, type GoalEvaluator } from "./goal-evaluator";
import type { RuntimeInstructionDispatcher } from "./instruction-dispatcher";
import { KeyedSerialExecutor } from "./keyed-serial-executor";
import type {
  RuntimeGoalEvaluationJournalPort,
  RuntimeGoalEvaluationSnapshot,
  RuntimeObservationContext,
} from "./runtime-observation";

const CONTROLLER_SOURCE_REF = "openloomi:goal-controller";
const MAX_CACHED_EVALUATIONS = 512;
const MAX_IDENTICAL_CONTINUATIONS = 3;

export interface GoalStopEvaluationInput {
  runEpoch: number;
  assistantTurnId: string;
  turnContext: RuntimeObservationContext | null;
  lastAssistantMessage?: string;
  stopHookActive: boolean;
}

export interface GoalFinalEvaluationInput {
  runEpoch: number;
  evaluationId: string;
  turnContext: RuntimeObservationContext | null;
  runtimeLeaseToken?: string;
}

export type GoalStopDecision =
  | {
      decision: "allow";
      outcome:
        | "no_active_goal"
        | "stale"
        | "completed"
        | "paused"
        | "budget_limited"
        | "expired";
      goalId?: string;
      goalRevision?: number;
    }
  | {
      decision: "block";
      outcome: "continue";
      goalId: string;
      goalRevision: number;
      instruction: RuntimeInstruction;
      reason: string;
    };

export interface GoalFinalEvaluationDecision {
  decision: "allow";
  outcome: "no_active_goal" | "stale" | "completed" | "paused";
  goalId?: string;
  goalRevision?: number;
}

export interface RuntimeGoalStopControllerPort {
  evaluateStop(input: GoalStopEvaluationInput): Promise<GoalStopDecision>;
  finalizeWithoutContinuation(
    input: GoalFinalEvaluationInput,
  ): Promise<GoalFinalEvaluationDecision>;
}

export interface GoalControllerSessionInput {
  ownerId: string;
  runtimeSessionId: string;
  transport: RuntimeInstructionTransportPort;
}

interface ContinuationProgress {
  fingerprint: string;
  count: number;
}

interface RemainingBudget {
  turns?: number;
  tokens?: number;
  durationSeconds?: number;
  deadline?: string;
}

interface BudgetAssessment {
  remaining: RemainingBudget;
  exhausted?: "budget_limited" | "expired";
}

/**
 * Provider-neutral Stop-boundary controller for the in-memory Goal vertical
 * slice. Provider adapters supply the turn identity and inline transport.
 */
export class GoalController {
  private readonly evaluations = new KeyedSerialExecutor();
  private readonly decisions = new Map<string, GoalStopDecision>();
  private readonly continuationProgress = new Map<
    string,
    ContinuationProgress
  >();

  constructor(
    private readonly state: AgentGoalStatePort & AgentGoalEvaluationStatePort,
    private readonly observations: RuntimeGoalEvaluationJournalPort,
    private readonly dispatcher: RuntimeInstructionDispatcher,
    private readonly evaluator: GoalEvaluator,
    private readonly clock: RuntimeClockPort,
    private readonly ids: RuntimeIdGeneratorPort,
  ) {}

  forSession(input: GoalControllerSessionInput): RuntimeGoalStopControllerPort {
    const ownerId = requiredIdentifier(input.ownerId, "ownerId");
    const runtimeSessionId = requiredIdentifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    if (input.transport.runtimeSessionId !== runtimeSessionId) {
      throw new Error("Goal Controller transport belongs to another session");
    }
    return {
      evaluateStop: (stop) =>
        this.evaluations.run(sessionScope(ownerId, runtimeSessionId), () =>
          this.evaluateStopSerialized(
            ownerId,
            runtimeSessionId,
            input.transport,
            stop,
          ),
        ),
      finalizeWithoutContinuation: (evaluation) =>
        this.evaluations.run(sessionScope(ownerId, runtimeSessionId), () =>
          this.finalizeWithoutContinuationSerialized(
            ownerId,
            runtimeSessionId,
            evaluation,
          ),
        ),
    };
  }

  private async finalizeWithoutContinuationSerialized(
    ownerId: string,
    runtimeSessionId: string,
    input: GoalFinalEvaluationInput,
  ): Promise<GoalFinalEvaluationDecision> {
    const runEpoch = nonNegativeInteger(input.runEpoch, "runEpoch");
    const evaluationId = requiredIdentifier(
      input.evaluationId,
      "evaluationId",
    );
    const runtimeLeaseToken =
      input.runtimeLeaseToken === undefined
        ? undefined
        : requiredIdentifier(input.runtimeLeaseToken, "runtimeLeaseToken");
    const active = await this.state.getActivePrimaryGoal(
      ownerId,
      runtimeSessionId,
    );
    if (!active) return { decision: "allow", outcome: "no_active_goal" };

    const authoritativeEpoch = await this.state.getRuntimeSessionRunEpoch(
      ownerId,
      runtimeSessionId,
    );
    if (authoritativeEpoch !== runEpoch) {
      return staleDecision(active.goal);
    }
    const turnContext = validateTurnContext(
      input.turnContext,
      ownerId,
      runtimeSessionId,
      runEpoch,
    );
    if (
      !turnContext ||
      turnContext.goalId !== active.goal.id ||
      turnContext.goalRevision !== active.goal.revision
    ) {
      return turnContext
        ? staleContextDecision(turnContext)
        : staleDecision(active.goal);
    }

    const evaluationKey = createGoalCommandFingerprint({
      runtimeSessionId,
      runEpoch,
      evaluationId,
      goalId: active.goal.id,
      goalRevision: active.goal.revision,
    });
    const cached = this.decisions.get(evaluationKey);
    if (isGoalFinalEvaluationDecision(cached)) {
      return structuredClone(cached);
    }

    const now = this.clock.now();
    const snapshot = await this.observations.beginGoalEvaluation({
      ownerId,
      runtimeSessionId,
      goalId: active.goal.id,
      goalRevision: active.goal.revision,
      runEpoch,
      evaluationKey,
      recordedAt: now.toISOString(),
    });
    if (!snapshot) return staleDecision(active.goal);

    let evaluation: GoalEvaluationResult;
    try {
      evaluation = await this.evaluator.evaluate({
        goal: active.goal,
        run: snapshot.run,
        evidence: snapshot.evidence,
        ...(snapshot.evidenceRevisionFloor === undefined
          ? {}
          : { evidenceRevisionFloor: snapshot.evidenceRevisionFloor }),
      });
    } catch (error) {
      evaluation = evaluatorFailureEvaluation(
        active.goal,
        `Goal evaluation failed: ${errorMessage(error)}`,
        error,
      );
    }

    const terminalEvaluation = GoalEvaluationResultSchema.parse({
      ...evaluation,
      nextInstruction: undefined,
    });
    const decision = await this.commitEvaluationOutcome({
      ownerId,
      runtimeSessionId,
      runEpoch,
      evaluationKey,
      goal: active.goal,
      evaluation: terminalEvaluation,
      status: terminalEvaluation.completed ? "completed" : "paused",
      outcome: terminalEvaluation.completed ? "completed" : "paused",
      now,
      ...(runtimeLeaseToken === undefined ? {} : { runtimeLeaseToken }),
    });
    if (decision.decision !== "allow") {
      throw new Error("A terminal Goal evaluation cannot request continuation");
    }
    if (!isGoalFinalEvaluationDecision(decision)) {
      throw new Error(
        `A terminal Goal evaluation returned unsupported outcome ${decision.outcome}`,
      );
    }
    this.cacheDecision(evaluationKey, decision);
    return decision;
  }

  private async evaluateStopSerialized(
    ownerId: string,
    runtimeSessionId: string,
    transport: RuntimeInstructionTransportPort,
    input: GoalStopEvaluationInput,
  ): Promise<GoalStopDecision> {
    const runEpoch = nonNegativeInteger(input.runEpoch, "runEpoch");
    const assistantTurnId = requiredIdentifier(
      input.assistantTurnId,
      "assistantTurnId",
    );
    const active = await this.state.getActivePrimaryGoal(
      ownerId,
      runtimeSessionId,
    );
    if (!active) return { decision: "allow", outcome: "no_active_goal" };

    const authoritativeEpoch = await this.state.getRuntimeSessionRunEpoch(
      ownerId,
      runtimeSessionId,
    );
    if (authoritativeEpoch !== runEpoch) {
      return staleDecision(active.goal);
    }
    const turnContext = validateTurnContext(
      input.turnContext,
      ownerId,
      runtimeSessionId,
      runEpoch,
    );
    if (
      !turnContext ||
      turnContext.goalId !== active.goal.id ||
      turnContext.goalRevision !== active.goal.revision
    ) {
      return turnContext
        ? staleContextDecision(turnContext)
        : staleDecision(active.goal);
    }

    const evaluationKey = createGoalCommandFingerprint({
      runtimeSessionId,
      runEpoch,
      assistantTurnId,
      goalId: active.goal.id,
      goalRevision: active.goal.revision,
    });
    const cached = this.decisions.get(evaluationKey);
    if (cached) {
      if (cached.decision === "block" && input.stopHookActive) {
        return this.pauseRecursiveStop({
          ownerId,
          runtimeSessionId,
          runEpoch,
          goal: active.goal,
          evaluationKey: `${evaluationKey}:recursion`,
        });
      }
      return structuredClone(cached);
    }

    const startedAt = this.clock.now().toISOString();
    const snapshot = await this.observations.beginGoalEvaluation({
      ownerId,
      runtimeSessionId,
      goalId: active.goal.id,
      goalRevision: active.goal.revision,
      runEpoch,
      evaluationKey,
      recordedAt: startedAt,
    });
    if (!snapshot) return staleDecision(active.goal);

    let evaluation: GoalEvaluationResult;
    try {
      evaluation = await this.evaluator.evaluate({
        goal: active.goal,
        run: snapshot.run,
        evidence: snapshot.evidence,
        ...(snapshot.evidenceRevisionFloor === undefined
          ? {}
          : { evidenceRevisionFloor: snapshot.evidenceRevisionFloor }),
        ...(input.lastAssistantMessage === undefined
          ? {}
          : {
              lastAssistantMessage: input.lastAssistantMessage.slice(0, 16_000),
            }),
      });
    } catch (error) {
      evaluation = evaluatorFailureEvaluation(
        active.goal,
        `Goal evaluation failed: ${errorMessage(error)}`,
        error,
      );
      const decision = await this.commitEvaluationOutcome({
        ownerId,
        runtimeSessionId,
        runEpoch,
        evaluationKey,
        goal: active.goal,
        evaluation,
        status: "paused",
        outcome: "paused",
      });
      return this.cacheDecision(evaluationKey, decision);
    }

    const now = this.clock.now();
    if (evaluation.completed) {
      const decision = await this.commitEvaluationOutcome({
        ownerId,
        runtimeSessionId,
        runEpoch,
        evaluationKey,
        goal: active.goal,
        evaluation,
        status: "completed",
        outcome: "completed",
        now,
      });
      return this.cacheDecision(evaluationKey, decision);
    }

    const budget = assessBudget(active.goal, snapshot, now);
    if (budget.exhausted) {
      const terminalEvaluation = GoalEvaluationResultSchema.parse({
        ...evaluation,
        reason: boundedReason(
          `${budgetTerminationReason(active.goal, snapshot, now, budget.exhausted)}\n${evaluation.reason}`,
        ),
        nextInstruction: undefined,
      });
      const decision = await this.commitEvaluationOutcome({
        ownerId,
        runtimeSessionId,
        runEpoch,
        evaluationKey,
        goal: active.goal,
        evaluation: terminalEvaluation,
        status: budget.exhausted,
        outcome: budget.exhausted,
        now,
      });
      return this.cacheDecision(evaluationKey, decision);
    }

    if (
      active.goal.completionPolicy === "manual" ||
      evaluation.missingCriteria.length === 0 ||
      hasMissingManualCriterion(active.goal, evaluation)
    ) {
      const decision = await this.commitEvaluationOutcome({
        ownerId,
        runtimeSessionId,
        runEpoch,
        evaluationKey,
        goal: active.goal,
        evaluation,
        status: "paused",
        outcome: "paused",
        now,
      });
      return this.cacheDecision(evaluationKey, decision);
    }

    if (this.recordContinuationProgress(active.goal, evaluation)) {
      const guarded = GoalEvaluationResultSchema.parse({
        ...evaluation,
        reason: boundedReason(
          `${evaluation.reason}\nAutomatic continuation stopped after ${MAX_IDENTICAL_CONTINUATIONS} evaluations without new evidence or satisfied criteria.`,
        ),
      });
      const decision = await this.commitEvaluationOutcome({
        ownerId,
        runtimeSessionId,
        runEpoch,
        evaluationKey,
        goal: active.goal,
        evaluation: guarded,
        status: "paused",
        outcome: "paused",
        now,
      });
      return this.cacheDecision(evaluationKey, decision);
    }

    try {
      const continuationEvaluation = withContinuationReason(
        active.goal,
        evaluation,
      );
      const instruction = await this.commitContinuation({
        ownerId,
        runtimeSessionId,
        transport,
        runEpoch,
        evaluationKey,
        goal: active.goal,
        evaluation: continuationEvaluation,
        budget: budget.remaining,
        now,
      });
      const finished = await this.observations.finishGoalEvaluation({
        ownerId,
        runtimeSessionId,
        goalId: active.goal.id,
        goalRevision: active.goal.revision,
        runEpoch,
        evaluationKey,
        evaluation: continuationEvaluation,
        outcome: "continuing",
        recordedAt: now.toISOString(),
      });
      if (!finished) return staleDecision(active.goal);
      const decision: GoalStopDecision = {
        decision: "block",
        outcome: "continue",
        goalId: active.goal.id,
        goalRevision: active.goal.revision,
        instruction,
        reason: formatRuntimeInstruction(instruction),
      };
      return this.cacheDecision(evaluationKey, decision);
    } catch (error) {
      await this.abandonEvaluation({
        ownerId,
        runtimeSessionId,
        runEpoch,
        evaluationKey,
        goal: active.goal,
      });
      throw error;
    }
  }

  private async commitContinuation(input: {
    ownerId: string;
    runtimeSessionId: string;
    transport: RuntimeInstructionTransportPort;
    runEpoch: number;
    evaluationKey: string;
    goal: AgentGoal;
    evaluation: GoalEvaluationResult;
    budget: RemainingBudget;
    now: Date;
  }): Promise<RuntimeInstruction> {
    const missingById = new Map(
      input.goal.successCriteria.map((criterion) => [criterion.id, criterion]),
    );
    const missingCriteria = input.evaluation.missingCriteria.map((id) => {
      const criterion = missingById.get(id);
      if (!criterion?.required) {
        throw new Error(
          `Evaluator returned unknown or optional missing criterion ${id}`,
        );
      }
      return { id, description: criterion.description };
    });
    const payload = {
      missingCriteria,
      reason: input.evaluation.reason,
      remainingBudget: input.budget,
    };
    const idempotencyKey = `goal-eval:${input.evaluationKey}`;
    const command: GoalCommandIdentity = {
      idempotencyKey,
      requestFingerprint: createGoalCommandFingerprint({
        kind: "goal.continue",
        runtimeSessionId: input.runtimeSessionId,
        goalId: input.goal.id,
        goalRevision: input.goal.revision,
        runEpoch: input.runEpoch,
        payload,
      }),
    };
    const instruction = instructionDraft({
      schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
      id: this.ids.generate(),
      goalId: input.goal.id,
      goalRevision: input.goal.revision,
      kind: "goal.continue",
      deliveryMode: "steer",
      targetSessionId: input.runtimeSessionId,
      payload,
      source: {
        type: "automation",
        authority: "automation",
        sourceRef: CONTROLLER_SOURCE_REF,
      },
      idempotencyKey,
      issuedAt: input.now.toISOString(),
    });
    const committed = await this.state.commitContinuation({
      ownerId: input.ownerId,
      runtimeSessionId: input.runtimeSessionId,
      goalId: input.goal.id,
      expectedRevision: input.goal.revision,
      expectedRunEpoch: input.runEpoch,
      instruction,
      command,
    });
    await this.dispatcher.acceptInline({
      ownerId: input.ownerId,
      runtimeSessionId: input.runtimeSessionId,
      targetInstructionId: committed.instruction.id,
      transport: input.transport,
      receipt: {
        instructionId: committed.instruction.id,
        runtimeSessionId: input.runtimeSessionId,
        state: "written_to_sdk",
        recordedAt: input.now.toISOString(),
      },
    });
    return committed.instruction;
  }

  private async commitEvaluationOutcome(input: {
    ownerId: string;
    runtimeSessionId: string;
    runEpoch: number;
    evaluationKey: string;
    goal: AgentGoal;
    evaluation: GoalEvaluationResult;
    status: Extract<
      GoalStatus,
      "paused" | "completed" | "budget_limited" | "expired"
    >;
    outcome: Extract<GoalStopDecision, { decision: "allow" }>["outcome"];
    now?: Date;
    runtimeLeaseToken?: string;
  }): Promise<GoalStopDecision> {
    const now = input.now ?? this.clock.now();
    const goal = AgentGoalSchema.parse({
      ...input.goal,
      revision: input.goal.revision + 1,
      status: input.status,
      updatedAt: now.toISOString(),
    });
    try {
      await this.state.commitEvaluationTransition({
        ownerId: input.ownerId,
        runtimeSessionId: input.runtimeSessionId,
        expectedRevision: input.goal.revision,
        expectedRunEpoch: input.runEpoch,
        goal,
        evaluation: input.evaluation,
        ...(input.runtimeLeaseToken === undefined
          ? {}
          : { runtimeLeaseToken: input.runtimeLeaseToken }),
      });
    } catch {
      await this.abandonEvaluation(input);
      return staleDecision(input.goal);
    }
    const finished = await this.observations.finishGoalEvaluation({
      ownerId: input.ownerId,
      runtimeSessionId: input.runtimeSessionId,
      goalId: input.goal.id,
      goalRevision: input.goal.revision,
      runEpoch: input.runEpoch,
      evaluationKey: input.evaluationKey,
      evaluation: input.evaluation,
      outcome:
        input.status === "completed"
          ? "completed"
          : input.status === "paused"
            ? "paused"
            : "budget_limited",
      recordedAt: now.toISOString(),
    });
    if (!finished) {
      throw new Error(
        `Goal evaluation ${input.evaluationKey} lost its observation lease before finalization`,
      );
    }
    this.continuationProgress.delete(progressKey(input.goal));
    return {
      decision: "allow",
      outcome: input.outcome,
      goalId: input.goal.id,
      goalRevision: goal.revision,
    };
  }

  private async pauseRecursiveStop(input: {
    ownerId: string;
    runtimeSessionId: string;
    runEpoch: number;
    goal: AgentGoal;
    evaluationKey: string;
  }): Promise<GoalStopDecision> {
    const now = this.clock.now().toISOString();
    const snapshot = await this.observations.beginGoalEvaluation({
      ownerId: input.ownerId,
      runtimeSessionId: input.runtimeSessionId,
      goalId: input.goal.id,
      goalRevision: input.goal.revision,
      runEpoch: input.runEpoch,
      evaluationKey: input.evaluationKey,
      recordedAt: now,
    });
    if (!snapshot) return staleDecision(input.goal);
    return this.commitEvaluationOutcome({
      ...input,
      evaluation: failedEvaluation(
        input.goal,
        "Claude invoked the Stop hook again without producing a new assistant turn; automatic continuation was paused to prevent recursion.",
      ),
      status: "paused",
      outcome: "paused",
    });
  }

  private async abandonEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    runEpoch: number;
    evaluationKey: string;
    goal: AgentGoal;
  }): Promise<void> {
    await this.observations.abandonGoalEvaluation({
      ownerId: input.ownerId,
      runtimeSessionId: input.runtimeSessionId,
      goalId: input.goal.id,
      goalRevision: input.goal.revision,
      runEpoch: input.runEpoch,
      evaluationKey: input.evaluationKey,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  private recordContinuationProgress(
    goal: AgentGoal,
    evaluation: GoalEvaluationResult,
  ): boolean {
    const key = progressKey(goal);
    const fingerprint = createGoalCommandFingerprint({
      satisfiedCriteria: evaluation.satisfiedCriteria,
      missingCriteria: evaluation.missingCriteria,
      evidence: evaluation.evidence,
    });
    const previous = this.continuationProgress.get(key);
    const count =
      previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
    this.continuationProgress.set(key, { fingerprint, count });
    return count >= MAX_IDENTICAL_CONTINUATIONS;
  }

  private cacheDecision(
    evaluationKey: string,
    decision: GoalStopDecision,
  ): GoalStopDecision {
    this.decisions.set(evaluationKey, structuredClone(decision));
    while (this.decisions.size > MAX_CACHED_EVALUATIONS) {
      const oldest = this.decisions.keys().next().value;
      if (oldest === undefined) break;
      this.decisions.delete(oldest);
    }
    return decision;
  }
}

function assessBudget(
  goal: AgentGoal,
  snapshot: RuntimeGoalEvaluationSnapshot,
  now: Date,
): BudgetAssessment {
  const remaining: RemainingBudget = {};
  let exhausted: BudgetAssessment["exhausted"];
  if (goal.maxTurns !== undefined) {
    remaining.turns = Math.max(0, goal.maxTurns - snapshot.run.turnsUsed);
    if (remaining.turns === 0) exhausted = "budget_limited";
  }
  if (goal.maxTokens !== undefined) {
    remaining.tokens = Math.max(0, goal.maxTokens - snapshot.run.tokensUsed);
    if (remaining.tokens === 0) exhausted = "budget_limited";
  }
  if (goal.maxDurationSeconds !== undefined) {
    const elapsedMilliseconds = Math.max(
      0,
      now.getTime() - Date.parse(snapshot.run.startedAt),
    );
    remaining.durationSeconds = Math.max(
      0,
      Math.ceil(
        (goal.maxDurationSeconds * 1_000 - elapsedMilliseconds) / 1_000,
      ),
    );
    if (remaining.durationSeconds === 0) exhausted = "budget_limited";
  }
  if (goal.deadline !== undefined) {
    if (Date.parse(goal.deadline) <= now.getTime()) exhausted = "expired";
    else remaining.deadline = goal.deadline;
  }
  return { remaining, ...(exhausted === undefined ? {} : { exhausted }) };
}

function budgetTerminationReason(
  goal: AgentGoal,
  snapshot: RuntimeGoalEvaluationSnapshot,
  now: Date,
  outcome: NonNullable<BudgetAssessment["exhausted"]>,
): string {
  if (outcome === "expired") {
    return `Automatic continuation stopped because the Goal deadline ${goal.deadline ?? ""} has passed.`.trim();
  }

  const exhausted: string[] = [];
  if (
    goal.maxTurns !== undefined &&
    snapshot.run.turnsUsed >= goal.maxTurns
  ) {
    exhausted.push(`maximum turn budget of ${goal.maxTurns}`);
  }
  if (
    goal.maxTokens !== undefined &&
    snapshot.run.tokensUsed >= goal.maxTokens
  ) {
    exhausted.push(`maximum token budget of ${goal.maxTokens}`);
  }
  if (
    goal.maxDurationSeconds !== undefined &&
    now.getTime() - Date.parse(snapshot.run.startedAt) >=
      goal.maxDurationSeconds * 1_000
  ) {
    exhausted.push(
      `maximum duration budget of ${goal.maxDurationSeconds} seconds`,
    );
  }
  const description =
    exhausted.length === 0 ? "execution budget" : exhausted.join(" and ");
  return `Automatic continuation stopped because the ${description} was exhausted.`;
}

function withContinuationReason(
  goal: AgentGoal,
  evaluation: GoalEvaluationResult,
): GoalEvaluationResult {
  const missingCriterionIds = new Set(evaluation.missingCriteria);
  const missingCriteria = goal.successCriteria.filter(
    (criterion) =>
      criterion.required && missingCriterionIds.has(criterion.id),
  );
  return GoalEvaluationResultSchema.parse({
    ...evaluation,
    reason: [
      "Continue working on the active Goal.",
      "Complete the following remaining required success criteria:",
      ...missingCriteria.map(
        (criterion) => `- [${criterion.id}] ${criterion.description}`,
      ),
    ]
      .join("\n")
      .slice(0, 8_000),
    nextInstruction: undefined,
  });
}

function hasMissingManualCriterion(
  goal: AgentGoal,
  evaluation: GoalEvaluationResult,
): boolean {
  const missing = new Set(evaluation.missingCriteria);
  return goal.successCriteria.some(
    (criterion) =>
      criterion.required &&
      missing.has(criterion.id) &&
      criterion.verification.type === "manual",
  );
}

function failedEvaluation(
  goal: AgentGoal,
  reason: string,
): GoalEvaluationResult {
  return GoalEvaluationResultSchema.parse({
    completed: false,
    confidence: 0,
    satisfiedCriteria: [],
    missingCriteria: goal.successCriteria
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.id),
    evidence: [],
    reason: boundedReason(reason),
  });
}

function evaluatorFailureEvaluation(
  goal: AgentGoal,
  reason: string,
  error: unknown,
): GoalEvaluationResult {
  const partial =
    error instanceof GoalEvaluatorError ? error.partialEvaluation : undefined;
  if (!partial) return failedEvaluation(goal, reason);

  const criterionIds = new Set(
    goal.successCriteria.map((criterion) => criterion.id),
  );
  const satisfiedCriteria = partial.satisfiedCriteria.filter((criterionId) =>
    criterionIds.has(criterionId),
  );
  const satisfied = new Set(satisfiedCriteria);
  return GoalEvaluationResultSchema.parse({
    completed: false,
    confidence: 0,
    satisfiedCriteria,
    missingCriteria: goal.successCriteria
      .filter(
        (criterion) => criterion.required && !satisfied.has(criterion.id),
      )
      .map((criterion) => criterion.id),
    evidence: partial.evidence.filter(({ criterionId }) =>
      satisfied.has(criterionId),
    ),
    reason: boundedReason(reason),
  });
}

function staleDecision(goal: AgentGoal): GoalFinalEvaluationDecision {
  return {
    decision: "allow",
    outcome: "stale",
    goalId: goal.id,
    goalRevision: goal.revision,
  };
}

function staleContextDecision(
  context: RuntimeObservationContext,
): GoalFinalEvaluationDecision {
  return {
    decision: "allow",
    outcome: "stale",
    goalId: context.goalId,
    goalRevision: context.goalRevision,
  };
}

function isGoalFinalEvaluationDecision(
  decision: GoalStopDecision | undefined,
): decision is GoalFinalEvaluationDecision {
  return (
    decision?.decision === "allow" &&
    (decision.outcome === "no_active_goal" ||
      decision.outcome === "stale" ||
      decision.outcome === "completed" ||
      decision.outcome === "paused")
  );
}

function validateTurnContext(
  context: RuntimeObservationContext | null,
  ownerId: string,
  runtimeSessionId: string,
  runEpoch: number,
): RuntimeObservationContext | null {
  if (!context) return null;
  if (
    context.ownerId !== ownerId ||
    context.runtimeSessionId !== runtimeSessionId ||
    context.runEpoch !== runEpoch
  ) {
    throw new Error("Stop turn context belongs to another Runtime Session");
  }
  return context;
}

function instructionDraft(
  draft: RuntimeInstructionDraft,
): RuntimeInstructionDraft {
  const parsed = RuntimeInstructionSchema.parse({ ...draft, sequence: 1 });
  const { sequence: _sequence, ...validated } = parsed;
  return validated as RuntimeInstructionDraft;
}

function progressKey(goal: AgentGoal): string {
  return JSON.stringify([goal.id, goal.revision]);
}

function sessionScope(ownerId: string, runtimeSessionId: string): string {
  return JSON.stringify([ownerId, runtimeSessionId]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedReason(reason: string): string {
  const normalized =
    reason.trim() || "Goal evaluation did not produce a reason.";
  return normalized.length <= 8_000
    ? normalized
    : `${normalized.slice(0, 7_980)}...[truncated]`;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    normalized !== value
  ) {
    throw new Error(`${field} must be a bounded identifier`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}
