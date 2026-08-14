import type { AgentGoalRuntime } from "./runtime";
import type {
  RuntimeObservationLeaseFencePort,
  RuntimeObservationLeaseRegistration,
} from "./runtime-observation";
import type {
  RuntimeLiveSessionLease,
  RuntimeSessionEnsureOptions,
  RuntimeSessionPersistencePort,
  RuntimeSessionRecoveryPersistencePort,
} from "./runtime-session-persistence";

export interface LiveRuntimeLeaseHost {
  readonly runtimeSessionId: string;
  readonly runEpoch: number;
  close(): Promise<void>;
}

export interface LiveRuntimeLease {
  readonly leaseToken: string;
  readonly initialRunEpoch: number;
  persistRunning(): Promise<void>;
  release(expectedRunEpoch: number): Promise<void>;
}

const LEASE_DURATION_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const EXPIRY_SAFETY_MS = 1_000;

export async function acquireLiveRuntimeLease(input: {
  persistence: RuntimeSessionRecoveryPersistencePort;
  ownerId: string;
  runtime: LiveRuntimeLeaseHost;
  metadata?: Omit<RuntimeSessionEnsureOptions, "recoveryLeaseToken">;
  unavailableError: () => Error;
}): Promise<LiveRuntimeLease> {
  const leaseOwner = `openloomi-live:${process.pid}:${crypto.randomUUID()}`;
  const claim = await input.persistence.claimLiveRuntime({
    ownerId: input.ownerId,
    runtimeSessionId: input.runtime.runtimeSessionId,
    leaseOwner,
    leaseDurationMs: LEASE_DURATION_MS,
    ...input.metadata,
  });
  if (!claim) throw input.unavailableError();
  return createLease(input.persistence, claim, input.runtime);
}

function createLease(
  persistence: RuntimeSessionRecoveryPersistencePort,
  claim: RuntimeLiveSessionLease,
  runtime: LiveRuntimeLeaseHost,
): LiveRuntimeLease {
  let stopped = false;
  let renewal: Promise<void> | undefined;
  let expiresAt = Date.now() + LEASE_DURATION_MS - EXPIRY_SAFETY_MS;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
  };
  const failClosed = (error: unknown) => {
    stop();
    console.error(
      `[Agent Goal Runtime] Lost live lease for ${claim.runtimeSessionId}; closing provider runtime`,
      error,
    );
    void runtime.close();
  };
  const scheduleExpiry = () => {
    if (stopped) return;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      () => failClosed(new Error(`Live lease for ${claim.runtimeSessionId} expired`)),
      Math.max(0, expiresAt - Date.now()),
    );
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
        leaseDurationMs: LEASE_DURATION_MS,
      })
      .then(() => {
        expiresAt = Date.now() + LEASE_DURATION_MS - EXPIRY_SAFETY_MS;
        scheduleExpiry();
      })
      .catch((error) => {
        if (!stopped) failClosed(error);
      })
      .finally(() => {
        renewal = undefined;
      });
  };
  const timer = setInterval(renew, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  scheduleExpiry();

  return {
    leaseToken: claim.leaseToken,
    initialRunEpoch: claim.runEpoch,
    persistRunning: () =>
      persistence.persistState({
        ownerId: claim.ownerId,
        runtimeSessionId: claim.runtimeSessionId,
        expectedState: claim.state,
        expectedRunEpoch: claim.runEpoch,
        state: "running",
        recoveryLeaseToken: claim.leaseToken,
      }).then(() => undefined),
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

export function isRecoveryPersistence(
  persistence: RuntimeSessionPersistencePort,
): persistence is RuntimeSessionRecoveryPersistencePort {
  const candidate = persistence as Partial<RuntimeSessionRecoveryPersistencePort>;
  return (
    typeof candidate.claimLiveRuntime === "function" &&
    typeof candidate.renewRecoveryLease === "function" &&
    typeof candidate.releaseLiveRuntime === "function" &&
    typeof candidate.persistState === "function"
  );
}

export function attachRuntimeObservationLease(
  observations: AgentGoalRuntime["observations"],
  ownerId: string,
  runtimeSessionId: string,
  leaseToken: string,
): RuntimeObservationLeaseRegistration | undefined {
  const candidate = observations as Partial<RuntimeObservationLeaseFencePort>;
  return typeof candidate.attachRuntimeLease === "function"
    ? candidate.attachRuntimeLease({ ownerId, runtimeSessionId, leaseToken })
    : undefined;
}
