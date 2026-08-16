import { NextResponse } from "next/server";

import type { AgentGoalCurrentResponse } from "@/lib/ai/runtime-instructions/api";
import {
  NO_STORE_HEADERS,
  getAgentGoalApiService,
  publicGoalSummary,
  withAuthenticatedGoalApi,
} from "@/lib/ai/runtime-instructions/api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return withAuthenticatedGoalApi(
    request,
    getAgentGoalApiService,
    async ({ ownerId, service }) => {
      const response: AgentGoalCurrentResponse = {
        goals: (await service.listCurrent(ownerId)).map(publicGoalSummary),
      };
      return NextResponse.json(response, { headers: NO_STORE_HEADERS });
    },
  );
}
