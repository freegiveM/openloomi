import {
  getAgentGoalRuntime,
  type AgentGoalRuntime,
  type RuntimeInstructionDispatch,
  type RuntimeSessionRegistration,
} from "@/lib/ai/runtime-instructions";
import type {
  AgentRuntimeRecovery,
  AgentRuntimeRecoveryContinuationResult,
  AgentRuntimeRecoveryGoalFinalizationResult,
} from "@openloomi/ai/agent/types";
import type {
  RuntimeObservationLeaseFencePort,
  RuntimeObservationLeaseRegistration,
} from "@/lib/ai/runtime-instructions/runtime-observation";
import type {
  RuntimeLiveSessionLease,
  RuntimeSessionEnsureOptions,
  RuntimeSessionPersistencePort,
  RuntimeSessionRecoveryPersistencePort,
} from "@/lib/ai/runtime-instructions/runtime-session-persistence";
import type { ClaudeRuntimeSession } from "./session";
import { ClaudeRuntimeEventObserver } from "./event-observer";
import type {
  ClaudeRuntimeGoalStopController,
  ClaudeRuntimeStopHookDecision,
} from "./supplemental-hooks";

export interface StartClaudeGoalRuntimeSessionInput {
  session?: unknown;
  runtime: ClaudeRuntimeSession;
  start: Parameters<ClaudeRuntimeSession["start"]>[0];
  goalRuntime?: AgentGoalRuntime;
  /** Credential-free metadata needed to recreate this exact runtime. */
  persistence?: Omit<RuntimeSessionEnsureOptions, "recoveryLeaseToken">;
  /** Trusted restart path; never populated from a public request body. */
  recovery?: Pick<
    AgentRuntimeRecovery,
    | "recoveryLeaseToken"
    | "instructionSettlements"
    | "onProviderSessionInitialized"
  >;
}

export class ClaudeGoalRuntimeRegistrationError extends Error {
  constructor(public readonly dispatch: RuntimeInstructionDispatch) {
    super(
      `Failed to replay pending Goal instructions: ${dispatch.status}`,
      dispatch.status === "transport_failed"
        ? { cause: dispatch.error }
        : undefined,
    );
    this.name = "ClaudeGoalRuntimeRegistrationError";
  }
}

export class ClaudeGoalRuntimeEpochMismatchError extends Error {
  readonly code = "run_epoch_mismatch";

  constructor(
    public readonly runtimeSessionId: string,
    public readonly expectedRunEpoch: number,
    public readonly actualRunEpoch: number,
  ) {
    super(
      `Cannot register Claude Runtime Session ${runtimeSessionId} at runEpoch ${actualRunEpoch}; OpenLoomi expects ${expectedRunEpoch}`,
    );
    this.name = "ClaudeGoalRuntimeEpochMismatchError";
  }
}

export class ClaudeGoalRuntimeRecoveryRequiredError extends Error {
  readonly code = "run_epoch_recovery_required";

  constructor(
    public readonly runtimeSessionId: string,
    public readonly runEpoch: number,
  ) {
    super(
      `Claude Runtime Session ${runtimeSessionId} at runEpoch ${runEpoch} must be attached through the authenticated durable recovery path`,
    );
    this.name = "ClaudeGoalRuntimeRecoveryRequiredError";
  }
}

export interface ClaudeGoalRuntimeRegistration extends Omit<
  RuntimeSessionRegistration,
  "release"
> {
  release(): Promise<void>;
}

export class ClaudeGoalRuntimeRecoveryAuthenticationError extends Error {
  readonly code = "runtime_recovery_authentication_required";

  constructor(public readonly runtimeSessionId: string) {
    super(
      `Claude Runtime Session ${runtimeSessionId} recovery requires an authenticated owner`,
    );
    this.name = "ClaudeGoalRuntimeRecoveryAuthenticationError";
  }
}

export class ClaudeGoalRuntimeLiveLeaseError extends Error {
  readonly code = "runtime_live_lease_unavailable";

  constructor(public readonly runtimeSessionId: string) {
    super(
      `Claude Runtime Session ${runtimeSessionId} is already owned by another live or recovering host`,
    );
    this.name = "ClaudeGoalRuntimeLiveLeaseError";
  }
}

/**
 * Reserves the owner-scoped runtime identity, starts the Claude SDK Query, then
 * replays its pending instruction outbox. The transport is not returned to the
 * caller until Query startup and the initial outbox replay have both finished.
 * Startup, registration, and replay form one lifecycle boundary: any failure
 * releases the registry handle and closes the runtime. An unauthenticated
 * session is deliberately not registered in a shared anonymous namespace.
 */
export async function startClaudeGoalRuntimeSession(
  input: StartClaudeGoalRuntimeSessionInput,
): Promise<ClaudeGoalRuntimeRegistration | undefined> {
  const ownerId = resolveAuthenticatedGoalRuntimeOwnerId(input.session);
  if (!ownerId) {
    if (input.recovery) {
      throw new ClaudeGoalRuntimeRecoveryAuthenticationError(
        input.runtime.runtimeSessionId,
      );
    }
    input.runtime.start(input.start);
    return undefined;
  }

  const goalRuntime = input.goalRuntime ?? getAgentGoalRuntime();
  let registration: ClaudeGoalRuntimeRegistration | undefined;
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
    if (input.recovery || !recoveryPersistence) {
      await goalRuntime.runtimeSessions.ensure(
        ownerId,
        input.runtime.runtimeSessionId,
        {
          ...input.persistence,
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
        metadata: input.persistence,
      });
    }
    const recoveryLeaseToken = input.recovery?.recoveryLeaseToken;
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
    const runtimeLeaseToken = recoveryLeaseToken ?? liveLease?.leaseToken;
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
    if (input.runtime.runEpoch !== expectedRunEpoch) {
      throw new ClaudeGoalRuntimeEpochMismatchError(
        input.runtime.runtimeSessionId,
        expectedRunEpoch,
        input.runtime.runEpoch,
      );
    }
    if (expectedRunEpoch > 0 && !input.recovery) {
      throw new ClaudeGoalRuntimeRecoveryRequiredError(
        input.runtime.runtimeSessionId,
        expectedRunEpoch,
      );
    }
    input.runtime.attachEventObserver(
      new ClaudeRuntimeEventObserver(
        ownerId,
        input.runtime.runtimeSessionId,
        goalRuntime.observations,
      ),
    );
    const goalStopController = goalRuntime.controller.forSession({
      ownerId,
      runtimeSessionId: input.runtime.runtimeSessionId,
      transport: input.runtime,
    });
    input.runtime.attachGoalStopController(goalStopController);
    const registerRuntime = () => {
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
    };
    // A recovery claim already reserves the durable Runtime Session identity.
    // Do not expose its transport to normal dispatch until Claude proves that
    // it resumed the exact persisted provider session. Otherwise a concurrent
    // Goal command could enter the SDK input stream before the identity fence.
    if (!input.recovery) registerRuntime();
    input.runtime.start(input.start);
    runtimeStarted = true;
    await liveLease?.persistRunning();
    if (input.recovery) {
      const providerSessionId =
        await input.runtime.waitUntilProviderSessionInitialized();
      registerRuntime();

      await goalRuntime.dispatcher.initializeRecoveredProgress({
        ownerId,
        runtimeSessionId: input.runtime.runtimeSessionId,
        transport: input.runtime,
        settlements: input.recovery.instructionSettlements,
      });
      await replayPendingInstructions({
        runtime: input.runtime,
        goalRuntime,
        ownerId,
      });

      const recoveryAttemptId =
        input.recovery.recoveryLeaseToken ?? crypto.randomUUID();
      await input.recovery.onProviderSessionInitialized?.({
        runtimeSessionId: input.runtime.runtimeSessionId,
        providerSessionId,
        runEpoch: input.runtime.runEpoch,
        continueGoal: createRecoveryContinuationTrigger(
          input.runtime,
          ownerId,
          goalRuntime,
          goalStopController,
          recoveryAttemptId,
        ),
        finalizeGoalWithoutContinuation:
          createRecoveryFinalizationTrigger(
            input.runtime,
            recoveryAttemptId,
            input.recovery.recoveryLeaseToken,
          ),
      });
    } else {
      await replayPendingInstructions({
        runtime: input.runtime,
        goalRuntime,
        ownerId,
      });
    }
    return registration;
  } catch (error) {
    try {
      await input.runtime.close();
    } finally {
      await registration?.release();
      await persistenceCleanup?.();
    }
    throw error;
  }
}

interface LiveRuntimeLease {
  readonly leaseToken: string;
  readonly initialRunEpoch: number;
  stop(): void;
  persistRunning(): Promise<void>;
  release(expectedRunEpoch: number): Promise<void>;
}

const LIVE_RUNTIME_LEASE_DURATION_MS = 60_000;
const LIVE_RUNTIME_HEARTBEAT_INTERVAL_MS = 20_000;
const LIVE_RUNTIME_EXPIRY_SAFETY_MS = 1_000;

async function acquireLiveRuntimeLease(input: {
  persistence: RuntimeSessionRecoveryPersistencePort;
  ownerId: string;
  runtime: ClaudeRuntimeSession;
  metadata?: Omit<RuntimeSessionEnsureOptions, "recoveryLeaseToken">;
}): Promise<LiveRuntimeLease | undefined> {
  const leaseOwner = `openloomi-live:${process.pid}:${crypto.randomUUID()}`;
  const claim = await input.persistence.claimLiveRuntime({
    ownerId: input.ownerId,
    runtimeSessionId: input.runtime.runtimeSessionId,
    leaseOwner,
    leaseDurationMs: LIVE_RUNTIME_LEASE_DURATION_MS,
    ...input.metadata,
  });
  if (!claim) {
    throw new ClaudeGoalRuntimeLiveLeaseError(input.runtime.runtimeSessionId);
  }
  return createLiveRuntimeLease(input.persistence, claim, input.runtime);
}

function createLiveRuntimeLease(
  persistence: RuntimeSessionRecoveryPersistencePort,
  claim: RuntimeLiveSessionLease,
  runtime: ClaudeRuntimeSession,
): LiveRuntimeLease {
  let stopped = false;
  let renewal: Promise<void> | undefined;
  let expiresAt =
    Date.now() + LIVE_RUNTIME_LEASE_DURATION_MS - LIVE_RUNTIME_EXPIRY_SAFETY_MS;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const failClosed = (error: unknown) => {
    stop();
    console.error(
      `[Agent Goal Runtime] Lost live lease for ${claim.runtimeSessionId}; closing Claude`,
      error,
    );
    void runtime.close();
  };
  const scheduleExpiry = () => {
    if (stopped) return;
    if (expiryTimer) clearTimeout(expiryTimer);
    const delay = Math.max(0, expiresAt - Date.now());
    expiryTimer = setTimeout(() => {
      failClosed(
        new Error(
          `Live lease for Runtime Session ${claim.runtimeSessionId} expired`,
        ),
      );
    }, delay);
    expiryTimer.unref?.();
  };
  const renew = () => {
    if (stopped || renewal) return;
    renewal = persistence
      .renewRecoveryLease({
        ownerId: claim.ownerId,
        runtimeSessionId: claim.runtimeSessionId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseDurationMs: LIVE_RUNTIME_LEASE_DURATION_MS,
      })
      .then(() => {
        expiresAt =
          Date.now() +
          LIVE_RUNTIME_LEASE_DURATION_MS -
          LIVE_RUNTIME_EXPIRY_SAFETY_MS;
        scheduleExpiry();
      })
      .catch((error) => {
        if (!stopped) failClosed(error);
      })
      .finally(() => {
        renewal = undefined;
      });
  };
  const timer = setInterval(renew, LIVE_RUNTIME_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
  };
  scheduleExpiry();

  return {
    leaseToken: claim.leaseToken,
    initialRunEpoch: claim.runEpoch,
    stop,
    persistRunning: async () => {
      await persistence.persistState({
        ownerId: claim.ownerId,
        runtimeSessionId: claim.runtimeSessionId,
        expectedState: claim.state,
        expectedRunEpoch: claim.runEpoch,
        state: "running",
        recoveryLeaseToken: claim.leaseToken,
      });
    },
    release: async (expectedRunEpoch) => {
      stop();
      await renewal;
      await persistence.releaseLiveRuntime({
        ownerId: claim.ownerId,
        runtimeSessionId: claim.runtimeSessionId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        expectedRunEpoch,
      });
    },
  };
}

function isRecoveryPersistence(
  persistence: RuntimeSessionPersistencePort,
): persistence is RuntimeSessionRecoveryPersistencePort {
  const candidate =
    persistence as Partial<RuntimeSessionRecoveryPersistencePort>;
  return (
    typeof candidate.claimLiveRuntime === "function" &&
    typeof candidate.renewRecoveryLease === "function" &&
    typeof candidate.releaseLiveRuntime === "function" &&
    typeof candidate.persistState === "function"
  );
}

function attachRuntimeObservationLease(
  observations: AgentGoalRuntime["observations"],
  ownerId: string,
  runtimeSessionId: string,
  leaseToken: string,
): RuntimeObservationLeaseRegistration | undefined {
  const candidate = observations as Partial<RuntimeObservationLeaseFencePort>;
  return typeof candidate.attachRuntimeLease === "function"
    ? candidate.attachRuntimeLease({
        ownerId,
        runtimeSessionId,
        leaseToken,
      })
    : undefined;
}

function memoizeAsync(action: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= action();
    return result;
  };
}

async function replayPendingInstructions(input: {
  runtime: ClaudeRuntimeSession;
  goalRuntime: AgentGoalRuntime;
  ownerId: string;
}): Promise<void> {
  const replay = await input.runtime.replayInitialInstructions(() =>
    input.goalRuntime.goals.replayPendingInstructions(
      input.ownerId,
      input.runtime.runtimeSessionId,
    ),
  );
  if (replay !== null && replay.status !== "accepted") {
    throw new ClaudeGoalRuntimeRegistrationError(replay);
  }
}

function createRecoveryContinuationTrigger(
  runtime: ClaudeRuntimeSession,
  ownerId: string,
  goalRuntime: AgentGoalRuntime,
  goalStopController: ClaudeRuntimeGoalStopController,
  recoveryAttemptId: string,
): () => Promise<AgentRuntimeRecoveryContinuationResult> {
  let decision: ClaudeRuntimeStopHookDecision | null = null;
  let inFlight: Promise<ClaudeRuntimeStopHookDecision> | null = null;
  return async () => {
    if (decision) return recoveryContinuationResult(decision);
    if (inFlight) return recoveryContinuationResult(await inFlight);

    inFlight = (async () => {
      const turnContext = await goalRuntime.observations.captureContext({
        ownerId,
        runtimeSessionId: runtime.runtimeSessionId,
        runEpoch: runtime.runEpoch,
      });
      const evaluated = await goalStopController.evaluateStop({
        runEpoch: runtime.runEpoch,
        // A runEpoch can survive multiple host restarts. Treat each durable
        // recovery claim as a new synthetic evaluation boundary so evidence
        // gathered between restarts cannot collide with an earlier
        // goal.continue command that used the same runEpoch.
        assistantTurnId: `recovery:${runtime.runtimeSessionId}:${runtime.runEpoch}:${recoveryAttemptId}`,
        turnContext,
        stopHookActive: false,
      });
      if (evaluated.decision === "block") {
        const receipt = await runtime.deliver(evaluated.instruction);
        if (receipt.state !== "queued") {
          throw new Error(
            `Recovered Goal continuation ${evaluated.instruction.id} was not queued: ${receipt.state}`,
          );
        }
      }
      return evaluated;
    })();
    try {
      decision = await inFlight;
      return recoveryContinuationResult(decision);
    } finally {
      inFlight = null;
    }
  };
}

function createRecoveryFinalizationTrigger(
  runtime: ClaudeRuntimeSession,
  recoveryAttemptId: string,
  runtimeLeaseToken?: string,
): () => Promise<AgentRuntimeRecoveryGoalFinalizationResult> {
  let result: AgentRuntimeRecoveryGoalFinalizationResult | null = null;
  let inFlight: Promise<AgentRuntimeRecoveryGoalFinalizationResult> | null =
    null;
  return async () => {
    if (result) return result;
    if (inFlight) return inFlight;

    inFlight = runtime.finalizeGoalWithoutContinuation(
      `recovery-terminal:${runtime.runtimeSessionId}:${runtime.runEpoch}:${recoveryAttemptId}`,
      runtimeLeaseToken,
    );
    try {
      const finalized = await inFlight;
      result = finalized;
      return finalized;
    } finally {
      inFlight = null;
    }
  };
}

function recoveryContinuationResult(
  decision: ClaudeRuntimeStopHookDecision,
): AgentRuntimeRecoveryContinuationResult {
  return decision.decision === "block"
    ? { decision: "block" as const, outcome: "continue" as const }
    : { decision: "allow" as const, outcome: decision.outcome };
}

export function resolveAuthenticatedGoalRuntimeOwnerId(
  session: unknown,
): string | undefined {
  if (!session || typeof session !== "object") return undefined;

  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return undefined;

  const id = (user as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;

  if (id.length === 0 || id.length > 256 || id !== id.trim()) {
    return undefined;
  }
  return id;
}
