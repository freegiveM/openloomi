import type { RuntimeInstruction } from "@melandlabs/ai/agent/runtime-instructions";

import type { StoredRuntimeInstruction } from "../goal-instruction-mappers";
import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./database";
import {
  nonNegativeInteger,
  normalizeIdentifier,
  normalizeScope,
  type SqliteGoalPersistenceScope,
} from "./repository-helpers";

/** Immutable Runtime Instruction/outbox reads for the desktop database. */
export class SqliteInstructionRepository {
  private readonly database: SqliteGoalRuntimeDatabase;

  constructor(source: SqliteGoalRuntimeDatabaseSource) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  async getById(
    input: SqliteGoalPersistenceScope & { instructionId: string },
  ): Promise<RuntimeInstruction | null> {
    return (await this.getStoredById(input))?.instruction ?? null;
  }

  async getStoredById(
    input: SqliteGoalPersistenceScope & { instructionId: string },
  ): Promise<StoredRuntimeInstruction | null> {
    const scope = normalizeScope(input);
    return this.database.store.getInstruction(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.instructionId, "instructionId"),
    );
  }

  async findCommandByIdempotency(
    input: SqliteGoalPersistenceScope & { idempotencyKey: string },
  ): Promise<StoredRuntimeInstruction | null> {
    const scope = normalizeScope(input);
    return this.database.store.findCommand(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.idempotencyKey, "idempotencyKey"),
    );
  }

  async list(
    input: SqliteGoalPersistenceScope & { afterSequence?: number },
  ): Promise<RuntimeInstruction[]> {
    const scope = normalizeScope(input);
    const afterSequence = nonNegativeInteger(
      input.afterSequence ?? 0,
      "afterSequence",
    );
    return this.database.store.listInstructions(
      scope.ownerId,
      scope.runtimeSessionId,
      afterSequence,
    );
  }
}
