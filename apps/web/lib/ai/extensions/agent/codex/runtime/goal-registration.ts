import {
  type AgentGoalRuntime,
  type RuntimeInstructionDispatch,
  type RuntimeSessionRegistration,
  getAgentGoalRuntime,
} from "@/lib/ai/runtime-instructions";
import type {
  GoalStopDecision,
  RuntimeGoalStopControllerPort,
} from "@/lib/ai/runtime-instructions/goal-controller";
import {
  type LiveRuntimeLease,
  acquireLiveRuntimeLease,
  attachRuntimeObservationLease,
  isRecoveryPersistence,
} from "@/lib/ai/runtime-instructions/live-runtime-lease";
import type { RuntimeObservationLeaseRegistration } from "@/lib/ai/runtime-instructions/runtime-observation";
import type { RuntimeSessionEnsureOptions } from "@/lib/ai/runtime-instructions/runtime-session-persistence";
import type {
  AgentRuntimeInstructionSettlement,
  AgentRuntimeRecovery,
  AgentRuntimeRecoveryContinuationResult,
  AgentRuntimeRecoveryGoalFinalizationResult,
} from "@openloomi/ai/agent/types";

import { CodexRuntimeEventObserver } from "./event-observer";
import type { CodexRuntimeSession } from "./session";

export interface StartCodexGoalRuntimeSessionInput {
  ownerId: string;
  runtime: CodexRuntimeSession;
  start: Omit<Parameters<CodexRuntimeSession["start"]>[0], "recovery">;
  goalRuntime?: AgentGoalRuntime;
  persistence?: Omit<
    RuntimeSessionEnsureOptions,
    "provider" | "recoveryLeaseToken"
  >;
  /** Trusted restart path; never accepted from a public request body. */
  recovery?: Pick<
    AgentRuntimeRecovery,
    | "providerSessionId"
    | "runEpoch"
    | "recoveryLeaseToken"
    | "instructionSettlements"
    | "replayableInstructionIds"
    | "onProviderSessionInitialized"
  >;
}

export interface CodexGoalRuntimeRegistration extends Omit<
  RuntimeSessionRegistration,
  "release"
> {
  release(): Promise<void>;
}

export class CodexGoalRuntimeRegistrationError extends Error {
  constructor(public readonly dispatch: RuntimeInstructionDispatch) {
    super(
      `Failed to replay pending Goal instructions: ${dispatch.status}`,
      dispatch.status === "transport_failed"
        ? { cause: dispatch.error }
        : undefined,
    );
    this.name = "CodexGoalRuntimeRegistrationError";
  }
}

export class CodexGoalRuntimeEpochMismatchError extends Error {
  readonly code = "run_epoch_mismatch";

  constructor(
    public readonly runtimeSessionId: string,
    public readonly expectedRunEpoch: number,
    public readonly actualRunEpoch: number,
  ) {
    super(
      `Cannot register Codex Runtime Session ${runtimeSessionId} at runEpoch ${actualRunEpoch}; OpenLoomi expects ${expectedRunEpoch}`,
    );
    this.name = "CodexGoalRuntimeEpochMismatchError";
  }
}

export class CodexGoalRuntimeLiveLeaseError extends Error {
  readonly code = "runtime_live_lease_unavailable";

  constructor(public readonly runtimeSessionId: string) {
    super(
      `Codex Runtime Session ${runtimeSessionId} is live-owned or awaiting restart recovery`,
    );
    this.name = "CodexGoalRuntimeLiveLeaseError";
  }
}

/**
 * Starts or exactly resumes one Codex app-server thread. Recovery uses the
 * coordinator's existing durable claim and exposes the transport only after
 * app-server proves the persisted provider identity.
 */
export async function startCodexGoalRuntimeSession(
  input: StartCodexGoalRuntimeSessionInput,
): Promise<CodexGoalRuntimeRegistration> {
  const ownerId = input.ownerId;
  const goalRuntime = input.goalRuntime ?? getAgentGoalRuntime();
  let registration: CodexGoalRuntimeRegistration | undefined;
  let persistenceCleanup: (() => Promise<void>) | undefined;
  let observationLease: RuntimeObservationLeaseRegistration | undefined;
  let runtimeStarted = false;

  try {
    const recoveryPersistence = isRecoveryPersistence(
      goalRuntime.runtimeSessions,
    )
      ? goalRuntime.runtimeSessions
      : undefined;
    let liveLease: LiveRuntimeLease | undefined;
    const metadata = {
      ...input.persistence,
      provider: "codex" as const,
    };

    if (input.recovery || !recoveryPersistence) {
      await goalRuntime.runtimeSessions.ensure(
        ownerId,
        input.runtime.runtimeSessionId,
        {
          ...metadata,
          ...(input.recovery?.recoveryLeaseToken === undefined
            ? {}
            : { recoveryLeaseToken: input.recovery.recoveryLeaseToken }),
        },
      );
    } else {
      liveLease = await acquireLiveRuntimeLease({
        persistence: recoveryPersistence,
        ownerId,
        runtime: input.runtime,
        metadata,
        unavailableError: () =>
          new CodexGoalRuntimeLiveLeaseError(input.runtime.runtimeSessionId),
      });
    }

    persistenceCleanup = memoizeAsync(async () => {
      try {
        if (liveLease) {
          await liveLease.release(
            runtimeStarted ? input.runtime.runEpoch : liveLease.initialRunEpoch,
          );
        }
      } finally {
        observationLease?.release();
      }
    });
    const runtimeLeaseToken =
      input.recovery?.recoveryLeaseToken ?? liveLease?.leaseToken;
    if (runtimeLeaseToken) {
      observationLease = attachRuntimeObservationLease(
        goalRuntime.observations,
        ownerId,
        input.runtime.runtimeSessionId,
        runtimeLeaseToken,
      );
    }

    const expectedRunEpoch = await goalRuntime.goals.getRuntimeSessionRunEpoch(
      ownerId,
      input.runtime.runtimeSessionId,
    );
    if (
      liveLease !== undefined &&
      liveLease.initialRunEpoch !== expectedRunEpoch
    ) {
      throw new CodexGoalRuntimeEpochMismatchError(
        input.runtime.runtimeSessionId,
        expectedRunEpoch,
        liveLease.initialRunEpoch,
      );
    }
    if (
      input.recovery !== undefined &&
      input.recovery.runEpoch !== expectedRunEpoch
    ) {
      throw new CodexGoalRuntimeEpochMismatchError(
        input.runtime.runtimeSessionId,
        expectedRunEpoch,
        input.recovery.runEpoch,
      );
    }
    input.runtime.initializeRunEpoch(expectedRunEpoch);

    input.runtime.attachEventObserver(
      new CodexRuntimeEventObserver(
        ownerId,
        input.runtime.runtimeSessionId,
        goalRuntime.observations,
      ),
    );
    const goalStopController = goalRuntime.controller.forSession({
      ownerId,
      runtimeSessionId: input.runtime.runtimeSessionId,
      transport: input.runtime,
      continuationDelivery: "transport",
    });
    input.runtime.attachGoalStopController(goalStopController);

    const acceptedInstructionIds =
      input.recovery?.instructionSettlements
        .filter((settlement) => settlement.disposition === "accepted")
        .map((settlement) => settlement.instructionId) ?? [];
    const contextBindings = input.recovery
      ? recoveryContextBindings(
          input.recovery.providerSessionId,
          input.recovery.instructionSettlements,
        )
      : [];
    const boundInstructionIds = new Set(
      contextBindings.map((binding) => binding.instructionId),
    );
    await input.runtime.start({
      ...input.start,
      ...(input.recovery
        ? {
            recovery: {
              providerSessionId: input.recovery.providerSessionId,
              replayableInstructionIds: input.recovery.replayableInstructionIds,
              contextInstructionIds: acceptedInstructionIds.filter(
                (instructionId) => !boundInstructionIds.has(instructionId),
              ),
              contextBindings,
            },
          }
        : {}),
    });
    runtimeStarted = true;

    // Do not expose the transport until app-server has returned the exact
    // thread. Delivery before that boundary cannot be fenced.
    const registryRegistration = goalRuntime.sessions.register({
      ownerId,
      transport: input.runtime,
    });
    let released = false;
    registration = {
      ...registryRegistration,
      release: async () => {
        if (released) return;
        released = true;
        registryRegistration.release();
        await persistenceCleanup?.();
      },
    };
    await liveLease?.persistRunning();
    const recoveredSettlements =
      input.runtime.recoveredInstructionSettlements();
    if (input.recovery) {
      await goalRuntime.dispatcher.initializeRecoveredProgress({
        ownerId,
        runtimeSessionId: input.runtime.runtimeSessionId,
        transport: input.runtime,
        settlements: mergeRecoverySettlements(
          input.recovery.instructionSettlements,
          recoveredSettlements,
        ),
      });
    }
    const replay = await goalRuntime.goals.replayPendingInstructions(
      ownerId,
      input.runtime.runtimeSessionId,
    );
    if (replay !== null && replay.status !== "accepted") {
      throw new CodexGoalRuntimeRegistrationError(replay);
    }
    if (input.recovery) {
      await input.runtime.activateRecoveredNotifications();
      const recoveredInstructionIds = new Set(
        recoveredSettlements
          .filter((settlement) => settlement.disposition === "accepted")
          .map((settlement) => settlement.instructionId),
      );
      const replayedInstructions = input.recovery.replayableInstructionIds.some(
        (instructionId) => !recoveredInstructionIds.has(instructionId),
      );
      const providerHasActiveTurn = input.runtime.hasActiveTurn();
      const recoveryAttemptId =
        input.recovery.recoveryLeaseToken ?? crypto.randomUUID();
      await input.recovery.onProviderSessionInitialized?.({
        runtimeSessionId: input.runtime.runtimeSessionId,
        providerSessionId: input.recovery.providerSessionId,
        runEpoch: input.runtime.runEpoch,
        replayedInstructions: replayedInstructions || providerHasActiveTurn,
        continueGoal: createRecoveryContinuationTrigger({
          ownerId,
          runtime: input.runtime,
          goalRuntime,
          goalStopController,
          recoveryAttemptId,
        }),
        finalizeGoalWithoutContinuation: createRecoveryFinalizationTrigger({
          ownerId,
          runtime: input.runtime,
          goalRuntime,
          goalStopController,
          recoveryAttemptId,
          runtimeLeaseToken: input.recovery.recoveryLeaseToken,
        }),
      });
    } else {
      await input.runtime.beginInitialTurn();
    }
    return registration;
  } catch (error) {
    try {
      await input.runtime.close();
    } finally {
      if (registration) await registration.release();
      else await persistenceCleanup?.();
    }
    throw error;
  }
}

function memoizeAsync(action: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= action();
    return result;
  };
}

function mergeRecoverySettlements(
  durable: readonly AgentRuntimeInstructionSettlement[],
  recovered: readonly AgentRuntimeInstructionSettlement[],
): AgentRuntimeInstructionSettlement[] {
  const merged = new Map<string, AgentRuntimeInstructionSettlement>();
  for (const settlement of [...durable, ...recovered]) {
    const previous = merged.get(settlement.instructionId);
    if (previous && !sameSettlement(previous, settlement)) {
      throw new Error(
        `Conflicting recovery settlements for instruction ${settlement.instructionId}`,
      );
    }
    merged.set(settlement.instructionId, { ...settlement });
  }
  return [...merged.values()];
}

function sameSettlement(
  left: AgentRuntimeInstructionSettlement,
  right: AgentRuntimeInstructionSettlement,
): boolean {
  return (
    left.disposition === right.disposition &&
    left.providerEventId === right.providerEventId &&
    left.reason === right.reason
  );
}

function recoveryContextBindings(
  providerSessionId: string,
  settlements: readonly AgentRuntimeInstructionSettlement[],
): Array<{
  instructionId: string;
  turnId: string;
  providerEventId: string;
  recordedAt: string;
}> {
  return settlements.flatMap((settlement) => {
    if (
      settlement.disposition !== "accepted" ||
      settlement.providerEventId === undefined
    ) {
      return [];
    }
    const prefix = `codex:${providerSessionId}:`;
    const suffix = `:input:${settlement.instructionId}`;
    if (
      !settlement.providerEventId.startsWith(prefix) ||
      !settlement.providerEventId.endsWith(suffix)
    ) {
      return [];
    }
    const turnId = settlement.providerEventId.slice(
      prefix.length,
      -suffix.length,
    );
    if (!turnId || turnId.length > 256 || turnId !== turnId.trim()) return [];
    return [
      {
        instructionId: settlement.instructionId,
        turnId,
        providerEventId: settlement.providerEventId,
        recordedAt: settlement.recordedAt,
      },
    ];
  });
}

function createRecoveryContinuationTrigger(input: {
  ownerId: string;
  runtime: CodexRuntimeSession;
  goalRuntime: AgentGoalRuntime;
  goalStopController: RuntimeGoalStopControllerPort;
  recoveryAttemptId: string;
}): () => Promise<AgentRuntimeRecoveryContinuationResult> {
  let result: AgentRuntimeRecoveryContinuationResult | undefined;
  let inFlight: Promise<AgentRuntimeRecoveryContinuationResult> | undefined;
  return async () => {
    if (result) return result;
    inFlight ??= (async () => {
      const turnContext = await input.goalRuntime.observations.captureContext({
        ownerId: input.ownerId,
        runtimeSessionId: input.runtime.runtimeSessionId,
        runEpoch: input.runtime.runEpoch,
      });
      return recoveryContinuationResult(
        await input.goalStopController.evaluateStop({
          runEpoch: input.runtime.runEpoch,
          assistantTurnId: `codex-recovery:${input.runtime.runtimeSessionId}:${input.runtime.runEpoch}:${input.recoveryAttemptId}`,
          turnContext,
          stopHookActive: false,
        }),
      );
    })();
    try {
      result = await inFlight;
      return result;
    } finally {
      inFlight = undefined;
    }
  };
}

function createRecoveryFinalizationTrigger(input: {
  ownerId: string;
  runtime: CodexRuntimeSession;
  goalRuntime: AgentGoalRuntime;
  goalStopController: RuntimeGoalStopControllerPort;
  recoveryAttemptId: string;
  runtimeLeaseToken?: string;
}): () => Promise<AgentRuntimeRecoveryGoalFinalizationResult> {
  let result: AgentRuntimeRecoveryGoalFinalizationResult | undefined;
  let inFlight: Promise<AgentRuntimeRecoveryGoalFinalizationResult> | undefined;
  return async () => {
    if (result) return result;
    inFlight ??= (async () => {
      const turnContext = await input.goalRuntime.observations.captureContext({
        ownerId: input.ownerId,
        runtimeSessionId: input.runtime.runtimeSessionId,
        runEpoch: input.runtime.runEpoch,
      });
      return input.goalStopController.finalizeWithoutContinuation({
        runEpoch: input.runtime.runEpoch,
        evaluationId: `codex-recovery-terminal:${input.runtime.runtimeSessionId}:${input.runtime.runEpoch}:${input.recoveryAttemptId}`,
        turnContext,
        ...(input.runtimeLeaseToken === undefined
          ? {}
          : { runtimeLeaseToken: input.runtimeLeaseToken }),
      });
    })();
    try {
      result = await inFlight;
      return result;
    } finally {
      inFlight = undefined;
    }
  };
}

function recoveryContinuationResult(
  decision: GoalStopDecision,
): AgentRuntimeRecoveryContinuationResult {
  return decision.decision === "block"
    ? { decision: "block", outcome: "continue" }
    : { decision: "allow", outcome: decision.outcome };
}
