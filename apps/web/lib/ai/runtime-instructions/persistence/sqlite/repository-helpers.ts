import { AgentGoalPersistenceError, persistenceConflict } from "../errors";
import type { SqliteGoalSessionRecord } from "./store";

export interface SqliteGoalPersistenceScope {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
}

export function normalizeScope(
  input: SqliteGoalPersistenceScope,
): SqliteGoalPersistenceScope {
  return {
    ownerId: normalizeIdentifier(input.ownerId, "ownerId"),
    runtimeSessionId: normalizeIdentifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    ),
  };
}

export function normalizeIdentifier(
  value: unknown,
  field: string,
  maxCharacters = 256,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (
    value.length === 0 ||
    value.length > maxCharacters ||
    value.trim() !== value
  ) {
    throw new TypeError(
      `${field} must be a non-empty identifier without surrounding whitespace`,
    );
  }
  return value;
}

export function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

export function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) throw new TypeError(`${field} must be positive`);
  return parsed;
}

export function isoDate(value: string, field: string): Date {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(milliseconds);
}

export function seconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

export function sqliteIso(value: Date): string {
  return new Date(seconds(value) * 1_000).toISOString();
}

export function requireCurrentEpoch(
  session: SqliteGoalSessionRecord | null,
  expectedRunEpoch: number,
): SqliteGoalSessionRecord {
  if (!isCurrentEpoch(session, expectedRunEpoch)) {
    throw persistenceConflict(
      "The Runtime Session epoch changed",
      "run_epoch_conflict",
    );
  }
  return session;
}

export function isCurrentEpoch(
  session: SqliteGoalSessionRecord | null,
  expectedRunEpoch: number,
): session is SqliteGoalSessionRecord {
  return session !== null && session.runEpoch === expectedRunEpoch;
}

export function requireProviderSession(
  session: SqliteGoalSessionRecord,
  providerSessionId: string | undefined,
  currentProviderSessionId?: string,
): void {
  if (
    !providerSessionMatches(
      session,
      providerSessionId,
      currentProviderSessionId,
    )
  ) {
    throw persistenceConflict(
      "The provider session does not match the authoritative Runtime Session",
      "conflict",
    );
  }
}

export function providerSessionMatches(
  session: SqliteGoalSessionRecord,
  providerSessionId: string | undefined,
  currentProviderSessionId?: string,
): boolean {
  if (providerSessionId === undefined) {
    return session.providerSessionId === currentProviderSessionId;
  }
  return (
    session.providerSessionId === providerSessionId &&
    (currentProviderSessionId === undefined ||
      currentProviderSessionId === providerSessionId)
  );
}

export function repositoryMutationError(
  message: string,
  cause: unknown,
): never {
  if (cause instanceof AgentGoalPersistenceError) throw cause;
  throw persistenceConflict(message, "conflict", cause);
}
