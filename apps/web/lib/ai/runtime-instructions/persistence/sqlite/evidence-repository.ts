import {
  canonicalJson,
  type GoalEvidence,
} from "@openloomi/ai/agent/runtime-instructions";

import { persistenceConflict } from "../errors";
import {
  buildAgentGoalEvidenceRecord,
  type AgentGoalEvidenceRecordInput,
} from "../internal/record-builders";
import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./database";
import {
  normalizeIdentifier,
  normalizeScope,
  repositoryMutationError,
  requireCurrentEpoch,
  sqliteIso,
  isoDate,
  type SqliteGoalPersistenceScope,
} from "./repository-helpers";

export interface SqliteAppendEvidenceResult {
  readonly evidence: GoalEvidence;
  readonly deduplicated: boolean;
}

export class SqliteEvidenceRepository {
  private readonly database: SqliteGoalRuntimeDatabase;

  constructor(source: SqliteGoalRuntimeDatabaseSource) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  async getById(
    input: SqliteGoalPersistenceScope & { evidenceId: string },
  ): Promise<GoalEvidence | null> {
    const scope = normalizeScope(input);
    return this.database.store.getEvidence(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.evidenceId, "evidenceId"),
    );
  }

  async listByRun(
    input: SqliteGoalPersistenceScope & { goalRunId: string },
  ): Promise<GoalEvidence[]> {
    const scope = normalizeScope(input);
    return this.database.store.listEvidenceByRun(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.goalRunId, "goalRunId"),
    );
  }

  async appendOnce(
    input: AgentGoalEvidenceRecordInput,
  ): Promise<SqliteAppendEvidenceResult> {
    const scope = normalizeScope(input);
    buildAgentGoalEvidenceRecord(input);
    const runEpoch = input.runEpoch;
    const evidence = input.evidence;
    normalizeIdentifier(evidence.id, "evidence.id");
    normalizeIdentifier(evidence.goalId, "evidence.goalId");
    normalizeIdentifier(evidence.goalRunId, "evidence.goalRunId");
    normalizeIdentifier(evidence.sourceEventId, "evidence.sourceEventId");
    if (evidence.instructionId !== undefined) {
      normalizeIdentifier(evidence.instructionId, "evidence.instructionId");
    }
    isoDate(evidence.observedAt, "evidence.observedAt");
    isoDate(input.recordedAt, "recordedAt");

    try {
      return this.database.immediate((store) => {
        requireCurrentEpoch(
          store.getSession(scope.ownerId, scope.runtimeSessionId),
          runEpoch,
        );
        const run = store.getRun(
          scope.ownerId,
          scope.runtimeSessionId,
          evidence.goalRunId,
        );
        if (
          !run ||
          run.runEpoch !== runEpoch ||
          run.goalId !== evidence.goalId ||
          run.goalRevision !== evidence.goalRevision
        ) {
          throw persistenceConflict(
            "Goal Evidence does not match its authoritative Goal Run revision",
            "conflict",
          );
        }
        if (evidence.instructionId !== undefined) {
          const instruction = store.getInstruction(
            scope.ownerId,
            scope.runtimeSessionId,
            evidence.instructionId,
          );
          if (
            !instruction ||
            instruction.runEpoch !== runEpoch ||
            instruction.instruction.goalId !== evidence.goalId ||
            instruction.instruction.goalRevision !== evidence.goalRevision
          ) {
            throw persistenceConflict(
              "Goal Evidence does not match its Runtime Instruction revision",
              "conflict",
            );
          }
        }

        const existing = store.findEvidenceBySourceEvent(
          scope.ownerId,
          scope.runtimeSessionId,
          evidence.goalRunId,
          evidence.sourceEventId,
        );
        if (existing) {
          if (
            canonicalJson(evidenceDedupeContent(existing)) !==
            canonicalJson(evidenceDedupeContent(evidence))
          ) {
            throw persistenceConflict(
              "The Goal evidence source event was already recorded with different content",
              "idempotency_conflict",
            );
          }
          return { evidence: existing, deduplicated: true };
        }

        store.insertEvidence(input);
        const inserted = store.getEvidence(
          scope.ownerId,
          scope.runtimeSessionId,
          evidence.id,
        );
        if (!inserted) {
          throw persistenceConflict(
            "Could not read the appended Goal Evidence",
          );
        }
        return { evidence: inserted, deduplicated: false };
      });
    } catch (cause) {
      repositoryMutationError("Could not append Goal evidence", cause);
    }
  }
}

function evidenceDedupeContent(evidence: GoalEvidence) {
  const { id: _id, observedAt, ...content } = evidence;
  return {
    ...content,
    observedAt: sqliteIso(isoDate(observedAt, "evidence.observedAt")),
  };
}
