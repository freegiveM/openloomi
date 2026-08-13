import type {
  AgentGoalUpdate,
  CreateAgentGoalInput,
  RuntimeProvider,
} from "@openloomi/ai/agent/runtime-instructions";

import type { GoalCommandResult, GoalService } from "../goal-service";
import type {
  AgentGoalDetailView,
  AgentGoalQueryService,
  AgentGoalSummaryView,
} from "../goal-query-service";
import type { RuntimeSessionRegistry } from "../runtime-session-registry";
import type { RuntimeSessionPersistencePort } from "../runtime-session-persistence";
import type { GoalPlannerPort } from "./goal-planner-port";
import type {
  ActivateGoalRequest,
  PauseGoalRequest,
  RemoveGoalContextRequest,
  ResumeGoalRequest,
  UpdateGoalRequest,
  UpsertGoalContextRequest,
} from "./schemas";

export interface AgentGoalApiDependencies {
  goals: Pick<
    GoalService,
    | "activateResolved"
    | "pause"
    | "update"
    | "resume"
    | "upsertContext"
    | "removeContext"
  >;
  queries: Pick<AgentGoalQueryService, "listBySession" | "getById">;
  liveSessions: Pick<RuntimeSessionRegistry, "resolve">;
  runtimeSessions: Pick<RuntimeSessionPersistencePort, "get" | "ensure">;
  planner: GoalPlannerPort;
  resolveNewRuntimeProvider(): RuntimeProvider;
  sessionOwnership: {
    isOwnedChat(ownerId: string, runtimeSessionId: string): Promise<boolean>;
  };
}

export interface AgentGoalSessionView {
  runtimeSessionId: string;
  live: boolean;
}

export interface AgentGoalSessionListView extends AgentGoalSessionView {
  goals: AgentGoalSummaryView[];
  activeGoalId: string | null;
}

export class AgentGoalApiError extends Error {
  constructor(
    public readonly code: "goal_not_found" | "runtime_session_not_found",
    message: string,
  ) {
    super(message);
    this.name = "AgentGoalApiError";
  }
}

/**
 * Authenticated-user application boundary for Goal HTTP handlers.
 *
 * Routes provide only the authenticated owner ID and user-level DTOs. Source
 * authority and provenance are materialized here so callers cannot impersonate
 * a policy, automation, connector, or another user.
 */
export class AgentGoalApiService {
  constructor(private readonly dependencies: AgentGoalApiDependencies) {}

  async listBySession(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<AgentGoalSessionListView> {
    const session = await this.requireSession(ownerId, runtimeSessionId);
    const goals = await this.dependencies.queries.listBySession(
      ownerId,
      runtimeSessionId,
    );
    return {
      runtimeSessionId,
      live: session.live,
      goals,
      activeGoalId:
        goals.find(({ goal }) => goal.goal.status === "active")?.goal.goal.id ??
        null,
    };
  }

  async getById(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
  }): Promise<AgentGoalDetailView & AgentGoalSessionView> {
    const session = await this.requireSession(
      input.ownerId,
      input.runtimeSessionId,
    );
    const goal = await this.dependencies.queries.getById(input);
    if (!goal) {
      throw new AgentGoalApiError(
        "goal_not_found",
        "Goal was not found for this Runtime Session",
      );
    }
    return {
      ...goal,
      runtimeSessionId: input.runtimeSessionId,
      live: session.live,
    };
  }

  async activate(
    ownerId: string,
    request: ActivateGoalRequest,
    idempotencyKey: string,
  ): Promise<GoalCommandResult> {
    await this.requireSession(ownerId, request.runtimeSessionId);
    const source = userCommandSource();
    const idempotencyPayload = { objective: request.objective };
    return this.dependencies.goals.activateResolved(
      {
        ownerId,
        runtimeSessionId: request.runtimeSessionId,
        idempotencyKey,
        source,
        idempotencyPayload,
      },
      async () => {
        const existingRuntimeSession =
          await this.dependencies.runtimeSessions.get(
            ownerId,
            request.runtimeSessionId,
          );
        const provider =
          existingRuntimeSession?.provider ??
          this.dependencies.resolveNewRuntimeProvider();
        if (existingRuntimeSession) {
          // Validate an existing durable session (including recovery fences)
          // before spending another provider turn on planning.
          await this.dependencies.runtimeSessions.ensure(
            ownerId,
            request.runtimeSessionId,
          );
        }
        const plan = await this.dependencies.planner.plan({
          ownerId,
          provider,
          objective: request.objective,
          ...(existingRuntimeSession?.workingDirectory === undefined
            ? {}
            : { workingDirectory: existingRuntimeSession.workingDirectory }),
        });
        if (!existingRuntimeSession) {
          await this.dependencies.runtimeSessions.ensure(
            ownerId,
            request.runtimeSessionId,
            { provider, initialState: "idle" },
          );
        }
        return userGoalInput(request.objective, plan);
      },
    );
  }

  async update(
    ownerId: string,
    goalId: string,
    request: UpdateGoalRequest,
    idempotencyKey: string,
  ): Promise<GoalCommandResult> {
    await this.requireSession(ownerId, request.runtimeSessionId);
    await this.dependencies.runtimeSessions.ensure(
      ownerId,
      request.runtimeSessionId,
    );
    return this.dependencies.goals.update({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      goalId,
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      source: userCommandSource(),
      update: userGoalUpdate(request.update),
    });
  }

  async resume(
    ownerId: string,
    goalId: string,
    request: ResumeGoalRequest,
    idempotencyKey: string,
  ): Promise<GoalCommandResult> {
    await this.requireSession(ownerId, request.runtimeSessionId);
    return this.dependencies.goals.resume({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      goalId,
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      source: userCommandSource(),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
  }

  async pause(
    ownerId: string,
    goalId: string,
    request: PauseGoalRequest,
    idempotencyKey: string,
  ): Promise<GoalCommandResult> {
    await this.requireSession(ownerId, request.runtimeSessionId);
    return this.dependencies.goals.pause({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      goalId,
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      source: userCommandSource(),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
  }

  async upsertContext(
    ownerId: string,
    goalId: string,
    request: UpsertGoalContextRequest,
    idempotencyKey: string,
  ): Promise<GoalCommandResult> {
    await this.requireSession(ownerId, request.runtimeSessionId);
    await this.dependencies.runtimeSessions.ensure(
      ownerId,
      request.runtimeSessionId,
    );
    return this.dependencies.goals.upsertContext({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      goalId,
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      source: userCommandSource(),
      contextRef: { ...request.contextRef, origin: "user" },
      ...(request.deliveryMode === undefined
        ? {}
        : { deliveryMode: request.deliveryMode }),
    });
  }

  async removeContext(
    ownerId: string,
    goalId: string,
    request: RemoveGoalContextRequest,
    idempotencyKey: string,
  ): Promise<GoalCommandResult> {
    await this.requireSession(ownerId, request.runtimeSessionId);
    await this.dependencies.runtimeSessions.ensure(
      ownerId,
      request.runtimeSessionId,
    );
    return this.dependencies.goals.removeContext({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      goalId,
      expectedRevision: request.expectedRevision,
      idempotencyKey,
      source: userCommandSource(),
      contextRefId: request.contextRefId,
      ...(request.deliveryMode === undefined
        ? {}
        : { deliveryMode: request.deliveryMode }),
    });
  }

  private async requireSession(ownerId: string, runtimeSessionId: string) {
    if (
      !(await this.dependencies.sessionOwnership.isOwnedChat(
        ownerId,
        runtimeSessionId,
      ))
    ) {
      throw new AgentGoalApiError(
        "runtime_session_not_found",
        "Runtime Session was not found for this user",
      );
    }
    return {
      live: Boolean(
        await this.dependencies.liveSessions.resolve(ownerId, runtimeSessionId),
      ),
    };
  }
}

function userCommandSource() {
  return { type: "user", authority: "user" } as const;
}

function userGoalInput(
  objective: string,
  steps: readonly string[],
): CreateAgentGoalInput {
  return {
    objective,
    successCriteria: steps.map((description, index) => ({
      id: `step-${index + 1}`,
      description,
      verification: { type: "agent_report" as const },
      required: true,
    })),
    constraints: [],
    contextRefs: [],
    priority: 50,
    completionPolicy: "tool_evidence",
    source: { type: "user" },
  };
}

function userGoalUpdate(input: UpdateGoalRequest["update"]): AgentGoalUpdate {
  const { constraints, ...update } = input;
  if (constraints === undefined) return update;
  return {
    ...update,
    constraints: constraints.map((constraint) => ({
      ...constraint,
      authority: "user",
    })),
  };
}
