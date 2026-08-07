import type {
  ActivateGoalRequest,
  PublicAgentGoal,
  PublicGoalSummary,
  UpdateGoalRequest,
} from "./api";

export interface GoalDraftItem {
  id: string;
  description: string;
}

export interface GoalDraft {
  objective: string;
  criteria: GoalDraftItem[];
  constraints: GoalDraftItem[];
  priority: string;
  maxTurns: string;
  maxTokens: string;
  maxDurationSeconds: string;
  deadline: string;
}

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

export function blankGoalDraft(): GoalDraft {
  return {
    objective: "",
    criteria: [{ id: "criterion-1", description: "" }],
    constraints: [],
    priority: "50",
    maxTurns: "12",
    maxTokens: "",
    maxDurationSeconds: "",
    deadline: "",
  };
}

export function goalDraft(goal: PublicAgentGoal): GoalDraft {
  return {
    objective: goal.objective,
    criteria: goal.successCriteria.map(({ id, description }) => ({
      id,
      description,
    })),
    constraints: goal.constraints.map(({ id, description }) => ({
      id,
      description,
    })),
    priority: String(goal.priority),
    maxTurns: goal.maxTurns === undefined ? "" : String(goal.maxTurns),
    maxTokens: goal.maxTokens === undefined ? "" : String(goal.maxTokens),
    maxDurationSeconds:
      goal.maxDurationSeconds === undefined
        ? ""
        : String(goal.maxDurationSeconds),
    deadline: goal.deadline ? toLocalDateTime(goal.deadline) : "",
  };
}

export function validateGoalDraft(
  draft: GoalDraft,
  requireMaxTurns = true,
): string | null {
  if (!draft.objective.trim()) return "objective";
  if (!draft.criteria.length || draft.criteria.some((item) => !item.description.trim())) {
    return "criteria";
  }
  if (draft.constraints.some((item) => !item.description.trim())) {
    return "constraints";
  }
  const priority = parseInteger(draft.priority);
  if (priority === undefined || priority < 0 || priority > 100) return "priority";
  const budgets = [draft.maxTurns, draft.maxTokens, draft.maxDurationSeconds];
  if (requireMaxTurns && parsePositiveInteger(draft.maxTurns) === undefined) {
    return "budget";
  }
  const limits = [10_000, 100_000_000, 30 * 24 * 60 * 60];
  if (
    budgets.some((value, index) => {
      if (!value) return false;
      const parsed = parsePositiveInteger(value);
      const limit = limits[index];
      return limit === undefined || parsed === undefined || parsed > limit;
    })
  ) {
    return "budget";
  }
  if (!draft.deadline && budgets.every((value) => !value)) return "budget";
  if (draft.deadline && Number.isNaN(new Date(draft.deadline).getTime())) {
    return "deadline";
  }
  return null;
}

export function goalInputFromDraft(
  draft: GoalDraft,
): ActivateGoalRequest["goal"] {
  return {
    objective: draft.objective.trim(),
    successCriteria: draft.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description.trim(),
      verification: { type: "model_evidence" as const },
      required: true,
    })),
    constraints: draft.constraints.map((constraint) => ({
      id: constraint.id,
      description: constraint.description.trim(),
      enforcement: "model_guidance" as const,
    })),
    priority: Number(draft.priority),
    maxTurns: Number(draft.maxTurns || 12),
    ...(draft.deadline ? { deadline: new Date(draft.deadline).toISOString() } : {}),
    ...(draft.maxTokens ? { maxTokens: Number(draft.maxTokens) } : {}),
    ...(draft.maxDurationSeconds
      ? { maxDurationSeconds: Number(draft.maxDurationSeconds) }
      : {}),
    completionPolicy: "model_evaluator",
  };
}

export function goalUpdateFromDraft(
  draft: GoalDraft,
): UpdateGoalRequest["update"] {
  return {
    objective: draft.objective.trim(),
    priority: Number(draft.priority),
    deadline: draft.deadline
      ? new Date(draft.deadline).toISOString()
      : null,
    maxTurns: draft.maxTurns ? Number(draft.maxTurns) : null,
    maxTokens: draft.maxTokens ? Number(draft.maxTokens) : null,
    maxDurationSeconds: draft.maxDurationSeconds
      ? Number(draft.maxDurationSeconds)
      : null,
  };
}

export function goalProgressPercent(summary: PublicGoalSummary): number {
  const { completedCriteria, totalCriteria } = summary.progress;
  if (totalCriteria === 0) return 0;
  return Math.min(100, Math.round((completedCriteria / totalCriteria) * 100));
}

export function shouldPollGoal(summary?: PublicGoalSummary): boolean {
  return summary?.goal.status === "active";
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
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

function parsePositiveInteger(value: string): number | undefined {
  const number = parseInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
