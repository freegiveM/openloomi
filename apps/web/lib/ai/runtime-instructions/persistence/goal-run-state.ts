import {
  assertGoalRunStatusTransition,
  type AgentGoal,
  type AgentGoalRun,
  type GoalRunStatus,
} from "@openloomi/ai/agent/runtime-instructions";

import { AgentGoalStateError } from "../goal-state-error";

export function assertGoalRunMutationTransition(
  current: GoalRunStatus,
  next: GoalRunStatus,
): void {
  if (current === next) return;
  try {
    assertGoalRunStatusTransition(current, next);
  } catch (cause) {
    throw new AgentGoalStateError(
      "invalid_commit",
      `Goal Run transition ${current} -> ${next} is invalid for this Goal mutation`,
      cause,
    );
  }
}

export function goalRunStatusForEvaluation(
  status: AgentGoal["status"],
): GoalRunStatus {
  switch (status) {
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "completed":
      return "completed";
    case "expired":
    case "budget_limited":
      return "budget_limited";
    case "failed":
      return "failed";
    default:
      throw new AgentGoalStateError(
        "invalid_commit",
        `Goal status ${status} is not an evaluator-owned Run outcome`,
      );
  }
}

export function isTerminalGoalRunStatus(status: GoalRunStatus): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "budget_limited" ||
    status === "failed"
  );
}

export function monotonicGoalRunActivity(
  run: Pick<AgentGoalRun, "startedAt" | "lastActivityAt">,
  observedAt: Date | string,
): Date {
  const observedAtMillis =
    observedAt instanceof Date ? observedAt.getTime() : Date.parse(observedAt);
  const lowerBound = Math.max(
    Date.parse(run.startedAt),
    Date.parse(run.lastActivityAt),
  );
  return new Date(Math.max(observedAtMillis, lowerBound));
}
