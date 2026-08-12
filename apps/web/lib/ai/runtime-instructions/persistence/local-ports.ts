/**
 * Local port extensions used by apps/web that build on the published
 * `@melandlabs/ai/agent/runtime-instructions` AgentGoalStatePort contract.
 *
 * The published port omits the `evaluation` and `runtimeLeaseToken` fields on
 * `commitEvaluationTransition`. OpenLoomi's in-memory and sqlite
 * implementations both accept those fields, so we declare a structurally
 * wider port here for callers that need them.
 */
import type {
  AgentGoal,
  AgentGoalStatePort,
  GoalEvaluationResult,
  GoalEvaluationTransitionCommit,
} from "@melandlabs/ai/agent/runtime-instructions";

export interface LocalAgentGoalStatePort extends AgentGoalStatePort {
  commitEvaluationTransition(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedRevision: number;
    expectedRunEpoch: number;
    goal: AgentGoal;
    evaluation?: GoalEvaluationResult;
    runtimeLeaseToken?: string;
  }): Promise<GoalEvaluationTransitionCommit>;
}

export type { AgentGoalStatePort };
