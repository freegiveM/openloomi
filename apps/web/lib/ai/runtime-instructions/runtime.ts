import type {
  RuntimeClockPort,
  RuntimeIdGeneratorPort,
} from "@openloomi/ai/agent/runtime-instructions";

import { getDbInstance, isTauriMode } from "@/lib/db";

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
import {
  GoalLifecycleService,
  type RuntimeSessionRecoveryWakePort,
} from "./goal-lifecycle-service";
import { InMemoryAgentGoalState } from "./in-memory-goal-state";
import { InMemoryRuntimeObservationJournal } from "./in-memory-runtime-observation-journal";
import { RuntimeInstructionDispatcher } from "./instruction-dispatcher";
import { OpenLoomiGoalSemanticEvaluator } from "./openloomi-goal-semantic-evaluator";
import type { RuntimeProviderObservationPort } from "./runtime-observation";
import { RuntimeSessionRegistry } from "./runtime-session-registry";
import {
  InMemoryRuntimeSessionPersistence,
  SqliteRuntimeSessionPersistence,
  type RuntimeSessionPersistencePort,
} from "./runtime-session-persistence";
import {
  SqliteAgentGoalState,
  SqliteDeliveryRepository,
  SqliteEvidenceRepository,
  SqliteGoalRepository,
  SqliteGoalRuntimeDatabase,
  SqliteInstructionRepository,
  SqliteRunRepository,
  type SqliteGoalRuntimeDatabaseSource,
} from "./persistence/sqlite";
import { SqliteRuntimeObservationJournal } from "./persistence/sqlite/runtime-observation-journal";

export interface InMemoryAgentGoalRuntime {
  readonly state: InMemoryAgentGoalState;
  readonly observations: InMemoryRuntimeObservationJournal;
  readonly sessions: RuntimeSessionRegistry;
  readonly dispatcher: RuntimeInstructionDispatcher;
  readonly controller: GoalController;
  readonly goals: GoalService;
  readonly queries: AgentGoalQueryService;
  readonly runtimeSessions: RuntimeSessionPersistencePort;
}

export interface AgentGoalRuntime {
  readonly sessions: RuntimeSessionRegistry;
  readonly dispatcher: RuntimeInstructionDispatcher;
  readonly goals: GoalService;
  readonly controller: GoalController;
  readonly observations: RuntimeProviderObservationPort;
  readonly queries: AgentGoalQueryService;
  readonly runtimeSessions: RuntimeSessionPersistencePort;
}

export interface SqliteAgentGoalRuntime extends AgentGoalRuntime {
  readonly state: SqliteAgentGoalState;
  readonly observations: SqliteRuntimeObservationJournal;
  readonly runtimeSessions: SqliteRuntimeSessionPersistence;
}

export function createInMemoryAgentGoalRuntime(
  options: {
    clock?: RuntimeClockPort;
    idGenerator?: RuntimeIdGeneratorPort;
    observationIdGenerator?: RuntimeIdGeneratorPort;
    semanticEvaluator?: GoalSemanticEvaluatorPort;
    recoveryWake?: RuntimeSessionRecoveryWakePort;
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
  const runtimeSessions = new InMemoryRuntimeSessionPersistence(clock);
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
    options.recoveryWake,
  );
  const goals = new GoalService(
    state,
    dispatcher,
    clock,
    idGenerator,
    lifecycle,
  );
  return {
    state,
    observations,
    sessions,
    dispatcher,
    controller,
    goals,
    queries,
    runtimeSessions,
  };
}

export function createSqliteAgentGoalRuntime(
  source: SqliteGoalRuntimeDatabaseSource,
  options: {
    clock?: RuntimeClockPort;
    idGenerator?: RuntimeIdGeneratorPort;
    observationIdGenerator?: RuntimeIdGeneratorPort;
    semanticEvaluator?: GoalSemanticEvaluatorPort;
    recoveryWake?: RuntimeSessionRecoveryWakePort;
  } = {},
): SqliteAgentGoalRuntime {
  const database =
    source instanceof SqliteGoalRuntimeDatabase
      ? source
      : new SqliteGoalRuntimeDatabase(source);
  const clock = options.clock ?? { now: () => new Date() };
  const idGenerator = options.idGenerator ?? {
    generate: () => crypto.randomUUID(),
  };
  const observationIdGenerator = options.observationIdGenerator ?? {
    generate: () => crypto.randomUUID(),
  };
  const state = new SqliteAgentGoalState(database, {
    now: () => clock.now(),
    generateId: () => idGenerator.generate(),
  });
  const sessions = new RuntimeSessionRegistry();
  const runtimeSessions = new SqliteRuntimeSessionPersistence(database, clock);
  const observations = new SqliteRuntimeObservationJournal(
    database,
    runtimeSessions,
    clock,
    observationIdGenerator,
  );
  return composeRuntime({
    state,
    observations,
    sessions,
    runtimeSessions,
    clock,
    idGenerator,
    semanticEvaluator: options.semanticEvaluator,
    recoveryWake: options.recoveryWake,
    queries: sqliteGoalReadSource(database),
  });
}

function composeRuntime(input: {
  state: SqliteAgentGoalState;
  observations: SqliteRuntimeObservationJournal;
  sessions: RuntimeSessionRegistry;
  runtimeSessions: SqliteRuntimeSessionPersistence;
  clock: RuntimeClockPort;
  idGenerator: RuntimeIdGeneratorPort;
  semanticEvaluator?: GoalSemanticEvaluatorPort;
  recoveryWake?: RuntimeSessionRecoveryWakePort;
  queries: AgentGoalReadSource;
}): SqliteAgentGoalRuntime {
  const queries = new AgentGoalQueryService(input.queries, input.clock);
  const dispatcher = new RuntimeInstructionDispatcher(
    input.sessions,
    input.state,
    input.observations,
  );
  const controller = new GoalController(
    input.state,
    input.observations,
    dispatcher,
    new GoalEvaluator(input.semanticEvaluator),
    input.clock,
    input.idGenerator,
  );
  const lifecycle = new GoalLifecycleService(
    input.state,
    dispatcher,
    input.sessions,
    input.clock,
    input.idGenerator,
    30_000,
    input.observations,
    input.recoveryWake,
  );
  return {
    state: input.state,
    observations: input.observations,
    sessions: input.sessions,
    runtimeSessions: input.runtimeSessions,
    dispatcher,
    controller,
    goals: new GoalService(
      input.state,
      dispatcher,
      input.clock,
      input.idGenerator,
      lifecycle,
    ),
    queries,
  };
}

function sqliteGoalReadSource(
  database: SqliteGoalRuntimeDatabase,
): AgentGoalReadSource {
  const goals = new SqliteGoalRepository(database);
  const runs = new SqliteRunRepository(database);
  const instructions = new SqliteInstructionRepository(database);
  const deliveries = new SqliteDeliveryRepository(database);
  const evidence = new SqliteEvidenceRepository(database);
  const session = (ownerId: string, runtimeSessionId: string) => ({
    ownerId,
    runtimeSessionId,
  });
  return {
    listGoals: (ownerId, runtimeSessionId) =>
      goals.listBySession(session(ownerId, runtimeSessionId)),
    getGoal: (ownerId, runtimeSessionId, goalId) =>
      goals.getById({ ...session(ownerId, runtimeSessionId), goalId }),
    listRuns: (ownerId, runtimeSessionId) =>
      runs.listBySession(session(ownerId, runtimeSessionId)),
    listInstructions: (ownerId, runtimeSessionId) =>
      instructions.list(session(ownerId, runtimeSessionId)),
    listDeliveries: (ownerId, runtimeSessionId) =>
      deliveries.listBySession(session(ownerId, runtimeSessionId)),
    getEvidence: (ownerId, runtimeSessionId, evidenceId) =>
      evidence.getById({
        ...session(ownerId, runtimeSessionId),
        evidenceId,
      }),
    listEvidence: async (ownerId, runtimeSessionId, goalRunId, limit) =>
      (
        await evidence.listByRun({
          ...session(ownerId, runtimeSessionId),
          goalRunId,
        })
      ).slice(-limit),
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
    getEvidence: async (ownerId, runtimeSessionId, evidenceId) =>
      (await observations.listEvidence(ownerId, runtimeSessionId)).find(
        (evidence) => evidence.id === evidenceId,
      ) ?? null,
    listEvidence: async (ownerId, runtimeSessionId, goalRunId, limit) =>
      (await observations.listEvidence(ownerId, runtimeSessionId))
        .filter((evidence) => evidence.goalRunId === goalRunId)
        .slice(-limit),
  };
}

type AgentGoalRuntimeGlobal = typeof globalThis & {
  __openLoomiAgentGoalRuntimeV2?: AgentGoalRuntime;
};

/**
 * Process-local composition root used by Claude sessions and future Goal
 * entry points. A durable state adapter can replace the in-memory adapter
 * without changing callers.
 */
export function getAgentGoalRuntime(): AgentGoalRuntime {
  const processGlobal = globalThis as AgentGoalRuntimeGlobal;
  processGlobal.__openLoomiAgentGoalRuntimeV2 ??= isTauriMode()
    ? createSqliteAgentGoalRuntime(
        getDbInstance() as unknown as SqliteGoalRuntimeDatabaseSource,
        {
          semanticEvaluator: new OpenLoomiGoalSemanticEvaluator(),
          recoveryWake: {
            async wake(input) {
              const { wakeAgentGoalRuntimeRecovery } =
                await import("./recovery/startup");
              return wakeAgentGoalRuntimeRecovery(input);
            },
          },
        },
      )
    : createInMemoryAgentGoalRuntime({
        semanticEvaluator: new OpenLoomiGoalSemanticEvaluator(),
      });
  return processGlobal.__openLoomiAgentGoalRuntimeV2;
}
