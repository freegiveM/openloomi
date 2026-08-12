import { isAbsolute } from "node:path";

import type { RuntimeSessionState } from "@openloomi/ai/agent/runtime-instructions";
import type {
  AgentRuntimeRecovery,
  AgentRuntimeRecoveryContinuationResult,
  AgentRuntimeRecoveryGoalFinalizationResult,
} from "@openloomi/ai/agent/types";
import type {
  NativeAgentRequest,
  NativeAgentRun,
  NativeAgentSession,
} from "@openloomi/ai/agent/native-runner";
import type { AgentRuntimePermissionHandler } from "@openloomi/ai/agent/runtime";

import type {
  RuntimeRecoveryCandidate,
  RuntimeRecoveryClaim,
  RuntimeRecoveryDescriptor,
  RuntimeRecoverySnapshot,
  RuntimeSessionRecoveryPersistencePort,
} from "../runtime-session-persistence";
import type { RuntimeObservationLeaseRegistration } from "../runtime-observation";
import type {
  PendingOperationRecoveryResult,
  RuntimeRecoveryPendingOperation,
} from "./pending-operation-reconciler";
import type {
  RuntimeRecoveryChatRecorder,
  RuntimeRecoveryChatRecorderInput,
} from "./chat-message-recorder";

const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_RESCAN_INTERVAL_MS = 15_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 60_000;
const RECOVERY_BOOTSTRAP_PROMPT =
  "Resume the authenticated OpenLoomi Goal Runtime from its durable state.";

export interface RuntimeRecoveryOwnerSession extends NativeAgentSession {
  user: NonNullable<NativeAgentSession["user"]> & { id: string };
  expires: string;
}

export interface RuntimeProviderSessionPreflightPort {
  verify(input: {
    providerSessionId: string;
    workingDirectory: string;
  }): Promise<void>;
}

export interface RuntimeRecoveryNativeRunnerPort {
  run(
    request: NativeAgentRequest,
    context: {
      session: RuntimeRecoveryOwnerSession;
      userId: string;
      abortController: AbortController;
      permissionHandler: AgentRuntimePermissionHandler;
      emitPermissionRequestEvents: false;
      runtimeRecovery: AgentRuntimeRecovery;
    },
  ): Promise<NativeAgentRun>;
}

export interface RuntimeRecoveryCoordinatorDependencies {
  persistence: RuntimeSessionRecoveryPersistencePort;
  providerPreflight: RuntimeProviderSessionPreflightPort;
  nativeRunner: RuntimeRecoveryNativeRunnerPort;
  loadOwnerSession(
    ownerId: string,
  ): Promise<RuntimeRecoveryOwnerSession | null>;
  reconcilePendingOperation(
    operation: RuntimeRecoveryPendingOperation,
  ): Promise<PendingOperationRecoveryResult>;
  /**
   * Extends the durable recovery fence to journal writes that occur before the
   * provider runtime attaches its own observation registration.
   */
  attachObservationLease?(input: {
    ownerId: string;
    runtimeSessionId: string;
    leaseToken: string;
  }): RuntimeObservationLeaseRegistration;
  createChatRecorder?(
    input: RuntimeRecoveryChatRecorderInput,
  ): Promise<RuntimeRecoveryChatRecorder>;
  logger?: Pick<Console, "log" | "warn" | "error">;
  leaseOwner?: string;
  scanLimit?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  rescanIntervalMs?: number;
  initializationTimeoutMs?: number;
}

export type RuntimeRecoveryStartupStatus =
  | "resumed"
  | "dormant"
  | "unclaimed"
  | "already_running"
  | "failed";

export interface RuntimeRecoveryStartupOutcome {
  ownerId: string;
  runtimeSessionId: string;
  status: RuntimeRecoveryStartupStatus;
  reason?: string;
}

export interface RuntimeRecoveryStartupReport {
  scanned: number;
  outcomes: RuntimeRecoveryStartupOutcome[];
}

/**
 * Reattaches unfinished, owner-scoped Goal runtimes to their exact provider
 * sessions. The durable recovery lease fences every reconciliation and remains
 * alive until the recovered provider query ends, so another process cannot
 * concurrently resume the same transcript.
 */
export class GoalRuntimeRecoveryCoordinator {
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly leaseOwner: string;
  private readonly scanLimit: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly rescanIntervalMs: number;
  private readonly initializationTimeoutMs: number;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly launches = new Map<
    string,
    Promise<RuntimeRecoveryStartupOutcome>
  >();
  private scan?: Promise<RuntimeRecoveryStartupReport>;
  private rescanTimer?: ReturnType<typeof setInterval>;
  private rescanInFlight = false;

  constructor(private readonly deps: RuntimeRecoveryCoordinatorDependencies) {
    this.logger = deps.logger ?? console;
    this.leaseOwner =
      normalizeIdentifier(deps.leaseOwner ?? `openloomi:${process.pid}`) ??
      `openloomi:${process.pid}`;
    this.scanLimit = positiveInteger(
      deps.scanLimit ?? DEFAULT_SCAN_LIMIT,
      "scanLimit",
    );
    this.leaseDurationMs = positiveInteger(
      deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.heartbeatIntervalMs = positiveInteger(
      deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.rescanIntervalMs = positiveInteger(
      deps.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS,
      "rescanIntervalMs",
    );
    this.initializationTimeoutMs = positiveInteger(
      deps.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
      "initializationTimeoutMs",
    );
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new TypeError(
        "heartbeatIntervalMs must be shorter than leaseDurationMs",
      );
    }
  }

  start(): Promise<RuntimeRecoveryStartupReport> {
    if (this.scan) return this.scan;
    const scan = this.scanRecoverable().finally(() => {
      if (this.scan === scan) this.scan = undefined;
    });
    this.scan = scan;
    return scan;
  }

  /**
   * Keeps looking for sessions whose previous host lease was still valid at
   * boot. The timer is process-local and unref'd; each pass remains bounded by
   * scanLimit and concurrent passes collapse onto the same scan promise.
   */
  startMonitoring(): void {
    if (this.rescanTimer) return;
    this.rescanTimer = setInterval(() => {
      if (this.rescanInFlight) return;
      this.rescanInFlight = true;
      void this.start()
        .then((report) => {
          if (report.scanned === 0) return;
          const resumed = report.outcomes.filter(
            (entry) => entry.status === "resumed",
          ).length;
          const failed = report.outcomes.filter(
            (entry) => entry.status === "failed",
          ).length;
          this.logger.log(
            `[Agent Goal Recovery] rescan scanned=${report.scanned} resumed=${resumed} failed=${failed}`,
          );
        })
        .catch((error) => {
          this.logger.warn("[Agent Goal Recovery] Rescan failed", error);
        })
        .finally(() => {
          this.rescanInFlight = false;
        });
    }, this.rescanIntervalMs);
    this.rescanTimer.unref?.();
  }

  stopMonitoring(): void {
    if (!this.rescanTimer) return;
    clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
  }

  private async scanRecoverable(): Promise<RuntimeRecoveryStartupReport> {
    const candidates = await this.deps.persistence.listRecoverable(
      this.scanLimit,
    );
    const outcomes: RuntimeRecoveryStartupOutcome[] = [];
    // Start sequentially so desktop boot does not spawn several Claude CLI
    // processes and database-heavy memory lookups at the same instant.
    for (const candidate of candidates) {
      outcomes.push(await this.startCandidate(candidate));
    }
    return { scanned: candidates.length, outcomes };
  }

  /**
   * Reattaches one dormant persisted Runtime Session after a user resumes its
   * Goal. This uses the same durable claim and initialization barrier as boot
   * recovery; it never creates a fresh provider conversation.
   */
  async wake(input: {
    ownerId: string;
    runtimeSessionId: string;
  }): Promise<RuntimeRecoveryStartupOutcome> {
    const ownerId = normalizeIdentifier(input.ownerId);
    const runtimeSessionId = normalizeIdentifier(input.runtimeSessionId);
    if (!ownerId || !runtimeSessionId) {
      throw new TypeError(
        "Recovery wake requires ownerId and runtimeSessionId",
      );
    }
    const candidate: RuntimeRecoveryCandidate = {
      ownerId,
      runtimeSessionId,
      runEpoch: 0,
      updatedAt: new Date().toISOString(),
    };
    const first = await this.startCandidate(candidate);
    // A startup scan can already be finalizing this session as dormant while
    // the resume transaction commits. Retry once after that launch releases
    // its claim so the now-active Goal is not stranded until another restart.
    return first.status === "dormant"
      ? this.startCandidate({
          ...candidate,
          updatedAt: new Date().toISOString(),
        })
      : first;
  }

  private startCandidate(
    candidate: RuntimeRecoveryCandidate,
  ): Promise<RuntimeRecoveryStartupOutcome> {
    const key = recoveryScope(candidate.ownerId, candidate.runtimeSessionId);
    if (this.activeRuns.has(key)) {
      return Promise.resolve(outcome(candidate, "already_running"));
    }
    const launching = this.launches.get(key);
    if (launching) return launching;

    const launch = this.claimAndStart(candidate).finally(() => {
      this.launches.delete(key);
    });
    this.launches.set(key, launch);
    return launch;
  }

  private async claimAndStart(
    candidate: RuntimeRecoveryCandidate,
  ): Promise<RuntimeRecoveryStartupOutcome> {
    let claim: RuntimeRecoveryClaim | null = null;
    let heartbeat: RecoveryLeaseHeartbeat | null = null;
    let observationLease: RuntimeObservationLeaseRegistration | undefined;
    let expectedRunEpoch = candidate.runEpoch;
    let expectedGoal:
      | { readonly id: string; readonly revision: number }
      | undefined;
    try {
      claim = await this.deps.persistence.claimRecovery({
        ownerId: candidate.ownerId,
        runtimeSessionId: candidate.runtimeSessionId,
        leaseOwner: this.leaseOwner,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!claim) return outcome(candidate, "unclaimed");
      observationLease = this.deps.attachObservationLease?.({
        ownerId: claim.ownerId,
        runtimeSessionId: claim.runtimeSessionId,
        leaseToken: claim.leaseToken,
      });

      heartbeat = new RecoveryLeaseHeartbeat({
        persistence: this.deps.persistence,
        claim,
        leaseDurationMs: this.leaseDurationMs,
        intervalMs: this.heartbeatIntervalMs,
        logger: this.logger,
      });
      heartbeat.start();

      let snapshot = claim.snapshot;
      expectedRunEpoch = snapshot.session.runEpoch;
      expectedGoal = snapshot.activeGoal?.goal;
      if (snapshot.pendingOperation) {
        await this.deps.reconcilePendingOperation(snapshot.pendingOperation);
        // Pending lifecycle/replacement recovery can change runEpoch, Goal
        // assignment, and the canonical outbox. Never start from the claim's
        // now-stale snapshot.
        snapshot = await this.deps.persistence.refreshRecovery(
          claimIdentity(claim),
        );
        expectedRunEpoch = snapshot.session.runEpoch;
        expectedGoal = snapshot.activeGoal?.goal;
      }

      if (!shouldResume(snapshot)) {
        await this.persistDormantState(claim, snapshot);
        heartbeat.stop();
        await this.deps.persistence.releaseRecoveryLease(claimIdentity(claim));
        return outcome(candidate, "dormant", dormantReason(snapshot));
      }

      const config = validateResumeConfiguration(snapshot);
      const ownerSession = await this.deps.loadOwnerSession(claim.ownerId);
      if (!ownerSession || ownerSession.user.id !== claim.ownerId) {
        throw new RuntimeRecoveryError(
          "runtime_recovery_owner_not_found",
          `Owner ${claim.ownerId} is unavailable for Runtime Session ${claim.runtimeSessionId}`,
        );
      }
      await this.deps.providerPreflight.verify({
        providerSessionId: config.providerSessionId,
        workingDirectory: config.workingDirectory,
      });
      heartbeat.assertHealthy();

      return await this.launchRecoveredRun({
        candidate,
        claim,
        snapshot,
        descriptor: config.descriptor,
        providerSessionId: config.providerSessionId,
        workingDirectory: config.workingDirectory,
        ownerSession,
        heartbeat,
      });
    } catch (error) {
      heartbeat?.stop();
      if (claim) {
        await this.pauseAfterRecoveryFailure(
          claim,
          expectedRunEpoch,
          error,
          expectedGoal,
        );
      }
      this.logger.error(
        `[Agent Goal Recovery] Failed to resume ${candidate.runtimeSessionId}`,
        error,
      );
      return outcome(candidate, "failed", errorMessage(error));
    } finally {
      observationLease?.release();
    }
  }

  private async launchRecoveredRun(input: {
    candidate: RuntimeRecoveryCandidate;
    claim: RuntimeRecoveryClaim;
    snapshot: RuntimeRecoverySnapshot;
    descriptor: RuntimeRecoveryDescriptor;
    providerSessionId: string;
    workingDirectory: string;
    ownerSession: RuntimeRecoveryOwnerSession;
    heartbeat: RecoveryLeaseHeartbeat;
  }): Promise<RuntimeRecoveryStartupOutcome> {
    const key = recoveryScope(
      input.claim.ownerId,
      input.claim.runtimeSessionId,
    );
    const abortController = new AbortController();
    const initialized = deferred<AgentRuntimeRecoveryContinuationResult>();
    let durableState = input.snapshot.session.state;
    let continuationResult: AgentRuntimeRecoveryContinuationResult | undefined;
    let intentionalStop = false;
    let failureFinalization: Promise<void> | undefined;
    let releasePromise: Promise<void> | undefined;
    let releaseRunEpoch = input.snapshot.session.runEpoch;
    let finalizeGoalWithoutContinuation:
      | (() => Promise<AgentRuntimeRecoveryGoalFinalizationResult>)
      | undefined;

    const releaseRuntime = async (expectedRunEpoch: number) => {
      releasePromise ??= (async () => {
        await input.heartbeat.stopAndDrain();
        await this.deps.persistence.releaseLiveRuntime({
          ...claimIdentity(input.claim),
          expectedRunEpoch,
        });
      })();
      await releasePromise;
    };

    const finalizeFailure = async (
      error: unknown,
      options: { evaluateDurableEvidence?: boolean } = {},
    ) => {
      failureFinalization ??= (async () => {
        let failureRunEpoch = releaseRunEpoch;
        let expectedGoal = input.snapshot.activeGoal?.goal;
        try {
          const latest = await this.deps.persistence.refreshRecovery(
            claimIdentity(input.claim),
          );
          failureRunEpoch = latest.session.runEpoch;
          releaseRunEpoch = failureRunEpoch;
          expectedGoal = latest.activeGoal?.goal;
        } catch (refreshError) {
          // A reclaimed/expired lease must not mutate the new owner's state.
          // For other failures, pauseAfterRecoveryFailure still has its own token and
          // epoch fence and will safely reject a stale snapshot.
          this.logger.warn(
            `[Agent Goal Recovery] Could not refresh failure epoch for ${input.claim.runtimeSessionId}`,
            refreshError,
          );
        }
        if (
          options.evaluateDurableEvidence &&
          finalizeGoalWithoutContinuation
        ) {
          try {
            const finalized = await finalizeGoalWithoutContinuation();
            if (finalized.outcome !== "stale") {
              await releaseRuntime(failureRunEpoch);
              return;
            }
            throw new RuntimeRecoveryError(
              "goal_finalization_stale",
              `Durable Goal evidence could not be finalized for revision ${finalized.goalRevision ?? "unknown"}`,
            );
          } catch (evaluationError) {
            // Evaluation is best-effort at a provider-failure boundary. If its
            // own infrastructure is unavailable, the fenced recovery pause
            // below still prevents a stuck running lease.
            this.logger.warn(
              `[Agent Goal Recovery] Could not evaluate durable evidence before pausing ${input.claim.runtimeSessionId}`,
              evaluationError,
            );
          }
        }
        input.heartbeat.stop();
        await this.pauseAfterRecoveryFailure(
          input.claim,
          failureRunEpoch,
          error,
          expectedGoal,
        );
      })();
      await failureFinalization;
    };
    input.heartbeat.onLost((error) => {
      initialized.reject(error);
      if (!abortController.signal.aborted) abortController.abort(error);
      void finalizeFailure(error);
    });

    const runtimeRecovery: AgentRuntimeRecovery = {
      runtimeSessionId: input.claim.runtimeSessionId,
      providerSessionId: input.providerSessionId,
      workingDirectory: input.workingDirectory,
      runEpoch: input.snapshot.session.runEpoch,
      recoveryLeaseToken: input.claim.leaseToken,
      instructionSettlements: input.snapshot.instructionSettlements.map(
        (settlement) => ({ ...settlement }),
      ),
      onProviderSessionInitialized: async (provider) => {
        try {
          assertProviderInitialization(input.claim, input.snapshot, provider);
          finalizeGoalWithoutContinuation =
            provider.finalizeGoalWithoutContinuation;
          durableState = await this.persistRuntimeState({
            claim: input.claim,
            expectedState: durableState,
            runEpoch: input.snapshot.session.runEpoch,
            state: "running",
          });
          continuationResult =
            input.snapshot.replayableInstructionIds.length > 0
              ? { decision: "block", outcome: "continue" }
              : await provider.continueGoal();
          if (continuationResult.decision === "allow") {
            // Mark the provider shutdown durably while retaining its lease.
            // The lease is released only after the generator terminates, so a
            // second process cannot resume the same transcript mid-shutdown.
            durableState = await this.persistRuntimeState({
              claim: input.claim,
              expectedState: durableState,
              runEpoch: input.snapshot.session.runEpoch,
              state: "interrupted",
            });
            intentionalStop = true;
            abortController.abort(
              new Error(`Recovered Goal is ${continuationResult.outcome}`),
            );
          }
          initialized.resolve(continuationResult);
        } catch (error) {
          initialized.reject(error);
          throw error;
        }
      },
    };

    const request = recoveryRequest(
      input.claim.runtimeSessionId,
      input.workingDirectory,
      input.descriptor,
    );
    const run = await this.deps.nativeRunner.run(request, {
      session: input.ownerSession,
      userId: input.claim.ownerId,
      abortController,
      permissionHandler: denyBackgroundPermission,
      emitPermissionRequestEvents: false,
      runtimeRecovery,
    });
    let chatRecorder: RuntimeRecoveryChatRecorder | undefined;
    try {
      chatRecorder = await this.deps.createChatRecorder?.({
        ownerId: input.claim.ownerId,
        runtimeSessionId: input.claim.runtimeSessionId,
        providerSessionId: input.providerSessionId,
        runEpoch: input.snapshot.session.runEpoch,
      });
    } catch (error) {
      // Chat presentation is best-effort and must never alter durable Goal
      // recovery semantics or release its lease early.
      this.logger.warn(
        `[Agent Goal Recovery] Could not attach chat output for ${input.claim.runtimeSessionId}`,
        error,
      );
    }

    const completion = (async () => {
      let providerFailure: RuntimeRecoveryError | undefined;
      const providerIterator = run.generator[Symbol.asyncIterator]();
      try {
        try {
          while (true) {
            const next = await providerIterator.next();
            if (next.done) break;
            const message = next.value;
            if (message.type === "error") {
              providerFailure = new RuntimeRecoveryError(
                "provider_resume_failed",
                message.message ?? "Recovered provider run failed",
              );
              if (!abortController.signal.aborted) {
                abortController.abort(providerFailure);
              }
            }
            try {
              await chatRecorder?.record(message);
            } catch (error) {
              this.logger.warn(
                `[Agent Goal Recovery] Could not persist recovered output for ${input.claim.runtimeSessionId}`,
                error,
              );
            }
            if (providerFailure) {
              break;
            }
          }
        } finally {
          try {
            await chatRecorder?.close();
          } catch (error) {
            this.logger.warn(
              `[Agent Goal Recovery] Could not flush recovered output for ${input.claim.runtimeSessionId}`,
              error,
            );
          }
        }
        if (providerFailure && !intentionalStop) {
          throw providerFailure;
        }
        if (!continuationResult) {
          throw new RuntimeRecoveryError(
            "provider_resume_ended_before_initialization",
            "Claude recovery ended before the provider session was initialized",
          );
        }
        if (continuationResult.decision === "block") {
          const latest = await this.deps.persistence.refreshRecovery(
            claimIdentity(input.claim),
          );
          releaseRunEpoch = latest.session.runEpoch;
          if (latest.activeGoal?.goal.status === "active") {
            throw new RuntimeRecoveryError(
              "provider_resume_ended_with_active_goal",
              "Claude recovery ended while the Goal was still active",
            );
          }
        }
        await releaseRuntime(releaseRunEpoch);
      } catch (error) {
        if (intentionalStop) {
          await releaseRuntime(releaseRunEpoch);
          return;
        }
        initialized.reject(error);
        try {
          await finalizeFailure(error, {
            evaluateDurableEvidence: error === providerFailure,
          });
        } finally {
          if (error === providerFailure) {
            // Keep the Goal observer attached until durable evidence has been
            // evaluated. Provider cleanup remains best-effort and must never
            // retain the recovery lease after that boundary.
            closeIteratorInBackground(
              providerIterator,
              input.claim.runtimeSessionId,
              this.logger,
            );
          }
        }
        throw error;
      } finally {
        input.heartbeat.stop();
      }
    })();

    // Own the rejection in the background. Startup only waits for the init
    // barrier; later provider failures durably pause the Goal for an explicit retry.
    const observedCompletion = completion
      .catch((error) => {
        this.logger.error(
          `[Agent Goal Recovery] Recovered runtime ${input.claim.runtimeSessionId} stopped`,
          error,
        );
      })
      .finally(() => {
        this.activeRuns.delete(key);
      });
    this.activeRuns.set(key, observedCompletion);

    try {
      await withTimeout(
        initialized.promise,
        this.initializationTimeoutMs,
        `Claude session ${input.providerSessionId} did not initialize in time`,
      );
      return outcome(input.candidate, "resumed");
    } catch (error) {
      if (!abortController.signal.aborted) abortController.abort(error);
      await finalizeFailure(error);
      this.logger.error(
        `[Agent Goal Recovery] Failed to initialize ${input.claim.runtimeSessionId}`,
        error,
      );
      return outcome(input.candidate, "failed", errorMessage(error));
    }
  }

  private async persistDormantState(
    claim: RuntimeRecoveryClaim,
    snapshot: RuntimeRecoverySnapshot,
  ): Promise<void> {
    if (snapshot.session.state === "idle") return;
    if (
      snapshot.session.state === "closed" ||
      snapshot.session.state === "failed"
    ) {
      return;
    }
    await this.deps.persistence.persistState({
      ownerId: claim.ownerId,
      runtimeSessionId: claim.runtimeSessionId,
      expectedState: snapshot.session.state,
      expectedRunEpoch: snapshot.session.runEpoch,
      state: "idle",
      recoveryLeaseToken: claim.leaseToken,
    });
  }

  private async persistRuntimeState(input: {
    claim: RuntimeRecoveryClaim;
    expectedState: RuntimeSessionState;
    runEpoch: number;
    state: RuntimeSessionState;
  }): Promise<RuntimeSessionState> {
    if (input.expectedState === input.state) return input.state;
    const persisted = await this.deps.persistence.persistState({
      ownerId: input.claim.ownerId,
      runtimeSessionId: input.claim.runtimeSessionId,
      expectedState: input.expectedState,
      expectedRunEpoch: input.runEpoch,
      state: input.state,
      recoveryLeaseToken: input.claim.leaseToken,
    });
    return persisted.state;
  }

  private async pauseAfterRecoveryFailure(
    claim: RuntimeRecoveryClaim,
    expectedRunEpoch: number,
    error: unknown,
    expectedGoal?: { readonly id: string; readonly revision: number },
  ): Promise<void> {
    const failure = recoveryFailure(error);
    try {
      await this.deps.persistence.pauseAfterRecoveryFailure({
        ...claimIdentity(claim),
        expectedRunEpoch,
        ...(expectedGoal === undefined
          ? {}
          : {
              expectedGoalId: expectedGoal.id,
              expectedGoalRevision: expectedGoal.revision,
            }),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
    } catch (markError) {
      this.logger.error(
        `[Agent Goal Recovery] Could not persist failure for ${claim.runtimeSessionId}`,
        markError,
      );
    }
  }
}

function closeIteratorInBackground(
  iterator: AsyncIterator<unknown>,
  runtimeSessionId: string,
  logger: Pick<Console, "warn">,
): void {
  try {
    const cleanup = iterator.return?.();
    if (!cleanup) return;
    void cleanup.catch((error) => {
      logger.warn(
        `[Agent Goal Recovery] Provider cleanup failed for ${runtimeSessionId}`,
        error,
      );
    });
  } catch (error) {
    logger.warn(
      `[Agent Goal Recovery] Provider cleanup failed for ${runtimeSessionId}`,
      error,
    );
  }
}

class RuntimeRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeRecoveryError";
  }
}

class RecoveryLeaseHeartbeat {
  private timer?: ReturnType<typeof setInterval>;
  private renewal: Promise<void> | null = null;
  private failure?: unknown;
  private expiresAt = 0;
  private readonly failureListeners = new Set<(error: unknown) => void>();

  constructor(
    private readonly input: {
      persistence: RuntimeSessionRecoveryPersistencePort;
      claim: RuntimeRecoveryClaim;
      leaseDurationMs: number;
      intervalMs: number;
      logger: Pick<Console, "warn">;
    },
  ) {
    this.expiresAt = Date.parse(input.claim.leaseExpiresAt);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.renewal) return;
      this.renewal = this.input.persistence
        .renewRecoveryLease({
          ...claimIdentity(this.input.claim),
          leaseDurationMs: this.input.leaseDurationMs,
        })
        .then((expiresAt) => {
          this.expiresAt = Date.parse(expiresAt);
        })
        .catch((error) => {
          if (
            recoveryErrorCode(error) === "runtime_recovery_claim_conflict" ||
            !Number.isFinite(this.expiresAt) ||
            Date.now() + this.input.intervalMs >= this.expiresAt
          ) {
            this.fail(error);
          }
          this.input.logger.warn(
            `[Agent Goal Recovery] Lease heartbeat failed for ${this.input.claim.runtimeSessionId}`,
            error,
          );
        })
        .finally(() => {
          this.renewal = null;
        });
    }, this.input.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.renewal;
    this.assertHealthy();
  }

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  onLost(listener: (error: unknown) => void): void {
    this.failureListeners.add(listener);
    if (this.failure !== undefined) listener(this.failure);
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        this.input.logger.warn(
          `[Agent Goal Recovery] Lease-loss handler failed for ${this.input.claim.runtimeSessionId}`,
          listenerError,
        );
      }
    }
  }
}

function shouldResume(snapshot: RuntimeRecoverySnapshot): boolean {
  return snapshot.activeGoal?.goal.status === "active";
}

function dormantReason(snapshot: RuntimeRecoverySnapshot): string {
  const status = snapshot.activeGoal?.goal.status;
  return status ? `goal_${status}` : "no_active_goal";
}

function validateResumeConfiguration(snapshot: RuntimeRecoverySnapshot): {
  providerSessionId: string;
  workingDirectory: string;
  descriptor: RuntimeRecoveryDescriptor;
} {
  if (snapshot.session.provider !== "claude") {
    throw new RuntimeRecoveryError(
      "runtime_recovery_provider_unsupported",
      `Runtime provider ${snapshot.session.provider} cannot be recovered by the Claude host`,
    );
  }
  const providerSessionId = normalizeIdentifier(
    snapshot.session.providerSessionId,
  );
  if (!providerSessionId) {
    throw new RuntimeRecoveryError(
      "provider_session_missing",
      "The unfinished Goal has no persisted Claude provider session",
    );
  }
  const workingDirectory = snapshot.session.workingDirectory;
  if (
    typeof workingDirectory !== "string" ||
    workingDirectory.length === 0 ||
    workingDirectory !== workingDirectory.trim() ||
    !isAbsolute(workingDirectory)
  ) {
    throw new RuntimeRecoveryError(
      "working_directory_missing",
      "The unfinished Goal has no valid persisted provider working directory",
    );
  }
  if (!snapshot.recoveryDescriptor) {
    throw new RuntimeRecoveryError(
      "recovery_descriptor_missing",
      "The unfinished Goal has no trusted runtime recovery descriptor",
    );
  }
  return {
    providerSessionId,
    workingDirectory,
    descriptor: snapshot.recoveryDescriptor,
  };
}

function recoveryRequest(
  runtimeSessionId: string,
  workingDirectory: string,
  descriptor: RuntimeRecoveryDescriptor,
): NativeAgentRequest {
  return {
    prompt: RECOVERY_BOOTSTRAP_PROMPT,
    provider: "claude",
    platform: "desktop-recovery",
    sessionId: runtimeSessionId,
    workDir: workingDirectory,
    useProvidedWorkDir: true,
    ...(descriptor.model === undefined && descriptor.thinkingLevel === undefined
      ? {}
      : {
          modelConfig: {
            ...(descriptor.model === undefined
              ? {}
              : { model: descriptor.model }),
            ...(descriptor.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: descriptor.thinkingLevel }),
          },
        }),
    ...(descriptor.allowedTools === undefined
      ? {}
      : { allowedTools: [...descriptor.allowedTools] }),
    ...(descriptor.disallowedTools === undefined
      ? {}
      : { disallowedTools: [...descriptor.disallowedTools] }),
    ...(descriptor.excludedTools === undefined
      ? {}
      : { excludeTools: [...descriptor.excludedTools] }),
    ...(descriptor.permissionMode === undefined
      ? {}
      : { permissionMode: descriptor.permissionMode }),
    ...(descriptor.sandbox === undefined
      ? {}
      : { sandboxConfig: { ...descriptor.sandbox } }),
    ...(descriptor.skillsConfig === undefined
      ? {}
      : { skillsConfig: { ...descriptor.skillsConfig } }),
    ...(descriptor.mcpConfig === undefined
      ? {}
      : { mcpConfig: { ...descriptor.mcpConfig } }),
  };
}

function assertProviderInitialization(
  claim: RuntimeRecoveryClaim,
  snapshot: RuntimeRecoverySnapshot,
  provider: {
    runtimeSessionId: string;
    providerSessionId: string;
    runEpoch: number;
  },
): void {
  if (
    provider.runtimeSessionId !== claim.runtimeSessionId ||
    provider.providerSessionId !== snapshot.session.providerSessionId ||
    provider.runEpoch !== snapshot.session.runEpoch
  ) {
    throw new RuntimeRecoveryError(
      "provider_session_mismatch",
      "Claude initialized a different provider session or runtime fence",
    );
  }
}

const denyBackgroundPermission: AgentRuntimePermissionHandler = async () => ({
  behavior: "deny",
});

function claimIdentity(claim: RuntimeRecoveryClaim) {
  return {
    ownerId: claim.ownerId,
    runtimeSessionId: claim.runtimeSessionId,
    leaseOwner: claim.leaseOwner,
    leaseToken: claim.leaseToken,
  };
}

function recoveryScope(ownerId: string, runtimeSessionId: string): string {
  return JSON.stringify([ownerId, runtimeSessionId]);
}

function outcome(
  candidate: RuntimeRecoveryCandidate,
  status: RuntimeRecoveryStartupStatus,
  reason?: string,
): RuntimeRecoveryStartupOutcome {
  return {
    ownerId: candidate.ownerId,
    runtimeSessionId: candidate.runtimeSessionId,
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    return undefined;
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryFailure(error: unknown): { code: string; message: string } {
  const candidateCode = recoveryErrorCode(error);
  const code =
    typeof candidateCode === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(candidateCode)
      ? candidateCode
      : "runtime_recovery_failed";
  const message =
    errorMessage(error).slice(0, 8_000) || "Runtime recovery failed";
  return { code, message };
}

function recoveryErrorCode(error: unknown): string | undefined {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new RuntimeRecoveryError(
                "provider_initialization_timeout",
                message,
              ),
            ),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
