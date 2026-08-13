import type {
  AgentGoalRun,
  DeliveryState,
  GoalEvidence,
  PersistedAgentGoal,
  RuntimeClockPort,
  RuntimeInstruction,
  RuntimeInstructionDelivery,
  RuntimeInstructionKind,
} from "@openloomi/ai/agent/runtime-instructions";

import { resolveGoalEvidenceRevisionFloor } from "./runtime-observation";

const MAX_VISIBLE_EVIDENCE = 100;

export interface AgentGoalProgressView {
  completedCriteria: number;
  totalCriteria: number;
  turnsUsed: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  lastReason?: string;
  lastEvidenceAt?: string;
}

/** Safe delivery projection used by the Goal API and UI. */
export interface AgentGoalDeliveryView {
  instructionId: string;
  sequence: number;
  kind: RuntimeInstructionKind;
  goalRevision?: number;
  state: DeliveryState;
  attempt: number;
  issuedAt: string;
  updatedAt: string;
  errorCode?: string;
}

export interface AgentGoalSummaryView {
  goal: PersistedAgentGoal;
  latestRun: AgentGoalRun | null;
  latestDelivery: AgentGoalDeliveryView | null;
  progress: AgentGoalProgressView;
}

export interface AgentGoalDetailView extends AgentGoalSummaryView {
  evidence: GoalEvidence[];
}

export interface AgentGoalReadSource {
  listGoals(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<PersistedAgentGoal[]>;
  getGoal(
    ownerId: string,
    runtimeSessionId: string,
    goalId: string,
  ): Promise<PersistedAgentGoal | null>;
  listRuns(ownerId: string, runtimeSessionId: string): Promise<AgentGoalRun[]>;
  listInstructions(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<RuntimeInstruction[]>;
  listDeliveries(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<RuntimeInstructionDelivery[]>;
  getEvidence(
    ownerId: string,
    runtimeSessionId: string,
    evidenceId: string,
  ): Promise<GoalEvidence | null>;
  listEvidence(
    ownerId: string,
    runtimeSessionId: string,
    goalRunId: string,
    limit: number,
  ): Promise<GoalEvidence[]>;
}

/** Owner-scoped read model shared by the HTTP API and the upcoming Goal UI. */
export class AgentGoalQueryService {
  constructor(
    private readonly source: AgentGoalReadSource,
    private readonly clock: RuntimeClockPort = { now: () => new Date() },
  ) {}

  async listBySession(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentGoalSummaryView[]> {
    const [goals, runs, instructions, deliveries] = await Promise.all([
      this.source.listGoals(ownerId, runtimeSessionId),
      this.source.listRuns(ownerId, runtimeSessionId),
      this.source.listInstructions(ownerId, runtimeSessionId),
      this.source.listDeliveries(ownerId, runtimeSessionId),
    ]);
    const deliveryIndex = indexLatestDeliveries(instructions, deliveries);
    const now = this.clock.now();
    return goals.map((goal) =>
      summaryFor(
        goal,
        latestRunForGoal(runs, goal.goal.id),
        deliveryIndex.get(goal.goal.id) ?? null,
        [],
        now,
        instructions,
        null,
      ),
    );
  }

  async getById(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
  }): Promise<AgentGoalDetailView | null> {
    const goal = await this.source.getGoal(
      input.ownerId,
      input.runtimeSessionId,
      input.goalId,
    );
    if (!goal) return null;

    const [runs, instructions, deliveries] = await Promise.all([
      this.source.listRuns(input.ownerId, input.runtimeSessionId),
      this.source.listInstructions(input.ownerId, input.runtimeSessionId),
      this.source.listDeliveries(input.ownerId, input.runtimeSessionId),
    ]);

    const latestRun = latestRunForGoal(runs, goal.goal.id);
    const evidence = latestRun
      ? await this.source.listEvidence(
          input.ownerId,
          input.runtimeSessionId,
          latestRun.id,
          MAX_VISIBLE_EVIDENCE,
        )
      : [];
    const evaluationEvidence = latestRun
      ? await loadEvaluationEvidence(
          this.source,
          input.ownerId,
          input.runtimeSessionId,
          latestRun,
          evidence,
        )
      : [];
    const evidenceRevisionFloor = resolveGoalEvidenceRevisionFloor(
      goal.goal.id,
      goal.goal.revision,
      instructions,
    );
    const isCurrentEvidence = (item: GoalEvidence) =>
      item.goalId === goal.goal.id &&
      item.goalRunId === latestRun?.id &&
      item.goalRevision >= evidenceRevisionFloor &&
      item.goalRevision <= goal.goal.revision;
    const scopedEvidence = evidence.filter(isCurrentEvidence);
    const evaluationEvidenceIds = new Set(
      evaluationEvidence
        .filter(isCurrentEvidence)
        .map((item) => item.id),
    );
    return {
      ...summaryFor(
        goal,
        latestRun,
        indexLatestDeliveries(instructions, deliveries).get(goal.goal.id) ??
          null,
        scopedEvidence,
        this.clock.now(),
        instructions,
        evaluationEvidenceIds,
      ),
      evidence: scopedEvidence.map((item) => structuredClone(item)),
    };
  }
}

async function loadEvaluationEvidence(
  source: AgentGoalReadSource,
  ownerId: string,
  runtimeSessionId: string,
  run: AgentGoalRun,
  visibleEvidence: readonly GoalEvidence[],
): Promise<GoalEvidence[]> {
  const evidenceById = new Map(
    visibleEvidence.map((item) => [item.id, item] as const),
  );
  const referencedIds = new Set(
    run.lastEvaluation?.evidence.flatMap(
      (association) => association.evidenceIds,
    ) ?? [],
  );
  const missingIds = [...referencedIds].filter(
    (evidenceId) => !evidenceById.has(evidenceId),
  );
  const missingEvidence = await Promise.all(
    missingIds.map((evidenceId) =>
      source.getEvidence(ownerId, runtimeSessionId, evidenceId),
    ),
  );
  for (const item of missingEvidence) {
    if (item) evidenceById.set(item.id, item);
  }
  return [...evidenceById.values()];
}

function indexLatestDeliveries(
  instructions: readonly RuntimeInstruction[],
  deliveries: readonly RuntimeInstructionDelivery[],
): Map<string, AgentGoalDeliveryView> {
  const latestAttemptByInstruction = new Map<
    string,
    RuntimeInstructionDelivery
  >();
  for (const delivery of deliveries) {
    const current = latestAttemptByInstruction.get(delivery.instructionId);
    if (
      !current ||
      delivery.attempt > current.attempt ||
      (delivery.attempt === current.attempt &&
        delivery.updatedAt > current.updatedAt)
    ) {
      latestAttemptByInstruction.set(delivery.instructionId, delivery);
    }
  }

  const result = new Map<string, AgentGoalDeliveryView>();
  for (const instruction of instructions) {
    if (instruction.goalId === undefined) continue;
    const current = result.get(instruction.goalId);
    if (current && current.sequence >= instruction.sequence) continue;
    const delivery = latestAttemptByInstruction.get(instruction.id);
    if (!delivery) continue;
    result.set(instruction.goalId, {
      instructionId: instruction.id,
      sequence: instruction.sequence,
      kind: instruction.kind,
      ...(instruction.goalRevision === undefined
        ? {}
        : { goalRevision: instruction.goalRevision }),
      state: delivery.state,
      attempt: delivery.attempt,
      issuedAt: instruction.issuedAt,
      updatedAt: delivery.updatedAt,
      ...(delivery.errorCode === undefined
        ? {}
        : { errorCode: delivery.errorCode }),
    });
  }
  return result;
}

function latestRunForGoal(
  runs: readonly AgentGoalRun[],
  goalId: string,
): AgentGoalRun | null {
  return (
    runs
      .filter((run) => run.goalId === goalId)
      .sort((left, right) => {
        if (left.runEpoch !== right.runEpoch) {
          return right.runEpoch - left.runEpoch;
        }
        const started = right.startedAt.localeCompare(left.startedAt);
        return started === 0 ? right.id.localeCompare(left.id) : started;
      })[0] ?? null
  );
}

function summaryFor(
  persistedGoal: PersistedAgentGoal,
  latestRun: AgentGoalRun | null,
  latestDelivery: AgentGoalDeliveryView | null,
  evidence: readonly GoalEvidence[],
  now: Date,
  instructions: readonly RuntimeInstruction[],
  evaluationEvidenceIds: ReadonlySet<string> | null,
): AgentGoalSummaryView {
  const goal = structuredClone(persistedGoal);
  const run = latestRun ? structuredClone(latestRun) : null;
  const evidenceRevisionFloor = resolveGoalEvidenceRevisionFloor(
    goal.goal.id,
    goal.goal.revision,
    instructions,
  );
  const evaluationIsCurrent =
    run !== null && run.goalRevision >= evidenceRevisionFloor;
  const evaluationEvidenceByCriterion = new Map(
    run?.lastEvaluation?.evidence.map((association) => [
      association.criterionId,
      association.evidenceIds,
    ]) ?? [],
  );
  const evaluationEvidenceIsCurrent =
    evaluationEvidenceIds === null ||
    run?.lastEvaluation === undefined ||
    run.lastEvaluation.satisfiedCriteria.every((criterionId) => {
      const evidenceIds = evaluationEvidenceByCriterion.get(criterionId);
      return (
        evidenceIds !== undefined &&
        evidenceIds.length > 0 &&
        evidenceIds.every((evidenceId) =>
          evaluationEvidenceIds.has(evidenceId),
        )
      );
    });
  if (run && (!evaluationIsCurrent || !evaluationEvidenceIsCurrent)) {
    run.lastEvaluation = undefined;
  }
  const satisfied = new Set(run?.lastEvaluation?.satisfiedCriteria ?? []);
  const completedCriteria = goal.goal.successCriteria.filter((criterion) =>
    satisfied.has(criterion.id),
  ).length;
  const lastEvidenceAt = evidence
    .map((item) => item.observedAt)
    .sort((left, right) => right.localeCompare(left))[0];

  return {
    goal,
    latestRun: run,
    latestDelivery: latestDelivery ? structuredClone(latestDelivery) : null,
    progress: {
      completedCriteria,
      totalCriteria: goal.goal.successCriteria.length,
      turnsUsed: run?.turnsUsed ?? 0,
      tokensUsed: run?.tokensUsed ?? 0,
      timeUsedSeconds: run ? elapsedSeconds(run, now) : 0,
      ...(run?.lastEvaluation?.reason === undefined
        ? {}
        : { lastReason: run.lastEvaluation.reason }),
      ...(lastEvidenceAt === undefined ? {} : { lastEvidenceAt }),
    },
  };
}

function elapsedSeconds(run: AgentGoalRun, now: Date): number {
  const start = Date.parse(run.startedAt);
  const terminal = isTerminalRunStatus(run.status);
  const end = Date.parse(
    run.completedAt ?? (terminal ? run.lastActivityAt : now.toISOString()),
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Math.floor((end - start) / 1_000);
}

function isTerminalRunStatus(status: AgentGoalRun["status"]): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "budget_limited" ||
    status === "failed"
  );
}
