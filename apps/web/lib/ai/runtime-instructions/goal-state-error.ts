export type AgentGoalStateErrorCode =
  | "active_primary_goal_conflict"
  | "goal_conflict"
  | "goal_not_found"
  | "idempotency_conflict"
  | "invalid_commit"
  | "lifecycle_transition_in_progress"
  | "lifecycle_transition_not_found"
  | "replacement_in_progress"
  | "replacement_not_found"
  | "run_epoch_conflict"
  | "revision_conflict";

/**
 * Storage-neutral failure raised by authoritative Goal state adapters.
 *
 * The codes intentionally match the in-memory adapter contract so callers do
 * not need dialect-specific error handling when durable persistence is wired.
 */
export class AgentGoalStateError extends Error {
  constructor(
    public readonly code: AgentGoalStateErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentGoalStateError";
  }
}
