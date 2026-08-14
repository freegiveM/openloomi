"use client";

import { useCallback, useState } from "react";
import useSWR, { mutate } from "swr";

import type {
  AgentGoalCommandResponse,
  AgentGoalDetailResponse,
  AgentGoalSessionResponse,
  PauseGoalRequest,
  ResumeGoalRequest,
} from "@/lib/ai/runtime-instructions/api";
import {
  activateAgentGoal,
  agentGoalDetailUrl,
  agentGoalSessionUrl,
  fetchAgentGoalDetail,
  fetchAgentGoalSession,
  pauseAgentGoal,
  resumeAgentGoal,
} from "@/lib/ai/runtime-instructions/api/client";
import {
  createGoalCommandIdempotencyKeys,
  shouldPollGoal,
} from "@/lib/ai/runtime-instructions/goal-ui-model";

export function useAgentGoalSession(runtimeSessionId: string | undefined) {
  const key = runtimeSessionId ? agentGoalSessionUrl(runtimeSessionId) : null;
  return useSWR<AgentGoalSessionResponse>(
    key,
    () => {
      if (!runtimeSessionId) throw new Error("runtimeSessionId is required");
      return fetchAgentGoalSession(runtimeSessionId);
    },
    {
      keepPreviousData: true,
      refreshInterval: (data) =>
        shouldPollGoal(
          data?.goals.find((item) => item.goal.id === data.activeGoalId),
        )
          ? data?.live
            ? 2_000
            : 5_000
          : 0,
    },
  );
}

export function useAgentGoalDetail(
  runtimeSessionId: string | undefined,
  goalId: string | undefined,
  enabled = true,
) {
  const key =
    runtimeSessionId && goalId && enabled
      ? agentGoalDetailUrl(runtimeSessionId, goalId)
      : null;
  return useSWR<AgentGoalDetailResponse>(
    key,
    () => {
      if (!runtimeSessionId || !goalId) {
        throw new Error("runtimeSessionId and goalId are required");
      }
      return fetchAgentGoalDetail(runtimeSessionId, goalId);
    },
    {
      keepPreviousData: true,
      refreshInterval: (data) =>
        shouldPollGoal(data) ? (data?.live ? 2_000 : 5_000) : 0,
    },
  );
}

export function useAgentGoalCommands(runtimeSessionId: string) {
  const [idempotencyKeys] = useState(createGoalCommandIdempotencyKeys);
  const refresh = useCallback(
    async (goalId?: string) => {
      await Promise.allSettled([
        mutate(agentGoalSessionUrl(runtimeSessionId)),
        goalId
          ? mutate(agentGoalDetailUrl(runtimeSessionId, goalId))
          : Promise.resolve(),
      ]);
    },
    [runtimeSessionId],
  );

  const execute = async (
    command: string,
    request: unknown,
    send: (idempotencyKey: string) => Promise<AgentGoalCommandResponse>,
  ) => {
    const response = await send(idempotencyKeys.keyFor(command, request));
    idempotencyKeys.clear(command, request);
    return response;
  };

  return {
    activate: async (objective: string) => {
      const request = { runtimeSessionId, objective };
      const response = await execute("activate", request, (idempotencyKey) =>
        activateAgentGoal(request, idempotencyKey),
      );
      await refresh(response.goal.id);
      return response;
    },
    pause: async (
      goalId: string,
      expectedRevision: number,
      reason?: PauseGoalRequest["reason"],
    ) => {
      const request = {
        runtimeSessionId,
        expectedRevision,
        ...(reason === undefined ? {} : { reason }),
      };
      const response = await execute(
        "pause",
        { goalId, ...request },
        (idempotencyKey) => pauseAgentGoal(goalId, request, idempotencyKey),
      );
      await refresh(goalId);
      return response;
    },
    resume: async (
      goalId: string,
      expectedRevision: number,
      reason?: ResumeGoalRequest["reason"],
    ) => {
      const request = {
        runtimeSessionId,
        expectedRevision,
        ...(reason === undefined ? {} : { reason }),
      };
      const response = await execute(
        "resume",
        { goalId, ...request },
        (idempotencyKey) => resumeAgentGoal(goalId, request, idempotencyKey),
      );
      await refresh(goalId);
      return response;
    },
  };
}
