import type { PersistedAgentGoal } from "@openloomi/ai/agent/runtime-instructions";

import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./database";
import {
  normalizeIdentifier,
  normalizeScope,
  type SqliteGoalPersistenceScope,
} from "./repository-helpers";

/** Read repository for visible authoritative Goals in the desktop database. */
export class SqliteGoalRepository {
  private readonly database: SqliteGoalRuntimeDatabase;

  constructor(source: SqliteGoalRuntimeDatabaseSource) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  async listBySession(
    input: SqliteGoalPersistenceScope,
  ): Promise<PersistedAgentGoal[]> {
    const scope = normalizeScope(input);
    return this.database.store
      .listGoals(scope.ownerId, scope.runtimeSessionId)
      .map((record) => record.persistedGoal);
  }

  async getById(
    input: SqliteGoalPersistenceScope & { goalId: string },
  ): Promise<PersistedAgentGoal | null> {
    const scope = normalizeScope(input);
    const goalId = normalizeIdentifier(input.goalId, "goalId");
    const record = this.database.store.getGoal(
      scope.ownerId,
      scope.runtimeSessionId,
      goalId,
    );
    return record?.slotState === "reserved"
      ? null
      : (record?.persistedGoal ?? null);
  }

  async getAssignedPrimary(
    input: SqliteGoalPersistenceScope,
  ): Promise<PersistedAgentGoal | null> {
    const scope = normalizeScope(input);
    return (
      this.database.store.getAssignedPrimaryGoal(
        scope.ownerId,
        scope.runtimeSessionId,
      )?.persistedGoal ?? null
    );
  }

  async getActivePrimary(
    input: SqliteGoalPersistenceScope,
  ): Promise<PersistedAgentGoal | null> {
    const goal = await this.getAssignedPrimary(input);
    return goal?.goal.status === "active" ? goal : null;
  }
}
