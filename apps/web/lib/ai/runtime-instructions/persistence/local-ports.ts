/**
 * Local port extensions used by apps/web on top of the workspace
 * `@openloomi/ai/agent/runtime-instructions` AgentGoalStatePort contract.
 *
 * Keep the evaluator and recovery fencing fields explicit at the application
 * boundary shared by the in-memory and sqlite implementations.
 */
import type {
  AgentGoal,
  AgentGoalStatePort,
  GoalEvaluationResult,
  GoalEvaluationTransitionCommit,
} from "@openloomi/ai/agent/runtime-instructions";

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
