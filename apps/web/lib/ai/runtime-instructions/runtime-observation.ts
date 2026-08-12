import type {
  AgentGoalRun,
  GoalEvaluationResult,
  GoalEvidence,
  GoalRunStatus,
  GoalEvidenceType,
  RuntimeDeliveryReceipt,
  RuntimeInstruction,
} from "@openloomi/ai/agent/runtime-instructions";

export interface RuntimeEvidenceDraft {
  type: GoalEvidenceType;
  sourceEventId: string;
  summary: string;
  success?: boolean;
  payload: unknown;
  observedAt: string;
}

export interface RuntimeObservationContext {
  ownerId: string;
  runtimeSessionId: string;
  goalRunId: string;
  goalId: string;
  goalRevision: number;
  instructionId: string;
  runEpoch: number;
}

export interface RuntimeUsageDelta {
  tokensUsed: number;
  turnsUsed: number;
}

export interface RuntimeProviderEventObservation {
  ownerId: string;
  runtimeSessionId: string;
  runEpoch: number;
  eventKey: string;
  providerEventId: string;
  providerSessionId?: string;
  observedAt: string;
  terminal?: boolean;
  usage?: RuntimeUsageDelta;
  context?: RuntimeObservationContext;
  acknowledgedContexts?: RuntimeObservationContext[];
  evidence?: RuntimeEvidenceDraft[];
}

export interface RuntimeGoalEvaluationSnapshot {
  run: AgentGoalRun;
  evidence: GoalEvidence[];
  /**
   * Oldest Goal revision whose evidence is still valid for the current Goal
   * definition. Lifecycle-only revisions (pause/resume/evaluation) preserve
   * evidence; goal/context mutations move this boundary forward.
   */
  evidenceRevisionFloor?: number;
}

const EVIDENCE_SCOPE_BOUNDARY_KINDS = new Set<RuntimeInstruction["kind"]>([
  "goal.activate",
  "goal.update",
  "context.upsert",
  "context.remove",
  "constraint.upsert",
  "constraint.remove",
]);

export function isGoalEvidenceRevisionBoundary(
  kind: RuntimeInstruction["kind"],
): boolean {
  return EVIDENCE_SCOPE_BOUNDARY_KINDS.has(kind);
}

/**
 * Resolve the semantic evidence boundary for a Goal revision.
 *
 * Goal revisions also fence lifecycle transitions, so exact-revision
 * filtering would discard valid evidence every time a Goal is paused and
 * resumed. Evidence remains valid until an instruction changes the Goal or
 * its evaluation context. Missing instruction history fails closed to the
 * current revision.
 */
export function resolveGoalEvidenceRevisionFloor(
  goalId: string,
  currentRevision: number,
  instructions: readonly RuntimeInstruction[],
): number {
  let floor: number | undefined;
  for (const instruction of instructions) {
    if (
      instruction.goalId !== goalId ||
      instruction.goalRevision === undefined ||
      instruction.goalRevision > currentRevision ||
      !isGoalEvidenceRevisionBoundary(instruction.kind)
    ) {
      continue;
    }
    floor = Math.max(floor ?? 0, instruction.goalRevision);
  }
  return floor ?? currentRevision;
}

export type RuntimeGoalEvaluationOutcome = Extract<
  GoalRunStatus,
  | "continuing"
  | "paused"
  | "blocked"
  | "completed"
  | "budget_limited"
  | "failed"
>;

export interface RuntimeGoalEvaluationJournalPort {
  beginGoalEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    goalRevision: number;
    runEpoch: number;
    evaluationKey: string;
    recordedAt: string;
  }): Promise<RuntimeGoalEvaluationSnapshot | null>;

  finishGoalEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    goalRevision: number;
    runEpoch: number;
    evaluationKey: string;
    evaluation: GoalEvaluationResult;
    outcome: RuntimeGoalEvaluationOutcome;
    recordedAt: string;
  }): Promise<boolean>;

  abandonGoalEvaluation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    goalRevision: number;
    runEpoch: number;
    evaluationKey: string;
    recordedAt: string;
  }): Promise<boolean>;
}

export interface RuntimeDeliveryJournalPort {
  prepareDelivery(input: {
    ownerId: string;
    instruction: RuntimeInstruction;
  }): Promise<void>;

  recordDeliveryReceipt(input: {
    ownerId: string;
    instruction: RuntimeInstruction;
    receipt: RuntimeDeliveryReceipt;
  }): Promise<void>;

  supersedeDeliveries(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionIds: string[];
    reason: string;
  }): Promise<void>;
}

export interface RuntimeLifecycleObservationPort extends Pick<
  RuntimeDeliveryJournalPort,
  "supersedeDeliveries"
> {
  finalizeControlInstruction(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
    runEpoch: number;
    status: "paused" | "cancelled";
    recordedAt?: string;
  }): Promise<void>;
}

/** Provider-facing observation boundary used by runtime adapters. */
export interface RuntimeProviderObservationPort {
  recordInstructionHandoff(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
    runEpoch: number;
    recordedAt?: string;
  }): Promise<boolean>;

  setProviderSession(input: {
    ownerId: string;
    runtimeSessionId: string;
    providerSessionId: string;
    runEpoch?: number;
  }): Promise<void>;

  captureContext(input: {
    ownerId: string;
    runtimeSessionId: string;
    runEpoch: number;
  }): Promise<RuntimeObservationContext | null>;

  observeProviderEvent(
    input: RuntimeProviderEventObservation,
  ): Promise<boolean>;
}

export interface RuntimeObservationLeaseRegistration {
  release(): void;
}

/**
 * Optional durable ownership fence implemented by persistent journals.
 * Runtime adapters attach the lease that owns their provider process before
 * any provider event or Delivery mutation is recorded.
 */
export interface RuntimeObservationLeaseFencePort {
  attachRuntimeLease(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseToken: string;
  }): RuntimeObservationLeaseRegistration;
}

/** Complete boundary implemented by process-local and future durable journals. */
export interface RuntimeObservationJournalPort
  extends
    RuntimeDeliveryJournalPort,
    RuntimeLifecycleObservationPort,
    RuntimeProviderObservationPort,
    RuntimeGoalEvaluationJournalPort {}

/** Observation recording is best effort and must not undo Goal commands. */
export async function recordRuntimeObservation(
  operation: string,
  record: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await record();
  } catch (error) {
    console.error(`[Agent Goal Runtime] Failed to ${operation}`, error);
  }
}
