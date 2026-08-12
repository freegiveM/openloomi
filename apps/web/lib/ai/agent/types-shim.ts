/**
 * Local structural shim for supplemental-input types that the published
 * `@melandlabs/ai/agent/supplemental-input` (v0.2.0) does not re-export, or
 * that have been narrowed in the published build relative to the previous
 * local `@openloomi/ai/agent/supplemental-input`. We declare the minimal
 * shape that apps/web code (and its tests) actually use.
 */

export type AgentSupplementalInputIntent = "steer" | "inform";

export interface AgentSupplementalInput {
  id: string;
  content: string;
  createdAt: string;
  intent?: AgentSupplementalInputIntent;
  /** Provider-side run epoch this input belongs to. Optional at the type
   *  level because the published implementation does not surface it. */
  runEpoch?: number;
}

export interface AgentSupplementalInputSource {
  hasPending?: () => boolean;
  close?: () => void;
  takePendingInform?: (limit?: number) => AgentSupplementalInput[] | AsyncIterable<AgentSupplementalInput>;
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentSupplementalInput>;
}

/**
 * The published @melandlabs/ai package dropped these two named types.
 * Restore just enough structure for apps/web runtime consumers.
 */
export type CompactionPlatform = string;
export interface ConversationWindowMessage {
  role: "user" | "assistant" | "system" | "tool" | string;
  content: string;
  [key: string]: unknown;
}

// ----------------------------------------------------------------------------
// Claude Goal Runtime restart-recovery types
//
// Main's #530 PR (e242ffcf + 0689ac70) added the durable recovery subsystem.
// The supporting types lived in the now-deleted
// `packages/ai/src/agent/types.ts`; the published @melandlabs/ai does not
// re-export them. Vendoring the structural shapes here lets the new
// coordinator / claude-runtime / tests compile without re-introducing a
// workspace dependency.
// ----------------------------------------------------------------------------

export interface AgentRuntimeInstructionSettlement {
  instructionId: string;
  finalState: string;
  observedAt: string;
  attempt: number;
}

export interface AgentRuntimeRecoveryContinuationResult {
  status: "running" | "completed" | "blocked" | "paused" | "failed" | "expired";
  detail?: string;
}

export interface AgentRuntimeRecoveryGoalFinalizationResult {
  status:
    | "completed"
    | "blocked"
    | "failed"
    | "paused"
    | "expired"
    | "cancelled";
  detail?: string;
}

export interface AgentRuntimeRecovery {
  /** Durable OpenLoomi Runtime Session identity. */
  runtimeSessionId: string;
  /** Exact provider session that must be resumed (never forked). */
  providerSessionId: string;
  /** Persisted provider working directory. */
  workingDirectory: string;
  /** Persisted runtime fencing epoch. */
  runEpoch: number;
  /** Opaque durable recovery claim issued by the trusted persistence layer. */
  recoveryLeaseToken?: string;
  /**
   * Durable delivery settlement used to rebuild process-local dispatcher
   * progress before the outbox is replayed. An explicit empty list means the
   * coordinator verified that every canonical instruction remains retryable.
   */
  instructionSettlements: readonly AgentRuntimeInstructionSettlement[];
  /**
   * Called only after Claude confirms that the expected provider session was
   * resumed and any settlement-aware outbox replay has finished. The host may
   * repair an interrupted evaluation and ask the attached GoalController for
   * one canonical continuation through `continueGoal`.
   */
  onProviderSessionInitialized?: (context: {
    runtimeSessionId: string;
    providerSessionId: string;
    runEpoch: number;
    continueGoal: () => Promise<AgentRuntimeRecoveryContinuationResult>;
    finalizeGoalWithoutContinuation?: () => Promise<AgentRuntimeRecoveryGoalFinalizationResult>;
  }) => void | Promise<void>;
}
