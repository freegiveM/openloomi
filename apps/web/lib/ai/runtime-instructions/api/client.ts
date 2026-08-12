import type {
  ActivateGoalRequest,
  AgentGoalCommandResponse,
  AgentGoalDetailResponse,
  AgentGoalSessionResponse,
  RemoveGoalContextRequest,
  ResumeGoalRequest,
  UpdateGoalRequest,
  UpsertGoalContextRequest,
} from ".";

export class AgentGoalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: string,
  ) {
    super(details ?? code);
    this.name = "AgentGoalApiError";
  }
}

export function agentGoalSessionUrl(runtimeSessionId: string): string {
  return `/api/agent-goals?runtimeSessionId=${encodeURIComponent(runtimeSessionId)}`;
}

export function agentGoalDetailUrl(
  runtimeSessionId: string,
  goalId: string,
): string {
  return `/api/agent-goals/${encodeURIComponent(goalId)}?runtimeSessionId=${encodeURIComponent(runtimeSessionId)}`;
}

export async function fetchAgentGoalSession(
  runtimeSessionId: string,
): Promise<AgentGoalSessionResponse> {
  return requestJson(agentGoalSessionUrl(runtimeSessionId));
}

export async function fetchAgentGoalDetail(
  runtimeSessionId: string,
  goalId: string,
): Promise<AgentGoalDetailResponse> {
  return requestJson(agentGoalDetailUrl(runtimeSessionId, goalId));
}

export async function activateAgentGoal(
  request: ActivateGoalRequest,
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentGoalCommandResponse> {
  return requestJson("/api/agent-goals", commandRequest("POST", request, idempotencyKey));
}

export async function updateAgentGoal(
  goalId: string,
  request: UpdateGoalRequest,
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentGoalCommandResponse> {
  return requestJson(
    `/api/agent-goals/${encodeURIComponent(goalId)}`,
    commandRequest("PATCH", request, idempotencyKey),
  );
}

export async function resumeAgentGoal(
  goalId: string,
  request: ResumeGoalRequest,
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentGoalCommandResponse> {
  return requestJson(
    `/api/agent-goals/${encodeURIComponent(goalId)}/resume`,
    commandRequest("POST", request, idempotencyKey),
  );
}

export async function upsertAgentGoalContext(
  goalId: string,
  request: UpsertGoalContextRequest,
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentGoalCommandResponse> {
  return requestJson(
    `/api/agent-goals/${encodeURIComponent(goalId)}/context`,
    commandRequest("PUT", request, idempotencyKey),
  );
}

export async function removeAgentGoalContext(
  goalId: string,
  request: RemoveGoalContextRequest,
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentGoalCommandResponse> {
  return requestJson(
    `/api/agent-goals/${encodeURIComponent(goalId)}/context`,
    commandRequest("DELETE", request, idempotencyKey),
  );
}

function commandRequest(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: unknown,
  idempotencyKey: string,
): RequestInit {
  return {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...init?.headers },
    ...init,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isErrorBody(body) ? body : undefined;
    throw new AgentGoalApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.cause,
    );
  }
  return body as T;
}

function isErrorBody(
  value: unknown,
): value is { code?: string; cause?: string } {
  return typeof value === "object" && value !== null;
}
