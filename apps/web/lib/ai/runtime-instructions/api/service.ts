import type {
  AgentGoalUpdate,
  CreateAgentGoalInput,
} from "@melandlabs/ai/agent/runtime-instructions";

import type { GoalCommandResult, GoalService } from "../goal-service";
import type {
  AgentGoalDetailView,
  AgentGoalQueryService,
  AgentGoalSummaryView,
} from "../goal-query-service";
import type { RuntimeSessionRegistry } from "../runtime-session-registry";
import type { RuntimeSessionPersistencePort } from "../runtime-session-persistence";
import type {
  ActivateGoalRequest,
  RemoveGoalContextRequest,
  ResumeGoalRequest,
  UpdateGoalRequest,
  UpsertGoalContextRequest,
} from "./schemas";

export interface AgentGoalApiDependencies {
  goals: Pick<
    GoalService,
    "activate" | "update" | "resume" | "upsertContext" | "removeContext"
  >;
  queries: Pick<AgentGoalQueryService, "listBySession" | "getById">;
  liveSessions: Pick<RuntimeSessionRegistry, "resolve">;
  runtimeSessions: Pick<RuntimeSessionPersistencePort, "ensure">;
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
    await this.dependencies.runtimeSessions.ensure(
      ownerId,
      request.runtimeSessionId,
    );
    return this.dependencies.goals.activate({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      idempotencyKey,
      source: userCommandSource(),
      goal: userGoalInput(request.goal),
    });
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
  input: ActivateGoalRequest["goal"],
): CreateAgentGoalInput {
  return {
    ...input,
    constraints: input.constraints.map((constraint) => ({
      ...constraint,
      authority: "user" as const,
    })),
    contextRefs: [],
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
