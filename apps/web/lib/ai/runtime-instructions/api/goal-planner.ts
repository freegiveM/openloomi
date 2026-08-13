import "server-only";

import { AGENT_GOAL_LIMITS } from "@openloomi/ai/agent/runtime-instructions";
import type { AgentMessage } from "@openloomi/ai/agent/types";

import {
  type AuthenticatedNativeAgentSession,
  runNativeAgentRequest,
} from "@/lib/ai/native-agent/runner";
import { resolveNativeAgentProviderRequest } from "@/lib/ai/native-agent/provider-env";
import {
  GoalPlanningError,
  type GoalPlannerPort,
  type GoalPlanRequest,
} from "./goal-planner-port";

export { GoalPlanningError } from "./goal-planner-port";

const DEFAULT_GOAL_PLANNING_TIMEOUT_MS = 90_000;

/** Uses the Runtime Session's pinned provider without attaching planning to the Goal run. */
export class NativeGoalPlanner implements GoalPlannerPort {
  constructor(
    private readonly timeoutMs = DEFAULT_GOAL_PLANNING_TIMEOUT_MS,
  ) {}

  async plan(request: GoalPlanRequest): Promise<string[]> {
    const abortController = new AbortController();
    let timedOut = false;
    let activeGenerator: AsyncGenerator<AgentMessage> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("Goal planning timed out"));
        void activeGenerator?.return(undefined).catch(() => undefined);
        reject(new GoalPlanningError("Goal planning timed out"));
      }, this.timeoutMs);
    });
    const body = resolveNativeAgentProviderRequest(
      {
        prompt: goalPlanningPrompt(request.objective),
        phase: "plan",
        permissionMode: "plan",
        allowedTools: [],
        ...(request.workingDirectory === undefined
          ? {}
          : {
              workDir: request.workingDirectory,
              useProvidedWorkDir: true,
            }),
      },
      process.env,
      { trustedProviderOverride: request.provider },
    );

    try {
      const run = await Promise.race([
        runNativeAgentRequest(body, {
          session: planningSession(request.ownerId),
          userId: request.ownerId,
          abortController,
          goalRuntimeSessionId: null,
        }),
        timeoutFailure,
      ]);
      activeGenerator = run.generator;
      return await Promise.race([
        collectGoalSteps(run.generator),
        timeoutFailure,
      ]);
    } catch (cause) {
      if (timedOut) throw new GoalPlanningError("Goal planning timed out");
      if (cause instanceof GoalPlanningError) throw cause;
      throw new GoalPlanningError("The selected Runtime could not plan this Goal", {
        cause,
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export async function collectGoalSteps(
  messages: AsyncIterable<AgentMessage>,
): Promise<string[]> {
  let steps: string[] | undefined;
  let errorMessage: string | undefined;

  for await (const message of messages) {
    if (message.type === "plan" && message.plan) {
      steps = message.plan.steps.map((step) => step.description.trim());
    } else if (message.type === "error") {
      errorMessage = message.message ?? message.content;
    }
  }

  if (errorMessage) {
    throw new GoalPlanningError(errorMessage);
  }
  if (!steps || steps.length === 0) {
    throw new GoalPlanningError(
      "The selected Runtime did not return an executable Goal plan",
    );
  }
  steps = steps.filter((description) => description.length > 0);
  if (steps.length === 0) {
    throw new GoalPlanningError(
      "The selected Runtime returned only empty Goal steps",
    );
  }
  if (steps.length > AGENT_GOAL_LIMITS.successCriteria) {
    throw new GoalPlanningError(
      `The selected Runtime returned more than ${AGENT_GOAL_LIMITS.successCriteria} Goal steps`,
    );
  }
  if (
    steps.some(
      (description) =>
        description.length > AGENT_GOAL_LIMITS.criterionDescriptionCharacters,
    )
  ) {
    throw new GoalPlanningError(
      "The selected Runtime returned a Goal step that is too long",
    );
  }
  return steps;
}

function goalPlanningPrompt(objective: string): string {
  return `This is an OpenLoomi Goal, not a question. Always return a structured plan, even when the Goal is simple. The ordered steps become the user-visible completion checklist. Produce the smallest useful checklist, with at most ${AGENT_GOAL_LIMITS.successCriteria} concise, non-overlapping steps in execution order and in the same language as the objective. Each step must add one distinct increment without including work assigned to later steps, and must describe a concrete, observable result that the executing agent can honestly report as complete. Avoid standalone analysis, planning, or explanation steps unless they produce a named deliverable. Do not execute any step during planning. Preserve the user's intent exactly.\n\nGoal objective:\n${objective}`;
}

function planningSession(ownerId: string): AuthenticatedNativeAgentSession {
  return {
    user: { id: ownerId, type: "regular" },
    expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  } as AuthenticatedNativeAgentSession;
}
