import { describe, expect, it, vi } from "vitest";

import type { NativeAgentRun } from "@openloomi/ai/agent/native-runner";
import type { AgentMessage } from "@openloomi/ai/agent/types";

import type { RuntimeRecoveryChatRecorder } from "@/lib/ai/runtime-instructions/recovery/chat-message-recorder";
import {
  GoalRuntimeRecoveryCoordinator,
  type RuntimeRecoveryCoordinatorDependencies,
} from "@/lib/ai/runtime-instructions/recovery/coordinator";
import type {
  RuntimeRecoveryClaim,
  RuntimeRecoverySnapshot,
  RuntimeSessionRecoveryPersistencePort,
} from "@/lib/ai/runtime-instructions/runtime-session-persistence";

const OWNER_ID = "goal-recovery-owner";
const RUNTIME_SESSION_ID = "goal-recovery-session";
const PROVIDER_SESSION_ID = "claude-provider-session";
const WORKING_DIRECTORY = "D:\\openloomi\\sessions\\goal-recovery";
const LEASE_TOKEN = "goal-recovery-lease-token";
const NOW = "2026-08-10T10:00:00.000Z";

describe("GoalRuntimeRecoveryCoordinator", () => {
  it("keeps paused Goals dormant without starting Claude", async () => {
    const snapshot = recoverySnapshot("paused", { sessionState: "running" });
    const harness = createHarness(snapshot);
    const report = await harness.coordinator.start();

    expect(report.outcomes).toEqual([
      expect.objectContaining({ status: "dormant", reason: "goal_paused" }),
    ]);
    expect(harness.persistState).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedState: "running",
        state: "idle",
        recoveryLeaseToken: LEASE_TOKEN,
      }),
    );
    expect(harness.releaseRecoveryLease).toHaveBeenCalledOnce();
    expect(harness.attachObservationLease).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      runtimeSessionId: RUNTIME_SESSION_ID,
      leaseToken: LEASE_TOKEN,
    });
    expect(harness.releaseObservationLease).toHaveBeenCalledOnce();
    expect(harness.providerPreflight).not.toHaveBeenCalled();
    expect(harness.nativeRun).not.toHaveBeenCalled();
  });

  it("resumes the exact Claude session and treats its intentional stop as success", async () => {
    const snapshot = recoverySnapshot("active");
    const harness = createHarness(snapshot, {
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        if (context.abortController.signal.aborted) {
          yield { type: "error", message: "expected provider abort" };
        }
        yield { type: "done" };
      },
    });

    const report = await harness.coordinator.start();
    expect(report.outcomes[0]?.status).toBe("resumed");
    expect(harness.providerPreflight).toHaveBeenCalledWith({
      providerSessionId: PROVIDER_SESSION_ID,
      workingDirectory: WORKING_DIRECTORY,
    });

    const firstNativeRun = harness.nativeRun.mock.calls[0];
    if (!firstNativeRun) {
      throw new Error("Expected recovery to start the native runtime");
    }
    const [request, context] = firstNativeRun;
    expect(request).toMatchObject({
      provider: "claude",
      sessionId: RUNTIME_SESSION_ID,
      workDir: WORKING_DIRECTORY,
      useProvidedWorkDir: true,
    });
    expect(request).not.toHaveProperty("conversation");
    expect(request.prompt).not.toContain("original user prompt");
    expect(context.runtimeRecovery).toMatchObject({
      runtimeSessionId: RUNTIME_SESSION_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      workingDirectory: WORKING_DIRECTORY,
      runEpoch: 0,
      recoveryLeaseToken: LEASE_TOKEN,
    });
    await expect(context.permissionHandler({} as never)).resolves.toEqual({
      behavior: "deny",
    });

    await vi.waitFor(() => {
      expect(harness.releaseLiveRuntime).toHaveBeenCalledWith({
        ownerId: OWNER_ID,
        runtimeSessionId: RUNTIME_SESSION_ID,
        leaseOwner: "test-recovery-host",
        leaseToken: LEASE_TOKEN,
        expectedRunEpoch: 0,
      });
    });
    expect(harness.persistState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedState: "idle", state: "running" }),
    );
    expect(harness.persistState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedState: "running",
        state: "interrupted",
      }),
    );
    expect(harness.markRecoveryFailed).not.toHaveBeenCalled();
  });

  it("keeps recovery successful when chat presentation persistence fails", async () => {
    const chatRecorder: RuntimeRecoveryChatRecorder = {
      record: vi.fn(async () => {
        throw new Error("message database unavailable");
      }),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw new Error("final message flush unavailable");
      }),
    };
    const harness = createHarness(recoverySnapshot("active"), {
      chatRecorder,
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        yield { type: "text", content: "recovered output" };
        yield { type: "done" };
      },
    });

    await expect(harness.coordinator.start()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ status: "resumed" })],
    });
    await vi.waitFor(() => {
      expect(harness.releaseLiveRuntime).toHaveBeenCalledOnce();
    });
    expect(harness.markRecoveryFailed).not.toHaveBeenCalled();
    expect(chatRecorder.record).toHaveBeenCalled();
    expect(chatRecorder.close).toHaveBeenCalledOnce();
  });

  it("retains the recovery lease until the provider generator terminates", async () => {
    let finishProvider!: () => void;
    const providerFinished = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const harness = createHarness(recoverySnapshot("active"), {
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        await providerFinished;
        yield { type: "done" };
      },
    });

    await expect(harness.coordinator.start()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ status: "resumed" })],
    });
    expect(harness.persistState).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "interrupted" }),
    );
    expect(harness.releaseLiveRuntime).not.toHaveBeenCalled();

    finishProvider();
    await vi.waitFor(() => {
      expect(harness.releaseLiveRuntime).toHaveBeenCalledOnce();
    });
  });

  it("wakes one resumed dormant session without waiting for another boot scan", async () => {
    const snapshot = recoverySnapshot("active");
    const harness = createHarness(snapshot, {
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        yield { type: "done" };
      },
    });

    await expect(
      harness.coordinator.wake({
        ownerId: OWNER_ID,
        runtimeSessionId: RUNTIME_SESSION_ID,
      }),
    ).resolves.toMatchObject({ status: "resumed" });
    expect(harness.listRecoverable).not.toHaveBeenCalled();
    expect(harness.claimRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        runtimeSessionId: RUNTIME_SESSION_ID,
      }),
    );
  });

  it("rescans after a previous live host lease expires", async () => {
    vi.useFakeTimers();
    const snapshot = recoverySnapshot("active");
    const harness = createHarness(snapshot, {
      rescanIntervalMs: 1_000,
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        yield { type: "done" };
      },
    });
    harness.listRecoverable
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([recoverableCandidate()])
      .mockResolvedValue([]);

    try {
      harness.coordinator.startMonitoring();
      await expect(harness.coordinator.start()).resolves.toEqual({
        scanned: 0,
        outcomes: [],
      });
      expect(harness.nativeRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.listRecoverable).toHaveBeenCalledTimes(2);
      expect(harness.nativeRun).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(harness.releaseLiveRuntime).toHaveBeenCalledOnce();
      });
    } finally {
      harness.coordinator.stopMonitoring();
      vi.useRealTimers();
    }
  });

  it("does not blacklist a dormant scope that later becomes actionable", async () => {
    const paused = recoverySnapshot("paused");
    const active = recoverySnapshot("active");
    const harness = createHarness(paused, {
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        yield { type: "done" };
      },
    });
    harness.claimRecovery
      .mockResolvedValueOnce({ ...harness.claim, snapshot: paused })
      .mockResolvedValueOnce({ ...harness.claim, snapshot: active });

    await expect(harness.coordinator.start()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ status: "dormant" })],
    });
    await expect(harness.coordinator.start()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ status: "resumed" })],
    });

    expect(harness.claimRecovery).toHaveBeenCalledTimes(2);
    expect(harness.nativeRun).toHaveBeenCalledOnce();
  });

  it("does not overlap slow rescans and stops monitoring idempotently", async () => {
    vi.useFakeTimers();
    const harness = createHarness(recoverySnapshot("active"), {
      rescanIntervalMs: 1_000,
    });
    let resolveScan!: (
      candidates: ReturnType<typeof recoverableCandidate>[],
    ) => void;
    harness.listRecoverable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );

    try {
      harness.coordinator.startMonitoring();
      harness.coordinator.startMonitoring();
      const initialScan = harness.coordinator.start();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(harness.listRecoverable).toHaveBeenCalledOnce();

      resolveScan([]);
      await expect(initialScan).resolves.toEqual({ scanned: 0, outcomes: [] });
      await vi.runAllTicks();

      harness.coordinator.stopMonitoring();
      harness.coordinator.stopMonitoring();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(harness.listRecoverable).toHaveBeenCalledOnce();
    } finally {
      harness.coordinator.stopMonitoring();
      vi.useRealTimers();
    }
  });

  it("does not enqueue a second continuation after replaying pending input", async () => {
    const snapshot = recoverySnapshot("active", {
      replayableInstructionIds: ["pending-instruction"],
    });
    const completed = recoverySnapshot("completed", {
      sessionState: "running",
    });
    const continueGoal = vi.fn();
    const harness = createHarness(snapshot, {
      refreshSnapshot: completed,
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal,
        });
        yield { type: "done" };
      },
    });

    const report = await harness.coordinator.start();
    expect(report.outcomes[0]?.status).toBe("resumed");
    await vi.waitFor(() => {
      expect(harness.releaseLiveRuntime).toHaveBeenCalledOnce();
    });
    expect(continueGoal).not.toHaveBeenCalled();
    expect(harness.markRecoveryFailed).not.toHaveBeenCalled();
  });

  it("refreshes the fenced snapshot after reconciling an interrupted operation", async () => {
    const claimed: RuntimeRecoverySnapshot = {
      ...recoverySnapshot("paused"),
      pendingOperation: {
        ownerId: OWNER_ID,
        runtimeSessionId: RUNTIME_SESSION_ID,
      } as never,
    };
    const refreshed = recoverySnapshot("active");
    const harness = createHarness(claimed, {
      refreshSnapshot: refreshed,
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "allow",
            outcome: "completed",
          }),
        });
        yield { type: "done" };
      },
    });

    const report = await harness.coordinator.start();
    expect(report.outcomes[0]?.status).toBe("resumed");
    expect(harness.reconcilePendingOperation).toHaveBeenCalledOnce();
    expect(harness.refreshRecovery).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      runtimeSessionId: RUNTIME_SESSION_ID,
      leaseOwner: "test-recovery-host",
      leaseToken: LEASE_TOKEN,
    });
    const reconcileOrder =
      harness.reconcilePendingOperation.mock.invocationCallOrder[0];
    const refreshOrder = harness.refreshRecovery.mock.invocationCallOrder[0];
    const runOrder = harness.nativeRun.mock.invocationCallOrder[0];
    if (
      reconcileOrder === undefined ||
      refreshOrder === undefined ||
      runOrder === undefined
    ) {
      throw new Error("Expected all recovery stages to run in order");
    }
    expect(reconcileOrder).toBeLessThan(refreshOrder);
    expect(refreshOrder).toBeLessThan(runOrder);
  });

  it("blocks recovery when the persisted provider transcript is unavailable", async () => {
    const snapshot = recoverySnapshot("active");
    const harness = createHarness(snapshot, {
      preflightError: Object.assign(new Error("transcript missing"), {
        code: "provider_session_unavailable",
      }),
    });

    const report = await harness.coordinator.start();
    expect(report.outcomes[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: "transcript missing",
      }),
    );
    expect(harness.markRecoveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRunEpoch: 0,
        errorCode: "provider_session_unavailable",
        errorMessage: "transcript missing",
      }),
    );
    expect(harness.nativeRun).not.toHaveBeenCalled();
  });

  it("fences a delayed provider failure against the latest recovered epoch", async () => {
    const initial = recoverySnapshot("active");
    const advanced = {
      ...recoverySnapshot("active", { sessionState: "running" }),
      session: {
        ...initial.session,
        state: "running" as const,
        runEpoch: 2,
      },
    };
    const harness = createHarness(initial, {
      refreshSnapshot: advanced,
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "block",
            outcome: "continue",
          }),
        });
        yield { type: "error", message: "provider failed after replacement" };
      },
    });

    await expect(harness.coordinator.start()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ status: "resumed" })],
    });
    await vi.waitFor(() => {
      expect(harness.markRecoveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRunEpoch: 2,
          errorCode: "provider_resume_failed",
          errorMessage: "provider failed after replacement",
        }),
      );
    });
  });

  it("clears the live recovery presentation after a provider error", async () => {
    const harness = createHarness(recoverySnapshot("active"), {
      nativeGenerator: async function* (context) {
        await context.runtimeRecovery.onProviderSessionInitialized?.({
          runtimeSessionId: RUNTIME_SESSION_ID,
          providerSessionId: PROVIDER_SESSION_ID,
          runEpoch: 0,
          continueGoal: async () => ({
            decision: "block",
            outcome: "continue",
          }),
        });
        yield { type: "error", message: "safe provider failure" };
      },
    });

    await expect(harness.coordinator.start()).resolves.toMatchObject({
      outcomes: [expect.objectContaining({ status: "resumed" })],
    });
    await vi.waitFor(() => {
      expect(harness.markRecoveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRunEpoch: 0,
          errorCode: "provider_resume_failed",
          errorMessage: "safe provider failure",
        }),
      );
    });

    expect(harness.currentRuntimeState()).toBe("failed");
    expect(harness.hasRecoveryLease()).toBe(false);
    await expect(harness.listRecoveryPresentationSessions()).resolves.toEqual(
      [],
    );
    expect(harness.releaseLiveRuntime).not.toHaveBeenCalled();
    expect(harness.releaseObservationLease).toHaveBeenCalledOnce();
  });
});

type RecoveryContext = Parameters<
  RuntimeRecoveryCoordinatorDependencies["nativeRunner"]["run"]
>[1];

function createHarness(
  initialSnapshot: RuntimeRecoverySnapshot,
  options: {
    refreshSnapshot?: RuntimeRecoverySnapshot;
    preflightError?: Error;
    rescanIntervalMs?: number;
    nativeGenerator?: (
      context: RecoveryContext,
    ) => AsyncGenerator<AgentMessage>;
    chatRecorder?: RuntimeRecoveryChatRecorder;
  } = {},
) {
  let state = initialSnapshot.session.state;
  let recoveryLeaseHeld = true;
  let recoveryFailed = false;
  const claim: RuntimeRecoveryClaim = {
    ownerId: OWNER_ID,
    runtimeSessionId: RUNTIME_SESSION_ID,
    leaseOwner: "test-recovery-host",
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: "2026-08-10T10:01:00.000Z",
    snapshot: initialSnapshot,
  };
  const persistState = vi.fn(async (input) => {
    state = input.state;
    return { ...initialSnapshot.session, state };
  });
  const releaseRecoveryLease = vi.fn(async () => {
    recoveryLeaseHeld = false;
  });
  const releaseLiveRuntime = vi.fn(async () => {
    state = "idle";
    recoveryLeaseHeld = false;
    return {
      ...initialSnapshot.session,
      state: "idle" as const,
    };
  });
  const markRecoveryFailed = vi.fn(async () => {
    state = "failed";
    recoveryFailed = true;
    recoveryLeaseHeld = false;
  });
  const listRecoveryPresentationSessions = vi.fn(async () =>
    recoveryFailed
      ? []
      : [
          {
            runtimeSessionId: RUNTIME_SESSION_ID,
            state,
            runEpoch: initialSnapshot.session.runEpoch,
            updatedAt: NOW,
          },
        ],
  );
  const refreshRecovery = vi.fn(
    async () => options.refreshSnapshot ?? initialSnapshot,
  );
  const listRecoverable = vi.fn(async () => [recoverableCandidate()]);
  const claimRecovery = vi.fn(async () => claim);
  const persistence = {
    listRecoverable,
    claimRecovery,
    refreshRecovery,
    renewRecoveryLease: vi.fn(async () => "2026-08-10T10:02:00.000Z"),
    releaseRecoveryLease,
    releaseLiveRuntime,
    persistState,
    markRecoveryFailed,
    listRecoveryPresentationSessions,
  } as unknown as RuntimeSessionRecoveryPersistencePort;
  const providerPreflight = vi.fn(async () => {
    if (options.preflightError) throw options.preflightError;
  });
  const nativeRun = vi.fn(async (_request, context: RecoveryContext) => {
    const generator = options.nativeGenerator
      ? options.nativeGenerator(context)
      : (async function* () {
          yield { type: "done" as const };
        })();
    return { generator, shouldAbortOnClose: () => false } as NativeAgentRun;
  });
  const reconcilePendingOperation = vi.fn();
  const releaseObservationLease = vi.fn();
  const attachObservationLease = vi.fn(() => ({
    release: releaseObservationLease,
  }));
  const chatRecorder = options.chatRecorder;
  const coordinator = new GoalRuntimeRecoveryCoordinator({
    persistence,
    providerPreflight: { verify: providerPreflight },
    nativeRunner: { run: nativeRun },
    loadOwnerSession: async () => ({
      user: { id: OWNER_ID },
      expires: "2026-08-11T10:00:00.000Z",
    }),
    reconcilePendingOperation,
    attachObservationLease,
    ...(chatRecorder ? { createChatRecorder: async () => chatRecorder } : {}),
    leaseOwner: "test-recovery-host",
    leaseDurationMs: 60_000,
    heartbeatIntervalMs: 30_000,
    ...(options.rescanIntervalMs === undefined
      ? {}
      : { rescanIntervalMs: options.rescanIntervalMs }),
    initializationTimeoutMs: 1_000,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return {
    coordinator,
    providerPreflight,
    nativeRun,
    persistState,
    releaseRecoveryLease,
    releaseLiveRuntime,
    markRecoveryFailed,
    refreshRecovery,
    reconcilePendingOperation,
    attachObservationLease,
    releaseObservationLease,
    claim,
    listRecoverable,
    claimRecovery,
    listRecoveryPresentationSessions,
    currentRuntimeState: () => state,
    hasRecoveryLease: () => recoveryLeaseHeld,
  };
}

function recoverableCandidate() {
  return {
    ownerId: OWNER_ID,
    runtimeSessionId: RUNTIME_SESSION_ID,
    providerSessionId: PROVIDER_SESSION_ID,
    workingDirectory: WORKING_DIRECTORY,
    runEpoch: 0,
    updatedAt: NOW,
  };
}

function recoverySnapshot(
  goalStatus: "active" | "paused" | "completed",
  options: {
    sessionState?: RuntimeRecoverySnapshot["session"]["state"];
    replayableInstructionIds?: string[];
  } = {},
): RuntimeRecoverySnapshot {
  return {
    session: {
      id: RUNTIME_SESSION_ID,
      ownerId: OWNER_ID,
      provider: "claude",
      providerSessionId: PROVIDER_SESSION_ID,
      workingDirectory: WORKING_DIRECTORY,
      state: options.sessionState ?? "idle",
      runEpoch: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
    recoveryDescriptor: {
      schemaVersion: 1,
      permissionMode: "default",
      allowedTools: ["Read", "Write"],
      skillsConfig: {
        enabled: true,
        userDirEnabled: true,
        appDirEnabled: true,
      },
      mcpConfig: {
        enabled: true,
        userDirEnabled: true,
        appDirEnabled: false,
      },
    },
    activeGoal: {
      ownerId: OWNER_ID,
      runtimeSessionId: RUNTIME_SESSION_ID,
      slot: "primary",
      goal: { id: "goal-id", status: goalStatus } as never,
    },
    runs: [],
    instructions: [],
    deliveries: [],
    evidence: [],
    replayableInstructionIds: options.replayableInstructionIds ?? [],
    instructionSettlements: [],
    reconciliation: {
      evaluationsReset: 0,
      leasesReclaimed: 0,
      queuedAttemptsRetried: 0,
      writtenAttemptsRetried: 0,
      expired: 0,
      superseded: 0,
    },
  };
}
