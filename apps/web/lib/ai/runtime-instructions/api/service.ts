import type {
  AgentGoalUpdate,
  CreateAgentGoalInput,
  GoalContextReference,
  GoalSource,
  RuntimeProvider,
} from "@openloomi/ai/agent/runtime-instructions";
import { GoalContextReferenceSchema } from "@openloomi/ai/agent/runtime-instructions";

import { createGoalCommandFingerprint } from "../command-fingerprint";
import {
  GoalServiceError,
  type GoalActivationCommandSource,
  type GoalCommandResult,
  type GoalService,
} from "../goal-service";
import { goalOccupiesPrimarySlot } from "../goal-state-validation";
import type {
  AgentGoalDetailView,
  AgentGoalQueryService,
  AgentGoalSummaryView,
} from "../goal-query-service";
import type { RuntimeSessionRegistry } from "../runtime-session-registry";
import type { RuntimeSessionPersistencePort } from "../runtime-session-persistence";
import type { GoalPlannerPort } from "./goal-planner-port";
import { KeyedSerialExecutor } from "../keyed-serial-executor";
import {
  ActivateGoalRequestSchema,
  type ActivateGoalRequest,
  type PauseGoalRequest,
  type RemoveGoalContextRequest,
  type ResumeGoalRequest,
  type UpdateGoalRequest,
  type UpsertGoalContextRequest,
} from "./schemas";

export interface AgentGoalApiDependencies {
  goals: Pick<
    GoalService,
    | "activateResolved"
    | "cancel"
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
    getOwner(runtimeSessionId: string): Promise<string | null>;
    ensureOwnedChat(input: {
      ownerId: string;
      runtimeSessionId: string;
      title: string;
    }): Promise<boolean>;
    listOwnedChatIds(ownerId: string): Promise<string[]>;
    deleteOwnedChat(runtimeSessionId: string): Promise<void>;
  };
}

interface PlannedGoalActivationInput {
  ownerId: string;
  runtimeSessionId: string;
  objective: string;
  idempotencyKey: string;
  commandSource: GoalActivationCommandSource;
  goalSource: GoalSource;
  idempotencyPayload: unknown;
}

const sessionMutations = new KeyedSerialExecutor();

export interface TrustedAgentGoalStartInput {
  ownerId: string;
  runtimeSessionId: string;
  objective: string;
  idempotencyKey: string;
  sourceId: string;
  connectorContext?: GoalContextReference;
}

type TrustedConnectorGoalContext = GoalContextReference & {
  origin: "connector";
  sourceRef: string;
};

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

  async listCurrent(ownerId: string): Promise<AgentGoalSummaryView[]> {
    const runtimeSessionIds =
      await this.dependencies.sessionOwnership.listOwnedChatIds(ownerId);
    const goals = (
      await Promise.all(
        runtimeSessionIds.map((runtimeSessionId) =>
          this.dependencies.queries.listBySession(ownerId, runtimeSessionId),
        ),
      )
    )
      .flat()
      // `blocked` remains readable as the persisted predecessor of `paused`.
      .filter(({ goal }) => goalOccupiesPrimarySlot(goal.goal.status));
    return goals.sort((left, right) =>
      right.goal.goal.updatedAt.localeCompare(left.goal.goal.updatedAt),
    );
  }

  async deleteSession(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<void> {
    return sessionMutations.run(
      sessionMutationScope(ownerId, runtimeSessionId),
      async () => {
        if (
          (await this.dependencies.sessionOwnership.getOwner(
            runtimeSessionId,
          )) !== ownerId
        ) {
          throw runtimeSessionNotFound();
        }
        const current = (
          await this.dependencies.queries.listBySession(
            ownerId,
            runtimeSessionId,
          )
        ).find(({ goal }) => goalOccupiesPrimarySlot(goal.goal.status));
        if (current) {
          await this.dependencies.goals.cancel({
            ownerId,
            runtimeSessionId,
            goalId: current.goal.goal.id,
            expectedRevision: current.goal.goal.revision,
            idempotencyKey: `chat-delete:${current.goal.goal.id}:${current.goal.goal.revision}`,
            source: userCommandSource(),
            reason: "The owning chat was deleted",
          });
        }
        await this.dependencies.sessionOwnership.deleteOwnedChat(
          runtimeSessionId,
        );
      },
    );
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
    return this.activatePlanned({
      ownerId,
      runtimeSessionId: request.runtimeSessionId,
      objective: request.objective,
      idempotencyKey,
      commandSource: userCommandSource(),
      goalSource: { type: "user" },
      idempotencyPayload: { objective: request.objective },
    });
  }

  async startTrusted(
    input: TrustedAgentGoalStartInput,
  ): Promise<GoalCommandResult> {
    const request = parseTrustedGoalRequest(input);
    const sourceId = parseTrustedSourceId(input.sourceId);
    const source = { type: "loop", id: sourceId } as const;
    const connectorContext = parseTrustedConnectorContext(
      input.connectorContext,
    );
    let result = await this.activatePlanned({
      ownerId: input.ownerId,
      runtimeSessionId: request.runtimeSessionId,
      objective: request.objective,
      idempotencyKey: input.idempotencyKey,
      commandSource: {
        type: "automation",
        authority: "automation",
        sourceRef: sourceId,
      },
      goalSource: source,
      idempotencyPayload: { objective: request.objective, source },
    });
    if (!connectorContext) return result;

    result = await this.dependencies.goals.upsertContext({
      ownerId: input.ownerId,
      runtimeSessionId: request.runtimeSessionId,
      goalId: result.goal.goal.id,
      expectedRevision: result.goal.goal.revision,
      idempotencyKey: createGoalCommandFingerprint({
        command: "trusted-goal-context",
        activationIdempotencyKey: input.idempotencyKey,
        contextId: connectorContext.id,
      }),
      source: {
        type: "connector",
        authority: "untrusted_data",
        sourceRef: connectorContext.sourceRef,
      },
      contextRef: connectorContext,
    });
    return result;
  }

  private activatePlanned(
    input: PlannedGoalActivationInput,
  ): Promise<GoalCommandResult> {
    return sessionMutations.run(
      sessionMutationScope(input.ownerId, input.runtimeSessionId),
      () => this.activatePlannedSerialized(input),
    );
  }

  private async activatePlannedSerialized(
    input: PlannedGoalActivationInput,
  ): Promise<GoalCommandResult> {
    const existingOwner = await this.dependencies.sessionOwnership.getOwner(
      input.runtimeSessionId,
    );
    if (existingOwner !== null && existingOwner !== input.ownerId) {
      throw runtimeSessionNotFound();
    }

    let chatOwned = existingOwner === input.ownerId;
    if (!chatOwned) {
      // A durable Runtime Session can only exist after its Chat was created.
      // If the Chat is now missing, fail before activateResolved can replay and
      // dispatch an orphaned instruction. Re-read ownership to allow a
      // concurrent first-time creator that won between these two reads.
      const existingRuntimeSession =
        await this.dependencies.runtimeSessions.get(
          input.ownerId,
          input.runtimeSessionId,
        );
      if (existingRuntimeSession) {
        chatOwned =
          (await this.dependencies.sessionOwnership.getOwner(
            input.runtimeSessionId,
          )) === input.ownerId;
        if (!chatOwned) throw runtimeSessionNotFound();
      }
    }
    const result = await this.dependencies.goals.activateResolved(
      {
        ownerId: input.ownerId,
        runtimeSessionId: input.runtimeSessionId,
        idempotencyKey: input.idempotencyKey,
        source: input.commandSource,
        idempotencyPayload: input.idempotencyPayload,
      },
      async () => {
        const existingRuntimeSession =
          await this.dependencies.runtimeSessions.get(
            input.ownerId,
            input.runtimeSessionId,
          );
        const provider =
          existingRuntimeSession?.provider ??
          this.dependencies.resolveNewRuntimeProvider();
        if (existingRuntimeSession) {
          await this.dependencies.runtimeSessions.ensure(
            input.ownerId,
            input.runtimeSessionId,
          );
        }
        const plan = await this.dependencies.planner.plan({
          ownerId: input.ownerId,
          provider,
          objective: input.objective,
          ...(existingRuntimeSession?.workingDirectory === undefined
            ? {}
            : { workingDirectory: existingRuntimeSession.workingDirectory }),
        });
        const chatEnsured = chatOwned
          ? (await this.dependencies.sessionOwnership.getOwner(
              input.runtimeSessionId,
            )) === input.ownerId
          : await this.dependencies.sessionOwnership.ensureOwnedChat({
              ownerId: input.ownerId,
              runtimeSessionId: input.runtimeSessionId,
              title: input.objective,
            });
        if (!chatEnsured) throw runtimeSessionNotFound();
        chatOwned = true;
        if (!existingRuntimeSession) {
          await this.dependencies.runtimeSessions.ensure(
            input.ownerId,
            input.runtimeSessionId,
            { provider, initialState: "idle" },
          );
        }
        return userGoalInput(input.objective, plan, input.goalSource);
      },
    );
    if (!chatOwned) {
      chatOwned =
        (await this.dependencies.sessionOwnership.getOwner(
          input.runtimeSessionId,
        )) === input.ownerId;
    }
    if (!chatOwned) throw runtimeSessionNotFound();
    return result;
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
      (await this.dependencies.sessionOwnership.getOwner(runtimeSessionId)) !==
      ownerId
    ) {
      throw runtimeSessionNotFound();
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
  source: GoalSource,
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
    source,
  };
}

function runtimeSessionNotFound(): AgentGoalApiError {
  return new AgentGoalApiError(
    "runtime_session_not_found",
    "Runtime Session was not found for this user",
  );
}

function sessionMutationScope(
  ownerId: string,
  runtimeSessionId: string,
): string {
  return `${ownerId}\u0000${runtimeSessionId}`;
}

function parseTrustedSourceId(value: unknown): string {
  const sourceId = typeof value === "string" ? value.trim() : "";
  if (!sourceId || sourceId.length > 256) {
    throw new GoalServiceError(
      "invalid_command",
      "Trusted Goal source id is invalid",
    );
  }
  return sourceId;
}

function parseTrustedGoalRequest(
  input: TrustedAgentGoalStartInput,
): ActivateGoalRequest {
  const parsed = ActivateGoalRequestSchema.safeParse({
    runtimeSessionId: input.runtimeSessionId,
    objective: input.objective,
  });
  if (!parsed.success) {
    throw new GoalServiceError(
      "invalid_command",
      "Trusted Goal request is invalid",
      parsed.error,
    );
  }
  return parsed.data;
}

function parseTrustedConnectorContext(
  input: TrustedAgentGoalStartInput["connectorContext"],
): TrustedConnectorGoalContext | undefined {
  if (!input) return undefined;
  const parsed = GoalContextReferenceSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.origin !== "connector" ||
    parsed.data.sourceRef === undefined
  ) {
    throw new GoalServiceError(
      "invalid_context_provenance",
      "Trusted connector context must preserve connector provenance",
      parsed.success ? undefined : parsed.error,
    );
  }
  return {
    ...parsed.data,
    origin: "connector",
    sourceRef: parsed.data.sourceRef,
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
