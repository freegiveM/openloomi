export type AgentGoalPersistenceErrorCode =
  | "invalid_record"
  | "conflict"
  | "idempotency_conflict"
  | "run_epoch_conflict";

export class AgentGoalPersistenceError extends Error {
  constructor(
    public readonly code: AgentGoalPersistenceErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentGoalPersistenceError";
  }
}

export function invalidPersistenceRecord(
  entity: string,
  message: string,
  cause?: unknown,
): never {
  throw new AgentGoalPersistenceError(
    "invalid_record",
    `Invalid persisted ${entity}: ${message}`,
    cause,
  );
}

export function persistenceConflict(
  message: string,
  code: Extract<
    AgentGoalPersistenceErrorCode,
    "conflict" | "idempotency_conflict" | "run_epoch_conflict"
  > = "conflict",
  cause?: unknown,
): AgentGoalPersistenceError {
  return new AgentGoalPersistenceError(code, message, cause);
}
