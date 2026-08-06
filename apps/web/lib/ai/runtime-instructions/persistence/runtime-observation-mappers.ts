import {
  DeliveryStateSchema,
  GoalEvaluationResultSchema,
  GoalEvidenceSchema,
  GoalRunStatusSchema,
  RuntimeProviderSchema,
  RuntimeSessionStateSchema,
  type AgentGoalRun,
  type AgentRuntimeSession,
  type GoalEvidence,
  type RuntimeInstructionDelivery,
} from "@openloomi/ai/agent/runtime-instructions";

import { invalidPersistenceRecord } from "./errors";
import {
  asPersistenceRecord,
  assertChronological,
  normalizeOptionalPersistedDate,
  normalizePersistedDate,
  parsePersistedSchema,
  readOptionalBoolean,
  readOptionalString,
  readOptionalText,
  readOptionalUuid,
  readRequiredInteger,
  readRequiredString,
  readRequiredUuid,
} from "./mapping";
import { isTerminalGoalRunStatus } from "./goal-run-state";

const SESSION_ENTITY = "Runtime Session";
const RUN_ENTITY = "Goal Run";
const DELIVERY_ENTITY = "Runtime Instruction Delivery";
const EVIDENCE_ENTITY = "Goal Evidence";

/** Delivery fields required to lease and fence a row returned by a worker query. */
export interface PersistedRuntimeInstructionDelivery extends RuntimeInstructionDelivery {
  readonly runEpoch: number;
  readonly availableAt: string;
}

export function mapRuntimeSessionRecord(value: unknown): AgentRuntimeSession {
  const row = asPersistenceRecord(value, SESSION_ENTITY);
  const createdAt = normalizePersistedDate(
    row.createdAt,
    "createdAt",
    SESSION_ENTITY,
  );
  const updatedAt = normalizePersistedDate(
    row.updatedAt,
    "updatedAt",
    SESSION_ENTITY,
  );
  assertChronological(
    SESSION_ENTITY,
    "createdAt",
    createdAt,
    "updatedAt",
    updatedAt,
  );
  readRequiredInteger(row, "lastInstructionSequence", SESSION_ENTITY, 0);
  if (row.pendingOperation !== null && row.pendingOperation !== undefined) {
    asPersistenceRecord(
      row.pendingOperation,
      "Runtime Session pending operation",
    );
  }

  return {
    id: readRequiredString(row, "id", SESSION_ENTITY),
    ownerId: readRequiredString(row, "ownerId", SESSION_ENTITY),
    provider: parsePersistedSchema(
      RuntimeProviderSchema,
      row.provider,
      "provider",
      SESSION_ENTITY,
    ),
    providerSessionId: readOptionalString(
      row,
      "providerSessionId",
      SESSION_ENTITY,
    ),
    workingDirectory: readOptionalText(row, "workingDirectory", SESSION_ENTITY),
    state: parsePersistedSchema(
      RuntimeSessionStateSchema,
      row.state,
      "state",
      SESSION_ENTITY,
    ),
    runEpoch: readRequiredInteger(row, "runEpoch", SESSION_ENTITY, 0),
    createdAt,
    updatedAt,
  };
}

export function mapAgentGoalRunRecord(value: unknown): AgentGoalRun {
  const row = asPersistenceRecord(value, RUN_ENTITY);
  const status = parsePersistedSchema(
    GoalRunStatusSchema,
    row.status,
    "status",
    RUN_ENTITY,
  );
  const startedAt = normalizePersistedDate(
    row.startedAt,
    "startedAt",
    RUN_ENTITY,
  );
  const lastActivityAt = normalizePersistedDate(
    row.lastActivityAt,
    "lastActivityAt",
    RUN_ENTITY,
  );
  const completedAt = normalizeOptionalPersistedDate(
    row.completedAt,
    "completedAt",
    RUN_ENTITY,
  );
  const createdAt = normalizePersistedDate(
    row.createdAt,
    "createdAt",
    RUN_ENTITY,
  );
  const updatedAt = normalizePersistedDate(
    row.updatedAt,
    "updatedAt",
    RUN_ENTITY,
  );
  assertChronological(
    RUN_ENTITY,
    "startedAt",
    startedAt,
    "lastActivityAt",
    lastActivityAt,
  );
  if (completedAt) {
    assertChronological(
      RUN_ENTITY,
      "lastActivityAt",
      lastActivityAt,
      "completedAt",
      completedAt,
    );
  }
  if (isTerminalGoalRunStatus(status) !== (completedAt !== undefined)) {
    invalidPersistenceRecord(
      RUN_ENTITY,
      "completedAt must be present exactly when the Run is terminal",
    );
  }
  assertChronological(
    RUN_ENTITY,
    "createdAt",
    createdAt,
    "updatedAt",
    updatedAt,
  );

  return {
    id: readRequiredUuid(row, "id", RUN_ENTITY),
    ownerId: readRequiredString(row, "ownerId", RUN_ENTITY),
    goalId: readRequiredUuid(row, "goalId", RUN_ENTITY),
    goalRevision: readRequiredInteger(row, "goalRevision", RUN_ENTITY, 1),
    runtimeSessionId: readRequiredString(row, "runtimeSessionId", RUN_ENTITY),
    providerSessionId: readOptionalString(row, "providerSessionId", RUN_ENTITY),
    runEpoch: readRequiredInteger(row, "runEpoch", RUN_ENTITY, 0),
    status,
    turnsUsed: readRequiredInteger(row, "turnsUsed", RUN_ENTITY, 0),
    tokensUsed: readRequiredInteger(row, "tokensUsed", RUN_ENTITY, 0),
    startedAt,
    lastActivityAt,
    completedAt,
    lastEvaluation:
      row.lastEvaluation === null || row.lastEvaluation === undefined
        ? undefined
        : parsePersistedSchema(
            GoalEvaluationResultSchema,
            row.lastEvaluation,
            "lastEvaluation",
            RUN_ENTITY,
          ),
  };
}

export function mapRuntimeInstructionDeliveryRecord(
  value: unknown,
): PersistedRuntimeInstructionDelivery {
  const row = asPersistenceRecord(value, DELIVERY_ENTITY);
  const state = parsePersistedSchema(
    DeliveryStateSchema,
    row.state,
    "state",
    DELIVERY_ENTITY,
  );
  const leaseToken = readOptionalString(row, "leaseToken", DELIVERY_ENTITY);
  const leaseOwner = readOptionalString(row, "leaseOwner", DELIVERY_ENTITY);
  const leaseExpiresAt = normalizeOptionalPersistedDate(
    row.leaseExpiresAt,
    "leaseExpiresAt",
    DELIVERY_ENTITY,
  );
  const leaseFields = [leaseToken, leaseOwner, leaseExpiresAt];
  const hasCompleteLease = leaseFields.every((value) => value !== undefined);
  const hasNoLease = leaseFields.every((value) => value === undefined);
  if (
    (state === "leased" && !hasCompleteLease) ||
    (state !== "leased" && !hasNoLease)
  ) {
    invalidPersistenceRecord(
      DELIVERY_ENTITY,
      "lease fields must all be present only while state is leased",
    );
  }
  const createdAt = normalizePersistedDate(
    row.createdAt,
    "createdAt",
    DELIVERY_ENTITY,
  );
  const updatedAt = normalizePersistedDate(
    row.updatedAt,
    "updatedAt",
    DELIVERY_ENTITY,
  );
  assertChronological(
    DELIVERY_ENTITY,
    "createdAt",
    createdAt,
    "updatedAt",
    updatedAt,
  );
  const availableAt = normalizePersistedDate(
    row.availableAt,
    "availableAt",
    DELIVERY_ENTITY,
  );
  const runEpoch = readRequiredInteger(row, "runEpoch", DELIVERY_ENTITY, 0);

  return {
    id: readRequiredUuid(row, "id", DELIVERY_ENTITY),
    ownerId: readRequiredString(row, "ownerId", DELIVERY_ENTITY),
    instructionId: readRequiredUuid(row, "instructionId", DELIVERY_ENTITY),
    runtimeSessionId: readRequiredString(
      row,
      "runtimeSessionId",
      DELIVERY_ENTITY,
    ),
    goalRunId: readOptionalUuid(row, "goalRunId", DELIVERY_ENTITY),
    runEpoch,
    state,
    attempt: readRequiredInteger(row, "attempt", DELIVERY_ENTITY, 1),
    availableAt,
    leaseToken,
    leaseOwner,
    leaseExpiresAt,
    providerEventId: readOptionalString(
      row,
      "providerEventId",
      DELIVERY_ENTITY,
    ),
    errorCode: readOptionalString(row, "errorCode", DELIVERY_ENTITY, 128),
    errorMessage: readOptionalText(row, "errorMessage", DELIVERY_ENTITY),
    createdAt,
    updatedAt,
  };
}

export function mapGoalEvidenceRecord(value: unknown): GoalEvidence {
  const row = asPersistenceRecord(value, EVIDENCE_ENTITY);
  const evidence = parsePersistedSchema(
    GoalEvidenceSchema,
    {
      id: readRequiredUuid(row, "id", EVIDENCE_ENTITY),
      goalId: readRequiredUuid(row, "goalId", EVIDENCE_ENTITY),
      goalRunId: readRequiredUuid(row, "goalRunId", EVIDENCE_ENTITY),
      goalRevision: readRequiredInteger(
        row,
        "goalRevision",
        EVIDENCE_ENTITY,
        1,
      ),
      instructionId: readOptionalUuid(row, "instructionId", EVIDENCE_ENTITY),
      criterionId: readOptionalString(row, "criterionId", EVIDENCE_ENTITY),
      type: row.type,
      sourceEventId: readRequiredString(row, "sourceEventId", EVIDENCE_ENTITY),
      summary: readRequiredString(row, "summary", EVIDENCE_ENTITY, 8_000),
      success: readOptionalBoolean(row, "success", EVIDENCE_ENTITY),
      payload: row.payload,
      observedAt: normalizePersistedDate(
        row.observedAt,
        "observedAt",
        EVIDENCE_ENTITY,
      ),
    },
    "row",
    EVIDENCE_ENTITY,
  );
  readRequiredString(row, "ownerId", EVIDENCE_ENTITY);
  readRequiredString(row, "runtimeSessionId", EVIDENCE_ENTITY);
  readRequiredInteger(row, "runEpoch", EVIDENCE_ENTITY, 0);
  normalizePersistedDate(row.createdAt, "createdAt", EVIDENCE_ENTITY);
  return evidence;
}
