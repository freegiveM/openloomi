import type {
  AgentGoalRun,
  GoalEvidence,
  PersistedAgentGoal,
  RuntimeInstruction,
} from "@openloomi/ai/agent/runtime-instructions";

import type {
  AgentGoalCommandCheckpoint,
  AgentGoalCommandPhase,
  AgentGoalCommandType,
  AgentGoalSlotState,
} from "@/lib/db/agent-goal-runtime-schema-types";

import {
  mapAgentGoalRecord,
  mapStoredRuntimeInstructionRecord,
} from "../goal-instruction-mappers";
import { EXACT_PERSISTED_INSTANT_PRECISION } from "../instant-precision";
import { readRequiredInteger, toDatabaseDate } from "../mapping";
import {
  mapAgentGoalRunRecord,
  mapGoalEvidenceRecord,
  mapRuntimeInstructionDeliveryRecord,
} from "../runtime-observation-mappers";

export interface AgentGoalRecordInput {
  readonly persistedGoal: PersistedAgentGoal;
  readonly slotState: AgentGoalSlotState;
}

export function buildAgentGoalRecord(input: AgentGoalRecordInput) {
  const { persistedGoal, slotState } = input;
  const { goal } = persistedGoal;
  const row = {
    id: goal.id,
    ownerId: persistedGoal.ownerId,
    runtimeSessionId: persistedGoal.runtimeSessionId,
    slot: persistedGoal.slot,
    slotState,
    revision: goal.revision,
    objective: goal.objective,
    priority: goal.priority,
    status: goal.status,
    deadline: goal.deadline
      ? toDatabaseDate(goal.deadline, "deadline", "Agent Goal")
      : null,
    maxTurns: goal.maxTurns ?? null,
    maxTokens: goal.maxTokens ?? null,
    maxDurationSeconds: goal.maxDurationSeconds ?? null,
    completionPolicy: goal.completionPolicy,
    sourceType: goal.source.type,
    sourceId: goal.source.id ?? null,
    goalSnapshot: goal,
    createdAt: toDatabaseDate(goal.createdAt, "createdAt", "Agent Goal"),
    updatedAt: toDatabaseDate(goal.updatedAt, "updatedAt", "Agent Goal"),
  };
  mapAgentGoalRecord(row, EXACT_PERSISTED_INSTANT_PRECISION);
  return row;
}

export interface AgentGoalRunRecordInput {
  readonly run: AgentGoalRun;
  readonly recordedAt: string;
}

export function buildAgentGoalRunRecord(input: AgentGoalRunRecordInput) {
  const createdAt = toDatabaseDate(input.recordedAt, "recordedAt", "Goal Run");
  const row = {
    id: input.run.id,
    ownerId: input.run.ownerId,
    runtimeSessionId: input.run.runtimeSessionId,
    goalId: input.run.goalId,
    goalRevision: input.run.goalRevision,
    runEpoch: input.run.runEpoch,
    providerSessionId: input.run.providerSessionId ?? null,
    status: input.run.status,
    turnsUsed: input.run.turnsUsed,
    tokensUsed: input.run.tokensUsed,
    startedAt: toDatabaseDate(input.run.startedAt, "startedAt", "Goal Run"),
    lastActivityAt: toDatabaseDate(
      input.run.lastActivityAt,
      "lastActivityAt",
      "Goal Run",
    ),
    completedAt: input.run.completedAt
      ? toDatabaseDate(input.run.completedAt, "completedAt", "Goal Run")
      : null,
    lastEvaluation: input.run.lastEvaluation ?? null,
    createdAt,
    updatedAt: createdAt,
  };
  mapAgentGoalRunRecord(row);
  return row;
}

export interface RuntimeInstructionRecordInput {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly runEpoch: number;
  readonly instruction: RuntimeInstruction;
  readonly requestFingerprint: string;
  readonly commandOrder: number;
  readonly commandType?: AgentGoalCommandType;
  readonly commandPhase?: AgentGoalCommandPhase;
  readonly commandCheckpoint?: AgentGoalCommandCheckpoint;
  readonly recordedAt: string;
}

export function buildRuntimeInstructionRecord(
  input: RuntimeInstructionRecordInput,
) {
  const recordedAt = toDatabaseDate(
    input.recordedAt,
    "recordedAt",
    "Runtime Instruction",
  );
  const row = {
    id: input.instruction.id,
    ownerId: input.ownerId,
    runtimeSessionId: input.runtimeSessionId,
    schemaVersion: input.instruction.schemaVersion,
    sequence: input.instruction.sequence,
    runEpoch: input.runEpoch,
    goalId: input.instruction.goalId ?? null,
    goalRevision: input.instruction.goalRevision ?? null,
    kind: input.instruction.kind,
    deliveryMode: input.instruction.deliveryMode,
    payload: input.instruction.payload,
    sourceType: input.instruction.source.type,
    sourceAuthority: input.instruction.source.authority,
    sourceRef: input.instruction.source.sourceRef ?? null,
    idempotencyKey: input.instruction.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    commandOrder: input.commandOrder,
    commandType: input.commandType ?? null,
    commandPhase: input.commandPhase ?? null,
    commandCheckpoint: input.commandCheckpoint ?? null,
    instructionSnapshot: input.instruction,
    issuedAt: toDatabaseDate(
      input.instruction.issuedAt,
      "issuedAt",
      "Runtime Instruction",
    ),
    expiresAt: input.instruction.expiresAt
      ? toDatabaseDate(
          input.instruction.expiresAt,
          "expiresAt",
          "Runtime Instruction",
        )
      : null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
  mapStoredRuntimeInstructionRecord(row, EXACT_PERSISTED_INSTANT_PRECISION);
  return row;
}

export interface PendingRuntimeDeliveryRecordInput {
  readonly id: string;
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly instructionId: string;
  readonly goalRunId?: string;
  readonly runEpoch: number;
  readonly attempt?: number;
  readonly availableAt: string;
  readonly recordedAt: string;
}

export function buildPendingRuntimeDeliveryRecord(
  input: PendingRuntimeDeliveryRecordInput,
) {
  const recordedAt = toDatabaseDate(
    input.recordedAt,
    "recordedAt",
    "Runtime Instruction Delivery",
  );
  const row = {
    id: input.id,
    ownerId: input.ownerId,
    runtimeSessionId: input.runtimeSessionId,
    instructionId: input.instructionId,
    goalRunId: input.goalRunId ?? null,
    runEpoch: readRequiredInteger(
      { runEpoch: input.runEpoch },
      "runEpoch",
      "Runtime Instruction Delivery",
      0,
    ),
    state: "pending" as const,
    attempt: input.attempt ?? 1,
    availableAt: toDatabaseDate(
      input.availableAt,
      "availableAt",
      "Runtime Instruction Delivery",
    ),
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    providerEventId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
  mapRuntimeInstructionDeliveryRecord(row);
  return row;
}

export interface AgentGoalEvidenceRecordInput {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly runEpoch: number;
  readonly evidence: GoalEvidence;
  readonly recordedAt: string;
}

export function buildAgentGoalEvidenceRecord(
  input: AgentGoalEvidenceRecordInput,
) {
  const row = {
    id: input.evidence.id,
    ownerId: input.ownerId,
    runtimeSessionId: input.runtimeSessionId,
    goalId: input.evidence.goalId,
    goalRunId: input.evidence.goalRunId,
    instructionId: input.evidence.instructionId ?? null,
    goalRevision: input.evidence.goalRevision,
    runEpoch: input.runEpoch,
    criterionId: input.evidence.criterionId ?? null,
    type: input.evidence.type,
    sourceEventId: input.evidence.sourceEventId,
    summary: input.evidence.summary,
    success: input.evidence.success ?? null,
    payload: input.evidence.payload,
    observedAt: toDatabaseDate(
      input.evidence.observedAt,
      "observedAt",
      "Goal Evidence",
    ),
    createdAt: toDatabaseDate(input.recordedAt, "recordedAt", "Goal Evidence"),
  };
  mapGoalEvidenceRecord(row);
  return row;
}
