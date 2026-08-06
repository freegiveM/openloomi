import {
  GoalIdSchema,
  RemoveGoalContextRequestSchema,
  UpsertGoalContextRequestSchema,
  getAgentGoalApiService,
  goalCommandResponse,
  invalidGoalApiRequest,
  parseGoalApiBody,
  readIdempotencyKey,
  withAuthenticatedGoalApi,
} from "@/lib/ai/runtime-instructions/api/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GoalContextRouteContext {
  params: Promise<{ goalId: string }>;
}

export async function PUT(request: Request, context: GoalContextRouteContext) {
  return mutateContext(request, context, "upsert");
}

export async function DELETE(
  request: Request,
  context: GoalContextRouteContext,
) {
  return mutateContext(request, context, "remove");
}

function mutateContext(
  request: Request,
  context: GoalContextRouteContext,
  action: "upsert" | "remove",
) {
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

      if (action === "upsert") {
        const parsed = await parseGoalApiBody(
          request,
          UpsertGoalContextRequestSchema,
        );
        if ("response" in parsed) return parsed.response;
        return goalCommandResponse(
          await service.upsertContext(
            ownerId,
            goalId.data,
            parsed.data,
            idempotency.data,
          ),
        );
      }

      const parsed = await parseGoalApiBody(
        request,
        RemoveGoalContextRequestSchema,
      );
      if ("response" in parsed) return parsed.response;
      return goalCommandResponse(
        await service.removeContext(
          ownerId,
          goalId.data,
          parsed.data,
          idempotency.data,
        ),
      );
    },
  );
}
