import "server-only";

import type { RuntimeProvider } from "@openloomi/ai/agent/runtime-instructions";

import { getConfiguredDefaultAgentProvider } from "@/lib/ai/native-agent/provider-env";
import {
  CHAT_OWNER_SCOPE_CONFLICT,
  deleteChatById,
  ensureOwnedChat,
  getChatById,
  getChatIdsByUserId,
} from "@/lib/db/queries";

import type { GoalCommandResult } from "../goal-service";
import { getAgentGoalRuntime } from "../runtime";
import {
  AgentGoalApiService,
  type TrustedAgentGoalStartInput,
} from "./service";
import type { GoalPlannerPort } from "./goal-planner-port";

export * from "./http";
export * from "./schemas";
export * from "./service";

export function getAgentGoalApiService(): AgentGoalApiService {
  const runtime = getAgentGoalRuntime();
  return new AgentGoalApiService({
    goals: runtime.goals,
    queries: runtime.queries,
    liveSessions: runtime.sessions,
    runtimeSessions: runtime.runtimeSessions,
    planner: nativeGoalPlanner,
    resolveNewRuntimeProvider: selectedGoalRuntimeProvider,
    sessionOwnership: {
      getOwner: async (runtimeSessionId) => {
        const chat = await getChatById({ id: runtimeSessionId });
        return chat?.userId ?? null;
      },
      ensureOwnedChat: async ({ ownerId, runtimeSessionId, title }) => {
        try {
          await ensureOwnedChat({ id: runtimeSessionId, userId: ownerId, title });
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === CHAT_OWNER_SCOPE_CONFLICT
          ) {
            return false;
          }
          throw error;
        }
      },
      listOwnedChatIds: getChatIdsByUserId,
      deleteOwnedChat: async (runtimeSessionId) => {
        await deleteChatById({ id: runtimeSessionId });
      },
    },
  });
}

/** Server-only automation boundary used by trusted Loop executors. */
export function startTrustedAgentGoal(
  input: TrustedAgentGoalStartInput,
): Promise<GoalCommandResult> {
  return getAgentGoalApiService().startTrusted(input);
}

const nativeGoalPlanner: GoalPlannerPort = {
  async plan(request) {
    const { NativeGoalPlanner } = await import("./goal-planner");
    return new NativeGoalPlanner().plan(request);
  },
};

function selectedGoalRuntimeProvider(): RuntimeProvider {
  return getConfiguredDefaultAgentProvider() === "codex" ? "codex" : "claude";
}
