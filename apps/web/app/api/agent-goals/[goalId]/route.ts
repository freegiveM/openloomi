import { NextResponse } from "next/server";

import type { AgentGoalDetailResponse } from "@/lib/ai/runtime-instructions/api";

import {
  GoalIdSchema,
  GoalSessionQuerySchema,
  NO_STORE_HEADERS,
  UpdateGoalRequestSchema,
  getAgentGoalApiService,
  goalCommandResponse,
  invalidGoalApiRequest,
  parseGoalApiBody,
  publicGoalDetail,
  readIdempotencyKey,
  withAuthenticatedGoalApi,
} from "@/lib/ai/runtime-instructions/api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GoalRouteContext {
  params: Promise<{ goalId: string }>;
}

export async function GET(request: Request, context: GoalRouteContext) {
  return withAuthenticatedGoalApi(
    request,
    getAgentGoalApiService,
    async ({ ownerId, service }) => {
      const goalId = GoalIdSchema.safeParse((await context.params).goalId);
      const query = GoalSessionQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!goalId.success) {
        return invalidGoalApiRequest(goalId.error.issues[0]?.message);
      }
      if (!query.success) {
        return invalidGoalApiRequest(query.error.issues[0]?.message);
      }
      const view = await service.getById({
        ownerId,
        runtimeSessionId: query.data.runtimeSessionId,
        goalId: goalId.data,
      });
      const response: AgentGoalDetailResponse = {
        runtimeSessionId: view.runtimeSessionId,
        live: view.live,
        ...publicGoalDetail(view),
      };
      return NextResponse.json(response, { headers: NO_STORE_HEADERS });
    },
  );
}

export async function PATCH(request: Request, context: GoalRouteContext) {
  return withAuthenticatedGoalApi(
    request,
    getAgentGoalApiService,
    async ({ ownerId, service }) => {
      const goalId = GoalIdSchema.safeParse((await context.params).goalId);
      if (!goalId.success) {
        return invalidGoalApiRequest(goalId.error.issues[0]?.message);
      }
      const idempotency = readIdempotencyKey(request);
      if ("response" in idempotency) return idempotency.response;
      const parsed = await parseGoalApiBody(request, UpdateGoalRequestSchema);
      if ("response" in parsed) return parsed.response;
      return goalCommandResponse(
        await service.update(
          ownerId,
          goalId.data,
          parsed.data,
          idempotency.data,
        ),
      );
    },
  );
}
