import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeRuntimeSession,
  startClaudeGoalRuntimeSession,
} from "@/lib/ai/extensions/agent/claude/runtime";

import {
  createSqliteAgentGoalRuntime,
  type SqliteAgentGoalRuntime,
} from "@/lib/ai/runtime-instructions/runtime";
import { GoalRuntimeRecoveryCoordinator } from "@/lib/ai/runtime-instructions/recovery/coordinator";
import {
  RuntimeSessionPersistenceError,
  SqliteRuntimeSessionPersistence,
  type RuntimeRecoveryDescriptor,
  type RuntimeSessionRecoveryPersistencePort,
} from "@/lib/ai/runtime-instructions/runtime-session-persistence";
import {
  createControlledClaudeQuery,
  createFakeClaudeSdkTransport,
} from "../../helpers/claude-runtime";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const START = new Date("2026-08-10T08:00:00.000Z");
const BASE_MIGRATIONS = [
  "0107_agent_goal_runtime.sql",
  "0108_agent_goal_runtime_recovery.sql",
].map((migration) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../lib/db/migrations-sqlite",
      migration,
    ),
    "utf8",
  ),
);
const RECOVERY_PAUSE_MIGRATION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../lib/db/migrations-sqlite/0109_agent_goal_recovery_pause.sql",
  ),
  "utf8",
);
const EVALUATION_PAUSE_MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../../lib/db/migrations-sqlite/0110_agent_goal_evaluation_pause.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const MIGRATIONS = [
  ...BASE_MIGRATIONS,
  RECOVERY_PAUSE_MIGRATION,
  EVALUATION_PAUSE_MIGRATION,
];

const openDatabases = new Set<Database.Database>();
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const database of openDatabases) database.close();
  openDatabases.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
  temporaryDirectories.clear();
});

interface FileBackedRuntime {
  readonly database: Database.Database;
  readonly path: string;
  readonly runtime: SqliteAgentGoalRuntime;
  readonly recovery: RuntimeSessionRecoveryPersistencePort;
  readonly workingDirectory: string;
  advance(seconds: number): void;
  close(): void;
  reopen(): FileBackedRuntime;
}

function createFileBackedRuntime(
  migrations: readonly string[] = MIGRATIONS,
): FileBackedRuntime {
  const directory = mkdtempSync(join(tmpdir(), "openloomi-goal-recovery-"));
  temporaryDirectories.add(directory);
  const path = join(directory, "runtime.sqlite");
  let now = START;
  initializeDatabase(path, migrations);

  const open = (): FileBackedRuntime => {
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    openDatabases.add(database);
    const clock = { now: () => now };
    const runtime = createSqliteAgentGoalRuntime(database, { clock });
    const recovery = runtime.runtimeSessions;
    if (!(recovery instanceof SqliteRuntimeSessionPersistence)) {
      throw new Error(
        "Expected the SQLite Runtime Session persistence adapter",
      );
    }
    return {
      database,
      path,
      runtime,
      recovery,
      workingDirectory: resolve(directory, "workspace"),
      advance(seconds) {
        now = new Date(now.getTime() + seconds * 1_000);
      },
      close() {
        database.close();
        openDatabases.delete(database);
      },
      reopen: open,
    };
  };

  return open();
}

function initializeDatabase(path: string, migrations: readonly string[]): void {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
  for (const migration of migrations) database.exec(migration);
  database.prepare('INSERT INTO "User" (id) VALUES (?)').run(OWNER_ID);
  database.close();
}

function goalInput(objective: string) {
  return {
    objective,
    successCriteria: [
      {
        id: "result-recorded",
        description: "The requested result is recorded",
        verification: {
          type: "tool_result" as const,
          toolName: "test",
          expectedOutcome: "passed",
        },
        required: true,
      },
    ],
    constraints: [],
    contextRefs: [],
    priority: 80,
    maxTurns: 8,
    completionPolicy: "tool_evidence" as const,
    source: { type: "user" as const },
  };
}

async function activate(runtime: FileBackedRuntime, runtimeSessionId: string) {
  await runtime.recovery.ensure(OWNER_ID, runtimeSessionId);
  return runtime.runtime.goals.activate({
    ownerId: OWNER_ID,
    runtimeSessionId,
    idempotencyKey: `activate-${runtimeSessionId}`,
    source: { type: "user", authority: "user" },
    goal: goalInput(`Recover ${runtimeSessionId}`),
  });
}

function deliveryRows(database: Database.Database, runtimeSessionId: string) {
  return database
    .prepare(
      `SELECT instruction_id AS instructionId, state, attempt,
              lease_token AS leaseToken, error_code AS errorCode
         FROM agent_runtime_deliveries
        WHERE owner_id = ? AND runtime_session_id = ?
        ORDER BY attempt ASC`,
    )
    .all(OWNER_ID, runtimeSessionId) as Array<{
    instructionId: string;
    state: string;
    attempt: number;
    leaseToken: string | null;
    errorCode: string | null;
  }>;
}

function recoveryErrorCode(error: unknown): string | undefined {
  return error instanceof RuntimeSessionPersistenceError
    ? error.code
    : undefined;
}

function claudeInitMessage(providerSessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: providerSessionId,
  } as SDKMessage;
}

function claudeResultMessage(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    total_cost_usd: 0.01,
    usage: { input_tokens: 4, output_tokens: 2 },
  } as SDKMessage;
}

describe("SQLite Runtime restart recovery", () => {
  it("persists live recovery metadata only for the runtime that wins ownership", async () => {
    const first = createFileBackedRuntime();
    const competing = first.reopen();
    const runtimeSessionId = "live-metadata-ownership";
    const firstDescriptor: RuntimeRecoveryDescriptor = {
      schemaVersion: 1,
      model: "claude-sonnet-first",
    };
    const competingDescriptor: RuntimeRecoveryDescriptor = {
      schemaVersion: 1,
      model: "claude-sonnet-competing",
    };
    const firstWorkingDirectory = resolve(
      dirname(first.path),
      "workspace-first",
    );
    const competingWorkingDirectory = resolve(
      dirname(first.path),
      "workspace-competing",
    );

    const [firstLease, competingLease] = await Promise.all([
      first.recovery.claimLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "first-live-host",
        workingDirectory: firstWorkingDirectory,
        recoveryDescriptor: firstDescriptor,
      }),
      competing.recovery.claimLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "competing-live-host",
        workingDirectory: competingWorkingDirectory,
        recoveryDescriptor: competingDescriptor,
      }),
    ]);
    expect([firstLease, competingLease].filter(Boolean)).toHaveLength(1);

    const winningLease = firstLease ?? competingLease;
    if (!winningLease) throw new Error("Expected one live Runtime owner");
    const winner = firstLease
      ? {
          workingDirectory: firstWorkingDirectory,
          descriptor: firstDescriptor,
        }
      : {
          workingDirectory: competingWorkingDirectory,
          descriptor: competingDescriptor,
        };
    expect(
      first.database
        .prepare(
          `SELECT working_directory AS workingDirectory,
                  recovery_descriptor AS recoveryDescriptor
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({
      workingDirectory: winner.workingDirectory,
      recoveryDescriptor: JSON.stringify(winner.descriptor),
    });

    await (firstLease ? first.recovery : competing.recovery).releaseLiveRuntime(
      {
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: winningLease.leaseOwner,
        leaseToken: winningLease.leaseToken,
        expectedRunEpoch: winningLease.runEpoch,
      },
    );
  });

  it("atomically releases live ownership and preserves resumable Goal state", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "live-release-unfinished";
    await runtime.recovery.ensure(OWNER_ID, runtimeSessionId);
    const lease = await runtime.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "ordinary-runtime-host",
      leaseDurationMs: 30_000,
    });
    if (!lease) throw new Error("Expected live Runtime ownership");
    await runtime.runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId,
      idempotencyKey: `activate-${runtimeSessionId}`,
      source: { type: "user", authority: "user" },
      goal: goalInput(`Recover ${runtimeSessionId}`),
    });

    await runtime.recovery.bindProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      providerSessionId: "claude-live-unfinished",
      runtimeLeaseToken: lease.leaseToken,
      expectedRunEpoch: lease.runEpoch,
    });
    await runtime.recovery.persistState({
      ownerId: OWNER_ID,
      runtimeSessionId,
      expectedState: lease.state,
      expectedRunEpoch: lease.runEpoch,
      state: "running",
      recoveryLeaseToken: lease.leaseToken,
    });
    await expect(
      runtime.recovery.releaseProviderSession(OWNER_ID, runtimeSessionId, {
        runtimeLeaseToken: "stale-live-lease-token",
        expectedRunEpoch: lease.runEpoch,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );
    expect(
      runtime.database
        .prepare(
          "SELECT provider_session_id FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(runtimeSessionId),
    ).toEqual({ provider_session_id: "claude-live-unfinished" });

    await expect(
      runtime.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        expectedRunEpoch: lease.runEpoch,
      }),
    ).resolves.toMatchObject({
      state: "interrupted",
      providerSessionId: "claude-live-unfinished",
      runEpoch: lease.runEpoch,
    });
    expect(
      runtime.database
        .prepare(
          `SELECT state, provider_session_id AS providerSessionId,
                  recovery_lease_token AS leaseToken
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({
      state: "interrupted",
      providerSessionId: "claude-live-unfinished",
      leaseToken: null,
    });
  });

  it("returns a finished live Runtime to idle and forgets its provider handle", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "live-release-finished";
    await runtime.recovery.ensure(OWNER_ID, runtimeSessionId);
    const lease = await runtime.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "ordinary-runtime-host",
    });
    if (!lease) throw new Error("Expected live Runtime ownership");
    await runtime.recovery.bindProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      providerSessionId: "claude-live-finished",
      runtimeLeaseToken: lease.leaseToken,
      expectedRunEpoch: lease.runEpoch,
    });
    await runtime.recovery.persistState({
      ownerId: OWNER_ID,
      runtimeSessionId,
      expectedState: lease.state,
      expectedRunEpoch: lease.runEpoch,
      state: "running",
      recoveryLeaseToken: lease.leaseToken,
    });

    await expect(
      runtime.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        expectedRunEpoch: lease.runEpoch,
      }),
    ).resolves.toMatchObject({ state: "idle", runEpoch: lease.runEpoch });
    expect(
      runtime.database
        .prepare(
          `SELECT state, provider_session_id AS providerSessionId,
                  recovery_lease_token AS leaseToken
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({ state: "idle", providerSessionId: null, leaseToken: null });
  });

  it.each([
    ["queued", "superseded", "runtime_execution_already_terminal"],
    ["written_to_sdk", "failed", "runtime_execution_already_terminal"],
    ["observed", "applied", null],
  ] as const)(
    "settles a delivery-only %s crash before releasing the recovered Session",
    async (crashedState, settledState, errorCode) => {
      const first = createFileBackedRuntime();
      const runtimeSessionId = `delivery-only-${crashedState}`;
      const liveLease = await first.recovery.claimLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "crashed-live-host",
        leaseDurationMs: 10_000,
      });
      if (!liveLease) throw new Error("Expected live Runtime ownership");
      const activation = await first.runtime.goals.activate({
        ownerId: OWNER_ID,
        runtimeSessionId,
        idempotencyKey: `activate-${runtimeSessionId}`,
        source: { type: "user", authority: "user" },
        goal: goalInput(`Finish before settling ${crashedState}`),
      });
      await first.recovery.bindProviderSession({
        ownerId: OWNER_ID,
        runtimeSessionId,
        providerSessionId: `claude-${runtimeSessionId}`,
        runtimeLeaseToken: liveLease.leaseToken,
        expectedRunEpoch: liveLease.runEpoch,
      });
      await first.recovery.persistState({
        ownerId: OWNER_ID,
        runtimeSessionId,
        expectedState: liveLease.state,
        expectedRunEpoch: liveLease.runEpoch,
        state: "running",
        recoveryLeaseToken: liveLease.leaseToken,
      });

      const terminalAt = START.toISOString();
      const terminalAtSeconds = Math.floor(START.getTime() / 1_000);
      first.database
        .prepare(
          `UPDATE agent_goals
              SET slot_state = 'released', revision = revision + 1,
                  status = 'completed',
                  goal_snapshot = json_set(
                    goal_snapshot,
                    '$.revision', revision + 1,
                    '$.status', 'completed',
                    '$.updatedAt', ?
                  ),
                  updated_at = ?
            WHERE owner_id = ? AND runtime_session_id = ?`,
        )
        .run(terminalAt, terminalAtSeconds, OWNER_ID, runtimeSessionId);
      first.database
        .prepare(
          `UPDATE agent_goal_runs
              SET goal_revision = goal_revision + 1, status = 'completed',
                  last_activity_at = ?, completed_at = ?, updated_at = ?
            WHERE owner_id = ? AND runtime_session_id = ?`,
        )
        .run(
          terminalAtSeconds,
          terminalAtSeconds,
          terminalAtSeconds,
          OWNER_ID,
          runtimeSessionId,
        );
      first.database
        .prepare(
          `UPDATE agent_runtime_deliveries
              SET state = ?, provider_event_id = ?
            WHERE instruction_id = ?`,
        )
        .run(
          crashedState,
          crashedState === "observed" ? "provider-observed-before-crash" : null,
          activation.instruction.id,
        );

      first.advance(11);
      first.close();
      const recovered = first.reopen();
      const nativeRun = vi.fn();
      const coordinator = new GoalRuntimeRecoveryCoordinator({
        persistence: recovered.recovery,
        providerPreflight: { verify: vi.fn() },
        nativeRunner: { run: nativeRun },
        loadOwnerSession: vi.fn(async () => null),
        reconcilePendingOperation: vi.fn(),
        leaseOwner: "delivery-cleanup-host",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 30_000,
        initializationTimeoutMs: 1_000,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await expect(coordinator.start()).resolves.toMatchObject({
        scanned: 1,
        outcomes: [
          expect.objectContaining({
            status: "dormant",
            reason: "no_active_goal",
          }),
        ],
      });
      expect(nativeRun).not.toHaveBeenCalled();
      expect(deliveryRows(recovered.database, runtimeSessionId)).toEqual([
        expect.objectContaining({
          state: settledState,
          errorCode,
          attempt: 1,
        }),
      ]);
      expect(
        recovered.database
          .prepare(
            `SELECT state, recovery_lease_token AS leaseToken
               FROM agent_runtime_sessions WHERE id = ?`,
          )
          .get(runtimeSessionId),
      ).toEqual({ state: "idle", leaseToken: null });
      await expect(recovered.recovery.listRecoverable()).resolves.toEqual([]);

      const nextLiveLease = await recovered.recovery.claimLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "next-live-host",
      });
      expect(nextLiveLease).toMatchObject({ state: "idle" });
      if (!nextLiveLease)
        throw new Error("Expected the Session to be reusable");
      await recovered.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: nextLiveLease.leaseOwner,
        leaseToken: nextLiveLease.leaseToken,
        expectedRunEpoch: nextLiveLease.runEpoch,
      });
    },
  );

  it("applies an observed crash boundary before terminal cleanup releases the runtime", async () => {
    const first = createFileBackedRuntime();
    const runtimeSessionId = "observed-crash-terminal-cleanup";
    await first.recovery.ensure(OWNER_ID, runtimeSessionId);
    const liveLease = await first.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "crashed-live-host",
      leaseDurationMs: 10_000,
    });
    if (!liveLease) throw new Error("Expected live Runtime ownership");
    const observationLease = first.runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseToken: liveLease.leaseToken,
    });
    const activation = await first.runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId,
      idempotencyKey: `activate-${runtimeSessionId}`,
      source: { type: "user", authority: "user" },
      goal: goalInput("Finish an observed Goal after restart"),
    });
    await first.recovery.bindProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      providerSessionId: "claude-observed-before-crash",
      runtimeLeaseToken: liveLease.leaseToken,
      expectedRunEpoch: liveLease.runEpoch,
    });
    await first.recovery.persistState({
      ownerId: OWNER_ID,
      runtimeSessionId,
      expectedState: liveLease.state,
      expectedRunEpoch: liveLease.runEpoch,
      state: "running",
      recoveryLeaseToken: liveLease.leaseToken,
    });
    await first.runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    await first.runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId,
      instructionId: activation.instruction.id,
      runEpoch: liveLease.runEpoch,
      recordedAt: START.toISOString(),
    });
    const context = await first.runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId,
      runEpoch: liveLease.runEpoch,
    });
    if (!context) throw new Error("Expected an observation context");
    await first.runtime.observations.observeProviderEvent({
      ownerId: OWNER_ID,
      runtimeSessionId,
      runEpoch: liveLease.runEpoch,
      eventKey: "assistant-observed-before-crash",
      providerEventId: "assistant-observed-before-crash",
      observedAt: START.toISOString(),
      terminal: false,
      context,
      evidence: [
        {
          type: "tool_result",
          sourceEventId: "assistant-observed-before-crash:test",
          summary: "Focused test passed before the host crashed",
          success: true,
          payload: { toolName: "test", outcome: "passed" },
          observedAt: START.toISOString(),
        },
      ],
    });
    expect(deliveryRows(first.database, runtimeSessionId)).toEqual([
      expect.objectContaining({ state: "observed", attempt: 1 }),
    ]);

    // Simulate a hard process exit: the durable lease is not released, but it
    // expires before another process reopens the same SQLite database.
    observationLease.release();
    first.advance(11);
    first.close();

    const recovered = first.reopen();
    const recoveryClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "recovery-host",
    });
    if (!recoveryClaim) throw new Error("Expected recovery ownership");
    expect(deliveryRows(recovered.database, runtimeSessionId)).toEqual([
      expect.objectContaining({ state: "applied", attempt: 1 }),
    ]);
    expect(recoveryClaim.snapshot).toMatchObject({
      replayableInstructionIds: [],
      instructionSettlements: [
        {
          instructionId: activation.instruction.id,
          disposition: "accepted",
          providerEventId: "assistant-observed-before-crash",
        },
      ],
    });

    const recoveredObservationLease =
      recovered.runtime.observations.attachRuntimeLease({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseToken: recoveryClaim.leaseToken,
      });
    const recoveredContext =
      await recovered.runtime.observations.captureContext({
        ownerId: OWNER_ID,
        runtimeSessionId,
        runEpoch: recoveryClaim.snapshot.session.runEpoch,
      });
    if (!recoveredContext)
      throw new Error("Expected the recovered observation context");
    const controller = recovered.runtime.controller.forSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      transport: {
        runtimeSessionId,
        async deliver(instruction) {
          return {
            instructionId: instruction.id,
            runtimeSessionId,
            state: "written_to_sdk",
            recordedAt: START.toISOString(),
          };
        },
        async interrupt() {},
      },
    });
    await expect(
      controller.evaluateStop({
        runEpoch: recoveryClaim.snapshot.session.runEpoch,
        assistantTurnId: "recovered-terminal-boundary",
        turnContext: recoveredContext,
        stopHookActive: false,
      }),
    ).resolves.toMatchObject({ decision: "allow", outcome: "completed" });
    recoveredObservationLease.release();

    await expect(
      recovered.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: recoveryClaim.leaseOwner,
        leaseToken: recoveryClaim.leaseToken,
        expectedRunEpoch: recoveryClaim.snapshot.session.runEpoch,
      }),
    ).resolves.toMatchObject({ state: "idle" });
    expect(
      recovered.database
        .prepare(
          `SELECT state, provider_session_id AS providerSessionId,
                  recovery_lease_token AS leaseToken
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({ state: "idle", providerSessionId: null, leaseToken: null });
    await expect(
      recovered.recovery.claimLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "next-live-host",
      }),
    ).resolves.toMatchObject({ state: "idle" });
  });

  it("rejects provider writes and release from expired or reclaimed live tokens", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "live-lease-fencing";
    await runtime.recovery.ensure(OWNER_ID, runtimeSessionId);
    const expired = await runtime.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "expired-live-host",
      leaseDurationMs: 10_000,
    });
    if (!expired) throw new Error("Expected the first live lease");
    runtime.advance(11);

    await expect(
      runtime.recovery.bindProviderSession({
        ownerId: OWNER_ID,
        runtimeSessionId,
        providerSessionId: "stale-provider-session",
        runtimeLeaseToken: expired.leaseToken,
        expectedRunEpoch: expired.runEpoch,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );
    await expect(
      runtime.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: expired.leaseOwner,
        leaseToken: expired.leaseToken,
        expectedRunEpoch: expired.runEpoch,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );

    const current = await runtime.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "replacement-live-host",
    });
    if (!current)
      throw new Error("Expected an expired lease to be reclaimable");
    await expect(
      runtime.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: expired.leaseOwner,
        leaseToken: expired.leaseToken,
        expectedRunEpoch: expired.runEpoch,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );
    await runtime.recovery.bindProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      providerSessionId: "current-provider-session",
      runtimeLeaseToken: current.leaseToken,
      expectedRunEpoch: current.runEpoch,
    });
    await expect(
      runtime.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: current.leaseOwner,
        leaseToken: current.leaseToken,
        expectedRunEpoch: current.runEpoch,
      }),
    ).resolves.toMatchObject({ state: "idle" });
  });

  it("does not release live ownership across a run epoch boundary", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "live-release-epoch-fence";
    await runtime.recovery.ensure(OWNER_ID, runtimeSessionId);
    const lease = await runtime.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "epoch-live-host",
    });
    if (!lease) throw new Error("Expected live Runtime ownership");
    await runtime.recovery.bindProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      providerSessionId: "epoch-provider-session",
      runtimeLeaseToken: lease.leaseToken,
      expectedRunEpoch: lease.runEpoch,
    });
    runtime.database
      .prepare(
        `UPDATE agent_runtime_sessions SET run_epoch = run_epoch + 1
          WHERE owner_id = ? AND id = ?`,
      )
      .run(OWNER_ID, runtimeSessionId);

    await expect(
      runtime.recovery.releaseLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: lease.leaseOwner,
        leaseToken: lease.leaseToken,
        expectedRunEpoch: lease.runEpoch,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );
    expect(
      runtime.database
        .prepare(
          `SELECT provider_session_id AS providerSessionId,
                  recovery_lease_token AS leaseToken, run_epoch AS runEpoch
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({
      providerSessionId: "epoch-provider-session",
      leaseToken: lease.leaseToken,
      runEpoch: lease.runEpoch + 1,
    });
  });

  it("hands an unfinished Runtime to one recovery worker after its live lease expires", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "live-expiry-recovery-handoff";
    await runtime.recovery.ensure(OWNER_ID, runtimeSessionId);
    const liveLease = await runtime.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "live-runtime-host",
      leaseDurationMs: 10_000,
    });
    if (!liveLease) throw new Error("Expected live Runtime ownership");
    await runtime.runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId,
      idempotencyKey: `activate-${runtimeSessionId}`,
      source: { type: "user", authority: "user" },
      goal: goalInput(`Recover ${runtimeSessionId}`),
    });
    const competing = runtime.reopen();

    await expect(runtime.recovery.listRecoverable()).resolves.toEqual([]);
    await expect(
      runtime.runtime.runtimeSessions.listRecoveryPresentationSessions(
        OWNER_ID,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ runtimeSessionId, state: "starting" }),
    ]);
    await expect(
      runtime.runtime.runtimeSessions.listRecoveryPresentationSessions(
        "another-owner",
      ),
    ).resolves.toEqual([]);
    await expect(
      competing.recovery.ensure(OWNER_ID, runtimeSessionId),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );
    await expect(
      runtime.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "early-recovery-worker",
      }),
    ).resolves.toBeNull();

    runtime.advance(11);
    await expect(
      competing.recovery.claimLiveRuntime({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "incorrect-ordinary-host",
      }),
    ).resolves.toBeNull();
    await expect(runtime.recovery.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ ownerId: OWNER_ID, runtimeSessionId }),
    ]);
    const recovered = await runtime.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "winning-recovery-worker",
    });
    expect(recovered).not.toBeNull();
    await expect(
      competing.runtime.runtimeSessions.listRecoveryPresentationSessions(
        OWNER_ID,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ runtimeSessionId, state: "starting" }),
    ]);
    await expect(
      competing.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "losing-recovery-worker",
      }),
    ).resolves.toBeNull();
  });

  it("rejects delayed provider observations after live ownership is reclaimed", async () => {
    const first = createFileBackedRuntime();
    const runtimeSessionId = "stale-live-provider-observation";
    await first.recovery.ensure(OWNER_ID, runtimeSessionId);
    const liveLease = await first.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "original-live-runtime",
      leaseDurationMs: 10_000,
    });
    if (!liveLease) throw new Error("Expected live Runtime ownership");
    const observationLease = first.runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseToken: liveLease.leaseToken,
    });
    const activation = await first.runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId,
      idempotencyKey: `activate-${runtimeSessionId}`,
      source: { type: "user", authority: "user" },
      goal: goalInput(`Recover ${runtimeSessionId}`),
    });
    await first.runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    await first.runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId,
      instructionId: activation.instruction.id,
      runEpoch: 0,
      recordedAt: START.toISOString(),
    });
    const staleContext = await first.runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId,
      runEpoch: 0,
    });
    if (!staleContext) throw new Error("Expected observation context");

    first.advance(11);
    const competing = first.reopen();
    const recoveryClaim = await competing.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "replacement-runtime",
    });
    if (!recoveryClaim) throw new Error("Expected recovery ownership");

    await expect(
      first.runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId,
        runEpoch: 0,
        eventKey: "delayed-old-runtime-result",
        providerEventId: "delayed-old-runtime-result",
        observedAt: new Date(START.getTime() + 11_000).toISOString(),
        terminal: true,
        context: staleContext,
        usage: { turnsUsed: 1, tokensUsed: 50 },
        evidence: [
          {
            type: "tool_result",
            sourceEventId: "delayed-old-runtime-result:test",
            summary: "This stale result must not be persisted",
            success: true,
            payload: { toolName: "test", outcome: "passed" },
            observedAt: new Date(START.getTime() + 11_000).toISOString(),
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no longer owns"),
    });
    expect(
      competing.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM agent_runtime_provider_events
               WHERE runtime_session_id = ?) AS providerEvents,
             (SELECT count(*) FROM agent_goal_evidence
               WHERE runtime_session_id = ?) AS evidence`,
        )
        .get(runtimeSessionId, runtimeSessionId),
    ).toEqual({ providerEvents: 0, evidence: 0 });
    observationLease.release();
  });

  it("keeps stable paused Goals out of periodic scans but available to an explicit wake", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "paused-explicit-recovery";
    await activate(runtime, runtimeSessionId);
    runtime.database
      .prepare(
        `UPDATE agent_goals
            SET status = 'paused',
                goal_snapshot = json_set(goal_snapshot, '$.status', 'paused')
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(OWNER_ID, runtimeSessionId);
    runtime.database
      .prepare(
        `UPDATE agent_goal_runs SET status = 'paused'
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(OWNER_ID, runtimeSessionId);

    await expect(runtime.recovery.listRecoverable()).resolves.toEqual([]);
    await expect(
      runtime.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "explicit-pause-wake",
      }),
    ).resolves.toMatchObject({
      snapshot: {
        activeGoal: { goal: { status: "paused" } },
        runs: [expect.objectContaining({ status: "paused" })],
      },
    });
  });

  it("prevents recovery from claiming an ordinary live Claude runtime", async () => {
    const runtime = createFileBackedRuntime();
    const handle = createControlledClaudeQuery();
    const sdk = createFakeClaudeSdkTransport(handle);
    const claude = new ClaudeRuntimeSession({
      runtimeSessionId: "ordinary-live-runtime",
      runEpoch: 0,
      sdkTransport: sdk.transport,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createMessageId: () => "ordinary-live-message",
    });
    const registration = await startClaudeGoalRuntimeSession({
      session: { user: { id: OWNER_ID } },
      runtime: claude,
      start: { initialPrompt: "Keep this ordinary runtime live" },
      goalRuntime: runtime.runtime,
      persistence: { workingDirectory: runtime.workingDirectory },
    });

    expect(
      runtime.database
        .prepare(
          `SELECT state, recovery_lease_token AS leaseToken
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get("ordinary-live-runtime"),
    ).toEqual({ state: "running", leaseToken: expect.any(String) });
    const competing = runtime.reopen();
    await expect(
      competing.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId: "ordinary-live-runtime",
        leaseOwner: "competing-recovery-host",
      }),
    ).resolves.toBeNull();

    registration?.release();
    await claude.close();
    await vi.waitFor(() => {
      expect(
        runtime.database
          .prepare(
            `SELECT recovery_lease_token AS leaseToken
               FROM agent_runtime_sessions WHERE id = ?`,
          )
          .get("ordinary-live-runtime"),
      ).toEqual({ leaseToken: null });
    });
  });

  it("hands a fresh Goal created after an ordinary turn to the next live Claude runtime", async () => {
    const first = createFileBackedRuntime();
    const runtimeSessionId = "fresh-goal-after-idle-turn";
    const ordinaryHandle = createControlledClaudeQuery();
    const ordinarySdk = createFakeClaudeSdkTransport(ordinaryHandle);
    const ordinaryClaude = new ClaudeRuntimeSession({
      runtimeSessionId,
      runEpoch: 0,
      sdkTransport: ordinarySdk.transport,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createMessageId: () => "ordinary-turn-message",
    });
    const ordinaryOutput = ordinaryClaude.subscribe()[Symbol.asyncIterator]();
    const ordinaryRegistration = await startClaudeGoalRuntimeSession({
      session: { user: { id: OWNER_ID } },
      runtime: ordinaryClaude,
      start: { initialPrompt: "Finish an ordinary chat turn" },
      goalRuntime: first.runtime,
      persistence: { workingDirectory: first.workingDirectory },
    });
    const ordinaryPrompt = ordinarySdk.queryInput?.prompt as
      | AsyncIterable<SDKUserMessage>
      | undefined;
    if (!ordinaryPrompt) throw new Error("Expected the ordinary SDK prompt");
    await expect(
      ordinaryPrompt[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({
      value: { message: { content: "Finish an ordinary chat turn" } },
    });

    ordinaryHandle.push(claudeInitMessage("ordinary-provider-session"));
    ordinaryHandle.push(claudeResultMessage());
    await expect(ordinaryOutput.next()).resolves.toMatchObject({
      value: { type: "result", content: "success" },
    });
    await vi.waitFor(() => expect(ordinaryClaude.state).toBe("idle"));
    await ordinaryRegistration?.release();
    await ordinaryClaude.close();
    expect(
      first.database
        .prepare(
          `SELECT state, provider_session_id AS providerSessionId,
                  recovery_lease_token AS leaseToken
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({ state: "idle", providerSessionId: null, leaseToken: null });

    const activation = await first.runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId,
      idempotencyKey: `activate-${runtimeSessionId}`,
      source: { type: "user", authority: "user" },
      goal: goalInput("Deliver this fresh Goal on the next Claude turn"),
    });
    expect(activation.dispatch).toMatchObject({ status: "unavailable" });
    expect(
      first.database
        .prepare(
          `SELECT
             (SELECT state FROM agent_runtime_sessions
               WHERE owner_id = ? AND id = ?) AS sessionState,
             (SELECT provider_session_id FROM agent_runtime_sessions
               WHERE owner_id = ? AND id = ?) AS providerSessionId,
             (SELECT status FROM agent_goals
               WHERE owner_id = ? AND runtime_session_id = ?) AS goalStatus,
             (SELECT status FROM agent_goal_runs
               WHERE owner_id = ? AND runtime_session_id = ?) AS runStatus,
             (SELECT kind FROM agent_runtime_instructions
               WHERE owner_id = ? AND runtime_session_id = ?) AS instructionKind,
             (SELECT count(*) FROM agent_runtime_deliveries
               WHERE owner_id = ? AND runtime_session_id = ?) AS deliveryAttempts`,
        )
        .get(
          OWNER_ID,
          runtimeSessionId,
          OWNER_ID,
          runtimeSessionId,
          OWNER_ID,
          runtimeSessionId,
          OWNER_ID,
          runtimeSessionId,
          OWNER_ID,
          runtimeSessionId,
          OWNER_ID,
          runtimeSessionId,
        ),
    ).toEqual({
      sessionState: "idle",
      providerSessionId: null,
      goalStatus: "active",
      runStatus: "queued",
      instructionKind: "goal.activate",
      deliveryAttempts: 1,
    });
    expect(deliveryRows(first.database, runtimeSessionId)).toEqual([
      expect.objectContaining({
        instructionId: activation.instruction.id,
        state: "pending",
        attempt: 1,
        leaseToken: null,
      }),
    ]);
    await expect(
      first.runtime.runtimeSessions.ensure(OWNER_ID, runtimeSessionId),
    ).resolves.toMatchObject({ state: "idle" });
    first.close();

    const next = first.reopen();
    await expect(next.recovery.listRecoverable()).resolves.toEqual([]);
    await expect(
      next.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "periodic-recovery-monitor",
      }),
    ).resolves.toBeNull();
    const nextHandle = createControlledClaudeQuery();
    const nextSdk = createFakeClaudeSdkTransport(nextHandle);
    const nextClaude = new ClaudeRuntimeSession({
      runtimeSessionId,
      runEpoch: 0,
      sdkTransport: nextSdk.transport,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createMessageId: () => "next-turn-message",
    });
    const claimLiveRuntime = vi.spyOn(next.recovery, "claimLiveRuntime");
    let nextRegistration:
      | Awaited<ReturnType<typeof startClaudeGoalRuntimeSession>>
      | undefined;
    try {
      nextRegistration = await startClaudeGoalRuntimeSession({
        session: { user: { id: OWNER_ID } },
        runtime: nextClaude,
        start: { initialPrompt: "Continue after the idle boundary" },
        goalRuntime: next.runtime,
        persistence: { workingDirectory: next.workingDirectory },
      });
      expect(claimLiveRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: OWNER_ID, runtimeSessionId }),
      );
      expect(
        next.database
          .prepare(
            `SELECT state, recovery_lease_token AS leaseToken
               FROM agent_runtime_sessions WHERE id = ?`,
          )
          .get(runtimeSessionId),
      ).toEqual({ state: "running", leaseToken: expect.any(String) });
      expect(deliveryRows(next.database, runtimeSessionId)).toEqual([
        expect.objectContaining({
          instructionId: activation.instruction.id,
          state: "queued",
          attempt: 1,
        }),
      ]);

      const nextPrompt = nextSdk.queryInput?.prompt as
        | AsyncIterable<SDKUserMessage>
        | undefined;
      if (!nextPrompt) throw new Error("Expected the next SDK prompt");
      const prompt = nextPrompt[Symbol.asyncIterator]();
      await expect(prompt.next()).resolves.toMatchObject({
        value: { message: { content: "Continue after the idle boundary" } },
      });
      await expect(prompt.next()).resolves.toMatchObject({
        value: {
          message: {
            content: expect.stringContaining(
              "Deliver this fresh Goal on the next Claude turn",
            ),
          },
        },
      });
      await vi.waitFor(() => {
        expect(deliveryRows(next.database, runtimeSessionId)).toEqual([
          expect.objectContaining({
            instructionId: activation.instruction.id,
            state: "written_to_sdk",
            attempt: 1,
          }),
        ]);
      });
    } finally {
      await nextRegistration?.release();
      await nextClaude.close();
    }
  });

  it("persists the exact resume identity and fences recovery claims across reopen", async () => {
    const first = createFileBackedRuntime();
    const runtimeSessionId = "recovery-identity";
    const descriptor: RuntimeRecoveryDescriptor = {
      schemaVersion: 1,
      model: "claude-sonnet",
      permissionMode: "default",
      allowedTools: ["Read", "Edit"],
      disallowedTools: ["Bash(rm:*)"],
      sandbox: { enabled: true, provider: "docker", image: "openloomi:test" },
      skillsConfig: {
        enabled: true,
        userDirEnabled: true,
        appDirEnabled: false,
      },
      mcpConfig: {
        enabled: true,
        userDirEnabled: false,
        appDirEnabled: true,
      },
    };

    await first.recovery.ensure(OWNER_ID, runtimeSessionId, {
      workingDirectory: first.workingDirectory,
      recoveryDescriptor: descriptor,
    });
    const liveLease = await first.recovery.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "initial-runtime-host",
    });
    if (!liveLease) throw new Error("Expected initial live Runtime ownership");
    const activation = await first.runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId,
      idempotencyKey: "activate-recovery-identity",
      source: { type: "user", authority: "user" },
      goal: goalInput("Resume the same Claude execution"),
    });
    await first.recovery.bindProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId,
      providerSessionId: "claude-session-resume-1",
      runtimeLeaseToken: liveLease.leaseToken,
      expectedRunEpoch: liveLease.runEpoch,
    });
    await first.recovery.releaseLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: liveLease.leaseOwner,
      leaseToken: liveLease.leaseToken,
      expectedRunEpoch: liveLease.runEpoch,
    });
    expect(
      first.database
        .prepare(
          "SELECT provider_session_id FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(runtimeSessionId),
    ).toEqual({ provider_session_id: "claude-session-resume-1" });
    first.close();

    const recovered = first.reopen();
    await expect(recovered.recovery.listRecoverable()).resolves.toEqual([
      expect.objectContaining({
        ownerId: OWNER_ID,
        runtimeSessionId,
        providerSessionId: "claude-session-resume-1",
        workingDirectory: recovered.workingDirectory,
        runEpoch: 0,
      }),
    ]);
    const firstClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "recovery-worker-a",
      leaseDurationMs: 30_000,
    });
    expect(firstClaim).not.toBeNull();
    if (!firstClaim) {
      throw new Error("Expected the first recovery claim to succeed");
    }
    expect(firstClaim?.snapshot).toMatchObject({
      session: {
        providerSessionId: "claude-session-resume-1",
        workingDirectory: recovered.workingDirectory,
      },
      recoveryDescriptor: descriptor,
      activeGoal: { goal: { id: activation.goal.goal.id } },
      replayableInstructionIds: [activation.instruction.id],
    });

    const competing = recovered.reopen();
    await expect(
      competing.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "recovery-worker-b",
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBeNull();

    recovered.advance(31);
    const replacementClaim = await competing.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "recovery-worker-b",
      leaseDurationMs: 30_000,
    });
    expect(replacementClaim?.leaseToken).toEqual(expect.any(String));
    expect(replacementClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);
    if (!replacementClaim) {
      throw new Error("Expected the expired recovery claim to be reclaimable");
    }

    await expect(
      recovered.recovery.ensure(OWNER_ID, runtimeSessionId, {
        recoveryLeaseToken: firstClaim.leaseToken,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );
    await expect(
      recovered.recovery.releaseRecoveryLease({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "recovery-worker-a",
        leaseToken: firstClaim.leaseToken,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );

    await competing.recovery.releaseRecoveryLease({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "recovery-worker-b",
      leaseToken: replacementClaim.leaseToken,
    });
    expect(
      competing.database
        .prepare(
          `SELECT provider_session_id, recovery_lease_token
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({
      provider_session_id: "claude-session-resume-1",
      recovery_lease_token: null,
    });
  });

  it("starts a normal runtime with only the disabled sandbox state persisted", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "disabled-legacy-sandbox";
    const handle = createControlledClaudeQuery();
    const sdk = createFakeClaudeSdkTransport(handle);
    const claude = new ClaudeRuntimeSession({
      runtimeSessionId,
      runEpoch: 0,
      sdkTransport: sdk.transport,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createMessageId: () => "disabled-sandbox-message",
    });
    const legacySandbox = {
      enabled: false,
      provider: "docker",
      image:
        "https://registry-user:registry-secret@registry.example.com/openloomi:test",
      apiEndpoint: "https://sandbox.example.test?token=legacy-secret",
      providerConfig: { networkToken: "legacy-secret" },
    } as NonNullable<RuntimeRecoveryDescriptor["sandbox"]>;

    const registration = await startClaudeGoalRuntimeSession({
      session: { user: { id: OWNER_ID } },
      runtime: claude,
      start: { initialPrompt: "Start without sandboxing" },
      goalRuntime: runtime.runtime,
      persistence: {
        workingDirectory: runtime.workingDirectory,
        recoveryDescriptor: {
          schemaVersion: 1,
          sandbox: legacySandbox,
        },
      },
    });

    expect(sdk.queryInput).toBeDefined();
    expect(
      runtime.database
        .prepare(
          `SELECT recovery_descriptor AS recoveryDescriptor
             FROM agent_runtime_sessions WHERE id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({
      recoveryDescriptor: JSON.stringify({
        schemaVersion: 1,
        sandbox: { enabled: false },
      }),
    });

    await registration?.release();
    await claude.close();
  });

  it("rejects the same legacy sandbox metadata when sandboxing is enabled", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "enabled-legacy-sandbox";
    const handle = createControlledClaudeQuery();
    const sdk = createFakeClaudeSdkTransport(handle);
    const claude = new ClaudeRuntimeSession({
      runtimeSessionId,
      runEpoch: 0,
      sdkTransport: sdk.transport,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      createMessageId: () => "enabled-sandbox-message",
    });

    await expect(
      startClaudeGoalRuntimeSession({
        session: { user: { id: OWNER_ID } },
        runtime: claude,
        start: { initialPrompt: "Start with sandboxing" },
        goalRuntime: runtime.runtime,
        persistence: {
          workingDirectory: runtime.workingDirectory,
          recoveryDescriptor: {
            schemaVersion: 1,
            sandbox: {
              enabled: true,
              provider: "docker",
              image:
                "https://registry-user:registry-secret@registry.example.com/openloomi:test",
            },
          },
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_configuration_invalid",
    );
    expect(sdk.queryInput).toBeUndefined();
    expect(
      runtime.database
        .prepare("SELECT count(*) AS count FROM agent_runtime_sessions")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("enforces recovery metadata invariants in migrated SQLite databases", async () => {
    const runtime = createFileBackedRuntime();
    await runtime.recovery.ensure(OWNER_ID, "recovery-database-checks");

    expect(() =>
      runtime.database
        .prepare(
          `UPDATE agent_runtime_sessions SET recovery_descriptor = '[]'
            WHERE id = ?`,
        )
        .run("recovery-database-checks"),
    ).toThrow("invalid agent runtime recovery state");
    expect(() =>
      runtime.database
        .prepare(
          `UPDATE agent_runtime_sessions SET recovery_lease_owner = 'orphan'
            WHERE id = ?`,
        )
        .run("recovery-database-checks"),
    ).toThrow("invalid agent runtime recovery state");
  });

  it("replays delivery attempts until Claude has observed them", async () => {
    const runtime = createFileBackedRuntime();
    const written = await activate(runtime, "recovery-written");
    const observed = await activate(runtime, "recovery-observed");
    const staleObserved = await activate(runtime, "recovery-stale-observed");
    const leased = await activate(runtime, "recovery-leased");
    const queued = await activate(runtime, "recovery-queued");

    runtime.database
      .prepare(
        `UPDATE agent_runtime_deliveries
            SET state = 'written_to_sdk', provider_event_id = 'provider-write-1'
          WHERE instruction_id = ?`,
      )
      .run(written.instruction.id);
    runtime.database
      .prepare(
        `UPDATE agent_runtime_deliveries
            SET state = 'observed', provider_event_id = 'provider-observed-1'
          WHERE instruction_id = ?`,
      )
      .run(observed.instruction.id);
    runtime.database
      .prepare(
        `UPDATE agent_runtime_deliveries
            SET state = 'observed', provider_event_id = 'provider-stale-observed-1'
          WHERE instruction_id = ?`,
      )
      .run(staleObserved.instruction.id);
    const currentUpdate = await runtime.runtime.goals.update({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-stale-observed",
      goalId: staleObserved.goal.goal.id,
      expectedRevision: staleObserved.goal.goal.revision,
      idempotencyKey: "revise-recovery-stale-observed",
      source: { type: "user", authority: "user" },
      update: { priority: 81 },
    });
    runtime.database
      .prepare(
        `UPDATE agent_runtime_deliveries
            SET state = 'leased', lease_token = 'dead-lease',
                lease_owner = 'dead-worker', lease_expires_at = ?
          WHERE instruction_id = ?`,
      )
      .run(Math.floor(START.getTime() / 1_000) - 1, leased.instruction.id);
    runtime.database
      .prepare(
        `UPDATE agent_runtime_deliveries SET state = 'queued'
          WHERE instruction_id = ?`,
      )
      .run(queued.instruction.id);
    runtime.close();

    const recovered = runtime.reopen();
    const writtenClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-written",
      leaseOwner: "delivery-recovery",
    });
    expect(writtenClaim?.snapshot).toMatchObject({
      replayableInstructionIds: [written.instruction.id],
      instructionSettlements: [],
      reconciliation: { writtenAttemptsRetried: 1 },
    });
    expect(deliveryRows(recovered.database, "recovery-written")).toEqual([
      expect.objectContaining({
        state: "failed",
        attempt: 1,
        errorCode: "runtime_restarted_before_provider_observation",
      }),
      expect.objectContaining({ state: "pending", attempt: 2 }),
    ]);
    if (!writtenClaim) {
      throw new Error(
        "Expected the written Delivery recovery claim to succeed",
      );
    }
    const redeliveredInstructionIds: string[] = [];
    const transport = {
      runtimeSessionId: "recovery-written",
      async deliver(instruction: (typeof written)["instruction"]) {
        redeliveredInstructionIds.push(instruction.id);
        return {
          instructionId: instruction.id,
          runtimeSessionId: instruction.targetSessionId,
          state: "written_to_sdk" as const,
          recordedAt: START.toISOString(),
        };
      },
      async interrupt() {},
    };
    const registration = recovered.runtime.sessions.register({
      ownerId: OWNER_ID,
      transport,
    });
    await recovered.runtime.dispatcher.initializeRecoveredProgress({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-written",
      transport,
      settlements: writtenClaim.snapshot.instructionSettlements,
    });
    await expect(
      recovered.runtime.goals.replayPendingInstructions(
        OWNER_ID,
        "recovery-written",
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(redeliveredInstructionIds).toEqual([written.instruction.id]);
    registration.release();

    const observedClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-observed",
      leaseOwner: "delivery-recovery",
    });
    expect(observedClaim?.snapshot).toMatchObject({
      replayableInstructionIds: [],
      instructionSettlements: [
        {
          instructionId: observed.instruction.id,
          disposition: "accepted",
          providerEventId: "provider-observed-1",
        },
      ],
    });
    expect(deliveryRows(recovered.database, "recovery-observed")).toEqual([
      expect.objectContaining({ state: "applied", attempt: 1 }),
    ]);

    const staleObservedClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-stale-observed",
      leaseOwner: "delivery-recovery",
    });
    expect(staleObservedClaim?.snapshot).toMatchObject({
      replayableInstructionIds: [currentUpdate.instruction.id],
      instructionSettlements: [
        {
          instructionId: staleObserved.instruction.id,
          disposition: "superseded",
          reason: expect.stringContaining("stale Goal revision"),
        },
      ],
    });
    expect(
      recovered.database
        .prepare(
          `SELECT state, error_code AS errorCode
             FROM agent_runtime_deliveries WHERE instruction_id = ?`,
        )
        .get(staleObserved.instruction.id),
    ).toEqual({ state: "failed", errorCode: "stale_runtime_fence" });

    const leasedClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-leased",
      leaseOwner: "delivery-recovery",
    });
    expect(leasedClaim?.snapshot).toMatchObject({
      replayableInstructionIds: [leased.instruction.id],
      reconciliation: { leasesReclaimed: 1 },
    });
    expect(deliveryRows(recovered.database, "recovery-leased")).toEqual([
      expect.objectContaining({
        state: "pending",
        attempt: 1,
        leaseToken: null,
      }),
    ]);

    const queuedClaim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-queued",
      leaseOwner: "delivery-recovery",
    });
    expect(queuedClaim?.snapshot).toMatchObject({
      replayableInstructionIds: [queued.instruction.id],
      reconciliation: { queuedAttemptsRetried: 1 },
    });
    expect(deliveryRows(recovered.database, "recovery-queued")).toEqual([
      expect.objectContaining({
        state: "failed",
        attempt: 1,
        errorCode: "runtime_restarted_before_provider_write",
      }),
      expect.objectContaining({ state: "pending", attempt: 2 }),
    ]);
  });

  it("fences delayed recovery failures by run epoch and lease expiry", async () => {
    const runtime = createFileBackedRuntime();
    await activate(runtime, "recovery-stale-epoch");
    await activate(runtime, "recovery-expired-lease");

    const epochClaim = await runtime.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-stale-epoch",
      leaseOwner: "failure-worker",
      leaseDurationMs: 30_000,
    });
    const expiryClaim = await runtime.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId: "recovery-expired-lease",
      leaseOwner: "failure-worker",
      leaseDurationMs: 30_000,
    });
    if (!epochClaim || !expiryClaim) {
      throw new Error("Expected both Runtimes to be claimed");
    }

    runtime.database
      .prepare(
        `UPDATE agent_runtime_sessions SET run_epoch = run_epoch + 1
          WHERE owner_id = ? AND id = ?`,
      )
      .run(OWNER_ID, "recovery-stale-epoch");
    await expect(
      runtime.recovery.pauseAfterRecoveryFailure({
        ownerId: OWNER_ID,
        runtimeSessionId: "recovery-stale-epoch",
        leaseOwner: "failure-worker",
        leaseToken: epochClaim.leaseToken,
        expectedRunEpoch: epochClaim.snapshot.session.runEpoch,
        errorCode: "provider_resume_failed",
        errorMessage: "Delayed failure from the prior epoch",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );

    runtime.advance(31);
    await expect(
      runtime.recovery.pauseAfterRecoveryFailure({
        ownerId: OWNER_ID,
        runtimeSessionId: "recovery-expired-lease",
        leaseOwner: "failure-worker",
        leaseToken: expiryClaim.leaseToken,
        expectedRunEpoch: expiryClaim.snapshot.session.runEpoch,
        errorCode: "provider_resume_failed",
        errorMessage: "Delayed failure after the lease expired",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        recoveryErrorCode(error) === "runtime_recovery_claim_conflict",
    );

    expect(
      runtime.database
        .prepare(
          `SELECT id, state FROM agent_runtime_sessions
            WHERE id IN (?, ?) ORDER BY id`,
        )
        .all("recovery-stale-epoch", "recovery-expired-lease"),
    ).toEqual([
      { id: "recovery-expired-lease", state: "starting" },
      { id: "recovery-stale-epoch", state: "starting" },
    ]);
    expect(
      runtime.database
        .prepare(
          `SELECT runtime_session_id AS runtimeSessionId, status
             FROM agent_goals
            WHERE runtime_session_id IN (?, ?)
            ORDER BY runtime_session_id`,
        )
        .all("recovery-stale-epoch", "recovery-expired-lease"),
    ).toEqual([
      { runtimeSessionId: "recovery-expired-lease", status: "active" },
      { runtimeSessionId: "recovery-stale-epoch", status: "active" },
    ]);
  });

  it("repairs legacy recovery and evaluator blocks into resumable paused state", async () => {
    const legacy = createFileBackedRuntime(BASE_MIGRATIONS);
    const blockedSessionId = "legacy-recovery-blocked";
    const failedSessionId = "legacy-recovery-failed";
    const evaluatorBlockedSessionId = "ordinary-evaluator-blocked";
    for (const runtimeSessionId of [
      blockedSessionId,
      failedSessionId,
      evaluatorBlockedSessionId,
    ]) {
      await activate(legacy, runtimeSessionId);
    }

    const legacyEvaluation = JSON.stringify({
      completed: false,
      confidence: 0,
      satisfiedCriteria: [],
      missingCriteria: ["result-recorded"],
      evidence: [],
      reason: "Goal recovery failed: persisted provider session was missing",
    });
    for (const runtimeSessionId of [blockedSessionId, failedSessionId]) {
      legacy.database
        .prepare(
          `UPDATE agent_runtime_sessions
              SET state = 'failed', provider_session_id = ?,
                  recovery_error_code = 'provider_session_unavailable',
                  recovery_error_message = 'persisted provider session was missing',
                  recovery_failed_at = unixepoch(), updated_at = unixepoch()
            WHERE owner_id = ? AND id = ?`,
        )
        .run(`provider-${runtimeSessionId}`, OWNER_ID, runtimeSessionId);
      legacy.database
        .prepare(
          `UPDATE agent_goals
              SET revision = 2, status = 'blocked',
                  goal_snapshot = json_set(
                    goal_snapshot, '$.revision', 2, '$.status', 'blocked'
                  )
            WHERE owner_id = ? AND runtime_session_id = ?`,
        )
        .run(OWNER_ID, runtimeSessionId);
    }
    legacy.database
      .prepare(
        `UPDATE agent_goal_runs
            SET goal_revision = 2, status = 'blocked',
                last_evaluation = ?
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(legacyEvaluation, OWNER_ID, blockedSessionId);
    legacy.database
      .prepare(
        `UPDATE agent_goal_runs
            SET goal_revision = 2, status = 'failed',
                completed_at = unixepoch(), last_evaluation = ?
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(legacyEvaluation, OWNER_ID, failedSessionId);

    legacy.database
      .prepare(
        `UPDATE agent_runtime_sessions SET state = 'interrupted'
          WHERE owner_id = ? AND id = ?`,
      )
      .run(OWNER_ID, evaluatorBlockedSessionId);
    legacy.database
      .prepare(
        `UPDATE agent_goals
            SET status = 'blocked',
                goal_snapshot = json_set(goal_snapshot, '$.status', 'blocked')
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(OWNER_ID, evaluatorBlockedSessionId);
    legacy.database
      .prepare(
        `UPDATE agent_goal_runs
            SET status = 'blocked', last_evaluation = ?
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(legacyEvaluation, OWNER_ID, evaluatorBlockedSessionId);

    legacy.database.exec(RECOVERY_PAUSE_MIGRATION);
    legacy.database.exec(RECOVERY_PAUSE_MIGRATION);

    for (const runtimeSessionId of [blockedSessionId, failedSessionId]) {
      const repaired = legacy.database
        .prepare(
          `SELECT
             session.state AS sessionState,
             session.provider_session_id AS providerSessionId,
             session.recovery_error_code AS errorCode,
             session.recovery_error_message AS errorMessage,
             session.recovery_failed_at AS recoveryFailedAt,
             session.recovery_lease_token AS leaseToken,
             goal.status AS goalStatus,
             goal.revision AS goalRevision,
             json_extract(goal.goal_snapshot, '$.status') AS snapshotStatus,
             json_extract(goal.goal_snapshot, '$.updatedAt') AS snapshotUpdatedAt,
             goal.updated_at AS goalUpdatedAt,
             run.status AS runStatus,
             run.completed_at AS completedAt,
             json_extract(run.last_evaluation, '$.reason') AS failureReason
           FROM agent_runtime_sessions AS session
           JOIN agent_goals AS goal
             ON goal.owner_id = session.owner_id
            AND goal.runtime_session_id = session.id
            AND goal.slot_state = 'assigned'
           JOIN agent_goal_runs AS run
             ON run.owner_id = session.owner_id
            AND run.runtime_session_id = session.id
            AND run.goal_id = goal.id
            AND run.run_epoch = session.run_epoch
          WHERE session.owner_id = ? AND session.id = ?`,
        )
        .get(OWNER_ID, runtimeSessionId) as Record<string, unknown>;
      expect(repaired).toMatchObject({
        sessionState: "idle",
        providerSessionId: `provider-${runtimeSessionId}`,
        errorCode: null,
        errorMessage: null,
        recoveryFailedAt: null,
        leaseToken: null,
        goalStatus: "paused",
        goalRevision: 2,
        snapshotStatus: "paused",
        runStatus: "paused",
        completedAt: null,
        failureReason:
          "Goal recovery failed: persisted provider session was missing",
      });
      expect(
        Math.floor(
          new Date(String(repaired.snapshotUpdatedAt)).getTime() / 1_000,
        ),
      ).toBe(repaired.goalUpdatedAt);
    }

    expect(
      legacy.database
        .prepare(
          `SELECT session.state AS sessionState, goal.status AS goalStatus,
                  run.status AS runStatus
             FROM agent_runtime_sessions AS session
             JOIN agent_goals AS goal
               ON goal.owner_id = session.owner_id
              AND goal.runtime_session_id = session.id
             JOIN agent_goal_runs AS run
               ON run.owner_id = goal.owner_id
              AND run.runtime_session_id = goal.runtime_session_id
              AND run.goal_id = goal.id
            WHERE session.owner_id = ? AND session.id = ?`,
        )
        .get(OWNER_ID, evaluatorBlockedSessionId),
    ).toEqual({
      sessionState: "interrupted",
      goalStatus: "blocked",
      runStatus: "blocked",
    });

    legacy.database.exec(EVALUATION_PAUSE_MIGRATION);
    legacy.database.exec(EVALUATION_PAUSE_MIGRATION);
    expect(
      legacy.database
        .prepare(
          `SELECT session.state AS sessionState, goal.status AS goalStatus,
                  json_extract(goal.goal_snapshot, '$.status') AS snapshotStatus,
                  run.status AS runStatus, run.completed_at AS completedAt,
                  json_extract(run.last_evaluation, '$.reason') AS evaluationReason
             FROM agent_runtime_sessions AS session
             JOIN agent_goals AS goal
               ON goal.owner_id = session.owner_id
              AND goal.runtime_session_id = session.id
             JOIN agent_goal_runs AS run
               ON run.owner_id = goal.owner_id
              AND run.runtime_session_id = goal.runtime_session_id
              AND run.goal_id = goal.id
              AND run.run_epoch = session.run_epoch
            WHERE session.owner_id = ? AND session.id = ?`,
        )
        .get(OWNER_ID, evaluatorBlockedSessionId) as Record<string, unknown>,
    ).toMatchObject({
      sessionState: "interrupted",
      goalStatus: "paused",
      snapshotStatus: "paused",
      runStatus: "paused",
      completedAt: null,
      evaluationReason:
        "Goal recovery failed: persisted provider session was missing",
    });
    const normalizedEvaluator = legacy.database
      .prepare(
        `SELECT json_extract(goal_snapshot, '$.updatedAt') AS snapshotUpdatedAt,
                updated_at AS goalUpdatedAt
           FROM agent_goals
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .get(OWNER_ID, evaluatorBlockedSessionId) as {
      snapshotUpdatedAt: string;
      goalUpdatedAt: number;
    };
    expect(
      Math.floor(Date.parse(normalizedEvaluator.snapshotUpdatedAt) / 1_000),
    ).toBe(normalizedEvaluator.goalUpdatedAt);
  });

  it("atomically pauses active Goal state when provider resume fails", async () => {
    const first = createFileBackedRuntime();
    const runtimeSessionId = "recovery-resume-failed";
    await activate(first, runtimeSessionId);
    first.database
      .prepare(
        `UPDATE agent_goal_runs SET status = 'running'
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(OWNER_ID, runtimeSessionId);
    first.database
      .prepare(
        `UPDATE agent_runtime_sessions SET provider_session_id = ?
          WHERE owner_id = ? AND id = ?`,
      )
      .run("provider-resume-failed", OWNER_ID, runtimeSessionId);
    first.close();

    const recovered = first.reopen();
    const claim = await recovered.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "resume-worker",
    });
    if (!claim) throw new Error("Expected the failed Runtime to be claimed");

    recovered.database.exec(`
      CREATE TRIGGER reject_paused_run
      BEFORE UPDATE OF status ON agent_goal_runs
      WHEN NEW.status = 'paused'
      BEGIN
        SELECT RAISE(ABORT, 'forced Goal Run failure');
      END;
    `);
    await expect(
      recovered.recovery.pauseAfterRecoveryFailure({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "resume-worker",
        leaseToken: claim.leaseToken,
        expectedRunEpoch: claim.snapshot.session.runEpoch,
        errorCode: "provider_session_missing",
        errorMessage: "Claude could not resume the persisted session",
      }),
    ).rejects.toSatisfy(
      (error: unknown) => recoveryErrorCode(error) === "storage_failure",
    );
    expect(
      recovered.database
        .prepare(
          `SELECT
             (SELECT state FROM agent_runtime_sessions WHERE id = ?) AS sessionState,
             (SELECT status FROM agent_goals WHERE runtime_session_id = ?) AS goalStatus,
             (SELECT status FROM agent_goal_runs WHERE runtime_session_id = ?) AS runStatus,
             (SELECT recovery_lease_token FROM agent_runtime_sessions WHERE id = ?) AS leaseToken`,
        )
        .get(
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
        ),
    ).toEqual({
      sessionState: "starting",
      goalStatus: "active",
      runStatus: "running",
      leaseToken: claim.leaseToken,
    });

    recovered.database.exec("DROP TRIGGER reject_paused_run");
    await recovered.recovery.pauseAfterRecoveryFailure({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "resume-worker",
      leaseToken: claim.leaseToken,
      expectedRunEpoch: claim.snapshot.session.runEpoch,
      errorCode: "provider_session_missing",
      errorMessage: "Claude could not resume the persisted session",
    });
    expect(
      recovered.database
        .prepare(
          `SELECT
             (SELECT state FROM agent_runtime_sessions WHERE id = ?) AS sessionState,
             (SELECT recovery_error_code FROM agent_runtime_sessions WHERE id = ?) AS errorCode,
             (SELECT recovery_error_message FROM agent_runtime_sessions WHERE id = ?) AS errorMessage,
             (SELECT recovery_failed_at FROM agent_runtime_sessions WHERE id = ?) AS recoveryFailedAt,
             (SELECT recovery_lease_token FROM agent_runtime_sessions WHERE id = ?) AS leaseToken,
             (SELECT provider_session_id FROM agent_runtime_sessions WHERE id = ?) AS providerSessionId,
             (SELECT status FROM agent_goals WHERE runtime_session_id = ?) AS goalStatus,
             (SELECT revision FROM agent_goals WHERE runtime_session_id = ?) AS goalRevision,
             (SELECT status FROM agent_goal_runs WHERE runtime_session_id = ?) AS runStatus,
             (SELECT goal_revision FROM agent_goal_runs WHERE runtime_session_id = ?) AS runRevision`,
        )
        .get(
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
          runtimeSessionId,
        ),
    ).toEqual({
      sessionState: "idle",
      errorCode: null,
      errorMessage: null,
      recoveryFailedAt: null,
      leaseToken: null,
      providerSessionId: "provider-resume-failed",
      goalStatus: "paused",
      goalRevision: 2,
      runStatus: "paused",
      runRevision: 2,
    });
    await expect(recovered.recovery.listRecoverable()).resolves.toEqual([]);
  });

  it.each(["queued", "evaluating", "continuing"] as const)(
    "pauses a %s Goal Run without finalizing it after recovery failure",
    async (runStatus) => {
      const runtime = createFileBackedRuntime();
      const runtimeSessionId = `recovery-pause-${runStatus}`;
      await activate(runtime, runtimeSessionId);
      if (runStatus !== "queued") {
        runtime.database
          .prepare(
            `UPDATE agent_goal_runs SET status = ?
              WHERE owner_id = ? AND runtime_session_id = ?`,
          )
          .run(runStatus, OWNER_ID, runtimeSessionId);
      }
      const claim = await runtime.recovery.claimRecovery({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "resume-worker",
      });
      if (!claim) throw new Error("Expected the Runtime to be claimed");

      await runtime.recovery.pauseAfterRecoveryFailure({
        ownerId: OWNER_ID,
        runtimeSessionId,
        leaseOwner: "resume-worker",
        leaseToken: claim.leaseToken,
        expectedRunEpoch: claim.snapshot.session.runEpoch,
        errorCode: "provider_resume_failed",
        errorMessage: `${runStatus} provider failure`,
      });

      expect(
        runtime.database
          .prepare(
            `SELECT status, completed_at AS completedAt,
                    json_extract(last_evaluation, '$.reason') AS reason
               FROM agent_goal_runs
              WHERE owner_id = ? AND runtime_session_id = ?`,
          )
          .get(OWNER_ID, runtimeSessionId),
      ).toEqual({
        status: "paused",
        completedAt: null,
        reason: `Goal recovery paused (provider_resume_failed): ${runStatus} provider failure`,
      });
    },
  );

  it("preserves certified progress when a later provider failure pauses recovery", async () => {
    const runtime = createFileBackedRuntime();
    const runtimeSessionId = "recovery-pause-preserves-progress";
    await activate(runtime, runtimeSessionId);
    runtime.database
      .prepare(
        `UPDATE agent_goal_runs
            SET status = 'running',
                last_evaluation = json(?)
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .run(
        JSON.stringify({
          completed: false,
          confidence: 0.8,
          satisfiedCriteria: ["result-recorded"],
          missingCriteria: [],
          evidence: [
            {
              criterionId: "result-recorded",
              evidenceIds: ["00000000-0000-4000-8000-000000000099"],
            },
          ],
          reason: "The durable result was previously certified.",
        }),
        OWNER_ID,
        runtimeSessionId,
      );
    const claim = await runtime.recovery.claimRecovery({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "resume-worker",
    });
    if (!claim) throw new Error("Expected the Runtime to be claimed");

    await runtime.recovery.pauseAfterRecoveryFailure({
      ownerId: OWNER_ID,
      runtimeSessionId,
      leaseOwner: "resume-worker",
      leaseToken: claim.leaseToken,
      expectedRunEpoch: claim.snapshot.session.runEpoch,
      errorCode: "provider_resume_failed",
      errorMessage: "provider stopped after producing evidence",
    });

    const evaluation = runtime.database
      .prepare(
        `SELECT last_evaluation AS lastEvaluation
           FROM agent_goal_runs
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .get(OWNER_ID, runtimeSessionId) as { lastEvaluation: string };
    expect(JSON.parse(evaluation.lastEvaluation)).toMatchObject({
      completed: false,
      confidence: 0.8,
      satisfiedCriteria: ["result-recorded"],
      missingCriteria: [],
      evidence: [
        {
          criterionId: "result-recorded",
          evidenceIds: ["00000000-0000-4000-8000-000000000099"],
        },
      ],
      reason:
        "Goal recovery paused (provider_resume_failed): provider stopped after producing evidence",
    });
  });

  it("deduplicates a provider event durably after the database is reopened", async () => {
    const first = createFileBackedRuntime();
    const runtimeSessionId = "recovery-provider-event";
    const activation = await activate(first, runtimeSessionId);
    await first.runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    await first.runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId,
      instructionId: activation.instruction.id,
      runEpoch: 0,
      recordedAt: START.toISOString(),
    });
    const context = await first.runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId,
      runEpoch: 0,
    });
    if (!context) throw new Error("Expected a durable observation context");

    const observation = {
      ownerId: OWNER_ID,
      runtimeSessionId,
      runEpoch: 0,
      eventKey: "claude-result-1",
      providerEventId: "claude-result-1",
      observedAt: START.toISOString(),
      terminal: true,
      context,
      usage: { turnsUsed: 1, tokensUsed: 7 },
      evidence: [
        {
          type: "tool_result" as const,
          sourceEventId: "claude-result-1:test",
          summary: "Focused test passed",
          success: true,
          payload: { toolName: "test", outcome: "passed" },
          observedAt: START.toISOString(),
        },
      ],
    };
    await expect(
      first.runtime.observations.observeProviderEvent(observation),
    ).resolves.toBe(true);
    first.close();

    const recovered = first.reopen();
    const replayedAt = new Date(START.getTime() + 30_000).toISOString();
    const replayedObservation = {
      ...observation,
      observedAt: replayedAt,
      evidence: observation.evidence.map((item) => ({
        ...item,
        observedAt: replayedAt,
      })),
    };
    await expect(
      recovered.runtime.observations.observeProviderEvent(replayedObservation),
    ).resolves.toBe(false);
    await expect(
      recovered.runtime.observations.observeProviderEvent({
        ...replayedObservation,
        usage: { turnsUsed: 1, tokensUsed: 8 },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("reused with different event data"),
    });
    expect(
      recovered.database
        .prepare(
          `SELECT turns_used AS turnsUsed, tokens_used AS tokensUsed
             FROM agent_goal_runs WHERE runtime_session_id = ?`,
        )
        .get(runtimeSessionId),
    ).toEqual({ turnsUsed: 1, tokensUsed: 7 });
    expect(
      recovered.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM agent_runtime_provider_events
               WHERE runtime_session_id = ?) AS providerEvents,
             (SELECT count(*) FROM agent_goal_evidence
               WHERE runtime_session_id = ?) AS evidence`,
        )
        .get(runtimeSessionId, runtimeSessionId),
    ).toEqual({ providerEvents: 1, evidence: 1 });
  });
});
