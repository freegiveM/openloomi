import {
  GoalEvaluationResultSchema,
  GoalRunStatusSchema,
  assertGoalRunStatusTransition,
  type AgentGoalRun,
  type GoalEvaluationResult,
  type GoalRunStatus,
} from "@melandlabs/ai/agent/runtime-instructions";

import { persistenceConflict } from "../errors";
import { isTerminalGoalRunStatus } from "../goal-run-state";
import { buildAgentGoalRunRecord } from "../internal/record-builders";
import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./database";
import {
  isoDate,
  isCurrentEpoch,
  nonNegativeInteger,
  normalizeIdentifier,
  normalizeScope,
  providerSessionMatches,
  repositoryMutationError,
  requireCurrentEpoch,
  seconds,
  sqliteIso,
  type SqliteGoalPersistenceScope,
} from "./repository-helpers";

export interface SqliteGoalRunTransitionInput extends SqliteGoalPersistenceScope {
  readonly runId: string;
  readonly expectedRunEpoch: number;
  readonly expectedStatus: GoalRunStatus;
  readonly nextStatus: GoalRunStatus;
  readonly updatedAt: string;
  readonly providerSessionId?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly lastActivityAt?: string;
  readonly completedAt?: string | null;
  readonly lastEvaluation?: GoalEvaluationResult | null;
}

export interface SqliteGoalRunProgressUpdateInput extends SqliteGoalPersistenceScope {
  readonly runId: string;
  readonly expectedRunEpoch: number;
  readonly expectedStatus: GoalRunStatus;
  readonly updatedAt: string;
  readonly providerSessionId?: string;
  readonly expectedTurnsUsed?: number;
  readonly turnsUsed?: number;
  readonly expectedTokensUsed?: number;
  readonly tokensUsed?: number;
  readonly lastActivityAt?: string;
  readonly lastEvaluation?: GoalEvaluationResult | null;
}

export class SqliteRunRepository {
  private readonly database: SqliteGoalRuntimeDatabase;

  constructor(source: SqliteGoalRuntimeDatabaseSource) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  async getById(
    input: SqliteGoalPersistenceScope & { runId: string },
  ): Promise<AgentGoalRun | null> {
    const scope = normalizeScope(input);
    return this.database.store.getRun(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.runId, "runId"),
    );
  }

  async findByGoalEpoch(
    input: SqliteGoalPersistenceScope & {
      goalId: string;
      runEpoch: number;
    },
  ): Promise<AgentGoalRun | null> {
    const scope = normalizeScope(input);
    return this.database.store.findRun(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.goalId, "goalId"),
      nonNegativeInteger(input.runEpoch, "runEpoch"),
    );
  }

  async listBySession(
    input: SqliteGoalPersistenceScope,
  ): Promise<AgentGoalRun[]> {
    const scope = normalizeScope(input);
    return this.database.store.listRuns(scope.ownerId, scope.runtimeSessionId);
  }

  async create(input: {
    run: AgentGoalRun;
    recordedAt: string;
  }): Promise<AgentGoalRun> {
    const scope = normalizeScope(input.run);
    buildAgentGoalRunRecord(input);
    validateInitialRun(input.run);
    isoDate(input.recordedAt, "recordedAt");

    try {
      return this.database.immediate((store) => {
        const session = requireCurrentEpoch(
          store.getSession(scope.ownerId, scope.runtimeSessionId),
          input.run.runEpoch,
        );
        if (session.providerSessionId !== input.run.providerSessionId) {
          throw persistenceConflict(
            "The Goal Run provider session does not match the authoritative Runtime Session",
            "conflict",
          );
        }
        const goal = store.getGoal(
          scope.ownerId,
          scope.runtimeSessionId,
          input.run.goalId,
        );
        if (
          goal?.slotState !== "assigned" ||
          goal.persistedGoal.goal.status !== "active" ||
          goal.persistedGoal.goal.revision !== input.run.goalRevision
        ) {
          throw persistenceConflict(
            "The Goal Run does not match the active assigned Goal revision",
            "conflict",
          );
        }
        store.insertRun(input.run, input.recordedAt);
        const inserted = store.getRun(
          scope.ownerId,
          scope.runtimeSessionId,
          input.run.id,
        );
        if (!inserted) {
          throw persistenceConflict("Could not read the created Goal Run");
        }
        return inserted;
      });
    } catch (cause) {
      repositoryMutationError("Could not create the Goal Run", cause);
    }
  }

  async transition(
    input: SqliteGoalRunTransitionInput,
  ): Promise<AgentGoalRun | null> {
    const scope = normalizeScope(input);
    const runId = normalizeIdentifier(input.runId, "runId");
    const expectedRunEpoch = nonNegativeInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const expectedStatus = parseRunStatus(
      input.expectedStatus,
      "expectedStatus",
    );
    const nextStatus = parseRunStatus(input.nextStatus, "nextStatus");
    assertGoalRunStatusTransition(expectedStatus, nextStatus);
    validateCompletion(nextStatus, input.completedAt);
    const updatedAt = isoDate(input.updatedAt, "updatedAt");
    const providerSessionId = optionalIdentifier(
      input.providerSessionId,
      "providerSessionId",
    );
    const turnsUsed = optionalCounter(input.turnsUsed, "turnsUsed");
    const tokensUsed = optionalCounter(input.tokensUsed, "tokensUsed");
    const lastActivityAt = optionalSqliteInstant(
      input.lastActivityAt,
      "lastActivityAt",
    );
    const completedAt = materializeCompletedAt(nextStatus, input.completedAt);
    if (
      completedAt !== undefined &&
      lastActivityAt !== undefined &&
      Date.parse(completedAt) < Date.parse(lastActivityAt)
    ) {
      throw new TypeError("completedAt cannot be earlier than lastActivityAt");
    }

    try {
      return this.database.immediate((store) => {
        const session = store.getSession(scope.ownerId, scope.runtimeSessionId);
        const record = store.getRunRecord(
          scope.ownerId,
          scope.runtimeSessionId,
          runId,
        );
        if (
          !isCurrentEpoch(session, expectedRunEpoch) ||
          !record ||
          record.run.runEpoch !== expectedRunEpoch ||
          record.run.status !== expectedStatus
        ) {
          return null;
        }
        if (
          !providerSessionMatches(
            session,
            providerSessionId,
            record.run.providerSessionId,
          )
        ) {
          return null;
        }
        if (
          seconds(updatedAt) < record.updatedAtSeconds ||
          (turnsUsed !== undefined && turnsUsed < record.run.turnsUsed) ||
          (tokensUsed !== undefined && tokensUsed < record.run.tokensUsed) ||
          (lastActivityAt !== undefined &&
            Date.parse(lastActivityAt) < Date.parse(record.run.lastActivityAt))
        ) {
          return null;
        }
        const nextLastActivityAt = lastActivityAt ?? record.run.lastActivityAt;
        if (
          completedAt !== undefined &&
          Date.parse(completedAt) < Date.parse(nextLastActivityAt)
        ) {
          return null;
        }
        const next: AgentGoalRun = {
          ...record.run,
          status: nextStatus,
          turnsUsed: turnsUsed ?? record.run.turnsUsed,
          tokensUsed: tokensUsed ?? record.run.tokensUsed,
          lastActivityAt: nextLastActivityAt,
          ...(providerSessionId === undefined ? {} : { providerSessionId }),
          ...(completedAt === undefined ? {} : { completedAt }),
          ...(input.lastEvaluation === undefined
            ? {}
            : {
                lastEvaluation:
                  input.lastEvaluation === null
                    ? undefined
                    : parseEvaluation(input.lastEvaluation),
              }),
        };
        if (!store.updateRun(record.run, next, sqliteIso(updatedAt)))
          return null;
        return store.getRun(scope.ownerId, scope.runtimeSessionId, runId);
      });
    } catch (cause) {
      repositoryMutationError("Could not transition the Goal Run", cause);
    }
  }

  async updateProgress(
    input: SqliteGoalRunProgressUpdateInput,
  ): Promise<AgentGoalRun | null> {
    const scope = normalizeScope(input);
    const runId = normalizeIdentifier(input.runId, "runId");
    const expectedRunEpoch = nonNegativeInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const expectedStatus = parseRunStatus(
      input.expectedStatus,
      "expectedStatus",
    );
    const updatedAt = isoDate(input.updatedAt, "updatedAt");
    const providerSessionId = optionalIdentifier(
      input.providerSessionId,
      "providerSessionId",
    );
    const turns = pairedCounter(
      input.expectedTurnsUsed,
      input.turnsUsed,
      "turnsUsed",
    );
    const tokens = pairedCounter(
      input.expectedTokensUsed,
      input.tokensUsed,
      "tokensUsed",
    );
    const lastActivityAt = optionalSqliteInstant(
      input.lastActivityAt,
      "lastActivityAt",
    );
    if (
      providerSessionId === undefined &&
      turns === undefined &&
      tokens === undefined &&
      input.lastActivityAt === undefined &&
      input.lastEvaluation === undefined
    ) {
      throw new TypeError(
        "A Goal Run progress update must change progress state",
      );
    }

    try {
      return this.database.immediate((store) => {
        const session = store.getSession(scope.ownerId, scope.runtimeSessionId);
        const record = store.getRunRecord(
          scope.ownerId,
          scope.runtimeSessionId,
          runId,
        );
        if (
          !isCurrentEpoch(session, expectedRunEpoch) ||
          !record ||
          record.run.runEpoch !== expectedRunEpoch ||
          record.run.status !== expectedStatus ||
          seconds(updatedAt) < record.updatedAtSeconds ||
          (turns !== undefined && record.run.turnsUsed !== turns.expected) ||
          (tokens !== undefined && record.run.tokensUsed !== tokens.expected) ||
          (lastActivityAt !== undefined &&
            Date.parse(lastActivityAt) < Date.parse(record.run.lastActivityAt))
        ) {
          return null;
        }
        if (
          !providerSessionMatches(
            session,
            providerSessionId,
            record.run.providerSessionId,
          )
        ) {
          return null;
        }
        const next: AgentGoalRun = {
          ...record.run,
          turnsUsed: turns?.next ?? record.run.turnsUsed,
          tokensUsed: tokens?.next ?? record.run.tokensUsed,
          lastActivityAt: lastActivityAt ?? record.run.lastActivityAt,
          ...(providerSessionId === undefined ? {} : { providerSessionId }),
          ...(input.lastEvaluation === undefined
            ? {}
            : {
                lastEvaluation:
                  input.lastEvaluation === null
                    ? undefined
                    : parseEvaluation(input.lastEvaluation),
              }),
        };
        if (!store.updateRun(record.run, next, sqliteIso(updatedAt)))
          return null;
        return store.getRun(scope.ownerId, scope.runtimeSessionId, runId);
      });
    } catch (cause) {
      repositoryMutationError("Could not update Goal Run progress", cause);
    }
  }
}

function validateInitialRun(run: AgentGoalRun): void {
  if (
    run.status !== "queued" ||
    run.turnsUsed !== 0 ||
    run.tokensUsed !== 0 ||
    run.completedAt !== undefined ||
    run.lastEvaluation !== undefined ||
    Date.parse(run.startedAt) !== Date.parse(run.lastActivityAt)
  ) {
    throw new TypeError(
      "A new Goal Run must be queued with zero usage, no evaluation or completion, and no activity after its start",
    );
  }
}

function parseRunStatus(value: unknown, field: string): GoalRunStatus {
  const parsed = GoalRunStatusSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${field} is not a Goal Run status`);
  return parsed.data;
}

function parseEvaluation(value: GoalEvaluationResult): GoalEvaluationResult {
  const parsed = GoalEvaluationResultSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("lastEvaluation is invalid");
  return parsed.data;
}

function optionalIdentifier(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? undefined : normalizeIdentifier(value, field);
}

function validateCompletion(
  status: GoalRunStatus,
  completedAt: string | null | undefined,
): void {
  if (isTerminalGoalRunStatus(status) && !completedAt) {
    throw new TypeError(
      `completedAt is required for Goal Run status ${status}`,
    );
  }
  if (
    !isTerminalGoalRunStatus(status) &&
    completedAt !== undefined &&
    completedAt !== null
  ) {
    throw new TypeError(
      `completedAt is not valid for Goal Run status ${status}`,
    );
  }
}

function materializeCompletedAt(
  status: GoalRunStatus,
  value: string | null | undefined,
): string | undefined {
  if (!isTerminalGoalRunStatus(status)) return undefined;
  const completed = isoDate(value as string, "completedAt");
  return sqliteIso(completed);
}

function optionalCounter(
  value: number | undefined,
  field: string,
): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, field);
}

function optionalSqliteInstant(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? undefined : sqliteIso(isoDate(value, field));
}

function pairedCounter(
  expected: number | undefined,
  next: number | undefined,
  field: string,
): { expected: number; next: number } | undefined {
  if ((expected === undefined) !== (next === undefined)) {
    throw new TypeError(
      `expected${field[0].toUpperCase()}${field.slice(1)} and ${field} must be supplied together`,
    );
  }
  if (expected === undefined || next === undefined) return undefined;
  const parsedExpected = nonNegativeInteger(
    expected,
    `expected${field[0].toUpperCase()}${field.slice(1)}`,
  );
  const parsedNext = nonNegativeInteger(next, field);
  if (parsedNext < parsedExpected)
    throw new TypeError(`${field} cannot decrease`);
  return { expected: parsedExpected, next: parsedNext };
}
