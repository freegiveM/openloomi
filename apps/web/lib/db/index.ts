/**
 * Backward-compatible facade for `apps/web/lib/db`.
 *
 * During the runtime/UI split (Phase 4 onward), pure helpers have been moved
 * to `@openloomi/db` and re-exported here so existing import sites keep working.
 * The schema + queries stay in this folder for now; they will move in a later
 * phase once the boundary is consolidated.
 */
export { db } from "./queries";
export * from "./schema";
export { batchInsert, DB_INSERT_CHUNK_SIZE } from "@openloomi/db/batch";
export {
  generateHashedPassword,
  generateDummyPassword,
} from "@openloomi/db/utils";
export type {
  AgentGoalSourceType,
  AgentGoalSnapshot,
  AgentGoalEvaluationSnapshot,
  AgentRuntimeInstructionSnapshot,
  AgentRuntimeInstructionPayload,
  AgentGoalEvidencePayload,
  AgentRuntimePendingOperation,
  AgentGoalCommandCheckpoint,
  AgentGoalSlot,
  AgentGoalSlotState,
  AgentGoalCommandType,
  AgentGoalCommandPhase,
  DeliveryState,
  GoalCompletionPolicy,
  GoalEvidenceType,
  GoalRunStatus,
  GoalStatus,
  RuntimeInstructionDeliveryMode,
  RuntimeInstructionKind,
  RuntimeInstructionSource,
  RuntimeProvider,
  RuntimeSessionState,
} from "@openloomi/db/agent-goal-runtime-schema-types";
export {
  addIdIfNeeded,
  executeTransaction,
  caseInsensitiveSearch,
  isValidUuid,
  hashPasswordResetToken,
  getDbInstance,
  isTauriMode,
} from "./shared";
