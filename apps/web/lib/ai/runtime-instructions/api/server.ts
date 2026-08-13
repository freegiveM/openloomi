import "server-only";

import type { RuntimeProvider } from "@openloomi/ai/agent/runtime-instructions";

import { getConfiguredDefaultAgentProvider } from "@/lib/ai/native-agent/provider-env";
import { getChatById } from "@/lib/db/queries";

import { getAgentGoalRuntime } from "../runtime";
import { AgentGoalApiService } from "./service";
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
      isOwnedChat: async (ownerId, runtimeSessionId) => {
        const chat = await getChatById({ id: runtimeSessionId });
        return chat?.userId === ownerId;
      },
    },
  });
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
