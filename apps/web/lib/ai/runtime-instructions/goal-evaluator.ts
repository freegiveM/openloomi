import {
  GoalEvaluationResultSchema,
  goalStepCompletionMarker,
  type AgentGoal,
  type AgentGoalRun,
  type GoalEvaluationResult,
  type GoalEvidence,
  type GoalSuccessCriterion,
} from "@openloomi/ai/agent/runtime-instructions";

const MAX_EVIDENCE_IDS_PER_CRITERION = 256;
const MAX_REASON_CHARACTERS = 8_000;
const MIN_SEMANTIC_COMPLETION_CONFIDENCE = 0.8;

const SUCCESS_OUTCOMES = new Set([
  "complete",
  "completed",
  "ok",
  "pass",
  "passed",
  "success",
  "succeeded",
]);
const FAILURE_OUTCOMES = new Set([
  "denied",
  "error",
  "fail",
  "failed",
  "failure",
  "rejected",
]);

export type GoalEvaluatorErrorCode =
  | "invalid_evaluation_snapshot"
  | "invalid_semantic_evaluation"
  | "semantic_evaluator_failed"
  | "semantic_evaluator_unavailable";

export class GoalEvaluatorError extends Error {
  constructor(
    public readonly code: GoalEvaluatorErrorCode,
    message: string,
    public readonly cause?: unknown,
    /**
     * Progress that was already proven by the fenced durable snapshot before
     * semantic evaluation failed. Callers may persist this as an incomplete
     * result without inventing or widening evidence associations.
     */
    public readonly partialEvaluation?: GoalEvaluationResult,
  ) {
    super(message);
    this.name = "GoalEvaluatorError";
  }
}

export interface GoalSemanticEvaluationInput {
  goal: AgentGoal;
  run: AgentGoalRun;
  /** Evidence is already fenced to this Goal, Run, and semantic revision. */
  evidence: GoalEvidence[];
  /** Only unresolved, required model-evidence criteria are delegated. */
  criteria: GoalSuccessCriterion[];
  satisfiedCriteria: string[];
  lastAssistantMessage?: string;
}

export interface GoalSemanticEvaluatorPort {
  evaluate(input: GoalSemanticEvaluationInput): Promise<GoalEvaluationResult>;
}

export interface GoalEvaluatorInput {
  goal: AgentGoal;
  run: AgentGoalRun;
  evidence: GoalEvidence[];
  evidenceRevisionFloor?: number;
  lastAssistantMessage?: string;
}

interface CriterionEvaluation {
  criterion: GoalSuccessCriterion;
  evidenceIds: string[];
  satisfied: boolean;
}

/**
 * Ordered Goal-step evaluator.
 *
 * Command and tool criteria are resolved from durable evidence first. Only
 * unresolved, required `model_evidence` criteria can reach the optional
 * semantic evaluator. Manual criteria and a manual completion policy are
 * never completed by this component.
 */
export class GoalEvaluator {
  constructor(private readonly semanticEvaluator?: GoalSemanticEvaluatorPort) {}

  async evaluate(input: GoalEvaluatorInput): Promise<GoalEvaluationResult> {
    assertSnapshot(input);

    const evidenceRevisionFloor =
      input.evidenceRevisionFloor ?? input.goal.revision;
    if (
      !Number.isInteger(evidenceRevisionFloor) ||
      evidenceRevisionFloor < 1 ||
      evidenceRevisionFloor > input.goal.revision
    ) {
      throw new GoalEvaluatorError(
        "invalid_evaluation_snapshot",
        `Goal evidence revision floor ${evidenceRevisionFloor} is invalid for Goal ${input.goal.id} revision ${input.goal.revision}`,
      );
    }
    const evidence = input.evidence.filter(
      (item) =>
        item.goalId === input.goal.id &&
        item.goalRunId === input.run.id &&
        item.goalRevision >= evidenceRevisionFloor &&
        item.goalRevision <= input.goal.revision,
    );
    const availableEvidenceIds = new Set(evidence.map(({ id }) => id));
    const evaluations = enforceOrderedRequiredPrefix(
      input.goal.successCriteria.map((criterion) =>
        restoreSatisfiedModelCriterion(
          evaluateDeterministically(criterion, evidence),
          input.run.lastEvaluation,
          availableEvidenceIds,
        ),
      ),
    );
    const currentStep = evaluations.find(
      (evaluation) => evaluation.criterion.required && !evaluation.satisfied,
    );

    // A manual current step is an explicit human boundary. Later steps do not
    // affect the current boundary because Goal progress is strictly ordered.
    if (
      input.goal.completionPolicy === "manual" ||
      currentStep?.criterion.verification.type === "manual"
    ) {
      return buildResult({
        goal: input.goal,
        evaluations,
        confidence: 1,
        manualApprovalRequired: true,
      });
    }

    // Command and tool steps remain deterministic. Evaluate only the first
    // unfinished required step instead of allowing later work to skip it.
    if (
      currentStep &&
      currentStep.criterion.verification.type !== "model_evidence"
    ) {
      return buildResult({
        goal: input.goal,
        evaluations,
        confidence: 1,
      });
    }

    const semanticCriteria = currentStep ? [currentStep.criterion] : [];
    if (semanticCriteria.length === 0) {
      return buildResult({
        goal: input.goal,
        evaluations,
        confidence: 1,
      });
    }

    if (input.goal.completionPolicy !== "model_evaluator") {
      return buildResult({
        goal: input.goal,
        evaluations,
        confidence: 1,
        semanticReason:
          "Tool-evidence completion policy does not permit model evaluation.",
      });
    }

    const partialEvaluation = buildResult({
      goal: input.goal,
      evaluations,
      confidence: 0,
    });

    if (!this.semanticEvaluator) {
      throw new GoalEvaluatorError(
        "semantic_evaluator_unavailable",
        "Required model-evidence criteria cannot be evaluated because no semantic evaluator is configured",
        undefined,
        partialEvaluation,
      );
    }

    let candidate: GoalEvaluationResult;
    try {
      candidate = await this.semanticEvaluator.evaluate({
        goal: structuredClone(input.goal),
        run: structuredClone(input.run),
        evidence: structuredClone(evidence),
        criteria: structuredClone(semanticCriteria),
        satisfiedCriteria: evaluations
          .filter(({ satisfied }) => satisfied)
          .map(({ criterion }) => criterion.id),
        ...(input.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: input.lastAssistantMessage }),
      });
    } catch (cause) {
      throw new GoalEvaluatorError(
        "semantic_evaluator_failed",
        "The semantic Goal evaluator failed",
        cause,
        partialEvaluation,
      );
    }

    let semantic: GoalEvaluationResult;
    try {
      semantic = validateSemanticEvaluation(
        candidate,
        semanticCriteria,
        evidence,
      );
    } catch (error) {
      if (error instanceof GoalEvaluatorError) {
        throw new GoalEvaluatorError(
          error.code,
          error.message,
          error.cause,
          partialEvaluation,
        );
      }
      throw error;
    }
    const semanticSatisfied = new Set(
      semantic.confidence >= MIN_SEMANTIC_COMPLETION_CONFIDENCE
        ? semantic.satisfiedCriteria
        : [],
    );
    const semanticEvidence = new Map(
      semantic.evidence.map(({ criterionId, evidenceIds }) => [
        criterionId,
        evidenceIds,
      ]),
    );
    const merged = enforceOrderedRequiredPrefix(
      evaluations.map((evaluation) =>
        semanticSatisfied.has(evaluation.criterion.id)
          ? {
              ...evaluation,
              satisfied: true,
              evidenceIds:
                semanticEvidence.get(evaluation.criterion.id) ??
                evaluation.evidenceIds,
            }
          : evaluation,
      ),
    );

    return buildResult({
      goal: input.goal,
      evaluations: merged,
      confidence: semantic.confidence,
      semanticReason:
        semantic.confidence >= MIN_SEMANTIC_COMPLETION_CONFIDENCE
          ? semantic.reason
          : `Semantic evaluation confidence ${semantic.confidence.toFixed(2)} is below the ${MIN_SEMANTIC_COMPLETION_CONFIDENCE.toFixed(2)} completion threshold. ${semantic.reason}`,
    });
  }
}

function assertSnapshot(input: GoalEvaluatorInput): void {
  if (
    input.run.goalId !== input.goal.id ||
    input.run.goalRevision !== input.goal.revision
  ) {
    throw new GoalEvaluatorError(
      "invalid_evaluation_snapshot",
      `Goal Run ${input.run.id} does not belong to Goal ${input.goal.id} revision ${input.goal.revision}`,
    );
  }
}

function evaluateDeterministically(
  criterion: GoalSuccessCriterion,
  evidence: GoalEvidence[],
): CriterionEvaluation {
  if (criterion.verification.type === "agent_report") {
    const evidenceIds = evidence
      .filter(
        (item) =>
          item.type === "agent_report" &&
          item.success !== false &&
          agentReportCompletesStep(item, criterion.id),
      )
      .map(({ id }) => id)
      .slice(0, MAX_EVIDENCE_IDS_PER_CRITERION);
    return { criterion, evidenceIds, satisfied: evidenceIds.length > 0 };
  }

  if (criterion.verification.type === "command_result") {
    const evidenceIds = evidence
      .filter((item) => commandEvidenceMatches(criterion, item))
      .map(({ id }) => id)
      .slice(0, MAX_EVIDENCE_IDS_PER_CRITERION);
    return { criterion, evidenceIds, satisfied: evidenceIds.length > 0 };
  }

  if (criterion.verification.type === "tool_result") {
    const evidenceIds = evidence
      .filter((item) => toolEvidenceMatches(criterion, item))
      .map(({ id }) => id)
      .slice(0, MAX_EVIDENCE_IDS_PER_CRITERION);
    return { criterion, evidenceIds, satisfied: evidenceIds.length > 0 };
  }

  // `model_evidence` is intentionally delegated and `manual` is never
  // inferred from evidence, including a model-generated assertion.
  return { criterion, evidenceIds: [], satisfied: false };
}

function restoreSatisfiedModelCriterion(
  evaluation: CriterionEvaluation,
  previous: GoalEvaluationResult | null | undefined,
  availableEvidenceIds: ReadonlySet<string>,
): CriterionEvaluation {
  // Goal evidence is immutable and criteria are monotonic within one run, just
  // like successful command/tool evidence. Never carry satisfaction across a
  // missing or fenced evidence item.
  if (
    evaluation.satisfied ||
    evaluation.criterion.verification.type !== "model_evidence" ||
    !previous?.satisfiedCriteria.includes(evaluation.criterion.id)
  ) {
    return evaluation;
  }

  const association = previous.evidence.find(
    ({ criterionId }) => criterionId === evaluation.criterion.id,
  );
  const evidenceIds = [...new Set(association?.evidenceIds ?? [])];
  if (
    evidenceIds.length === 0 ||
    evidenceIds.some((id) => !availableEvidenceIds.has(id))
  ) {
    return evaluation;
  }

  return {
    ...evaluation,
    satisfied: true,
    evidenceIds: evidenceIds.slice(0, MAX_EVIDENCE_IDS_PER_CRITERION),
  };
}

function agentReportCompletesStep(
  evidence: GoalEvidence,
  criterionId: string,
): boolean {
  const payload = asRecord(evidence.payload);
  const report = payload?.outputPreview;
  if (typeof report !== "string") return false;
  const marker = goalStepCompletionMarker(criterionId);
  return report.split(/\r?\n/, 1)[0]?.trim() === marker;
}

function enforceOrderedRequiredPrefix(
  evaluations: CriterionEvaluation[],
): CriterionEvaluation[] {
  let requiredStepMissing = false;
  return evaluations.map((evaluation) => {
    if (requiredStepMissing && evaluation.satisfied) {
      return { ...evaluation, satisfied: false, evidenceIds: [] };
    }
    if (evaluation.criterion.required && !evaluation.satisfied) {
      requiredStepMissing = true;
    }
    return evaluation;
  });
}

function commandEvidenceMatches(
  criterion: GoalSuccessCriterion,
  evidence: GoalEvidence,
): boolean {
  if (criterion.verification.type !== "command_result") return false;
  if (evidence.type !== "command_result" && evidence.type !== "test_result") {
    return false;
  }

  const payload = asRecord(evidence.payload);
  const command = payload?.command;
  if (
    criterion.verification.commandPattern !== undefined &&
    (typeof command !== "string" ||
      !command.includes(criterion.verification.commandPattern))
  ) {
    return false;
  }

  const expected = criterion.verification.expectedExitCode;
  const exitCode = payload?.exitCode;
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
    if (exitCode !== expected) return false;
    // Contradictory provider evidence must never satisfy a criterion.
    if (expected === 0 && evidence.success === false) return false;
    if (expected !== 0 && evidence.success === true) return false;
    return true;
  }

  // Claude hooks do not always expose an exit code. A successful command is
  // sufficient evidence for the conventional zero exit code, but a failed
  // command does not reveal which non-zero code it returned.
  return expected === 0 && evidence.success === true;
}

function toolEvidenceMatches(
  criterion: GoalSuccessCriterion,
  evidence: GoalEvidence,
): boolean {
  if (
    criterion.verification.type !== "tool_result" ||
    evidence.type !== "tool_result"
  ) {
    return false;
  }
  const payload = asRecord(evidence.payload);
  const actualToolName = payload?.toolName;
  if (
    typeof actualToolName !== "string" ||
    !toolNamesMatch(criterion.verification.toolName, actualToolName)
  ) {
    return false;
  }

  const expected = normalizeText(criterion.verification.expectedOutcome);
  if (SUCCESS_OUTCOMES.has(expected)) return evidence.success === true;
  if (FAILURE_OUTCOMES.has(expected)) return evidence.success === false;

  const outcomeText = [
    evidence.summary,
    stringField(payload, "outcome"),
    stringField(payload, "outputPreview"),
    stringField(payload, "result"),
    stringField(payload, "status"),
  ]
    .filter((value): value is string => value !== undefined)
    .map(normalizeText);
  return outcomeText.some((value) => value.includes(expected));
}

function validateSemanticEvaluation(
  candidate: GoalEvaluationResult,
  criteria: GoalSuccessCriterion[],
  evidence: GoalEvidence[],
): GoalEvaluationResult {
  const parsed = GoalEvaluationResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw invalidSemanticEvaluation(
      "The semantic evaluator returned an invalid result",
      parsed.error,
    );
  }

  const result = parsed.data;
  const requested = new Set(criteria.map(({ id }) => id));
  const classified = [...result.satisfiedCriteria, ...result.missingCriteria];
  if (
    classified.length !== requested.size ||
    classified.some((criterionId) => !requested.has(criterionId)) ||
    requested.size !== new Set(classified).size
  ) {
    throw invalidSemanticEvaluation(
      "The semantic evaluator must classify every delegated criterion exactly once",
    );
  }
  if (result.completed !== (result.missingCriteria.length === 0)) {
    throw invalidSemanticEvaluation(
      "The semantic evaluator completion flag contradicts its missing criteria",
    );
  }

  const availableEvidence = new Set(evidence.map(({ id }) => id));
  const semanticallySatisfied = new Set(result.satisfiedCriteria);
  const evidenceByCriterion = new Map<string, string[]>();
  const criteriaWithInvalidEvidence = new Set<string>();
  let ignoredEvidenceAssociation = false;
  for (const association of result.evidence) {
    if (
      !requested.has(association.criterionId) ||
      !semanticallySatisfied.has(association.criterionId)
    ) {
      ignoredEvidenceAssociation = true;
      continue;
    }
    if (evidenceByCriterion.has(association.criterionId)) {
      ignoredEvidenceAssociation = true;
      criteriaWithInvalidEvidence.add(association.criterionId);
      continue;
    }

    // Evidence references come from a model and must never widen the
    // controller's authoritative snapshot. Treat a bad citation as an
    // unsatisfied criterion instead of terminating the Goal: the cited data is
    // ignored and a later turn can provide valid, scoped evidence.
    if (
      new Set(association.evidenceIds).size !==
        association.evidenceIds.length ||
      association.evidenceIds.some((id) => !availableEvidence.has(id))
    ) {
      ignoredEvidenceAssociation = true;
      criteriaWithInvalidEvidence.add(association.criterionId);
      continue;
    }
    evidenceByCriterion.set(association.criterionId, association.evidenceIds);
  }
  for (const criterionId of result.satisfiedCriteria) {
    if ((evidenceByCriterion.get(criterionId)?.length ?? 0) === 0) {
      criteriaWithInvalidEvidence.add(criterionId);
    }
  }

  if (
    criteriaWithInvalidEvidence.size === 0 &&
    !ignoredEvidenceAssociation
  ) {
    return result;
  }

  const satisfiedCriteria = result.satisfiedCriteria.filter(
    (criterionId) => !criteriaWithInvalidEvidence.has(criterionId),
  );
  const satisfied = new Set(satisfiedCriteria);
  const missingCriteria = criteria
    .map(({ id }) => id)
    .filter((criterionId) => !satisfied.has(criterionId));
  const downgraded = criteria
    .map(({ id }) => id)
    .filter((criterionId) => criteriaWithInvalidEvidence.has(criterionId));
  const associationReason =
    downgraded.length > 0
      ? `Semantic evidence associations were invalid or outside the delegated snapshot; affected criteria remain unsatisfied: ${downgraded.join(", ")}.`
      : "Invalid semantic evidence associations outside the delegated criteria were ignored.";
  const reason = [result.reason, associationReason]
    .join(" ")
    .slice(0, MAX_REASON_CHARACTERS)
    .trim();

  return GoalEvaluationResultSchema.parse({
    ...result,
    completed: missingCriteria.length === 0,
    satisfiedCriteria,
    missingCriteria,
    evidence: result.evidence.filter(
      ({ criterionId }) =>
        satisfied.has(criterionId) &&
        evidenceByCriterion.has(criterionId),
    ),
    reason,
  });
}

function buildResult(input: {
  goal: AgentGoal;
  evaluations: CriterionEvaluation[];
  confidence: number;
  manualApprovalRequired?: boolean;
  semanticReason?: string;
}): GoalEvaluationResult {
  const satisfiedCriteria = input.evaluations
    .filter(({ satisfied }) => satisfied)
    .map(({ criterion }) => criterion.id);
  const missingCriteria = input.evaluations
    .filter(({ criterion, satisfied }) => criterion.required && !satisfied)
    .map(({ criterion }) => criterion.id);
  const completed =
    !input.manualApprovalRequired && missingCriteria.length === 0;
  const evidence = input.evaluations
    .filter(({ satisfied, evidenceIds }) => satisfied && evidenceIds.length > 0)
    .map(({ criterion, evidenceIds }) => ({
      criterionId: criterion.id,
      evidenceIds,
    }));

  const summary = input.manualApprovalRequired
    ? "Manual approval is required; OpenLoomi will not complete this Goal automatically."
    : completed
      ? "All required execution steps are complete."
      : `Required execution steps remain incomplete: ${missingCriteria.join(", ")}.`;
  const reason = [summary, input.semanticReason]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .slice(0, MAX_REASON_CHARACTERS)
    .trim();

  return GoalEvaluationResultSchema.parse({
    completed,
    confidence: input.confidence,
    satisfiedCriteria,
    missingCriteria,
    evidence,
    reason,
  });
}

function invalidSemanticEvaluation(
  message: string,
  cause?: unknown,
): GoalEvaluatorError {
  return new GoalEvaluatorError("invalid_semantic_evaluation", message, cause);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toolNamesMatch(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeText(expected);
  const normalizedActual = normalizeText(actual);
  return (
    normalizedActual === normalizedExpected ||
    (!normalizedExpected.includes("__") &&
      normalizedActual.endsWith(`__${normalizedExpected}`))
  );
}
