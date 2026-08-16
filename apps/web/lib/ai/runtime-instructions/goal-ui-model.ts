import type {
  AgentGoalCommandResponse,
  AgentGoalDetailResponse,
  PublicAgentGoal,
  PublicGoalSummary,
} from "./api";

export interface GoalCommandIdempotencyKeys {
  keyFor(command: string, request: unknown): string;
  clear(command: string, request: unknown): void;
}

export interface GoalStartSingleFlight<T> {
  run(input: {
    runtimeSessionId: string;
    objective: string;
    start: () => Promise<T>;
    onPendingChange?: (objective: string | undefined) => void;
    conflictError?: () => Error;
  }): Promise<T>;
}

export interface GoalActivationFlow {
  activate: () => Promise<AgentGoalCommandResponse>;
  refresh: () => unknown | PromiseLike<unknown>;
  startFallback: () => unknown | PromiseLike<unknown>;
  onRefreshError?: (error: unknown) => void;
  onFallbackError: (error: unknown) => void;
}

export type GoalComposerSubmission =
  | { kind: "chat" }
  | { kind: "open" }
  | { kind: "start"; objective: string }
  | { kind: "reject_attachments" };

/** Matches only `/goal` or `/goal <objective>` at the start of the composer. */
export function parseGoalCommand(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1]?.trim() ?? "") : null;
}

export function resolveGoalComposerSubmission(
  text: string,
  attachmentCount: number,
): GoalComposerSubmission {
  const objective = parseGoalCommand(text);
  if (objective === null) return { kind: "chat" };
  if (attachmentCount > 0) return { kind: "reject_attachments" };
  return objective ? { kind: "start", objective } : { kind: "open" };
}

export function createGoalCommandIdempotencyKeys(
  createKey: () => string = () => crypto.randomUUID(),
): GoalCommandIdempotencyKeys {
  const pending = new Map<string, string>();

  return {
    keyFor(command, request) {
      const fingerprint = commandFingerprint(command, request);
      const existing = pending.get(fingerprint);
      if (existing) return existing;

      const key = createKey();
      pending.set(fingerprint, key);
      return key;
    },
    clear(command, request) {
      pending.delete(commandFingerprint(command, request));
    },
  };
}

/**
 * Keeps Goal planning single-flight per chat. Durable idempotency remains the
 * server-side safety net; this gate prevents duplicate browser requests and
 * exposes the pending objective for immediate UI feedback.
 */
export function createGoalStartSingleFlight<T>(): GoalStartSingleFlight<T> {
  const pending = new Map<string, { objective: string; promise: Promise<T> }>();

  return {
    run({
      runtimeSessionId,
      objective,
      start,
      onPendingChange,
      conflictError,
    }) {
      const existing = pending.get(runtimeSessionId);
      if (existing) {
        if (existing.objective === objective) return existing.promise;
        return Promise.reject(
          conflictError?.() ??
            new Error("A Goal is already being planned for this chat."),
        );
      }

      onPendingChange?.(objective);
      const promise = Promise.resolve()
        .then(start)
        .finally(() => {
          if (pending.get(runtimeSessionId)?.promise !== promise) return;
          pending.delete(runtimeSessionId);
          onPendingChange?.(undefined);
        });
      pending.set(runtimeSessionId, { objective, promise });
      return promise;
    },
  };
}

/**
 * Ends the interactive planning request as soon as activation succeeds while
 * keeping the Goal refresh and first chat turn supervised in the background.
 */
export async function activateGoalWithChatFallback({
  activate,
  refresh,
  startFallback,
  onRefreshError,
  onFallbackError,
}: GoalActivationFlow): Promise<AgentGoalCommandResponse> {
  const response = await activate();

  runGoalBackgroundAction(refresh, onRefreshError);
  if (response.dispatch.status === "unavailable") {
    runGoalBackgroundAction(startFallback, onFallbackError);
  }

  return response;
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

function runGoalBackgroundAction(
  action: () => unknown | PromiseLike<unknown>,
  onError?: (error: unknown) => void,
): void {
  try {
    void Promise.resolve(action()).catch((error) => {
      reportGoalBackgroundError(onError, error);
    });
  } catch (error) {
    reportGoalBackgroundError(onError, error);
  }
}

function reportGoalBackgroundError(
  onError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    onError?.(error);
  } catch {
    // A reporting failure must not turn a supervised background task into an
    // unhandled rejection.
  }
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
