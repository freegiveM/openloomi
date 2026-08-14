import {
  AgentGoalSchema,
  RuntimeInstructionSchema,
  type AgentGoal,
  type PersistedAgentGoal,
  type RuntimeInstruction,
} from "@openloomi/ai/agent/runtime-instructions";

import type {
  AgentGoalCommandCheckpoint,
  AgentGoalCommandPhase,
  AgentGoalCommandType,
  AgentGoalSlotState,
} from "@/lib/db/agent-goal-runtime-schema-types";

import { invalidPersistenceRecord } from "./errors";
import type { PersistedInstantPrecision } from "./instant-precision";
import {
  asPersistenceRecord,
  assertChronological,
  assertPersistedEqual,
  assertPersistedInstantMatchesSnapshot,
  normalizeOptionalPersistedDate,
  normalizePersistedDate,
  parsePersistedJson,
  parsePersistedSchema,
  readOptionalString,
  readRequiredInteger,
  readRequiredString,
  type PersistenceRecord,
} from "./mapping";

const GOAL_ENTITY = "Agent Goal";
const INSTRUCTION_ENTITY = "Runtime Instruction";

const SLOT_STATES = new Set<AgentGoalSlotState>([
  "assigned",
  "reserved",
  "released",
]);

export interface StoredRuntimeInstruction {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly runEpoch: number;
  readonly instruction: RuntimeInstruction;
  readonly requestFingerprint: string;
  readonly commandOrder: number;
  readonly commandType?: AgentGoalCommandType;
  readonly commandPhase?: AgentGoalCommandPhase;
  readonly commandCheckpoint?: AgentGoalCommandCheckpoint;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function mapAgentGoalRecord(
  value: unknown,
  persistedInstantPrecision: PersistedInstantPrecision,
): PersistedAgentGoal {
  const row = asPersistenceRecord(value, GOAL_ENTITY);
  const ownerId = readRequiredString(row, "ownerId", GOAL_ENTITY);
  const runtimeSessionId = readRequiredString(
    row,
    "runtimeSessionId",
    GOAL_ENTITY,
  );
  const id = readRequiredString(row, "id", GOAL_ENTITY);
  const slot = readRequiredString(row, "slot", GOAL_ENTITY);
  const slotState = readRequiredString(row, "slotState", GOAL_ENTITY);
  if (slot !== "primary") {
    invalidPersistenceRecord(GOAL_ENTITY, `unsupported slot ${slot}`);
  }
  if (!SLOT_STATES.has(slotState as AgentGoalSlotState)) {
    invalidPersistenceRecord(GOAL_ENTITY, `unsupported slotState ${slotState}`);
  }

  const goal = normalizeGoalSnapshot(row.goalSnapshot);
  const deadline = normalizeOptionalPersistedDate(
    row.deadline,
    "deadline",
    GOAL_ENTITY,
  );
  const createdAt = normalizePersistedDate(
    row.createdAt,
    "createdAt",
    GOAL_ENTITY,
  );
  const updatedAt = normalizePersistedDate(
    row.updatedAt,
    "updatedAt",
    GOAL_ENTITY,
  );

  assertPersistedEqual(GOAL_ENTITY, "id", id, goal.id);
  assertPersistedEqual(
    GOAL_ENTITY,
    "revision",
    readRequiredInteger(row, "revision", GOAL_ENTITY, 1),
    goal.revision,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "objective",
    readRequiredString(row, "objective", GOAL_ENTITY, 8_000),
    goal.objective,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "priority",
    readRequiredInteger(row, "priority", GOAL_ENTITY, 0),
    goal.priority,
  );
  assertPersistedEqual(GOAL_ENTITY, "status", row.status, goal.status);
  assertPersistedInstantMatchesSnapshot(
    GOAL_ENTITY,
    "deadline",
    deadline,
    goal.deadline,
    persistedInstantPrecision,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "maxTurns",
    row.maxTurns ?? undefined,
    goal.maxTurns,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "maxTokens",
    row.maxTokens ?? undefined,
    goal.maxTokens,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "maxDurationSeconds",
    row.maxDurationSeconds ?? undefined,
    goal.maxDurationSeconds,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "completionPolicy",
    row.completionPolicy,
    goal.completionPolicy,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "sourceType",
    row.sourceType,
    goal.source.type,
  );
  assertPersistedEqual(
    GOAL_ENTITY,
    "sourceId",
    readOptionalString(row, "sourceId", GOAL_ENTITY),
    goal.source.id,
  );
  assertPersistedInstantMatchesSnapshot(
    GOAL_ENTITY,
    "createdAt",
    createdAt,
    goal.createdAt,
    persistedInstantPrecision,
  );
  assertPersistedInstantMatchesSnapshot(
    GOAL_ENTITY,
    "updatedAt",
    updatedAt,
    goal.updatedAt,
    persistedInstantPrecision,
  );

  return {
    ownerId,
    runtimeSessionId,
    slot: "primary",
    goal,
  };
}

export function mapRuntimeInstructionRecord(
  value: unknown,
  persistedInstantPrecision: PersistedInstantPrecision,
): RuntimeInstruction {
  return mapStoredRuntimeInstructionRecord(value, persistedInstantPrecision)
    .instruction;
}

export function mapStoredRuntimeInstructionRecord(
  value: unknown,
  persistedInstantPrecision: PersistedInstantPrecision,
): StoredRuntimeInstruction {
  const row = asPersistenceRecord(value, INSTRUCTION_ENTITY);
  const ownerId = readRequiredString(row, "ownerId", INSTRUCTION_ENTITY);
  const runtimeSessionId = readRequiredString(
    row,
    "runtimeSessionId",
    INSTRUCTION_ENTITY,
  );
  const instruction = normalizeInstructionSnapshot(row.instructionSnapshot);
  const issuedAt = normalizePersistedDate(
    row.issuedAt,
    "issuedAt",
    INSTRUCTION_ENTITY,
  );
  const expiresAt = normalizeOptionalPersistedDate(
    row.expiresAt,
    "expiresAt",
    INSTRUCTION_ENTITY,
  );
  const createdAt = normalizePersistedDate(
    row.createdAt,
    "createdAt",
    INSTRUCTION_ENTITY,
  );
  const updatedAt = normalizePersistedDate(
    row.updatedAt,
    "updatedAt",
    INSTRUCTION_ENTITY,
  );
  const sequence = readRequiredInteger(row, "sequence", INSTRUCTION_ENTITY, 1);
  const runEpoch = readRequiredInteger(row, "runEpoch", INSTRUCTION_ENTITY, 0);
  const commandOrder = readRequiredInteger(
    row,
    "commandOrder",
    INSTRUCTION_ENTITY,
    0,
  );
  const requestFingerprint = readRequiredString(
    row,
    "requestFingerprint",
    INSTRUCTION_ENTITY,
    64,
  );
  if (!/^[a-f0-9]{64}$/i.test(requestFingerprint)) {
    invalidPersistenceRecord(
      INSTRUCTION_ENTITY,
      "requestFingerprint must be a SHA-256 digest",
    );
  }

  assertPersistedEqual(INSTRUCTION_ENTITY, "id", row.id, instruction.id);
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "schemaVersion",
    row.schemaVersion,
    instruction.schemaVersion,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "sequence",
    sequence,
    instruction.sequence,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "goalId",
    row.goalId ?? undefined,
    instruction.goalId,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "goalRevision",
    row.goalRevision ?? undefined,
    instruction.goalRevision,
  );
  assertPersistedEqual(INSTRUCTION_ENTITY, "kind", row.kind, instruction.kind);
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "deliveryMode",
    row.deliveryMode,
    instruction.deliveryMode,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "targetSessionId",
    runtimeSessionId,
    instruction.targetSessionId,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "payload",
    row.payload,
    instruction.payload,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "sourceType",
    row.sourceType,
    instruction.source.type,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "sourceAuthority",
    row.sourceAuthority,
    instruction.source.authority,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "sourceRef",
    readOptionalString(row, "sourceRef", INSTRUCTION_ENTITY, 2_048),
    instruction.source.sourceRef,
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "idempotencyKey",
    row.idempotencyKey,
    instruction.idempotencyKey,
  );
  assertPersistedInstantMatchesSnapshot(
    INSTRUCTION_ENTITY,
    "issuedAt",
    issuedAt,
    instruction.issuedAt,
    persistedInstantPrecision,
  );
  assertPersistedInstantMatchesSnapshot(
    INSTRUCTION_ENTITY,
    "expiresAt",
    expiresAt,
    instruction.expiresAt,
    persistedInstantPrecision,
  );
  assertChronological(
    INSTRUCTION_ENTITY,
    "createdAt",
    createdAt,
    "updatedAt",
    updatedAt,
  );

  const command = mapCommandMetadata(row, commandOrder);
  return {
    ownerId,
    runtimeSessionId,
    runEpoch,
    instruction,
    requestFingerprint,
    commandOrder,
    ...command,
    createdAt,
    updatedAt,
  };
}

function normalizeGoalSnapshot(value: unknown): AgentGoal {
  const snapshot = parsePersistedSchema<AgentGoal>(
    AgentGoalSchema,
    value,
    "goalSnapshot",
    GOAL_ENTITY,
  );
  return AgentGoalSchema.parse({
    ...snapshot,
    createdAt: normalizePersistedDate(
      snapshot.createdAt,
      "goalSnapshot.createdAt",
      GOAL_ENTITY,
    ),
    updatedAt: normalizePersistedDate(
      snapshot.updatedAt,
      "goalSnapshot.updatedAt",
      GOAL_ENTITY,
    ),
    ...(snapshot.deadline === undefined || snapshot.deadline === null
      ? {}
      : {
          deadline: normalizePersistedDate(
            snapshot.deadline,
            "goalSnapshot.deadline",
            GOAL_ENTITY,
          ),
        }),
  });
}

function normalizeInstructionSnapshot(value: unknown): RuntimeInstruction {
  const snapshot = parsePersistedSchema<RuntimeInstruction>(
    RuntimeInstructionSchema,
    value,
    "instructionSnapshot",
    INSTRUCTION_ENTITY,
  );
  return RuntimeInstructionSchema.parse({
    ...snapshot,
    issuedAt: normalizePersistedDate(
      snapshot.issuedAt,
      "instructionSnapshot.issuedAt",
      INSTRUCTION_ENTITY,
    ),
    ...(snapshot.expiresAt === undefined || snapshot.expiresAt === null
      ? {}
      : {
          expiresAt: normalizePersistedDate(
            snapshot.expiresAt,
            "instructionSnapshot.expiresAt",
            INSTRUCTION_ENTITY,
          ),
        }),
  });
}

function mapCommandMetadata(
  row: PersistenceRecord,
  commandOrder: number,
): Pick<
  StoredRuntimeInstruction,
  "commandType" | "commandPhase" | "commandCheckpoint"
> {
  if (commandOrder > 0) {
    if (
      row.commandType !== null ||
      row.commandPhase !== null ||
      row.commandCheckpoint !== null
    ) {
      invalidPersistenceRecord(
        INSTRUCTION_ENTITY,
        "non-root command rows cannot contain command metadata",
      );
    }
    return {};
  }

  const commandType = readRequiredString(
    row,
    "commandType",
    INSTRUCTION_ENTITY,
    32,
  ) as AgentGoalCommandType;
  const commandPhase = readRequiredString(
    row,
    "commandPhase",
    INSTRUCTION_ENTITY,
    32,
  ) as AgentGoalCommandPhase;
  const validPhase =
    (commandType === "goal_instruction" && commandPhase === "committed") ||
    (commandType === "lifecycle" &&
      ["prepared", "boundary_observed", "finalized"].includes(commandPhase)) ||
    (commandType === "replacement" &&
      ["prepared", "boundary_observed", "activated"].includes(commandPhase));
  if (!validPhase) {
    invalidPersistenceRecord(
      INSTRUCTION_ENTITY,
      `invalid command phase ${commandType}/${commandPhase}`,
    );
  }
  const checkpoint = asPersistenceRecord(
    parsePersistedJson(
      row.commandCheckpoint,
      "commandCheckpoint",
      INSTRUCTION_ENTITY,
    ),
    "Runtime Instruction command checkpoint",
  );
  assertPersistedEqual(
    INSTRUCTION_ENTITY,
    "commandCheckpoint.type",
    checkpoint.type,
    commandType,
  );
  return {
    commandType,
    commandPhase,
    commandCheckpoint: checkpoint as AgentGoalCommandCheckpoint,
  };
}
