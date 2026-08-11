import { NextResponse } from "next/server";

import type { AgentGoalSessionResponse } from "@/lib/ai/runtime-instructions/api";

import {
  ActivateGoalRequestSchema,
  GoalSessionQuerySchema,
  NO_STORE_HEADERS,
  getAgentGoalApiService,
  goalCommandResponse,
  invalidGoalApiRequest,
  parseGoalApiBody,
  publicGoalSummary,
  readIdempotencyKey,
  withAuthenticatedGoalApi,
} from "@/lib/ai/runtime-instructions/api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return withAuthenticatedGoalApi(
    request,
    getAgentGoalApiService,
    async ({ ownerId, service }) => {
      const query = GoalSessionQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) {
        return invalidGoalApiRequest(query.error.issues[0]?.message);
      }
      const view = await service.listBySession(
        ownerId,
        query.data.runtimeSessionId,
      );
      const response: AgentGoalSessionResponse = {
        runtimeSessionId: view.runtimeSessionId,
        live: view.live,
        activeGoalId: view.activeGoalId,
        goals: view.goals.map(publicGoalSummary),
      };
      return NextResponse.json(response, { headers: NO_STORE_HEADERS });
    },
  );
}

export async function POST(request: Request) {
  return withAuthenticatedGoalApi(
    request,
    getAgentGoalApiService,
    async ({ ownerId, service }) => {
      const idempotency = readIdempotencyKey(request);
      if ("response" in idempotency) return idempotency.response;
      const parsed = await parseGoalApiBody(request, ActivateGoalRequestSchema);
      if ("response" in parsed) return parsed.response;
      return goalCommandResponse(
        await service.activate(ownerId, parsed.data, idempotency.data),
        { created: true },
      );
    },
  );
}
