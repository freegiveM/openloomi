import { isAbsolute } from "node:path";

import {
  assertDeliveryStateTransition,
  assertGoalStatusTransition,
  assertGoalRunStatusTransition,
  assertRuntimeSessionStateTransition,
  type AgentGoalRun,
  type AgentRuntimeSession,
  type GoalEvidence,
  type PersistedAgentGoal,
  type RuntimeClockPort,
  type RuntimeInstruction,
  type RuntimeSessionState,
} from "@openloomi/ai/agent/runtime-instructions";

import type { AgentRuntimePendingOperation } from "@/lib/db/agent-goal-runtime-schema-types";

import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./persistence/sqlite/database";
import type {
  SqliteGoalRuntimeStore,
  SqliteGoalSessionRecord,
} from "./persistence/sqlite/store";
import type { PersistedRuntimeInstructionDelivery } from "./persistence/runtime-observation-mappers";

export type RuntimeSessionPersistenceErrorCode =
  | "runtime_session_not_found"
  | "runtime_session_recovery_required"
  | "runtime_recovery_claim_conflict"
  | "runtime_recovery_configuration_invalid"
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

/**
 * Provider-neutral, credential-free options required to recreate a runtime.
 * API keys, base URLs, auth tokens, and provider-specific configuration are
 * intentionally absent; the recovery host resolves those from current trusted
 * application configuration.
 */
export interface RuntimeRecoveryDescriptor {
  readonly schemaVersion: 1;
  readonly model?: string;
  readonly thinkingLevel?: "disabled" | "low" | "adaptive";
  readonly permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly excludedTools?: readonly string[];
  readonly sandbox?: {
    readonly enabled: boolean;
    readonly provider?: string;
    readonly image?: string;
  };
  readonly skillsConfig?: RuntimeRecoveryFeatureSources;
  readonly mcpConfig?: RuntimeRecoveryFeatureSources;
}

export interface RuntimeRecoveryFeatureSources {
  readonly enabled: boolean;
  readonly userDirEnabled: boolean;
  readonly appDirEnabled: boolean;
}

export interface RuntimeSessionEnsureOptions {
  readonly workingDirectory?: string;
  readonly recoveryDescriptor?: RuntimeRecoveryDescriptor;
  /** Trusted token returned by `claimRecovery`; never accepted from HTTP. */
  readonly recoveryLeaseToken?: string;
}

export interface RuntimeRecoveryCandidate {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly providerSessionId?: string;
  readonly workingDirectory?: string;
  readonly runEpoch: number;
  readonly updatedAt: string;
}

/** Internal read model used only to reconnect the desktop UI to live recovery. */
export interface RuntimeRecoveryPresentationSession {
  readonly runtimeSessionId: string;
  readonly state: RuntimeSessionState;
  readonly runEpoch: number;
  readonly updatedAt: string;
}

export interface RuntimeRecoveryInstructionSettlement {
  readonly instructionId: string;
  readonly disposition: "accepted" | "superseded";
  readonly recordedAt: string;
  readonly providerEventId?: string;
  readonly reason?: string;
}

export interface RuntimeRecoverySnapshot {
  readonly session: AgentRuntimeSession;
  readonly recoveryDescriptor?: RuntimeRecoveryDescriptor;
  readonly activeGoal?: PersistedAgentGoal;
  readonly pendingOperation?: AgentRuntimePendingOperation;
  readonly runs: readonly AgentGoalRun[];
  readonly instructions: readonly RuntimeInstruction[];
  readonly deliveries: readonly PersistedRuntimeInstructionDelivery[];
  readonly evidence: readonly GoalEvidence[];
  readonly replayableInstructionIds: readonly string[];
  readonly instructionSettlements: readonly RuntimeRecoveryInstructionSettlement[];
  readonly reconciliation: {
    readonly evaluationsReset: number;
    readonly leasesReclaimed: number;
    readonly queuedAttemptsRetried: number;
    readonly writtenAttemptsRetried: number;
    readonly expired: number;
    readonly superseded: number;
  };
}

export interface RuntimeRecoveryClaim {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly snapshot: RuntimeRecoverySnapshot;
}

/**
 * Durable ownership of an ordinary, already-running provider session.
 * Unlike a recovery claim, acquiring this lease never reconciles persisted
 * Goal state or Delivery attempts.
 */
export interface RuntimeLiveSessionLease {
  readonly ownerId: string;
  readonly runtimeSessionId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly state: RuntimeSessionState;
  readonly runEpoch: number;
}

export interface RuntimeSessionLeaseFence {
  readonly runtimeLeaseToken: string;
  readonly expectedRunEpoch: number;
}

export interface RuntimeSessionRecoveryPersistencePort extends RuntimeSessionPersistencePort {
  claimLiveRuntime(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseDurationMs?: number;
    workingDirectory?: string;
    recoveryDescriptor?: RuntimeRecoveryDescriptor;
  }): Promise<RuntimeLiveSessionLease | null>;
  releaseLiveRuntime(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
    expectedRunEpoch: number;
  }): Promise<AgentRuntimeSession>;
  listRecoverable(limit?: number): Promise<RuntimeRecoveryCandidate[]>;
  claimRecovery(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseDurationMs?: number;
  }): Promise<RuntimeRecoveryClaim | null>;
  refreshRecovery(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
  }): Promise<RuntimeRecoverySnapshot>;
  renewRecoveryLease(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
    leaseDurationMs?: number;
  }): Promise<string>;
  releaseRecoveryLease(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
  }): Promise<void>;
  persistState(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedState: RuntimeSessionState;
    expectedRunEpoch: number;
    state: RuntimeSessionState;
    recoveryLeaseToken?: string;
  }): Promise<AgentRuntimeSession>;
  pauseAfterRecoveryFailure(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
    expectedRunEpoch: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
}

export interface RuntimeSessionPersistencePort {
  get(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentRuntimeSession | null>;
  ensure(
    ownerId: string,
    runtimeSessionId: string,
    options?: RuntimeSessionEnsureOptions,
  ): Promise<AgentRuntimeSession>;
  bindProviderSession(input: {
    ownerId: string;
    runtimeSessionId: string;
    providerSessionId: string;
    runtimeLeaseToken?: string;
    expectedRunEpoch?: number;
  }): Promise<void>;
  releaseProviderSession(
    ownerId: string,
    runtimeSessionId: string,
    fence?: RuntimeSessionLeaseFence,
  ): Promise<void>;
}

export class InMemoryRuntimeSessionPersistence implements RuntimeSessionPersistencePort {
  private readonly sessions = new Map<string, AgentRuntimeSession>();

  constructor(
    private readonly clock: RuntimeClockPort = { now: () => new Date() },
  ) {}

  async get(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentRuntimeSession | null> {
    const session = this.sessions.get(
      identifier(runtimeSessionId, "runtimeSessionId"),
    );
    return session?.ownerId === identifier(ownerId, "ownerId")
      ? structuredClone(session)
      : null;
  }

  async ensure(
    ownerId: string,
    runtimeSessionId: string,
    options: RuntimeSessionEnsureOptions = {},
  ): Promise<AgentRuntimeSession> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.ownerId !== owner) throw sessionNotFound(sessionId);
      const workingDirectory = options.workingDirectory
        ? workingDirectoryPath(options.workingDirectory)
        : existing.workingDirectory;
      if (workingDirectory === existing.workingDirectory) {
        return structuredClone(existing);
      }
      const updated = {
        ...existing,
        workingDirectory,
        updatedAt: this.clock.now().toISOString(),
      };
      this.sessions.set(sessionId, updated);
      return structuredClone(updated);
    }
    const now = this.clock.now().toISOString();
    const session: AgentRuntimeSession = {
      id: sessionId,
      ownerId: owner,
      provider: "claude",
      ...(options.workingDirectory === undefined
        ? {}
        : { workingDirectory: workingDirectoryPath(options.workingDirectory) }),
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
    runtimeLeaseToken?: string;
    expectedRunEpoch?: number;
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
    _fence?: RuntimeSessionLeaseFence,
  ): Promise<void> {
    const session = await this.get(ownerId, runtimeSessionId);
    if (!session?.providerSessionId) return;
    const { providerSessionId: _providerSessionId, ...released } = session;
    released.updatedAt = this.clock.now().toISOString();
    this.sessions.set(session.id, released);
  }
}

export class SqliteRuntimeSessionPersistence implements RuntimeSessionRecoveryPersistencePort {
  private readonly database: SqliteGoalRuntimeDatabase;
  /** Process-local capabilities backed by durable, expiring SQLite leases. */
  private readonly claimed = new Map<
    string,
    { leaseOwner: string; leaseToken: string; runEpoch: number }
  >();

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
    options: RuntimeSessionEnsureOptions = {},
  ): Promise<AgentRuntimeSession> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const claim = scope(owner, sessionId);
    const metadata = parseEnsureOptions(options);
    try {
      const record = this.database.immediate((store) => {
        const byId = store.getSessionById(sessionId);
        if (byId) {
          if (byId.ownerId !== owner) throw sessionNotFound(sessionId);
          const localClaim = this.claimed.get(claim);
          const recoveryToken = metadata.recoveryLeaseToken;
          const leaseIsCurrent =
            byId.recoveryLeaseExpiresAtSeconds !== undefined &&
            byId.recoveryLeaseExpiresAtSeconds > nowSeconds(this.clock);
          const tokenAuthorizesRecovery =
            recoveryToken !== undefined &&
            byId.recoveryLeaseToken === recoveryToken &&
            leaseIsCurrent;
          const localClaimIsCurrent =
            localClaim !== undefined &&
            byId.recoveryLeaseToken === localClaim.leaseToken &&
            byId.recoveryLeaseOwner === localClaim.leaseOwner &&
            leaseIsCurrent;
          if (recoveryToken !== undefined && !tokenAuthorizesRecovery) {
            throw recoveryClaimConflict(sessionId);
          }
          if (
            leaseIsCurrent &&
            !localClaimIsCurrent &&
            !tokenAuthorizesRecovery
          ) {
            throw recoveryClaimConflict(sessionId);
          }
          if (!localClaimIsCurrent && !tokenAuthorizesRecovery) {
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
                updatedAtSeconds: Math.floor(
                  this.clock.now().getTime() / 1_000,
                ),
              });
              return store.getSession(owner, sessionId) ?? byId;
            }
          }
          const workingDirectory =
            metadata.workingDirectory ?? byId.workingDirectory;
          const recoveryDescriptor =
            metadata.recoveryDescriptor ?? parseStoredDescriptor(byId);
          if (
            workingDirectory !== byId.workingDirectory ||
            canonicalJson(recoveryDescriptor) !==
              canonicalJson(parseStoredDescriptor(byId))
          ) {
            if (
              !store.updateSessionRecoveryMetadata({
                ownerId: owner,
                runtimeSessionId: sessionId,
                workingDirectory,
                recoveryDescriptor,
                updatedAtSeconds: nowSeconds(this.clock),
              })
            ) {
              throw storageFailure(
                "Could not persist Runtime recovery metadata",
              );
            }
          }
          return store.getSession(owner, sessionId) ?? byId;
        }
        if (!store.hasUser(owner)) throw sessionNotFound(sessionId);
        if (metadata.recoveryLeaseToken !== undefined) {
          throw recoveryClaimConflict(sessionId);
        }
        const now = nowSeconds(this.clock);
        store.insertSession({
          ownerId: owner,
          runtimeSessionId: sessionId,
          ...(metadata.workingDirectory === undefined
            ? {}
            : { workingDirectory: metadata.workingDirectory }),
          ...(metadata.recoveryDescriptor === undefined
            ? {}
            : { recoveryDescriptor: metadata.recoveryDescriptor }),
          recordedAtSeconds: now,
        });
        const inserted = store.getSession(owner, sessionId);
        if (!inserted)
          throw storageFailure("Could not read the created Runtime Session");
        return inserted;
      });
      if (metadata.recoveryLeaseToken !== undefined) {
        const leaseOwner = record.recoveryLeaseOwner;
        if (!leaseOwner) throw recoveryClaimConflict(sessionId);
        this.claimed.set(claim, {
          leaseOwner,
          leaseToken: metadata.recoveryLeaseToken,
          runEpoch: record.runEpoch,
        });
      }
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
    runtimeLeaseToken?: string;
    expectedRunEpoch?: number;
  }): Promise<void> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    const providerSessionId = identifier(
      input.providerSessionId,
      "providerSessionId",
    );
    const localClaim = this.claimed.get(scope(ownerId, runtimeSessionId));
    const suppliedLeaseToken =
      input.runtimeLeaseToken ?? localClaim?.leaseToken;
    const suppliedRunEpoch = input.expectedRunEpoch ?? localClaim?.runEpoch;
    if (suppliedLeaseToken === undefined || suppliedRunEpoch === undefined) {
      throw recoveryClaimConflict(runtimeSessionId);
    }
    const runtimeLeaseToken = identifier(
      suppliedLeaseToken,
      "runtimeLeaseToken",
    );
    const expectedRunEpoch = nonNegativeInteger(
      suppliedRunEpoch,
      "expectedRunEpoch",
    );
    try {
      this.database.immediate((store) => {
        const current = store.getSession(ownerId, runtimeSessionId);
        if (!current) throw sessionNotFound(runtimeSessionId);
        const now = nowSeconds(this.clock);
        if (
          current.recoveryLeaseToken !== runtimeLeaseToken ||
          current.recoveryLeaseExpiresAtSeconds === undefined ||
          current.recoveryLeaseExpiresAtSeconds <= now ||
          current.runEpoch !== expectedRunEpoch
        ) {
          throw recoveryClaimConflict(runtimeSessionId);
        }
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
          runtimeLeaseToken,
          expectedRunEpoch,
          availableAtSeconds: now,
          updatedAtSeconds: now,
        });
        if (!changed) throw providerConflict(runtimeSessionId);
      });
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not bind the Claude provider session", cause);
    }
  }

  async releaseProviderSession(
    ownerId: string,
    runtimeSessionId: string,
    fence?: RuntimeSessionLeaseFence,
  ): Promise<void> {
    const owner = identifier(ownerId, "ownerId");
    const sessionId = identifier(runtimeSessionId, "runtimeSessionId");
    const claim = scope(owner, sessionId);
    const localClaim = this.claimed.get(claim);
    const suppliedLeaseToken =
      fence?.runtimeLeaseToken ?? localClaim?.leaseToken;
    const suppliedRunEpoch = fence?.expectedRunEpoch ?? localClaim?.runEpoch;
    if (suppliedLeaseToken === undefined || suppliedRunEpoch === undefined) {
      throw recoveryClaimConflict(sessionId);
    }
    const runtimeLeaseToken = identifier(
      suppliedLeaseToken,
      "runtimeLeaseToken",
    );
    const expectedRunEpoch = nonNegativeInteger(
      suppliedRunEpoch,
      "expectedRunEpoch",
    );
    try {
      this.database.immediate((store) => {
        const session = store.getSession(owner, sessionId);
        const now = nowSeconds(this.clock);
        if (
          !session ||
          session.recoveryLeaseToken !== runtimeLeaseToken ||
          session.recoveryLeaseExpiresAtSeconds === undefined ||
          session.recoveryLeaseExpiresAtSeconds <= now ||
          session.runEpoch !== expectedRunEpoch
        ) {
          throw recoveryClaimConflict(sessionId);
        }
        // The provider session identity is the only resume handle. Keep it
        // while durable Goal/Run state is unfinished; a process-local lease is
        // not proof that the provider session itself should be forgotten.
        if (
          session.providerSessionId &&
          !store.hasUnfinishedRuntimeState(owner, sessionId)
        ) {
          if (
            !store.clearProviderSession({
              ownerId: owner,
              runtimeSessionId: sessionId,
              expectedProviderSessionId: session.providerSessionId,
              updatedAtSeconds: now,
            })
          ) {
            throw providerConflict(sessionId);
          }
        }
      });
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure(
        "Could not release the Claude provider session",
        cause,
      );
    }
  }

  async listRecoverable(limit = 100): Promise<RuntimeRecoveryCandidate[]> {
    const parsedLimit = positiveInteger(limit, "limit", 500);
    try {
      const store = this.database.store;
      return store
        .listRecoverableSessionIds(nowSeconds(this.clock), parsedLimit)
        .flatMap(({ ownerId, runtimeSessionId }) => {
          const session = store.getSession(ownerId, runtimeSessionId);
          return session
            ? [
                {
                  ownerId,
                  runtimeSessionId,
                  ...(session.providerSessionId === undefined
                    ? {}
                    : { providerSessionId: session.providerSessionId }),
                  ...(session.workingDirectory === undefined
                    ? {}
                    : { workingDirectory: session.workingDirectory }),
                  runEpoch: session.runEpoch,
                  updatedAt: secondsIso(session.updatedAtSeconds),
                },
              ]
            : [];
        });
    } catch (cause) {
      throw storageFailure(
        "Could not list recoverable Runtime Sessions",
        cause,
      );
    }
  }

  async listRecoveryPresentationSessions(
    ownerId: string,
    limit = 20,
  ): Promise<RuntimeRecoveryPresentationSession[]> {
    const owner = identifier(ownerId, "ownerId");
    const parsedLimit = positiveInteger(limit, "limit", 100);
    try {
      const store = this.database.store;
      return store
        .listRecoveryPresentationSessionIds(owner, parsedLimit)
        .flatMap((runtimeSessionId) => {
          const session = store.getSession(owner, runtimeSessionId);
          return session
            ? [
                {
                  runtimeSessionId,
                  state: session.state,
                  runEpoch: session.runEpoch,
                  updatedAt: secondsIso(session.updatedAtSeconds),
                },
              ]
            : [];
        });
    } catch (cause) {
      throw storageFailure(
        "Could not list Runtime Sessions for recovery presentation",
        cause,
      );
    }
  }

  async claimLiveRuntime(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseDurationMs?: number;
    workingDirectory?: string;
    recoveryDescriptor?: RuntimeRecoveryDescriptor;
  }): Promise<RuntimeLiveSessionLease | null> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    const leaseOwner = identifier(input.leaseOwner, "leaseOwner");
    const leaseDurationMs = recoveryLeaseDuration(input.leaseDurationMs);
    const metadata = parseEnsureOptions({
      ...(input.workingDirectory === undefined
        ? {}
        : { workingDirectory: input.workingDirectory }),
      ...(input.recoveryDescriptor === undefined
        ? {}
        : { recoveryDescriptor: input.recoveryDescriptor }),
    });
    const leaseToken = crypto.randomUUID();
    const now = nowSeconds(this.clock);
    const leaseExpiresAtSeconds = now + Math.ceil(leaseDurationMs / 1_000);
    try {
      const session = this.database.immediate((store) => {
        let current = store.getSessionById(runtimeSessionId);
        let inserted = false;
        if (current) {
          if (current.ownerId !== ownerId)
            throw sessionNotFound(runtimeSessionId);
        } else {
          if (!store.hasUser(ownerId)) throw sessionNotFound(runtimeSessionId);
          store.insertSession({
            ownerId,
            runtimeSessionId,
            ...(metadata.workingDirectory === undefined
              ? {}
              : { workingDirectory: metadata.workingDirectory }),
            ...(metadata.recoveryDescriptor === undefined
              ? {}
              : { recoveryDescriptor: metadata.recoveryDescriptor }),
            recordedAtSeconds: now,
          });
          current = store.getSession(ownerId, runtimeSessionId);
          if (!current) {
            throw storageFailure("Could not read the created Runtime Session");
          }
          inserted = true;
        }
        if (
          !store.claimLiveRuntimeLease({
            ownerId,
            runtimeSessionId,
            leaseOwner,
            leaseToken,
            availableAtSeconds: now,
            leaseExpiresAtSeconds,
            updatedAtSeconds: now,
          })
        ) {
          if (inserted) {
            throw storageFailure(
              "Could not claim the newly created Runtime Session",
            );
          }
          return null;
        }
        if (current.providerSessionId) {
          if (
            !store.clearProviderSession({
              ownerId,
              runtimeSessionId,
              expectedProviderSessionId: current.providerSessionId,
              updatedAtSeconds: now,
            })
          ) {
            throw providerConflict(runtimeSessionId);
          }
        }
        const workingDirectory =
          metadata.workingDirectory ?? current.workingDirectory;
        const descriptor =
          metadata.recoveryDescriptor ?? parseStoredDescriptor(current);
        if (
          workingDirectory !== current.workingDirectory ||
          canonicalJson(descriptor) !==
            canonicalJson(parseStoredDescriptor(current))
        ) {
          if (
            !store.updateSessionRecoveryMetadata({
              ownerId,
              runtimeSessionId,
              workingDirectory,
              recoveryDescriptor: descriptor,
              updatedAtSeconds: now,
            })
          ) {
            throw storageFailure("Could not persist Runtime recovery metadata");
          }
        }
        return store.getSession(ownerId, runtimeSessionId) ?? current;
      });
      if (!session) return null;
      this.claimed.set(scope(ownerId, runtimeSessionId), {
        leaseOwner,
        leaseToken,
        runEpoch: session.runEpoch,
      });
      return {
        ownerId,
        runtimeSessionId,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: secondsIso(leaseExpiresAtSeconds),
        state: session.state,
        runEpoch: session.runEpoch,
      };
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure(
        "Could not claim live Runtime Session ownership",
        cause,
      );
    }
  }

  async releaseLiveRuntime(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
    expectedRunEpoch: number;
  }): Promise<AgentRuntimeSession> {
    const parsed = recoveryLeaseInput(input);
    const expectedRunEpoch = nonNegativeInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const now = nowSeconds(this.clock);
    try {
      const session = this.database.immediate((store) => {
        if (
          !store.releaseLiveRuntimeLease({
            ...parsed,
            expectedRunEpoch,
            availableAtSeconds: now,
            updatedAtSeconds: now,
          })
        ) {
          throw recoveryClaimConflict(parsed.runtimeSessionId);
        }
        const released = store.getSession(
          parsed.ownerId,
          parsed.runtimeSessionId,
        );
        if (!released) throw sessionNotFound(parsed.runtimeSessionId);
        return released;
      });
      const claim = scope(parsed.ownerId, parsed.runtimeSessionId);
      if (this.claimed.get(claim)?.leaseToken === parsed.leaseToken) {
        this.claimed.delete(claim);
      }
      return mapSession(session);
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure(
        "Could not release live Runtime Session ownership",
        cause,
      );
    }
  }

  async claimRecovery(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseDurationMs?: number;
  }): Promise<RuntimeRecoveryClaim | null> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    const leaseOwner = identifier(input.leaseOwner, "leaseOwner");
    const leaseDurationMs = recoveryLeaseDuration(input.leaseDurationMs);
    const leaseToken = crypto.randomUUID();
    const now = nowSeconds(this.clock);
    const leaseExpiresAtSeconds = now + Math.ceil(leaseDurationMs / 1_000);
    try {
      const snapshot = this.database.immediate((store) => {
        const session = store.getSession(ownerId, runtimeSessionId);
        if (!session) throw sessionNotFound(runtimeSessionId);
        if (
          !store.claimRecoveryLease({
            ownerId,
            runtimeSessionId,
            leaseOwner,
            leaseToken,
            availableAtSeconds: now,
            leaseExpiresAtSeconds,
            updatedAtSeconds: now,
          })
        ) {
          return null;
        }
        return reconcileAndSnapshot(
          store,
          store.getSession(ownerId, runtimeSessionId) ?? session,
          this.clock.now(),
        );
      });
      if (!snapshot) return null;
      this.claimed.set(scope(ownerId, runtimeSessionId), {
        leaseOwner,
        leaseToken,
        runEpoch: snapshot.session.runEpoch,
      });
      return {
        ownerId,
        runtimeSessionId,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: secondsIso(leaseExpiresAtSeconds),
        snapshot,
      };
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not claim Runtime Session recovery", cause);
    }
  }

  async refreshRecovery(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
  }): Promise<RuntimeRecoverySnapshot> {
    const parsed = recoveryLeaseInput(input);
    try {
      return this.database.immediate((store) => {
        const session = store.getSession(
          parsed.ownerId,
          parsed.runtimeSessionId,
        );
        if (
          !session ||
          session.recoveryLeaseOwner !== parsed.leaseOwner ||
          session.recoveryLeaseToken !== parsed.leaseToken ||
          session.recoveryLeaseExpiresAtSeconds === undefined ||
          session.recoveryLeaseExpiresAtSeconds <= nowSeconds(this.clock)
        ) {
          throw recoveryClaimConflict(parsed.runtimeSessionId);
        }
        return reconcileAndSnapshot(store, session, this.clock.now());
      });
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure(
        "Could not refresh Runtime recovery snapshot",
        cause,
      );
    }
  }

  async renewRecoveryLease(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
    leaseDurationMs?: number;
  }): Promise<string> {
    const parsed = recoveryLeaseInput(input);
    const now = nowSeconds(this.clock);
    const expiresAt =
      now + Math.ceil(recoveryLeaseDuration(input.leaseDurationMs) / 1_000);
    try {
      const renewed = this.database.immediate((store) =>
        store.renewRecoveryLease({
          ...parsed,
          availableAtSeconds: now,
          leaseExpiresAtSeconds: expiresAt,
          updatedAtSeconds: now,
        }),
      );
      if (!renewed) throw recoveryClaimConflict(parsed.runtimeSessionId);
      return secondsIso(expiresAt);
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not renew Runtime recovery lease", cause);
    }
  }

  async releaseRecoveryLease(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
  }): Promise<void> {
    const parsed = recoveryLeaseInput(input);
    const now = nowSeconds(this.clock);
    try {
      const released = this.database.immediate((store) =>
        store.releaseRecoveryLease({
          ...parsed,
          availableAtSeconds: now,
          updatedAtSeconds: now,
        }),
      );
      if (!released) throw recoveryClaimConflict(parsed.runtimeSessionId);
      const localClaim = this.claimed.get(
        scope(parsed.ownerId, parsed.runtimeSessionId),
      );
      if (localClaim?.leaseToken === parsed.leaseToken) {
        this.claimed.delete(scope(parsed.ownerId, parsed.runtimeSessionId));
      }
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not release Runtime recovery lease", cause);
    }
  }

  async persistState(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedState: RuntimeSessionState;
    expectedRunEpoch: number;
    state: RuntimeSessionState;
    recoveryLeaseToken?: string;
  }): Promise<AgentRuntimeSession> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const runtimeSessionId = identifier(
      input.runtimeSessionId,
      "runtimeSessionId",
    );
    if (input.expectedState !== input.state) {
      assertRuntimeSessionStateTransition(input.expectedState, input.state);
    }
    try {
      return this.database.immediate((store) => {
        const current = store.getSession(ownerId, runtimeSessionId);
        if (!current) throw sessionNotFound(runtimeSessionId);
        const recoveryLeaseToken =
          input.recoveryLeaseToken === undefined
            ? undefined
            : identifier(input.recoveryLeaseToken, "recoveryLeaseToken");
        if (
          current.state !== input.expectedState ||
          current.runEpoch !== input.expectedRunEpoch ||
          (recoveryLeaseToken === undefined
            ? current.recoveryLeaseToken !== undefined
            : current.recoveryLeaseToken !== recoveryLeaseToken ||
              current.recoveryLeaseExpiresAtSeconds === undefined ||
              current.recoveryLeaseExpiresAtSeconds <= nowSeconds(this.clock))
        ) {
          throw recoveryClaimConflict(runtimeSessionId);
        }
        if (current.state !== input.state) {
          const changed = store.updateSessionState({
            ownerId,
            runtimeSessionId,
            expectedState: input.expectedState,
            expectedRunEpoch: input.expectedRunEpoch,
            state: input.state,
            ...(recoveryLeaseToken === undefined ? {} : { recoveryLeaseToken }),
            updatedAtSeconds: nowSeconds(this.clock),
          });
          if (!changed) throw recoveryClaimConflict(runtimeSessionId);
        }
        const updated = store.getSession(ownerId, runtimeSessionId);
        if (!updated) throw sessionNotFound(runtimeSessionId);
        return mapSession(updated);
      });
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not persist Runtime Session state", cause);
    }
  }

  async pauseAfterRecoveryFailure(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseOwner: string;
    leaseToken: string;
    expectedRunEpoch: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const parsed = recoveryLeaseInput(input);
    const expectedRunEpoch = nonNegativeInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const errorCode = boundedText(input.errorCode, "errorCode", 128);
    const errorMessage = boundedText(input.errorMessage, "errorMessage", 8_000);
    try {
      const paused = this.database.immediate((store) => {
        const session = store.getSession(
          parsed.ownerId,
          parsed.runtimeSessionId,
        );
        if (
          !session ||
          session.recoveryLeaseOwner !== parsed.leaseOwner ||
          session.recoveryLeaseToken !== parsed.leaseToken ||
          session.runEpoch !== expectedRunEpoch ||
          session.recoveryLeaseExpiresAtSeconds === undefined ||
          session.recoveryLeaseExpiresAtSeconds <= nowSeconds(this.clock)
        ) {
          return false;
        }
        if (session.state !== "idle") {
          assertRuntimeSessionStateTransition(session.state, "idle");
        }
        const at = this.clock.now().toISOString();
        const assigned = store.getAssignedPrimaryGoal(
          parsed.ownerId,
          parsed.runtimeSessionId,
        );
        if (assigned?.persistedGoal.goal.status === "active") {
          const currentGoal = assigned.persistedGoal;
          assertGoalStatusTransition(currentGoal.goal.status, "paused");
          const pausedGoal: PersistedAgentGoal = {
            ...currentGoal,
            goal: {
              ...currentGoal.goal,
              revision: currentGoal.goal.revision + 1,
              status: "paused",
              updatedAt: at,
            },
          };
          const failureEvaluation = {
            completed: false,
            confidence: 0,
            satisfiedCriteria: [],
            missingCriteria: currentGoal.goal.successCriteria
              .filter((criterion) => criterion.required)
              .map((criterion) => criterion.id),
            evidence: [],
            reason: `Goal recovery paused (${errorCode}): ${errorMessage}`.slice(
              0,
              8_000,
            ),
          };
          if (
            !store.updateGoal(
              pausedGoal,
              currentGoal.goal.revision,
              "assigned",
              "assigned",
            )
          ) {
            throw storageFailure(
              "Could not pause the Goal after recovery failure",
            );
          }
          const run = store.findRun(
            parsed.ownerId,
            parsed.runtimeSessionId,
            currentGoal.goal.id,
            session.runEpoch,
          );
          if (
            run &&
            ["queued", "running", "evaluating", "continuing"].includes(
              run.status,
            )
          ) {
            assertGoalRunStatusTransition(run.status, "paused");
            if (
              !store.updateRun(
                run,
                {
                  ...run,
                  goalRevision: pausedGoal.goal.revision,
                  status: "paused",
                  lastActivityAt: at,
                  completedAt: undefined,
                  lastEvaluation: failureEvaluation,
                },
                at,
              )
            ) {
              throw storageFailure(
                "Could not pause the Goal Run after recovery failure",
              );
            }
          }
        }
        return store.pauseAfterRecoveryFailure({
          ...parsed,
          expectedRunEpoch,
          updatedAtSeconds: nowSeconds(this.clock),
        });
      });
      if (!paused) throw recoveryClaimConflict(parsed.runtimeSessionId);
      this.claimed.delete(scope(parsed.ownerId, parsed.runtimeSessionId));
    } catch (cause) {
      if (cause instanceof RuntimeSessionPersistenceError) throw cause;
      throw storageFailure("Could not pause Runtime recovery", cause);
    }
  }
}

function reconcileAndSnapshot(
  store: SqliteGoalRuntimeStore,
  session: SqliteGoalSessionRecord,
  now: Date,
): RuntimeRecoverySnapshot {
  const recordedAt = now.toISOString();
  const instructions = store.listStoredInstructions(
    session.ownerId,
    session.runtimeSessionId,
  );
  const instructionById = new Map(
    instructions.map((stored) => [stored.instruction.id, stored]),
  );
  const activeGoal = store.getAssignedPrimaryGoal(
    session.ownerId,
    session.runtimeSessionId,
  )?.persistedGoal;
  const deliveryOnlyRecovery = store.hasDeliveryOnlyRecoveryState(
    session.ownerId,
    session.runtimeSessionId,
  );
  const reconciliation = {
    evaluationsReset: 0,
    leasesReclaimed: 0,
    queuedAttemptsRetried: 0,
    writtenAttemptsRetried: 0,
    expired: 0,
    superseded: 0,
  };

  for (const run of store.listRuns(session.ownerId, session.runtimeSessionId)) {
    if (run.status !== "evaluating") continue;
    assertGoalRunStatusTransition(run.status, "running");
    if (
      !store.updateRun(
        run,
        { ...run, status: "running", lastActivityAt: recordedAt },
        recordedAt,
      )
    ) {
      throw storageFailure(`Could not reset evaluating Goal Run ${run.id}`);
    }
    reconciliation.evaluationsReset += 1;
  }

  for (const delivery of store.listDeliveries(
    session.ownerId,
    session.runtimeSessionId,
  )) {
    if (!isRecoverableDelivery(delivery.state)) continue;
    const stored = instructionById.get(delivery.instructionId);
    const instruction = stored?.instruction;
    const expired =
      instruction?.expiresAt !== undefined &&
      Date.parse(instruction.expiresAt) <= now.getTime();
    const stale =
      !stored ||
      stored.runEpoch !== session.runEpoch ||
      delivery.runEpoch !== session.runEpoch ||
      (!deliveryOnlyRecovery &&
        instruction?.goalId !== undefined &&
        (activeGoal?.goal.id !== instruction.goalId ||
          activeGoal.goal.revision !== instruction.goalRevision));

    if (delivery.state === "observed") {
      // An observed Delivery crossed the provider boundary before the host
      // disappeared. Claiming the abandoned runtime establishes the missing
      // terminal boundary, so a still-current attempt can be made durable as
      // applied without replaying it to the provider. Never apply an observed
      // attempt from an obsolete epoch or Goal revision.
      transitionRecoveryDelivery(
        store,
        delivery,
        stale ? "failed" : "applied",
        recordedAt,
        stale
          ? {
              errorCode: "stale_runtime_fence",
              errorMessage:
                "Observed instruction belongs to a stale Goal revision or run epoch",
            }
          : {},
      );
      if (stale) reconciliation.superseded += 1;
      continue;
    }

    if (expired) {
      transitionRecoveryDelivery(
        store,
        delivery,
        delivery.state === "written_to_sdk" ? "failed" : "expired",
        recordedAt,
        {
          errorCode: "instruction_expired",
          errorMessage: "Instruction expired while the runtime was offline",
        },
      );
      reconciliation.expired += 1;
      continue;
    }
    if (stale) {
      transitionRecoveryDelivery(
        store,
        delivery,
        delivery.state === "written_to_sdk" ? "failed" : "superseded",
        recordedAt,
        {
          errorCode: "stale_runtime_fence",
          errorMessage:
            "Instruction belongs to a stale Goal revision or run epoch",
        },
      );
      reconciliation.superseded += 1;
      continue;
    }
    if (deliveryOnlyRecovery) {
      transitionRecoveryDelivery(
        store,
        delivery,
        delivery.state === "written_to_sdk" ? "failed" : "superseded",
        recordedAt,
        {
          errorCode: "runtime_execution_already_terminal",
          errorMessage:
            "Instruction remained unsettled after its Goal execution reached a terminal state",
        },
      );
      reconciliation.superseded += 1;
      continue;
    }
    if (delivery.state === "leased") {
      transitionRecoveryDelivery(store, delivery, "pending", recordedAt);
      reconciliation.leasesReclaimed += 1;
      continue;
    }
    if (delivery.state === "queued") {
      retryRecoveryDelivery(store, delivery, recordedAt, {
        errorCode: "runtime_restarted_before_provider_write",
        errorMessage:
          "Queued delivery was not durably observed by the provider before restart",
      });
      reconciliation.queuedAttemptsRetried += 1;
      continue;
    }
    if (delivery.state === "written_to_sdk") {
      retryRecoveryDelivery(store, delivery, recordedAt, {
        errorCode: "runtime_restarted_before_provider_observation",
        errorMessage:
          "Delivery reached the SDK input boundary but was not durably observed by the provider before restart",
      });
      reconciliation.writtenAttemptsRetried += 1;
    }
  }

  const runs = store.listRuns(session.ownerId, session.runtimeSessionId);
  const deliveries = store.listDeliveries(
    session.ownerId,
    session.runtimeSessionId,
  );
  const evidence = runs.flatMap((run) =>
    store.listEvidenceByRun(session.ownerId, session.runtimeSessionId, run.id),
  );
  const progress = recoveryInstructionProgress(instructions, deliveries);
  return {
    session: mapSession(
      store.getSession(session.ownerId, session.runtimeSessionId) ?? session,
    ),
    ...(parseStoredDescriptor(session) === undefined
      ? {}
      : { recoveryDescriptor: parseStoredDescriptor(session) }),
    ...(activeGoal === undefined ? {} : { activeGoal }),
    ...(session.pendingOperation === undefined
      ? {}
      : { pendingOperation: structuredClone(session.pendingOperation) }),
    runs,
    instructions: instructions.map((stored) => stored.instruction),
    deliveries,
    evidence,
    replayableInstructionIds: progress.replayableInstructionIds,
    instructionSettlements: progress.instructionSettlements,
    reconciliation,
  };
}

function recoveryInstructionProgress(
  instructions: ReturnType<SqliteGoalRuntimeStore["listStoredInstructions"]>,
  deliveries: readonly PersistedRuntimeInstructionDelivery[],
): Pick<
  RuntimeRecoverySnapshot,
  "replayableInstructionIds" | "instructionSettlements"
> {
  const replayableInstructionIds: string[] = [];
  const instructionSettlements: RuntimeRecoveryInstructionSettlement[] = [];
  for (const stored of instructions) {
    const attempts = deliveries.filter(
      (delivery) => delivery.instructionId === stored.instruction.id,
    );
    const visible = attempts.find((delivery) =>
      isProviderObservedDelivery(delivery.state),
    );
    if (visible) {
      instructionSettlements.push({
        instructionId: stored.instruction.id,
        disposition: "accepted",
        recordedAt: visible.updatedAt,
        ...(visible.providerEventId === undefined
          ? {}
          : { providerEventId: visible.providerEventId }),
      });
      continue;
    }
    if (attempts.some((delivery) => delivery.state === "pending")) {
      replayableInstructionIds.push(stored.instruction.id);
      continue;
    }
    const terminal = attempts.at(-1);
    if (terminal && isTerminalDelivery(terminal.state)) {
      instructionSettlements.push({
        instructionId: stored.instruction.id,
        disposition: "superseded",
        recordedAt: terminal.updatedAt,
        reason:
          terminal.errorMessage ??
          `Instruction settled as ${terminal.state} before recovery`,
      });
    }
  }
  return { replayableInstructionIds, instructionSettlements };
}

function transitionRecoveryDelivery(
  store: SqliteGoalRuntimeStore,
  current: PersistedRuntimeInstructionDelivery,
  state: PersistedRuntimeInstructionDelivery["state"],
  recordedAt: string,
  fields: Pick<
    PersistedRuntimeInstructionDelivery,
    "errorCode" | "errorMessage"
  > = {},
): void {
  assertDeliveryStateTransition(current.state, state);
  const next: PersistedRuntimeInstructionDelivery = {
    ...current,
    state,
    updatedAt: recordedAt,
    leaseToken: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    ...fields,
  };
  if (!store.updateDelivery(current, next)) {
    throw storageFailure(`Could not reconcile Delivery ${current.id}`);
  }
}

function retryRecoveryDelivery(
  store: SqliteGoalRuntimeStore,
  delivery: PersistedRuntimeInstructionDelivery,
  recordedAt: string,
  fields: Pick<
    PersistedRuntimeInstructionDelivery,
    "errorCode" | "errorMessage"
  >,
): void {
  transitionRecoveryDelivery(store, delivery, "failed", recordedAt, fields);
  store.insertPendingDelivery({
    id: crypto.randomUUID(),
    ownerId: delivery.ownerId,
    runtimeSessionId: delivery.runtimeSessionId,
    instructionId: delivery.instructionId,
    ...(delivery.goalRunId === undefined
      ? {}
      : { goalRunId: delivery.goalRunId }),
    runEpoch: delivery.runEpoch,
    attempt: delivery.attempt + 1,
    availableAt: recordedAt,
    recordedAt,
  });
}

function isRecoverableDelivery(
  state: PersistedRuntimeInstructionDelivery["state"],
): boolean {
  return (
    state === "pending" ||
    state === "leased" ||
    state === "queued" ||
    state === "written_to_sdk" ||
    state === "observed"
  );
}

function isProviderObservedDelivery(
  state: PersistedRuntimeInstructionDelivery["state"],
): boolean {
  return state === "observed" || state === "applied" || state === "completed";
}

function isTerminalDelivery(
  state: PersistedRuntimeInstructionDelivery["state"],
): boolean {
  return (
    state === "rejected" ||
    state === "expired" ||
    state === "superseded" ||
    state === "cancelled" ||
    state === "failed"
  );
}

function mapSession(record: SqliteGoalSessionRecord): AgentRuntimeSession {
  return {
    id: record.runtimeSessionId,
    ownerId: record.ownerId,
    provider: record.provider,
    ...(record.workingDirectory === undefined
      ? {}
      : { workingDirectory: record.workingDirectory }),
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
  if (
    store.isWaitingForFirstProviderRuntime(
      session.ownerId,
      session.runtimeSessionId,
    )
  ) {
    return false;
  }
  if (session.pendingOperation !== undefined) return true;
  if (store.getAssignedPrimaryGoal(session.ownerId, session.runtimeSessionId)) {
    return true;
  }
  if (
    store
      .listRuns(session.ownerId, session.runtimeSessionId)
      .some((run) =>
        [
          "queued",
          "running",
          "evaluating",
          "continuing",
          "paused",
          "blocked",
        ].includes(run.status),
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
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value;
}

function scope(ownerId: string, runtimeSessionId: string): string {
  return JSON.stringify([ownerId, runtimeSessionId]);
}

function sessionNotFound(
  runtimeSessionId: string,
): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError(
    "runtime_session_not_found",
    `Runtime Session ${runtimeSessionId} was not found for this user`,
  );
}

function providerConflict(
  runtimeSessionId: string,
): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError(
    "provider_session_conflict",
    `Runtime Session ${runtimeSessionId} is already bound to another Claude session`,
  );
}

function storageFailure(
  message: string,
  cause?: unknown,
): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError("storage_failure", message, {
    cause,
  });
}

function recoveryClaimConflict(
  runtimeSessionId: string,
): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError(
    "runtime_recovery_claim_conflict",
    `Runtime Session ${runtimeSessionId} is not owned by this recovery claim`,
  );
}

function parseEnsureOptions(
  options: RuntimeSessionEnsureOptions,
): RuntimeSessionEnsureOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Runtime Session options must be an object");
  }
  return {
    ...(options.workingDirectory === undefined
      ? {}
      : { workingDirectory: workingDirectoryPath(options.workingDirectory) }),
    ...(options.recoveryDescriptor === undefined
      ? {}
      : { recoveryDescriptor: recoveryDescriptor(options.recoveryDescriptor) }),
    ...(options.recoveryLeaseToken === undefined
      ? {}
      : {
          recoveryLeaseToken: identifier(
            options.recoveryLeaseToken,
            "recoveryLeaseToken",
          ),
        }),
  };
}

function parseStoredDescriptor(
  session: SqliteGoalSessionRecord,
): RuntimeRecoveryDescriptor | undefined {
  return session.recoveryDescriptor === undefined
    ? undefined
    : recoveryDescriptor(session.recoveryDescriptor);
}

function recoveryDescriptor(value: unknown): RuntimeRecoveryDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recoveryConfigurationInvalid("Recovery descriptor must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "schemaVersion",
    "model",
    "thinkingLevel",
    "permissionMode",
    "allowedTools",
    "disallowedTools",
    "excludedTools",
    "sandbox",
    "skillsConfig",
    "mcpConfig",
  ]);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw recoveryConfigurationInvalid(
      `Recovery descriptor contains unsupported field ${unknownKey}`,
    );
  }
  if (record.schemaVersion !== 1) {
    throw recoveryConfigurationInvalid(
      "Recovery descriptor schemaVersion must be 1",
    );
  }
  const thinkingLevel = optionalLiteral(
    record.thinkingLevel,
    ["disabled", "low", "adaptive"] as const,
    "thinkingLevel",
  );
  const permissionMode = optionalLiteral(
    record.permissionMode,
    ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const,
    "permissionMode",
  );
  return {
    schemaVersion: 1,
    ...(record.model === undefined
      ? {}
      : { model: boundedText(record.model, "model", 256) }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(record.allowedTools === undefined
      ? {}
      : { allowedTools: stringList(record.allowedTools, "allowedTools") }),
    ...(record.disallowedTools === undefined
      ? {}
      : {
          disallowedTools: stringList(
            record.disallowedTools,
            "disallowedTools",
          ),
        }),
    ...(record.excludedTools === undefined
      ? {}
      : { excludedTools: stringList(record.excludedTools, "excludedTools") }),
    ...(record.sandbox === undefined
      ? {}
      : { sandbox: sandboxDescriptor(record.sandbox) }),
    ...(record.skillsConfig === undefined
      ? {}
      : { skillsConfig: featureSources(record.skillsConfig, "skillsConfig") }),
    ...(record.mcpConfig === undefined
      ? {}
      : { mcpConfig: featureSources(record.mcpConfig, "mcpConfig") }),
  };
}

function sandboxDescriptor(
  value: unknown,
): NonNullable<RuntimeRecoveryDescriptor["sandbox"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recoveryConfigurationInvalid("sandbox must be an object");
  }
  const record = value as Record<string, unknown>;
  const enabled = booleanValue(record.enabled, "sandbox.enabled");

  // Provider details have no effect while sandboxing is disabled. Older
  // clients may still send their previously saved provider, image, endpoint,
  // or network configuration, so discard it instead of persisting or
  // validating data that recovery will never consume.
  if (!enabled) return { enabled: false };

  const unknown = Object.keys(record).find(
    (key) => !["enabled", "provider", "image"].includes(key),
  );
  if (unknown) {
    throw recoveryConfigurationInvalid(
      `sandbox contains unsupported field ${unknown}`,
    );
  }
  return {
    enabled: true,
    ...(record.provider === undefined
      ? {}
      : { provider: boundedText(record.provider, "sandbox.provider", 128) }),
    ...(record.image === undefined
      ? {}
      : { image: credentialFreeSandboxImage(record.image) }),
  };
}

function credentialFreeSandboxImage(value: unknown): string {
  const image = boundedText(value, "sandbox.image", 512);
  // Container image references are names (optionally with a tag or digest),
  // not credential-bearing URLs. Query strings/fragments are likewise not
  // part of an OCI image reference and are common places for bearer secrets.
  if (image.includes("://") || image.includes("?") || image.includes("#")) {
    throw recoveryConfigurationInvalid(
      "sandbox.image must not contain a URL or embedded credentials",
    );
  }
  const at = image.indexOf("@");
  if (
    at !== -1 &&
    (image.indexOf("@", at + 1) !== -1 ||
      !/^[A-Za-z][A-Za-z0-9+._-]*:[A-Za-z0-9=_-]+$/.test(image.slice(at + 1)))
  ) {
    throw recoveryConfigurationInvalid(
      "sandbox.image must not contain embedded credentials",
    );
  }
  return image;
}

function featureSources(
  value: unknown,
  field: string,
): RuntimeRecoveryFeatureSources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recoveryConfigurationInvalid(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => !["enabled", "userDirEnabled", "appDirEnabled"].includes(key),
  );
  if (unknown) {
    throw recoveryConfigurationInvalid(
      `${field} contains unsupported field ${unknown}`,
    );
  }
  return {
    enabled: booleanValue(record.enabled, `${field}.enabled`),
    userDirEnabled: booleanValue(
      record.userDirEnabled,
      `${field}.userDirEnabled`,
    ),
    appDirEnabled: booleanValue(record.appDirEnabled, `${field}.appDirEnabled`),
  };
}

function recoveryConfigurationInvalid(
  message: string,
): RuntimeSessionPersistenceError {
  return new RuntimeSessionPersistenceError(
    "runtime_recovery_configuration_invalid",
    message,
  );
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw recoveryConfigurationInvalid(
      `${field} must be a bounded string list`,
    );
  }
  return value.map((item, index) =>
    boundedText(item, `${field}[${index}]`, 256),
  );
}

function optionalLiteral<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw recoveryConfigurationInvalid(`${field} is invalid`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw recoveryConfigurationInvalid(`${field} must be boolean`);
  }
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    throw new TypeError(`${field} must be non-empty bounded text`);
  }
  return value;
}

function workingDirectoryPath(value: unknown): string {
  const path = boundedText(value, "workingDirectory", 4_096);
  if (!isAbsolute(path)) {
    throw recoveryConfigurationInvalid("workingDirectory must be absolute");
  }
  return path;
}

function recoveryLeaseInput(input: {
  ownerId: string;
  runtimeSessionId: string;
  leaseOwner: string;
  leaseToken: string;
}) {
  return {
    ownerId: identifier(input.ownerId, "ownerId"),
    runtimeSessionId: identifier(input.runtimeSessionId, "runtimeSessionId"),
    leaseOwner: identifier(input.leaseOwner, "leaseOwner"),
    leaseToken: identifier(input.leaseToken, "leaseToken"),
  };
}

function recoveryLeaseDuration(value: number | undefined): number {
  const duration = value ?? 30_000;
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1_000 ||
    duration > 300_000
  ) {
    throw new TypeError("leaseDurationMs must be between 1 and 300 seconds");
  }
  return duration;
}

function positiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be a positive bounded integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function nowSeconds(clock: RuntimeClockPort): number {
  return Math.floor(clock.now().getTime() / 1_000);
}

function secondsIso(value: number): string {
  return new Date(value * 1_000).toISOString();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
