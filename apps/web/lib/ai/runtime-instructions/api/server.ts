import "server-only";

import { getChatById } from "@/lib/db/queries";

import { getAgentGoalRuntime } from "../runtime";
import { AgentGoalApiService } from "./service";

export * from "./http";
export * from "./schemas";
export * from "./service";

export function getAgentGoalApiService(): AgentGoalApiService {
  const runtime = getAgentGoalRuntime();
  return new AgentGoalApiService({
    goals: runtime.goals,
    queries: runtime.queries,
    liveSessions: runtime.sessions,
    sessionOwnership: {
      isOwnedChat: async (ownerId, runtimeSessionId) => {
        const chat = await getChatById({ id: runtimeSessionId });
        return chat?.userId === ownerId;
      },
    },
  });
}
