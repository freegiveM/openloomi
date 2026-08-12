import { NextResponse } from "next/server";

import type {
  AgentGoalRecoverySession,
  AgentGoalRecoverySessionsResponse,
} from "@/lib/ai/runtime-instructions/api";
import {
  NO_STORE_HEADERS,
  getAgentGoalApiService,
  withAuthenticatedGoalApi,
} from "@/lib/ai/runtime-instructions/api/server";
import {
  getAgentGoalRuntime,
  type SqliteAgentGoalRuntime,
} from "@/lib/ai/runtime-instructions/runtime";
import { getChatById } from "@/lib/db/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Minimal, owner-scoped read model used to reconnect the desktop chat UI to a
 * Goal Runtime that the server is recovering after process restart.
 */
export async function GET(request: Request) {
  return withAuthenticatedGoalApi(
    request,
    getAgentGoalApiService,
    async ({ ownerId }) => {
      const goalRuntime = getAgentGoalRuntime();
      if (!("state" in goalRuntime)) {
        return NextResponse.json<AgentGoalRecoverySessionsResponse>(
          { sessions: [] },
          { headers: NO_STORE_HEADERS },
        );
      }

      const sqliteRuntime = goalRuntime as SqliteAgentGoalRuntime;
      const persisted =
        await sqliteRuntime.runtimeSessions.listRecoveryPresentationSessions(
          ownerId,
        );
      const candidates = await Promise.all(
        persisted.map(async (session) => {
          const chat = await getChatById({ id: session.runtimeSessionId });
          // Runtime rows are owner-scoped already. Re-check the Chat owner at
          // the HTTP boundary because its title is part of the response.
          if (!chat || chat.userId !== ownerId) return null;
          return {
            runtimeSessionId: session.runtimeSessionId,
            state: session.state,
            live: sqliteRuntime.sessions.has(ownerId, session.runtimeSessionId),
            chat: {
              id: chat.id,
              title: chat.title,
              createdAt: chat.createdAt.toISOString(),
            },
          };
        }),
      );
      const sessions = candidates.filter(
        (session): session is AgentGoalRecoverySession => session !== null,
      );

      return NextResponse.json<AgentGoalRecoverySessionsResponse>(
        { sessions },
        { headers: NO_STORE_HEADERS },
      );
    },
  );
}
