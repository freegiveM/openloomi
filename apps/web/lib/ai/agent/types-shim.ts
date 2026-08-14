/**
 * Local structural shim for supplemental-input types that the published
 * `@melandlabs/ai/agent/supplemental-input` (v0.2.0) does not re-export, or
 * that have been narrowed in the published build relative to the previous
 * local `@openloomi/ai/agent/supplemental-input`. We declare the minimal
 * shape that apps/web code (and its tests) actually use.
 */

import type { AgentOptions as MelandAgentOptions } from "@melandlabs/ai/agent";
import type { AgentOptions as LocalAgentOptions } from "@openloomi/ai/agent/types";

export type {
  AgentRuntimeInstructionSettlement,
  AgentRuntimeRecovery,
  AgentRuntimeRecoveryContinuationResult,
  AgentRuntimeRecoveryGoalFinalizationResult,
} from "@openloomi/ai/agent/types";

/**
 * The provider base class stays on the published Agent contract. Goal Runtime
 * attachment and recovery are host-only additions supplied by the local
 * protocol until the published package exposes them.
 */
export type GoalRuntimeAgentOptions = MelandAgentOptions &
  Pick<LocalAgentOptions, "goalRuntimeSessionId" | "runtimeRecovery">;

export type AgentSupplementalInputIntent = "steer" | "inform";

export type AgentSupplementalInputSource = NonNullable<
  MelandAgentOptions["supplementalInput"]
>;

export type AgentSupplementalInput =
  AgentSupplementalInputSource extends AsyncIterable<infer Input>
    ? Input
    : never;

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
