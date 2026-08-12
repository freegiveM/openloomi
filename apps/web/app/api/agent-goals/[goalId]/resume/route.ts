import {
  GoalIdSchema,
  ResumeGoalRequestSchema,
  getAgentGoalApiService,
  goalCommandResponse,
  invalidGoalApiRequest,
  parseGoalApiBody,
  readIdempotencyKey,
  withAuthenticatedGoalApi,
} from "@/lib/ai/runtime-instructions/api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GoalResumeRouteContext {
  params: Promise<{ goalId: string }>;
}

export async function POST(request: Request, context: GoalResumeRouteContext) {
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
      const parsed = await parseGoalApiBody(request, ResumeGoalRequestSchema);
      if ("response" in parsed) return parsed.response;
      return goalCommandResponse(
        await service.resume(
          ownerId,
          goalId.data,
          parsed.data,
          idempotency.data,
        ),
      );
    },
  );
}
