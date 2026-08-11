import type {
  AgentRuntimeSession,
  RuntimeClockPort,
} from "@openloomi/ai/agent/runtime-instructions";

import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./persistence/sqlite/database";
import type {
  SqliteGoalRuntimeStore,
  SqliteGoalSessionRecord,
} from "./persistence/sqlite/store";

export type RuntimeSessionPersistenceErrorCode =
  | "runtime_session_not_found"
  | "runtime_session_recovery_required"
  | "provider_session_conflict"
  | "storage_failure";

export class RuntimeSessionPersistenceError extends Error {
  constructor(
    public readonly code: RuntimeSessionPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeSessionPersistenceError";
  }
}

export interface RuntimeSessionPersistencePort {
  get(ownerId: string, runtimeSessionId: string): Promise<AgentRuntimeSession | null>;
  ensure(ownerId: string, runtimeSessionId: string): Promise<AgentRuntimeSession>;
  bindProviderSession(input: {
    ownerId: string;
    runtimeSessionId: string;
    providerSessionId: string;
  }): Promise<void>;
  releaseProviderSession(ownerId: string, runtimeSessionId: string): Promise<void>;
}

export class InMemoryRuntimeSessionPersistence
  implements RuntimeSessionPersistencePort
{
  private readonly sessions = new Map<string, AgentRuntimeSession>();

  constructor(
    private readonly clock: RuntimeClockPort = { now: () => new Date() },
  ) {}

  async get(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentRuntimeSession | null> {
    const session = this.sessions.get(identifier(runtimeSessionId, "runtimeSessionId"));
    return session?.ownerId === identifier(ownerId, "ownerId")
      ? structuredClone(session)
      : null;
  }

  async ensure(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentRuntimeSession> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.ownerId !== owner) throw sessionNotFound(sessionId);
      return structuredClone(existing);
    }
    const now = this.clock.now().toISOString();
    const session: AgentRuntimeSession = {
      id: sessionId,
      ownerId: owner,
      provider: "claude",
      state: "starting",
      runEpoch: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    return structuredClone(session);
  }

  async bindProviderSession(input: {
    ownerId: string;
    runtimeSessionId: string;
    providerSessionId: string;
  }): Promise<void> {
    const session = await this.ensure(input.ownerId, input.runtimeSessionId);
    const providerSessionId = identifier(
      input.providerSessionId,
      "providerSessionId",
    );
    if (
      session.providerSessionId !== undefined &&
      session.providerSessionId !== providerSessionId
    ) {
      throw providerConflict(input.runtimeSessionId);
    }
    session.providerSessionId = providerSessionId;
    session.updatedAt = this.clock.now().toISOString();
    this.sessions.set(session.id, session);
  }

  async releaseProviderSession(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<void> {
    const session = await this.get(ownerId, runtimeSessionId);
    if (!session?.providerSessionId) return;
    const { providerSessionId: _providerSessionId, ...released } = session;
    released.updatedAt = this.clock.now().toISOString();
    this.sessions.set(session.id, released);
  }
}

/** Refuses to claim unfinished rows until durable restart recovery exists. */
export class SqliteRuntimeSessionPersistence
  implements RuntimeSessionPersistencePort
{
  private readonly database: SqliteGoalRuntimeDatabase;
  private readonly claimed = new Set<string>();
  private readonly providerLeases = new Map<string, string>();

  constructor(
    source: SqliteGoalRuntimeDatabaseSource,
    private readonly clock: RuntimeClockPort = { now: () => new Date() },
  ) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  async get(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentRuntimeSession | null> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const record = this.database.store.getSession(owner, sessionId);
    return record ? mapSession(record) : null;
  }

  async ensure(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentRuntimeSession> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const claim = scope(owner, sessionId);
    try {
      const record = this.database.immediate((store) => {
        const byId = store.getSessionById(sessionId);
        if (byId) {
          if (byId.ownerId !== owner) throw sessionNotFound(sessionId);
          if (!this.claimed.has(claim)) {
            if (requiresRecovery(store, byId)) {
              throw new RuntimeSessionPersistenceError(
                "runtime_session_recovery_required",
                `Runtime Session ${sessionId} has unfinished Goal state and requires restart recovery`,
              );
            }
            if (byId.providerSessionId) {
              store.clearProviderSession({
                ownerId: owner,
                runtimeSessionId: sessionId,
                expectedProviderSessionId: byId.providerSessionId,
                updatedAtSeconds: Math.floor(this.clock.now().getTime() / 1_000),
              });
              return store.getSession(owner, sessionId) ?? byId;
            }
          }
          return byId;
        }
        if (!store.hasUser(owner)) throw sessionNotFound(sessionId);
        const now = Math.floor(this.clock.now().getTime() / 1_000);
        store.insertSession({ ownerId: owner, runtimeSessionId: sessionId, recordedAtSeconds: now });
        const inserted = store.getSession(owner, sessionId);
        if (!inserted) throw storageFailure("Could not read the created Runtime Session");
        return inserted;
      });
      this.claimed.add(claim);
      return mapSession(record);
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not ensure the Runtime Session", cause);
    }
  }

  async bindProviderSession(input: {
    ownerId: string;
    runtimeSessionId: string;
    providerSessionId: string;
  }): Promise<void> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(input.runtimeSessionId, "runtimeSessionId");
    const providerSessionId = identifier(input.providerSessionId, "providerSessionId");
    await this.ensure(ownerId, runtimeSessionId);
    try {
      this.database.immediate((store) => {
        const current = store.getSession(ownerId, runtimeSessionId);
        if (!current) throw sessionNotFound(runtimeSessionId);
        if (current.providerSessionId === providerSessionId) return;
        if (current.providerSessionId !== undefined) {
          throw providerConflict(runtimeSessionId);
        }
        const assigned = store.getSessionByProviderSessionId(providerSessionId);
        if (assigned && assigned.runtimeSessionId !== runtimeSessionId) {
          throw providerConflict(runtimeSessionId);
        }
        const changed = store.bindProviderSession({
          ownerId,
          runtimeSessionId,
          providerSessionId,
          updatedAtSeconds: Math.floor(this.clock.now().getTime() / 1_000),
        });
        if (!changed) throw providerConflict(runtimeSessionId);
      });
      this.providerLeases.set(scope(ownerId, runtimeSessionId), providerSessionId);
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not bind the Claude provider session", cause);
    }
  }

  async releaseProviderSession(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<void> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const claim = scope(owner, sessionId);
    const providerSessionId = this.providerLeases.get(claim);
    if (!providerSessionId) return;
    try {
      this.database.immediate((store) => {
        store.clearProviderSession({
          ownerId: owner,
          runtimeSessionId: sessionId,
          expectedProviderSessionId: providerSessionId,
          updatedAtSeconds: Math.floor(this.clock.now().getTime() / 1_000),
        });
      });
      this.providerLeases.delete(claim);
    } catch (cause) {
      throw storageFailure("Could not release the Claude provider session", cause);
    }
  }
}

function mapSession(record: SqliteGoalSessionRecord): AgentRuntimeSession {
  return {
    id: record.runtimeSessionId,
    ownerId: record.ownerId,
    provider: record.provider,
    state: record.state,
    runEpoch: record.runEpoch,
    ...(record.providerSessionId === undefined
      ? {}
      : { providerSessionId: record.providerSessionId }),
    createdAt: new Date(record.createdAtSeconds * 1_000).toISOString(),
    updatedAt: new Date(record.updatedAtSeconds * 1_000).toISOString(),
  };
}

function requiresRecovery(
  store: SqliteGoalRuntimeStore,
  session: SqliteGoalSessionRecord,
): boolean {
  if (session.pendingOperation !== undefined) return true;
  if (store.getAssignedPrimaryGoal(session.ownerId, session.runtimeSessionId)) {
    return true;
  }
  if (
    store
      .listRuns(session.ownerId, session.runtimeSessionId)
      .some((run) =>
        ["queued", "running", "evaluating", "continuing", "paused", "blocked"].includes(
          run.status,
        ),
      )
  ) {
    return true;
  }
  return store
    .listDeliveries(session.ownerId, session.runtimeSessionId)
    .some((delivery) =>
      ["pending", "leased", "queued", "written_to_sdk", "observed"].includes(
        delivery.state,
      ),
    );
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value;
}

function scope(ownerId: string, runtimeSessionId: string): string {
  return JSON.stringify([ownerId, runtimeSessionId]);
}

function sessionNotFound(runtimeSessionId: string): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError(
    "runtime_session_not_found",
    `Runtime Session ${runtimeSessionId} was not found for this user`,
  );
}

function providerConflict(runtimeSessionId: string): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError(
    "provider_session_conflict",
    `Runtime Session ${runtimeSessionId} is already bound to another Claude session`,
  );
}

function storageFailure(message: string, cause?: unknown): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError("storage_failure", message, { cause });
}
