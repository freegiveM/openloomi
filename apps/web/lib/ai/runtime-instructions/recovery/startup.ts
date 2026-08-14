import { stat } from "node:fs/promises";

import type { RuntimeProvider } from "@openloomi/ai/agent/runtime-instructions";

import { getDbInstance } from "@/lib/db";
import { getUserById } from "@/lib/db/queries";
import {
  runNativeAgentRequest,
  type NativeAgentRunnerContext,
} from "@/lib/ai/native-agent/runner";
import { resolveNativeAgentProviderRequest } from "@/lib/ai/native-agent/provider-env";
import { getAgentGoalRuntime, type SqliteAgentGoalRuntime } from "../runtime";
import type {
  RuntimeSessionPersistencePort,
  RuntimeSessionRecoveryPersistencePort,
} from "../runtime-session-persistence";
import {
  SqliteDeliveryRepository,
  SqliteInstructionRepository,
  type SqliteGoalRuntimeDatabaseSource,
} from "../persistence/sqlite";
import { PendingGoalOperationRecovery } from "./pending-operation-reconciler";
import { createRuntimeRecoveryChatRecorder } from "./chat-message-recorder";
import {
  GoalRuntimeRecoveryCoordinator,
  type RuntimeProviderSessionPreflightPort,
  type RuntimeRecoveryOwnerSession,
  type RuntimeRecoveryStartupReport,
} from "./coordinator";

type RecoveryProcessGlobal = typeof globalThis & {
  __openLoomiGoalRuntimeRecoveryCoordinator?: GoalRuntimeRecoveryCoordinator;
  __openLoomiGoalRuntimeRecoveryBootstrap?: Promise<RuntimeRecoveryStartupReport>;
};

/**
 * Tauri/Node boot entrypoint. The process-global coordinator survives Next.js
 * development reloads and keeps active recovery tasks from being started a
 * second time by another instrumentation registration in the same process.
 */
export function startAgentGoalRuntimeRecovery(): Promise<RuntimeRecoveryStartupReport> {
  const processGlobal = globalThis as RecoveryProcessGlobal;
  const coordinator = getOrCreateRecoveryCoordinator(processGlobal);
  coordinator.startMonitoring();
  if (processGlobal.__openLoomiGoalRuntimeRecoveryBootstrap) {
    return processGlobal.__openLoomiGoalRuntimeRecoveryBootstrap;
  }

  const bootstrap = coordinator.start().finally(() => {
    if (processGlobal.__openLoomiGoalRuntimeRecoveryBootstrap === bootstrap) {
      processGlobal.__openLoomiGoalRuntimeRecoveryBootstrap = undefined;
    }
  });
  processGlobal.__openLoomiGoalRuntimeRecoveryBootstrap = bootstrap;
  return bootstrap;
}

export async function wakeAgentGoalRuntimeRecovery(input: {
  ownerId: string;
  runtimeSessionId: string;
}): Promise<boolean> {
  const coordinator = getOrCreateRecoveryCoordinator(
    globalThis as RecoveryProcessGlobal,
  );
  const result = await coordinator.wake(input);
  return result.status === "resumed" || result.status === "already_running";
}

function getOrCreateRecoveryCoordinator(
  processGlobal: RecoveryProcessGlobal,
): GoalRuntimeRecoveryCoordinator {
  processGlobal.__openLoomiGoalRuntimeRecoveryCoordinator ??=
    createAgentGoalRuntimeRecoveryCoordinator();
  return processGlobal.__openLoomiGoalRuntimeRecoveryCoordinator;
}

export function createAgentGoalRuntimeRecoveryCoordinator(): GoalRuntimeRecoveryCoordinator {
  const runtime = getAgentGoalRuntime();
  const sqliteRuntime = asSqliteRuntime(runtime);
  const persistence = asRecoveryPersistence(runtime.runtimeSessions);
  const databaseSource =
    getDbInstance() as unknown as SqliteGoalRuntimeDatabaseSource;
  const pendingOperations = new PendingGoalOperationRecovery(
    sqliteRuntime.state,
    new SqliteInstructionRepository(databaseSource),
    new SqliteDeliveryRepository(databaseSource),
    sqliteRuntime.observations,
  );

  return new GoalRuntimeRecoveryCoordinator({
    persistence,
    providerPreflight: new RuntimeProviderSessionPreflight(),
    nativeRunner: {
      run: (request, context) =>
        runNativeAgentRequest(
          resolveNativeAgentProviderRequest(request, process.env, {
            trustedProviderOverride: request.provider as "claude" | "codex",
          }),
          context as unknown as NativeAgentRunnerContext,
        ),
    },
    loadOwnerSession: loadRecoveryOwnerSession,
    reconcilePendingOperation: (operation) =>
      pendingOperations.reconcile(operation),
    attachObservationLease: (input) =>
      sqliteRuntime.observations.attachRuntimeLease(input),
    createChatRecorder: createRuntimeRecoveryChatRecorder,
    logger: console,
  });
}

class RuntimeProviderSessionPreflight implements RuntimeProviderSessionPreflightPort {
  async verify(input: {
    provider: RuntimeProvider;
    providerSessionId: string;
    workingDirectory: string;
  }): Promise<void> {
    // Codex app-server validates the exact persisted thread as part of its
    // authoritative thread/resume handshake. Starting a second app-server here
    // would resolve configuration independently from the actual recovered run.
    if (input.provider === "codex") return;

    let directory: Awaited<ReturnType<typeof stat>>;
    try {
      directory = await stat(input.workingDirectory);
    } catch (cause) {
      throw new ProviderSessionPreflightError(
        "working_directory_unavailable",
        `Persisted working directory is unavailable: ${input.workingDirectory}`,
        { cause },
      );
    }
    if (!directory.isDirectory()) {
      throw new ProviderSessionPreflightError(
        "working_directory_unavailable",
        `Persisted working directory is not a directory: ${input.workingDirectory}`,
      );
    }

    try {
      const { getSessionInfo, getSessionMessages } =
        await import("@anthropic-ai/claude-agent-sdk");
      const options = { dir: input.workingDirectory };
      const info = await getSessionInfo(input.providerSessionId, options);
      if (info) return;

      // getSessionInfo intentionally returns undefined when a valid transcript
      // has no extractable summary. Inspect one historical message before
      // declaring the exact resume handle missing.
      const messages = await getSessionMessages(input.providerSessionId, {
        ...options,
        limit: 1,
        includeSystemMessages: true,
      });
      if (messages.length > 0) return;
    } catch (cause) {
      if (cause instanceof ProviderSessionPreflightError) throw cause;
      throw new ProviderSessionPreflightError(
        "provider_session_unreadable",
        `Claude session ${input.providerSessionId} could not be read from its persisted working directory`,
        { cause },
      );
    }
    throw new ProviderSessionPreflightError(
      "provider_session_unavailable",
      `Claude session ${input.providerSessionId} no longer exists in its persisted working directory`,
    );
  }
}

class ProviderSessionPreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderSessionPreflightError";
  }
}

async function loadRecoveryOwnerSession(
  ownerId: string,
): Promise<RuntimeRecoveryOwnerSession | null> {
  const user = await getUserById(ownerId);
  if (!user) return null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
      type: "regular",
    },
    platform: "desktop-recovery",
    expires: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  };
}

function asRecoveryPersistence(
  persistence: RuntimeSessionPersistencePort,
): RuntimeSessionRecoveryPersistencePort {
  const candidate =
    persistence as Partial<RuntimeSessionRecoveryPersistencePort>;
  for (const method of [
    "listRecoverable",
    "claimRecovery",
    "refreshRecovery",
    "renewRecoveryLease",
    "releaseRecoveryLease",
    "releaseLiveRuntime",
    "persistState",
    "pauseAfterRecoveryFailure",
  ] as const) {
    if (typeof candidate[method] !== "function") {
      throw new Error(
        "Goal Runtime restart recovery requires the durable SQLite runtime-session adapter",
      );
    }
  }
  return persistence as RuntimeSessionRecoveryPersistencePort;
}

function asSqliteRuntime(runtime: ReturnType<typeof getAgentGoalRuntime>) {
  if (!("state" in runtime)) {
    throw new Error(
      "Goal Runtime restart recovery is only available for the desktop SQLite runtime",
    );
  }
  return runtime as SqliteAgentGoalRuntime;
}
