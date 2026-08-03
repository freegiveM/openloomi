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
}

export interface AgentGoalRuntime {
  readonly sessions: RuntimeSessionRegistry;
  readonly goals: GoalService;
  readonly controller: GoalController;
  readonly observations: RuntimeProviderObservationPort;
  readonly replacements: GoalReplacementCoordinator;
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
  };
}

let agentGoalRuntime: InMemoryAgentGoalRuntime | undefined;

/**
 * Process-local composition root used by Claude sessions and future Goal
 * entry points. A durable state adapter can replace the in-memory adapter
 * without changing callers.
 */
export function getAgentGoalRuntime(): AgentGoalRuntime {
  agentGoalRuntime ??= createInMemoryAgentGoalRuntime({
    semanticEvaluator: new OpenLoomiGoalSemanticEvaluator(),
  });
  return agentGoalRuntime;
}
