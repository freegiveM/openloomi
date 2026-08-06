import {
  AgentGoalDomainError,
  type AgentGoalRun,
  type GoalEvidence,
  type PersistedAgentGoal,
  type RuntimeDeliveryReceipt,
} from "@openloomi/ai/agent/runtime-instructions";
import { NextResponse } from "next/server";
import type { z } from "zod";

import { getAuthUser } from "@/lib/auth/dual-auth";
import { isTauriMode } from "@/lib/env/constants";

import { AgentGoalStateError } from "../goal-state-error";
import type { GoalCommandResult } from "../goal-service";
import { GoalServiceError } from "../goal-service-error";
import type {
  AgentGoalDetailView,
  AgentGoalSummaryView,
} from "../goal-query-service";
import type {
  RuntimeInstructionDispatch,
  RuntimeInstructionDispatchFailure,
} from "../instruction-dispatcher";
import type {
  AgentGoalCommandResponse,
  AgentGoalDetailResponse,
  PublicAgentGoal,
  PublicAgentGoalRun,
  PublicDeliveryReceipt,
  PublicGoalEvidence,
  PublicGoalSummary,
  PublicInstructionDispatch,
  PublicInstructionDispatchFailure,
} from "./contracts";
import { AgentGoalApiError, type AgentGoalApiService } from "./service";
import { IdempotencyKeySchema } from "./schemas";

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export interface AuthenticatedGoalApiContext {
  ownerId: string;
  service: AgentGoalApiService;
}

export async function withAuthenticatedGoalApi(
  request: Request,
  getService: () => AgentGoalApiService,
  handler: (context: AuthenticatedGoalApiContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const user = await getAuthUser(request).catch(() => null);
  if (!user) {
    return apiError("unauthorized", 401);
  }
  if (!isTauriMode()) {
    return apiError("goal_runtime_unavailable", 503);
  }

  try {
    return await handler({ ownerId: user.id, service: getService() });
  } catch (error) {
    return goalApiErrorResponse(error);
  }
}

export async function parseGoalApiBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<{ data: z.output<T> } | { response: NextResponse }> {
  const payload = await request.json().catch(() => undefined);
  if (payload === undefined) {
    return { response: apiError("invalid_json", 400) };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      response: apiError(
        "invalid_goal_request",
        400,
        parsed.error.issues[0]?.message,
      ),
    };
  }
  return { data: parsed.data };
}

export function readIdempotencyKey(
  request: Request,
): { data: string } | { response: NextResponse } {
  const parsed = IdempotencyKeySchema.safeParse(
    request.headers.get("idempotency-key"),
  );
  return parsed.success
    ? { data: parsed.data }
    : { response: apiError("idempotency_key_required", 400) };
}

export function invalidGoalApiRequest(cause?: string): NextResponse {
  return apiError("invalid_goal_request", 400, cause);
}

export function goalCommandResponse(
  result: GoalCommandResult,
  options: { created?: boolean } = {},
): NextResponse {
  const delivered =
    result.dispatch.status === "accepted" ||
    result.dispatch.status === "superseded";
  const status = delivered
    ? options.created && !result.deduplicated
      ? 201
      : 200
    : 202;
  const response: AgentGoalCommandResponse = {
    goal: publicGoal(result.goal),
    instruction: {
      id: result.instruction.id,
      sequence: result.instruction.sequence,
      kind: result.instruction.kind,
      ...(result.instruction.goalRevision === undefined
        ? {}
        : { goalRevision: result.instruction.goalRevision }),
      issuedAt: result.instruction.issuedAt,
    },
    deduplicated: result.deduplicated,
    dispatch: publicDispatch(result.dispatch),
  };
  return NextResponse.json(response, { status, headers: NO_STORE_HEADERS });
}

export function publicGoalSummary(
  view: AgentGoalSummaryView,
): PublicGoalSummary {
  return {
    goal: publicGoal(view.goal),
    latestRun: view.latestRun ? publicRun(view.latestRun) : null,
    latestDelivery: view.latestDelivery,
    progress: view.progress,
  };
}

export function publicGoalDetail(
  view: AgentGoalDetailView,
): Omit<AgentGoalDetailResponse, "runtimeSessionId" | "live"> {
  return {
    ...publicGoalSummary(view),
    evidence: view.evidence.map(publicEvidence),
  };
}

function goalApiErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentGoalApiError) {
    return apiError(error.code, 404);
  }
  if (error instanceof GoalServiceError) {
    const status =
      error.code === "goal_not_found" ||
      error.code === "goal_session_mismatch" ||
      error.code === "context_not_found"
        ? 404
        : error.code === "no_change" || error.code === "goal_not_active"
          ? 409
          : 400;
    return apiError(error.code, status);
  }
  if (error instanceof AgentGoalDomainError) {
    return apiError(error.code, error.code === "invalid_goal" ? 400 : 409);
  }
  if (error instanceof AgentGoalStateError) {
    const status =
      error.code === "goal_not_found"
        ? 404
        : error.code === "invalid_commit"
          ? 500
          : 409;
    return apiError(error.code, status);
  }
  console.error("[Agent Goal API] Request failed", error);
  return apiError("goal_runtime_error", 500);
}

function apiError(code: string, status: number, cause?: string): NextResponse {
  return NextResponse.json(
    { error: code, code, ...(cause === undefined ? {} : { cause }) },
    { status, headers: NO_STORE_HEADERS },
  );
}

function publicGoal(goal: PersistedAgentGoal): PublicAgentGoal {
  return {
    runtimeSessionId: goal.runtimeSessionId,
    slot: goal.slot,
    ...structuredClone(goal.goal),
  };
}

function publicRun(run: AgentGoalRun): PublicAgentGoalRun {
  const {
    ownerId: _ownerId,
    providerSessionId: _providerSessionId,
    lastEvaluation,
    ...publicFields
  } = structuredClone(run);
  if (!lastEvaluation) return publicFields;
  const { nextInstruction: _nextInstruction, ...publicEvaluation } =
    lastEvaluation;
  return { ...publicFields, lastEvaluation: publicEvaluation };
}

function publicEvidence(evidence: GoalEvidence): PublicGoalEvidence {
  const { payload: _payload, ...publicFields } = structuredClone(evidence);
  return publicFields;
}

function publicDispatch(
  dispatch: RuntimeInstructionDispatch,
): PublicInstructionDispatch {
  if (dispatch.status === "accepted") {
    return {
      status: dispatch.status,
      instructionId: dispatch.instructionId,
      receipt: publicReceipt(dispatch.receipt),
    };
  }
  if (dispatch.status === "rejected") {
    return {
      status: dispatch.status,
      instructionId: dispatch.instructionId,
      receipt: publicReceipt(dispatch.receipt),
      code: "transport_rejected",
    };
  }
  if (dispatch.status === "transport_failed") {
    return {
      status: dispatch.status,
      runtimeSessionId: dispatch.runtimeSessionId,
      instructionId: dispatch.instructionId,
      code: "transport_failed",
    };
  }
  if (dispatch.status === "deferred") {
    return {
      status: dispatch.status,
      runtimeSessionId: dispatch.runtimeSessionId,
      instructionId: dispatch.instructionId,
      blockedByInstructionId: dispatch.blockedByInstructionId,
      failure: publicDispatchFailure(dispatch.failure),
    };
  }
  if (dispatch.status === "superseded") {
    return {
      status: dispatch.status,
      runtimeSessionId: dispatch.runtimeSessionId,
      instructionId: dispatch.instructionId,
    };
  }
  return {
    status: dispatch.status,
    runtimeSessionId: dispatch.runtimeSessionId,
    instructionId: dispatch.instructionId,
  };
}

function publicDispatchFailure(
  failure: RuntimeInstructionDispatchFailure,
): PublicInstructionDispatchFailure {
  if (failure.status === "transport_failed") {
    return {
      status: failure.status,
      runtimeSessionId: failure.runtimeSessionId,
      instructionId: failure.instructionId,
      code: "transport_failed",
    };
  }
  return {
    status: failure.status,
    instructionId: failure.instructionId,
    receipt: publicReceipt(failure.receipt),
    code: "transport_rejected",
  };
}

function publicReceipt(receipt: RuntimeDeliveryReceipt): PublicDeliveryReceipt {
  return {
    runtimeSessionId: receipt.runtimeSessionId,
    state: receipt.state,
    recordedAt: receipt.recordedAt,
  };
}
