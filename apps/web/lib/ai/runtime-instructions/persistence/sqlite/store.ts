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
  AgentRuntimePendingOperation,
} from "@/lib/db/agent-goal-runtime-schema-types";

import {
  mapAgentGoalRecord,
  mapStoredRuntimeInstructionRecord,
  type StoredRuntimeInstruction,
} from "../goal-instruction-mappers";
import {
  buildAgentGoalRecord,
  buildAgentGoalEvidenceRecord,
  buildAgentGoalRunRecord,
  buildPendingRuntimeDeliveryRecord,
  buildRuntimeInstructionRecord,
  type AgentGoalEvidenceRecordInput,
  type PendingRuntimeDeliveryRecordInput,
} from "../internal/record-builders";
import { WHOLE_SECOND_PERSISTED_INSTANT_PRECISION } from "../instant-precision";
import {
  mapAgentGoalRunRecord,
  mapGoalEvidenceRecord,
  mapRuntimeInstructionDeliveryRecord,
  type PersistedRuntimeInstructionDelivery,
} from "../runtime-observation-mappers";
import type { BetterSqlite3Client } from "./transaction";

export interface SqliteGoalSessionRecord {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly runEpoch: number;
  readonly lastInstructionSequence: number;
  readonly providerSessionId?: string;
  readonly pendingOperation?: AgentRuntimePendingOperation;
  readonly createdAtSeconds: number;
  readonly updatedAtSeconds: number;
}

export interface SqliteGoalRecord {
  readonly persistedGoal: PersistedAgentGoal;
  readonly slotState: AgentGoalSlotState;
}

export interface SqliteGoalRunRecord {
  readonly run: AgentGoalRun;
  readonly updatedAtSeconds: number;
}

export interface UpdateSqliteSessionInput {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly expectedRunEpoch: number;
  readonly expectedInstructionSequence: number;
  readonly expectedPendingOperation: AgentRuntimePendingOperation | null;
  readonly runEpoch: number;
  readonly instructionSequence: number;
  readonly pendingOperation: AgentRuntimePendingOperation | null;
  readonly updatedAtSeconds: number;
}

export interface InsertSqliteInstructionInput {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly runEpoch: number;
  readonly instruction: RuntimeInstruction;
  readonly requestFingerprint: string;
  readonly commandOrder: number;
  readonly commandType?: AgentGoalCommandType;
  readonly commandPhase?: AgentGoalCommandPhase;
  readonly commandCheckpoint?: AgentGoalCommandCheckpoint;
  readonly goalRunId?: string;
  readonly deliveryId: string;
  readonly recordedAt: string;
}

export interface UpdateSqliteDeliveryInput {
  readonly current: PersistedRuntimeInstructionDelivery;
  readonly next: PersistedRuntimeInstructionDelivery;
}

/**
 * Synchronous SQLite row store shared by the Goal state unit of work and the
 * standalone repositories. Callers that perform writes must hold the native
 * `BEGIN IMMEDIATE` boundary supplied by SqliteGoalRuntimeDatabase.
 */
export class SqliteGoalRuntimeStore {
  constructor(private readonly client: BetterSqlite3Client) {}

  getSession(
    ownerId: string,
    runtimeSessionId: string,
  ): SqliteGoalSessionRecord | null {
    const row = this.client
      .prepare(
        `SELECT owner_id, id, run_epoch, last_instruction_sequence,
                provider_session_id, pending_operation, created_at, updated_at
           FROM agent_runtime_sessions
          WHERE owner_id = ? AND id = ?`,
      )
      .get(ownerId, runtimeSessionId) as RawRow | undefined;
    if (!row) return null;
    return {
      ownerId: requiredString(row.owner_id, "runtime session owner_id"),
      runtimeSessionId: requiredString(row.id, "runtime session id"),
      runEpoch: requiredInteger(row.run_epoch, "runtime session run_epoch", 0),
      lastInstructionSequence: requiredInteger(
        row.last_instruction_sequence,
        "runtime session last_instruction_sequence",
        0,
      ),
      ...(optionalString(row.provider_session_id) === undefined
        ? {}
        : { providerSessionId: optionalString(row.provider_session_id) }),
      ...(row.pending_operation === null || row.pending_operation === undefined
        ? {}
        : {
            pendingOperation: parseJsonObject(
              row.pending_operation,
              "runtime session pending_operation",
            ) as unknown as AgentRuntimePendingOperation,
          }),
      createdAtSeconds: requiredInteger(
        row.created_at,
        "runtime session created_at",
        0,
      ),
      updatedAtSeconds: requiredInteger(
        row.updated_at,
        "runtime session updated_at",
        0,
      ),
    };
  }

  updateSession(input: UpdateSqliteSessionInput): boolean {
    const expectedPending = serializeJson(input.expectedPendingOperation);
    const pendingPredicate =
      input.expectedPendingOperation === null
        ? "pending_operation IS NULL"
        : "pending_operation = ?";
    const parameters: unknown[] = [
      input.runEpoch,
      input.instructionSequence,
      serializeJson(input.pendingOperation),
      input.updatedAtSeconds,
      input.ownerId,
      input.runtimeSessionId,
      input.expectedRunEpoch,
      input.expectedInstructionSequence,
    ];
    if (input.expectedPendingOperation !== null) {
      parameters.push(expectedPending);
    }
    return (
      this.client
        .prepare(
          `UPDATE agent_runtime_sessions
              SET run_epoch = ?, last_instruction_sequence = ?,
                  pending_operation = ?, updated_at = ?
            WHERE owner_id = ? AND id = ? AND run_epoch = ?
              AND last_instruction_sequence = ? AND ${pendingPredicate}`,
        )
        .run(...parameters).changes === 1
    );
  }

  getGoalForOwner(ownerId: string, goalId: string): SqliteGoalRecord | null {
    const row = this.client
      .prepare("SELECT * FROM agent_goals WHERE owner_id = ? AND id = ?")
      .get(ownerId, goalId) as RawRow | undefined;
    return row ? mapGoalRow(row) : null;
  }

  getGoal(
    ownerId: string,
    runtimeSessionId: string,
    goalId: string,
  ): SqliteGoalRecord | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goals
          WHERE owner_id = ? AND runtime_session_id = ? AND id = ?`,
      )
      .get(ownerId, runtimeSessionId, goalId) as RawRow | undefined;
    return row ? mapGoalRow(row) : null;
  }

  getAssignedPrimaryGoal(
    ownerId: string,
    runtimeSessionId: string,
  ): SqliteGoalRecord | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goals
          WHERE owner_id = ? AND runtime_session_id = ?
            AND slot = 'primary' AND slot_state = 'assigned'
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId) as RawRow | undefined;
    return row ? mapGoalRow(row) : null;
  }

  listGoals(ownerId: string, runtimeSessionId: string): SqliteGoalRecord[] {
    return this.client
      .prepare(
        `SELECT * FROM agent_goals
          WHERE owner_id = ? AND runtime_session_id = ?
            AND slot_state IN ('assigned', 'released')
          ORDER BY updated_at DESC, id DESC`,
      )
      .all(ownerId, runtimeSessionId)
      .map((row) => mapGoalRow(row as RawRow));
  }

  insertGoal(
    persistedGoal: PersistedAgentGoal,
    slotState: AgentGoalSlotState,
  ): void {
    const row = buildAgentGoalRecord({ persistedGoal, slotState });
    this.client
      .prepare(
        `INSERT INTO agent_goals (
           id, owner_id, runtime_session_id, slot, slot_state, revision,
           objective, priority, status, deadline, max_turns, max_tokens,
           max_duration_seconds, completion_policy, source_type, source_id,
           goal_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.ownerId,
        row.runtimeSessionId,
        row.slot,
        row.slotState,
        row.revision,
        row.objective,
        row.priority,
        row.status,
        optionalDateSeconds(row.deadline),
        row.maxTurns,
        row.maxTokens,
        row.maxDurationSeconds,
        row.completionPolicy,
        row.sourceType,
        row.sourceId,
        JSON.stringify(row.goalSnapshot),
        dateSeconds(row.createdAt),
        dateSeconds(row.updatedAt),
      );
  }

  updateGoal(
    persistedGoal: PersistedAgentGoal,
    expectedRevision: number,
    expectedSlotState: AgentGoalSlotState,
    slotState: AgentGoalSlotState,
  ): boolean {
    const row = buildAgentGoalRecord({ persistedGoal, slotState });
    return (
      this.client
        .prepare(
          `UPDATE agent_goals
              SET slot_state = ?, revision = ?, objective = ?, priority = ?,
                  status = ?, deadline = ?, max_turns = ?, max_tokens = ?,
                  max_duration_seconds = ?, completion_policy = ?,
                  source_type = ?, source_id = ?, goal_snapshot = ?,
                  updated_at = ?
            WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
              AND revision = ? AND slot_state = ?`,
        )
        .run(
          row.slotState,
          row.revision,
          row.objective,
          row.priority,
          row.status,
          optionalDateSeconds(row.deadline),
          row.maxTurns,
          row.maxTokens,
          row.maxDurationSeconds,
          row.completionPolicy,
          row.sourceType,
          row.sourceId,
          JSON.stringify(row.goalSnapshot),
          dateSeconds(row.updatedAt),
          row.ownerId,
          row.runtimeSessionId,
          row.id,
          expectedRevision,
          expectedSlotState,
        ).changes === 1
    );
  }

  updateGoalSlotState(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    expectedSlotState: AgentGoalSlotState;
    slotState: AgentGoalSlotState;
  }): boolean {
    return (
      this.client
        .prepare(
          `UPDATE agent_goals SET slot_state = ?
            WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
              AND slot_state = ?`,
        )
        .run(
          input.slotState,
          input.ownerId,
          input.runtimeSessionId,
          input.goalId,
          input.expectedSlotState,
        ).changes === 1
    );
  }

  findCommand(
    ownerId: string,
    runtimeSessionId: string,
    idempotencyKey: string,
  ): StoredRuntimeInstruction | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_runtime_instructions
          WHERE owner_id = ? AND runtime_session_id = ?
            AND idempotency_key = ? AND command_order = 0
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, idempotencyKey) as RawRow | undefined;
    return row ? mapInstructionRow(row) : null;
  }

  getInstruction(
    ownerId: string,
    runtimeSessionId: string,
    instructionId: string,
  ): StoredRuntimeInstruction | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_runtime_instructions
          WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, instructionId) as RawRow | undefined;
    return row ? mapInstructionRow(row) : null;
  }

  findInstructionId(instructionId: string): boolean {
    return Boolean(
      this.client
        .prepare("SELECT 1 FROM agent_runtime_instructions WHERE id = ?")
        .get(instructionId),
    );
  }

  listInstructions(
    ownerId: string,
    runtimeSessionId: string,
    afterSequence = 0,
  ): RuntimeInstruction[] {
    return this.client
      .prepare(
        `SELECT * FROM agent_runtime_instructions
          WHERE owner_id = ? AND runtime_session_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
      )
      .all(ownerId, runtimeSessionId, afterSequence)
      .map((row) => mapInstructionRow(row as RawRow).instruction);
  }

  insertInstruction(input: InsertSqliteInstructionInput): void {
    const instructionRow = buildRuntimeInstructionRecord(input);
    this.client
      .prepare(
        `INSERT INTO agent_runtime_instructions (
           id, owner_id, runtime_session_id, schema_version, sequence,
           run_epoch, goal_id, goal_revision, kind, delivery_mode, payload,
           source_type, source_authority, source_ref, idempotency_key,
           request_fingerprint, command_order, command_type, command_phase,
           command_checkpoint, instruction_snapshot, issued_at, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instructionRow.id,
        instructionRow.ownerId,
        instructionRow.runtimeSessionId,
        instructionRow.schemaVersion,
        instructionRow.sequence,
        instructionRow.runEpoch,
        instructionRow.goalId,
        instructionRow.goalRevision,
        instructionRow.kind,
        instructionRow.deliveryMode,
        JSON.stringify(instructionRow.payload),
        instructionRow.sourceType,
        instructionRow.sourceAuthority,
        instructionRow.sourceRef,
        instructionRow.idempotencyKey,
        instructionRow.requestFingerprint,
        instructionRow.commandOrder,
        instructionRow.commandType,
        instructionRow.commandPhase,
        serializeJson(instructionRow.commandCheckpoint),
        JSON.stringify(instructionRow.instructionSnapshot),
        dateSeconds(instructionRow.issuedAt),
        optionalDateSeconds(instructionRow.expiresAt),
        dateSeconds(instructionRow.createdAt),
        dateSeconds(instructionRow.updatedAt),
      );
  }

  insertPendingDelivery(input: PendingRuntimeDeliveryRecordInput): void {
    const deliveryRow = buildPendingRuntimeDeliveryRecord({
      ...input,
    });
    this.client
      .prepare(
        `INSERT INTO agent_runtime_deliveries (
           id, owner_id, runtime_session_id, instruction_id, goal_run_id,
           run_epoch, state, attempt, available_at, lease_token, lease_owner,
           lease_expires_at, provider_event_id, error_code, error_message,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryRow.id,
        deliveryRow.ownerId,
        deliveryRow.runtimeSessionId,
        deliveryRow.instructionId,
        deliveryRow.goalRunId,
        deliveryRow.runEpoch,
        deliveryRow.state,
        deliveryRow.attempt,
        dateSeconds(deliveryRow.availableAt),
        deliveryRow.leaseToken,
        deliveryRow.leaseOwner,
        optionalDateSeconds(deliveryRow.leaseExpiresAt),
        deliveryRow.providerEventId,
        deliveryRow.errorCode,
        deliveryRow.errorMessage,
        dateSeconds(deliveryRow.createdAt),
        dateSeconds(deliveryRow.updatedAt),
      );
  }

  insertInstructionAndPendingDelivery(
    input: InsertSqliteInstructionInput,
  ): void {
    this.insertInstruction(input);
    this.insertPendingDelivery({
      id: input.deliveryId,
      ownerId: input.ownerId,
      runtimeSessionId: input.runtimeSessionId,
      instructionId: input.instruction.id,
      ...(input.goalRunId === undefined ? {} : { goalRunId: input.goalRunId }),
      runEpoch: input.runEpoch,
      availableAt: input.recordedAt,
      recordedAt: input.recordedAt,
    });
  }

  updateCommandCheckpoint(input: {
    ownerId: string;
    runtimeSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    commandType: Exclude<AgentGoalCommandType, "goal_instruction">;
    expectedPhase: AgentGoalCommandPhase;
    phase: AgentGoalCommandPhase;
    checkpoint: AgentGoalCommandCheckpoint;
    updatedAt: string;
  }): boolean {
    return (
      this.client
        .prepare(
          `UPDATE agent_runtime_instructions
              SET command_phase = ?, command_checkpoint = ?, updated_at = ?
            WHERE owner_id = ? AND runtime_session_id = ?
              AND idempotency_key = ? AND command_order = 0
              AND request_fingerprint = ? AND command_type = ?
              AND command_phase = ?`,
        )
        .run(
          input.phase,
          JSON.stringify(input.checkpoint),
          isoSeconds(input.updatedAt),
          input.ownerId,
          input.runtimeSessionId,
          input.idempotencyKey,
          input.requestFingerprint,
          input.commandType,
          input.expectedPhase,
        ).changes === 1
    );
  }

  findRun(
    ownerId: string,
    runtimeSessionId: string,
    goalId: string,
    runEpoch: number,
  ): AgentGoalRun | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goal_runs
          WHERE owner_id = ? AND runtime_session_id = ?
            AND goal_id = ? AND run_epoch = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, goalId, runEpoch) as RawRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  getRun(
    ownerId: string,
    runtimeSessionId: string,
    runId: string,
  ): AgentGoalRun | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goal_runs
          WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, runId) as RawRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  getRunRecord(
    ownerId: string,
    runtimeSessionId: string,
    runId: string,
  ): SqliteGoalRunRecord | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goal_runs
          WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, runId) as RawRow | undefined;
    return row
      ? {
          run: mapRunRow(row),
          updatedAtSeconds: requiredInteger(
            row.updated_at,
            "Goal Run updated_at",
            0,
          ),
        }
      : null;
  }

  listRuns(ownerId: string, runtimeSessionId: string): AgentGoalRun[] {
    return this.client
      .prepare(
        `SELECT * FROM agent_goal_runs
          WHERE owner_id = ? AND runtime_session_id = ?
          ORDER BY started_at ASC, id ASC`,
      )
      .all(ownerId, runtimeSessionId)
      .map((row) => mapRunRow(row as RawRow));
  }

  insertRun(run: AgentGoalRun, recordedAt: string): void {
    const row = buildAgentGoalRunRecord({ run, recordedAt });
    this.client
      .prepare(
        `INSERT INTO agent_goal_runs (
           id, owner_id, runtime_session_id, goal_id, goal_revision,
           run_epoch, provider_session_id, status, turns_used, tokens_used,
           started_at, last_activity_at, completed_at, last_evaluation,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.ownerId,
        row.runtimeSessionId,
        row.goalId,
        row.goalRevision,
        row.runEpoch,
        row.providerSessionId,
        row.status,
        row.turnsUsed,
        row.tokensUsed,
        dateSeconds(row.startedAt),
        dateSeconds(row.lastActivityAt),
        optionalDateSeconds(row.completedAt),
        serializeJson(row.lastEvaluation),
        dateSeconds(row.createdAt),
        dateSeconds(row.updatedAt),
      );
  }

  updateRun(
    current: AgentGoalRun,
    next: AgentGoalRun,
    recordedAt: string,
  ): boolean {
    return (
      this.client
        .prepare(
          `UPDATE agent_goal_runs
              SET goal_revision = ?, provider_session_id = ?, status = ?,
                  turns_used = ?, tokens_used = ?, last_activity_at = ?,
                  completed_at = ?, last_evaluation = ?, updated_at = ?
            WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
              AND goal_id = ? AND run_epoch = ? AND goal_revision = ?
              AND status = ?`,
        )
        .run(
          next.goalRevision,
          next.providerSessionId ?? null,
          next.status,
          next.turnsUsed,
          next.tokensUsed,
          isoSeconds(next.lastActivityAt),
          next.completedAt ? isoSeconds(next.completedAt) : null,
          serializeJson(next.lastEvaluation),
          isoSeconds(recordedAt),
          current.ownerId,
          current.runtimeSessionId,
          current.id,
          current.goalId,
          current.runEpoch,
          current.goalRevision,
          current.status,
        ).changes === 1
    );
  }

  getDelivery(
    ownerId: string,
    runtimeSessionId: string,
    deliveryId: string,
  ): PersistedRuntimeInstructionDelivery | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_runtime_deliveries
          WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, deliveryId) as RawRow | undefined;
    return row ? mapDeliveryRow(row) : null;
  }

  getActiveDeliveryForInstruction(
    ownerId: string,
    runtimeSessionId: string,
    instructionId: string,
  ): PersistedRuntimeInstructionDelivery | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_runtime_deliveries
          WHERE owner_id = ? AND runtime_session_id = ? AND instruction_id = ?
            AND state IN ('pending', 'leased', 'queued', 'written_to_sdk', 'observed', 'applied')
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, instructionId) as RawRow | undefined;
    return row ? mapDeliveryRow(row) : null;
  }

  listDeliveryAttempts(
    ownerId: string,
    runtimeSessionId: string,
    instructionId: string,
  ): PersistedRuntimeInstructionDelivery[] {
    return this.client
      .prepare(
        `SELECT * FROM agent_runtime_deliveries
          WHERE owner_id = ? AND runtime_session_id = ? AND instruction_id = ?
          ORDER BY attempt ASC`,
      )
      .all(ownerId, runtimeSessionId, instructionId)
      .map((row) => mapDeliveryRow(row as RawRow));
  }

  listDispatchableDeliveries(
    ownerId: string,
    runtimeSessionId: string,
    availableAtSeconds: number,
    limit: number,
  ): PersistedRuntimeInstructionDelivery[] {
    return this.client
      .prepare(
        `SELECT delivery.*
           FROM agent_runtime_deliveries AS delivery
           JOIN agent_runtime_instructions AS instruction
             ON instruction.owner_id = delivery.owner_id
            AND instruction.runtime_session_id = delivery.runtime_session_id
            AND instruction.id = delivery.instruction_id
            AND instruction.run_epoch = delivery.run_epoch
           JOIN agent_runtime_sessions AS session
             ON session.owner_id = delivery.owner_id
            AND session.id = delivery.runtime_session_id
            AND session.run_epoch = delivery.run_epoch
          WHERE delivery.owner_id = ? AND delivery.runtime_session_id = ?
            AND delivery.state = 'pending' AND delivery.available_at <= ?
          ORDER BY delivery.available_at ASC, instruction.sequence ASC,
                   delivery.attempt ASC, delivery.id ASC
          LIMIT ?`,
      )
      .all(ownerId, runtimeSessionId, availableAtSeconds, limit)
      .map((row) => mapDeliveryRow(row as RawRow));
  }

  updateDelivery(
    current: PersistedRuntimeInstructionDelivery,
    next: PersistedRuntimeInstructionDelivery,
  ): boolean {
    return (
      this.client
        .prepare(
          `UPDATE agent_runtime_deliveries
              SET state = ?, available_at = ?, lease_token = ?, lease_owner = ?,
                  lease_expires_at = ?, provider_event_id = ?, error_code = ?,
                  error_message = ?, updated_at = ?
            WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
              AND run_epoch = ? AND state = ? AND updated_at = ?
              AND lease_token IS ?`,
        )
        .run(
          next.state,
          isoSeconds(next.availableAt),
          next.leaseToken ?? null,
          next.leaseOwner ?? null,
          next.leaseExpiresAt ? isoSeconds(next.leaseExpiresAt) : null,
          next.providerEventId ?? null,
          next.errorCode ?? null,
          next.errorMessage ?? null,
          isoSeconds(next.updatedAt),
          current.ownerId,
          current.runtimeSessionId,
          current.id,
          current.runEpoch,
          current.state,
          isoSeconds(current.updatedAt),
          current.leaseToken ?? null,
        ).changes === 1
    );
  }

  getEvidence(
    ownerId: string,
    runtimeSessionId: string,
    evidenceId: string,
  ): GoalEvidence | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goal_evidence
          WHERE owner_id = ? AND runtime_session_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, evidenceId) as RawRow | undefined;
    return row ? mapEvidenceRow(row) : null;
  }

  findEvidenceBySourceEvent(
    ownerId: string,
    runtimeSessionId: string,
    goalRunId: string,
    sourceEventId: string,
  ): GoalEvidence | null {
    const row = this.client
      .prepare(
        `SELECT * FROM agent_goal_evidence
          WHERE owner_id = ? AND runtime_session_id = ?
            AND goal_run_id = ? AND source_event_id = ?
          LIMIT 1`,
      )
      .get(ownerId, runtimeSessionId, goalRunId, sourceEventId) as
      | RawRow
      | undefined;
    return row ? mapEvidenceRow(row) : null;
  }

  listEvidenceByRun(
    ownerId: string,
    runtimeSessionId: string,
    goalRunId: string,
  ): GoalEvidence[] {
    return this.client
      .prepare(
        `SELECT * FROM agent_goal_evidence
          WHERE owner_id = ? AND runtime_session_id = ? AND goal_run_id = ?
          ORDER BY observed_at ASC, id ASC`,
      )
      .all(ownerId, runtimeSessionId, goalRunId)
      .map((row) => mapEvidenceRow(row as RawRow));
  }

  insertEvidence(input: AgentGoalEvidenceRecordInput): void {
    const row = buildAgentGoalEvidenceRecord(input);
    this.client
      .prepare(
        `INSERT INTO agent_goal_evidence (
           id, owner_id, runtime_session_id, goal_id, goal_run_id,
           instruction_id, goal_revision, run_epoch, criterion_id, type,
           source_event_id, summary, success, payload, observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.ownerId,
        row.runtimeSessionId,
        row.goalId,
        row.goalRunId,
        row.instructionId,
        row.goalRevision,
        row.runEpoch,
        row.criterionId,
        row.type,
        row.sourceEventId,
        row.summary,
        row.success === null ? null : row.success ? 1 : 0,
        JSON.stringify(row.payload),
        dateSeconds(row.observedAt),
        dateSeconds(row.createdAt),
      );
  }
}

type RawRow = Readonly<Record<string, unknown>>;

function mapGoalRow(row: RawRow): SqliteGoalRecord {
  const mapped = mapAgentGoalRecord(
    {
      id: row.id,
      ownerId: row.owner_id,
      runtimeSessionId: row.runtime_session_id,
      slot: row.slot,
      slotState: row.slot_state,
      revision: row.revision,
      objective: row.objective,
      priority: row.priority,
      status: row.status,
      deadline: optionalUnixDate(row.deadline),
      maxTurns: row.max_turns,
      maxTokens: row.max_tokens,
      maxDurationSeconds: row.max_duration_seconds,
      completionPolicy: row.completion_policy,
      sourceType: row.source_type,
      sourceId: row.source_id,
      goalSnapshot: parseJsonObject(row.goal_snapshot, "Goal goal_snapshot"),
      createdAt: unixDate(row.created_at, "Goal created_at"),
      updatedAt: unixDate(row.updated_at, "Goal updated_at"),
    },
    WHOLE_SECOND_PERSISTED_INSTANT_PRECISION,
  );
  const slotState = requiredString(row.slot_state, "Goal slot_state");
  if (!isGoalSlotState(slotState)) {
    throw new Error(`Invalid persisted Goal slot_state ${slotState}`);
  }
  return { persistedGoal: mapped, slotState };
}

function mapInstructionRow(row: RawRow): StoredRuntimeInstruction {
  return mapStoredRuntimeInstructionRecord(
    {
      id: row.id,
      ownerId: row.owner_id,
      runtimeSessionId: row.runtime_session_id,
      schemaVersion: row.schema_version,
      sequence: row.sequence,
      runEpoch: row.run_epoch,
      goalId: row.goal_id,
      goalRevision: row.goal_revision,
      kind: row.kind,
      deliveryMode: row.delivery_mode,
      payload: parseJsonObject(row.payload, "Instruction payload"),
      sourceType: row.source_type,
      sourceAuthority: row.source_authority,
      sourceRef: row.source_ref,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      commandOrder: row.command_order,
      commandType: row.command_type,
      commandPhase: row.command_phase,
      commandCheckpoint:
        row.command_checkpoint === null
          ? null
          : parseJsonObject(
              row.command_checkpoint,
              "Instruction command_checkpoint",
            ),
      instructionSnapshot: parseJsonObject(
        row.instruction_snapshot,
        "Instruction instruction_snapshot",
      ),
      issuedAt: unixDate(row.issued_at, "Instruction issued_at"),
      expiresAt: optionalUnixDate(row.expires_at),
      createdAt: unixDate(row.created_at, "Instruction created_at"),
      updatedAt: unixDate(row.updated_at, "Instruction updated_at"),
    },
    WHOLE_SECOND_PERSISTED_INSTANT_PRECISION,
  );
}

function mapRunRow(row: RawRow): AgentGoalRun {
  return mapAgentGoalRunRecord({
    id: row.id,
    ownerId: row.owner_id,
    runtimeSessionId: row.runtime_session_id,
    goalId: row.goal_id,
    goalRevision: row.goal_revision,
    runEpoch: row.run_epoch,
    providerSessionId: row.provider_session_id,
    status: row.status,
    turnsUsed: row.turns_used,
    tokensUsed: row.tokens_used,
    startedAt: unixDate(row.started_at, "Goal Run started_at"),
    lastActivityAt: unixDate(row.last_activity_at, "Goal Run last_activity_at"),
    completedAt: optionalUnixDate(row.completed_at),
    lastEvaluation:
      row.last_evaluation === null
        ? null
        : parseJsonObject(row.last_evaluation, "Goal Run last_evaluation"),
    createdAt: unixDate(row.created_at, "Goal Run created_at"),
    updatedAt: unixDate(row.updated_at, "Goal Run updated_at"),
  });
}

function mapDeliveryRow(row: RawRow): PersistedRuntimeInstructionDelivery {
  return mapRuntimeInstructionDeliveryRecord({
    id: row.id,
    ownerId: row.owner_id,
    runtimeSessionId: row.runtime_session_id,
    instructionId: row.instruction_id,
    goalRunId: row.goal_run_id,
    runEpoch: row.run_epoch,
    state: row.state,
    attempt: row.attempt,
    availableAt: unixDate(row.available_at, "Delivery available_at"),
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: optionalUnixDate(row.lease_expires_at),
    providerEventId: row.provider_event_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: unixDate(row.created_at, "Delivery created_at"),
    updatedAt: unixDate(row.updated_at, "Delivery updated_at"),
  });
}

function mapEvidenceRow(row: RawRow): GoalEvidence {
  return mapGoalEvidenceRecord({
    id: row.id,
    ownerId: row.owner_id,
    runtimeSessionId: row.runtime_session_id,
    goalId: row.goal_id,
    goalRunId: row.goal_run_id,
    instructionId: row.instruction_id,
    goalRevision: row.goal_revision,
    runEpoch: row.run_epoch,
    criterionId: row.criterion_id,
    type: row.type,
    sourceEventId: row.source_event_id,
    summary: row.summary,
    success:
      row.success === null || row.success === undefined
        ? null
        : requiredInteger(row.success, "Evidence success", 0) === 1,
    payload: parseJsonValue(row.payload, "Evidence payload"),
    observedAt: unixDate(row.observed_at, "Evidence observed_at"),
    createdAt: unixDate(row.created_at, "Evidence created_at"),
  });
}

function isGoalSlotState(value: string): value is AgentGoalSlotState {
  return value === "assigned" || value === "reserved" || value === "released";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid persisted ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value, "optional string");
}

function requiredInteger(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Invalid persisted ${field}`);
  }
  return value as number;
}

function parseJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw new Error(`Invalid persisted ${field}`, { cause });
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid persisted ${field}`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonValue(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(`Invalid persisted ${field}`, { cause });
  }
}

function serializeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function dateSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function optionalDateSeconds(value: Date | null): number | null {
  return value === null ? null : dateSeconds(value);
}

function isoSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new TypeError("Invalid ISO timestamp");
  return Math.floor(milliseconds / 1000);
}

function unixDate(value: unknown, field: string): Date {
  return new Date(requiredInteger(value, field, 0) * 1000);
}

function optionalUnixDate(value: unknown): Date | null {
  return value === null || value === undefined
    ? null
    : unixDate(value, "optional timestamp");
}
