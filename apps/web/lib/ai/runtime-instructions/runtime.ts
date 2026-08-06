import type {
  RuntimeClockPort,
  RuntimeIdGeneratorPort,
} from "@openloomi/ai/agent/runtime-instructions";

import { GoalService } from "./goal-service";
import { GoalController } from "./goal-controller";
import {
  GoalEvaluator,
  type GoalSemanticEvaluatorPort,
} from "./goal-evaluator";
import {
  AgentGoalQueryService,
  type AgentGoalReadSource,
} from "./goal-query-service";
import { GoalLifecycleService } from "./goal-lifecycle-service";
import { GoalReplacementCoordinator } from "./goal-replacement-coordinator";
import { InMemoryAgentGoalState } from "./in-memory-goal-state";
import { InMemoryRuntimeObservationJournal } from "./in-memory-runtime-observation-journal";
import { RuntimeInstructionDispatcher } from "./instruction-dispatcher";
import { OpenLoomiGoalSemanticEvaluator } from "./openloomi-goal-semantic-evaluator";
import type { RuntimeProviderObservationPort } from "./runtime-observation";
import { RuntimeSessionRegistry } from "./runtime-session-registry";

export interface InMemoryAgentGoalRuntime {
  readonly state: InMemoryAgentGoalState;
  readonly observations: InMemoryRuntimeObservationJournal;
  readonly sessions: RuntimeSessionRegistry;
  readonly dispatcher: RuntimeInstructionDispatcher;
  readonly controller: GoalController;
  readonly goals: GoalService;
  readonly replacements: GoalReplacementCoordinator;
  readonly queries: AgentGoalQueryService;
}

export interface AgentGoalRuntime {
  readonly sessions: RuntimeSessionRegistry;
  readonly goals: GoalService;
  readonly controller: GoalController;
  readonly observations: RuntimeProviderObservationPort;
  readonly replacements: GoalReplacementCoordinator;
  readonly queries: AgentGoalQueryService;
}

export function createInMemoryAgentGoalRuntime(
  options: {
    clock?: RuntimeClockPort;
    idGenerator?: RuntimeIdGeneratorPort;
    observationIdGenerator?: RuntimeIdGeneratorPort;
    semanticEvaluator?: GoalSemanticEvaluatorPort;
  } = {},
): InMemoryAgentGoalRuntime {
  const state = new InMemoryAgentGoalState();
  const sessions = new RuntimeSessionRegistry();
  const clock = options.clock ?? { now: () => new Date() };
  const idGenerator = options.idGenerator ?? {
    generate: () => crypto.randomUUID(),
  };
  const observationIdGenerator = options.observationIdGenerator ?? {
    generate: () => crypto.randomUUID(),
  };
  const observations = new InMemoryRuntimeObservationJournal(
    state,
    clock,
    observationIdGenerator,
  );
  const queries = new AgentGoalQueryService(
    inMemoryGoalReadSource(state, observations),
    clock,
  );
  const dispatcher = new RuntimeInstructionDispatcher(
    sessions,
    state,
    observations,
  );
  const controller = new GoalController(
    state,
    observations,
    dispatcher,
    new GoalEvaluator(options.semanticEvaluator),
    clock,
    idGenerator,
  );
  const lifecycle = new GoalLifecycleService(
    state,
    dispatcher,
    sessions,
    clock,
    idGenerator,
    30_000,
    observations,
  );
  const goals = new GoalService(
    state,
    dispatcher,
    clock,
    idGenerator,
    lifecycle,
  );
  const replacements = new GoalReplacementCoordinator(
    state,
    dispatcher,
    sessions,
    clock,
    idGenerator,
    30_000,
    observations,
  );
  return {
    state,
    observations,
    sessions,
    dispatcher,
    controller,
    goals,
    replacements,
    queries,
  };
}

function inMemoryGoalReadSource(
  state: InMemoryAgentGoalState,
  observations: InMemoryRuntimeObservationJournal,
): AgentGoalReadSource {
  return {
    listGoals: (ownerId, runtimeSessionId) =>
      state.listGoals(ownerId, runtimeSessionId),
    getGoal: async (ownerId, runtimeSessionId, goalId) => {
      const goal = await state.getGoal(ownerId, goalId);
      return goal?.runtimeSessionId === runtimeSessionId ? goal : null;
    },
    listRuns: (ownerId, runtimeSessionId) =>
      observations.listGoalRuns(ownerId, runtimeSessionId),
    listInstructions: (ownerId, runtimeSessionId) =>
      state.listInstructions(ownerId, runtimeSessionId),
    listDeliveries: (ownerId, runtimeSessionId) =>
      observations.listDeliveries(ownerId, runtimeSessionId),
    listEvidence: async (ownerId, runtimeSessionId, goalRunId, limit) =>
      (await observations.listEvidence(ownerId, runtimeSessionId))
        .filter((evidence) => evidence.goalRunId === goalRunId)
        .slice(-limit),
  };
}

type AgentGoalRuntimeGlobal = typeof globalThis & {
  __openLoomiAgentGoalRuntimeV1?: InMemoryAgentGoalRuntime;
};

/**
 * Process-local composition root used by Claude sessions and future Goal
 * entry points. A durable state adapter can replace the in-memory adapter
 * without changing callers.
 */
export function getAgentGoalRuntime(): AgentGoalRuntime {
  const processGlobal = globalThis as AgentGoalRuntimeGlobal;
  processGlobal.__openLoomiAgentGoalRuntimeV1 ??=
    createInMemoryAgentGoalRuntime({
      semanticEvaluator: new OpenLoomiGoalSemanticEvaluator(),
    });
  return processGlobal.__openLoomiAgentGoalRuntimeV1;
}
