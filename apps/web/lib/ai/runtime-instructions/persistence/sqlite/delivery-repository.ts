import {
  DeliveryStateSchema,
  assertDeliveryStateTransition,
  type DeliveryState,
} from "@openloomi/ai/agent/runtime-instructions";

import { persistenceConflict } from "../errors";
import {
  buildPendingRuntimeDeliveryRecord,
  type PendingRuntimeDeliveryRecordInput,
} from "../internal/record-builders";
import type { PersistedRuntimeInstructionDelivery } from "../runtime-observation-mappers";
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
  positiveInteger,
  repositoryMutationError,
  requireCurrentEpoch,
  seconds,
  sqliteIso,
  type SqliteGoalPersistenceScope,
} from "./repository-helpers";

export interface SqliteDeliveryTransitionInput extends SqliteGoalPersistenceScope {
  readonly deliveryId: string;
  readonly expectedRunEpoch: number;
  readonly expectedState: DeliveryState;
  readonly nextState: DeliveryState;
  readonly updatedAt: string;
  readonly expectedLeaseToken?: string;
  readonly lease?: {
    readonly token: string;
    readonly owner: string;
    readonly expiresAt: string;
  };
  readonly availableAt?: string;
  readonly providerEventId?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

export class SqliteDeliveryRepository {
  private readonly database: SqliteGoalRuntimeDatabase;

  constructor(source: SqliteGoalRuntimeDatabaseSource) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
  }

  async getById(
    input: SqliteGoalPersistenceScope & { deliveryId: string },
  ): Promise<PersistedRuntimeInstructionDelivery | null> {
    const scope = normalizeScope(input);
    return this.database.store.getDelivery(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.deliveryId, "deliveryId"),
    );
  }

  async getActiveByInstruction(
    input: SqliteGoalPersistenceScope & { instructionId: string },
  ): Promise<PersistedRuntimeInstructionDelivery | null> {
    const scope = normalizeScope(input);
    return this.database.store.getActiveDeliveryForInstruction(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.instructionId, "instructionId"),
    );
  }

  async listAttempts(
    input: SqliteGoalPersistenceScope & { instructionId: string },
  ): Promise<PersistedRuntimeInstructionDelivery[]> {
    const scope = normalizeScope(input);
    return this.database.store.listDeliveryAttempts(
      scope.ownerId,
      scope.runtimeSessionId,
      normalizeIdentifier(input.instructionId, "instructionId"),
    );
  }

  async listDispatchable(
    input: SqliteGoalPersistenceScope & { availableAt: string; limit?: number },
  ): Promise<PersistedRuntimeInstructionDelivery[]> {
    const scope = normalizeScope(input);
    const limit = positiveInteger(input.limit ?? 100, "limit");
    if (limit > 1_000) {
      throw new TypeError("limit must be an integer between 1 and 1000");
    }
    return this.database.store.listDispatchableDeliveries(
      scope.ownerId,
      scope.runtimeSessionId,
      seconds(isoDate(input.availableAt, "availableAt")),
      limit,
    );
  }

  async createPending(
    input: PendingRuntimeDeliveryRecordInput,
  ): Promise<PersistedRuntimeInstructionDelivery> {
    const scope = normalizeScope(input);
    buildPendingRuntimeDeliveryRecord(input);
    const attempt = positiveInteger(input.attempt ?? 1, "attempt");
    const instructionId = normalizeIdentifier(
      input.instructionId,
      "instructionId",
    );
    const goalRunId =
      input.goalRunId === undefined
        ? undefined
        : normalizeIdentifier(input.goalRunId, "goalRunId");
    isoDate(input.availableAt, "availableAt");
    isoDate(input.recordedAt, "recordedAt");

    try {
      return this.database.immediate((store) => {
        requireCurrentEpoch(
          store.getSession(scope.ownerId, scope.runtimeSessionId),
          input.runEpoch,
        );
        const instruction = store.getInstruction(
          scope.ownerId,
          scope.runtimeSessionId,
          instructionId,
        );
        if (!instruction || instruction.runEpoch !== input.runEpoch) {
          throw persistenceConflict(
            "The Delivery does not match its Runtime Instruction",
            "conflict",
          );
        }
        if (goalRunId === undefined) {
          if (
            instruction.instruction.goalId !== undefined ||
            instruction.instruction.goalRevision !== undefined
          ) {
            throw persistenceConflict(
              "A Goal-bound Runtime Instruction Delivery requires its Goal Run",
              "conflict",
            );
          }
        } else {
          const run = store.getRun(
            scope.ownerId,
            scope.runtimeSessionId,
            goalRunId,
          );
          if (
            !run ||
            run.runEpoch !== input.runEpoch ||
            run.goalId !== instruction.instruction.goalId ||
            run.goalRevision !== instruction.instruction.goalRevision
          ) {
            throw persistenceConflict(
              "The Delivery Instruction and Goal Run do not match",
              "conflict",
            );
          }
        }

        const attempts = store.listDeliveryAttempts(
          scope.ownerId,
          scope.runtimeSessionId,
          instructionId,
        );
        const hasExpectedPredecessor =
          attempt === 1
            ? attempts.length === 0
            : attempts.some((candidate) => candidate.attempt === attempt - 1);
        if (!hasExpectedPredecessor) {
          throw persistenceConflict(
            "The Delivery attempt does not immediately follow persisted history",
            "conflict",
          );
        }

        store.insertPendingDelivery({ ...input, attempt, goalRunId });
        const inserted = store.getDelivery(
          scope.ownerId,
          scope.runtimeSessionId,
          input.id,
        );
        if (!inserted) {
          throw persistenceConflict("Could not read the created Delivery");
        }
        return inserted;
      });
    } catch (cause) {
      repositoryMutationError(
        "Could not create the pending Runtime Instruction Delivery",
        cause,
      );
    }
  }

  async transition(
    input: SqliteDeliveryTransitionInput,
  ): Promise<PersistedRuntimeInstructionDelivery | null> {
    const scope = normalizeScope(input);
    const deliveryId = normalizeIdentifier(input.deliveryId, "deliveryId");
    const expectedRunEpoch = nonNegativeInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const expectedState = parseState(input.expectedState, "expectedState");
    const nextState = parseState(input.nextState, "nextState");
    assertDeliveryStateTransition(expectedState, nextState);
    validateExpectedLease(expectedState, input.expectedLeaseToken);
    const updatedAt = isoDate(input.updatedAt, "updatedAt");
    const lease = materializeLease(nextState, input.lease, updatedAt);
    const availableAt = input.availableAt
      ? sqliteIso(isoDate(input.availableAt, "availableAt"))
      : undefined;
    const providerEventId = optionalIdentifier(
      input.providerEventId,
      "providerEventId",
    );
    const errorCode = optionalIdentifier(input.errorCode, "errorCode", 128);
    if (
      input.errorMessage !== undefined &&
      input.errorMessage !== null &&
      typeof input.errorMessage !== "string"
    ) {
      throw new TypeError("errorMessage must be a string or null");
    }

    try {
      return this.database.immediate((store) => {
        const session = store.getSession(scope.ownerId, scope.runtimeSessionId);
        const current = store.getDelivery(
          scope.ownerId,
          scope.runtimeSessionId,
          deliveryId,
        );
        if (
          !isCurrentEpoch(session, expectedRunEpoch) ||
          !current ||
          current.runEpoch !== expectedRunEpoch ||
          current.state !== expectedState ||
          Date.parse(current.updatedAt) > updatedAt.getTime() ||
          (input.expectedLeaseToken !== undefined &&
            current.leaseToken !== input.expectedLeaseToken)
        ) {
          return null;
        }
        const next: PersistedRuntimeInstructionDelivery = {
          ...current,
          state: nextState,
          updatedAt: sqliteIso(updatedAt),
          availableAt: availableAt ?? current.availableAt,
          ...(lease ?? {
            leaseToken: undefined,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
          }),
          ...(input.providerEventId === undefined
            ? {}
            : { providerEventId: providerEventId ?? undefined }),
          ...(input.errorCode === undefined
            ? {}
            : { errorCode: errorCode ?? undefined }),
          ...(input.errorMessage === undefined
            ? {}
            : { errorMessage: input.errorMessage ?? undefined }),
        };
        if (!store.updateDelivery(current, next)) return null;
        return store.getDelivery(
          scope.ownerId,
          scope.runtimeSessionId,
          deliveryId,
        );
      });
    } catch (cause) {
      repositoryMutationError(
        "Could not transition the Runtime Instruction Delivery",
        cause,
      );
    }
  }
}

function parseState(value: unknown, field: string): DeliveryState {
  const parsed = DeliveryStateSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${field} is not a Delivery state`);
  return parsed.data;
}

function validateExpectedLease(
  expectedState: DeliveryState,
  token: string | undefined,
): void {
  if (expectedState === "leased" && token === undefined) {
    throw new TypeError(
      "expectedLeaseToken is required when transitioning a leased delivery",
    );
  }
  if (expectedState !== "leased" && token !== undefined) {
    throw new TypeError(
      "expectedLeaseToken is only valid for a leased delivery",
    );
  }
  if (token !== undefined) normalizeIdentifier(token, "expectedLeaseToken");
}

function materializeLease(
  nextState: DeliveryState,
  input: SqliteDeliveryTransitionInput["lease"],
  updatedAt: Date,
):
  | Pick<
      PersistedRuntimeInstructionDelivery,
      "leaseToken" | "leaseOwner" | "leaseExpiresAt"
    >
  | undefined {
  if (nextState !== "leased") {
    if (input) throw new TypeError("lease is only valid for the leased state");
    return undefined;
  }
  if (!input) throw new TypeError("lease is required for the leased state");
  const expiresAt = isoDate(input.expiresAt, "lease.expiresAt");
  if (seconds(expiresAt) <= seconds(updatedAt)) {
    throw new TypeError(
      "lease.expiresAt must remain later than updatedAt at SQLite precision",
    );
  }
  return {
    leaseToken: normalizeIdentifier(input.token, "lease.token"),
    leaseOwner: normalizeIdentifier(input.owner, "lease.owner"),
    leaseExpiresAt: sqliteIso(expiresAt),
  };
}

function optionalIdentifier(
  value: string | null | undefined,
  field: string,
  maxCharacters = 256,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return normalizeIdentifier(value, field, maxCharacters);
}
