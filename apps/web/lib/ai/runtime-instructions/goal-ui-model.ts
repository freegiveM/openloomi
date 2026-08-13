import type {
  AgentGoalDetailResponse,
  PublicAgentGoal,
  PublicGoalSummary,
} from "./api";

export interface GoalCommandIdempotencyKeys {
  keyFor(command: string, request: unknown): string;
  clear(command: string, request: unknown): void;
}

export function createGoalCommandIdempotencyKeys(
  createKey: () => string = () => crypto.randomUUID(),
): GoalCommandIdempotencyKeys {
  let pending: { fingerprint: string; key: string } | undefined;

  return {
    keyFor(command, request) {
      const fingerprint = commandFingerprint(command, request);
      if (pending?.fingerprint !== fingerprint) {
        pending = { fingerprint, key: createKey() };
      }
      return pending.key;
    },
    clear(command, request) {
      if (pending?.fingerprint === commandFingerprint(command, request)) {
        pending = undefined;
      }
    },
  };
}

export interface GoalStepView {
  id: string;
  description: string;
  number: number;
  state: "completed" | "current" | "pending";
}

export interface GoalStepsView {
  steps: GoalStepView[];
  completed: number;
  total: number;
  percent: number;
}

export function goalStepsView(detail: AgentGoalDetailResponse): GoalStepsView {
  const satisfied = new Set(
    detail.latestRun?.lastEvaluation?.satisfiedCriteria ?? [],
  );
  for (const item of detail.evidence) {
    if (item.success && item.criterionId) satisfied.add(item.criterionId);
  }

  const completedRequiredIds = new Set<string>();
  let currentRequiredId: string | undefined;
  let requiredStepMissing = false;
  for (const step of detail.goal.successCriteria) {
    if (!step.required) continue;
    if (
      !requiredStepMissing &&
      (detail.goal.status === "completed" || satisfied.has(step.id))
    ) {
      completedRequiredIds.add(step.id);
      continue;
    }
    if (!requiredStepMissing) currentRequiredId = step.id;
    requiredStepMissing = true;
  }
  const steps = detail.goal.successCriteria.map((step, index) => {
    const completed = step.required
      ? completedRequiredIds.has(step.id)
      : satisfied.has(step.id);
    return {
      id: step.id,
      description: step.description,
      number: index + 1,
      state: completed
        ? ("completed" as const)
        : step.required && step.id === currentRequiredId
          ? ("current" as const)
          : ("pending" as const),
    };
  });
  const completed = completedRequiredIds.size;
  const total = detail.goal.successCriteria.filter(
    (step) => step.required,
  ).length;

  return {
    steps,
    completed,
    total,
    percent:
      total === 0
        ? detail.goal.status === "completed"
          ? 100
          : 0
        : Math.round((completed / total) * 100),
  };
}

export function shouldPollGoal(summary?: PublicGoalSummary): boolean {
  return summary?.goal.status === "active";
}

export function displayGoalStatus(
  status: PublicAgentGoal["status"],
): PublicAgentGoal["status"] {
  return status === "blocked" ? "paused" : status;
}

export function canResumeGoal(status: PublicAgentGoal["status"]): boolean {
  return status === "paused" || status === "blocked";
}

export function canCreateNewGoal(goals: PublicGoalSummary[]): boolean {
  return !goals.some(({ goal }) =>
    ["active", "paused", "blocked"].includes(goal.status),
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function commandFingerprint(command: string, request: unknown): string {
  return `${command}:${stableSerialize(request)}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
