import type { GoalContextReference } from "@openloomi/ai/agent/runtime-instructions";
import { v5 as uuidv5 } from "uuid";

import type { GoalCommandResult } from "@/lib/ai/runtime-instructions/goal-service";
import type { AgentGoalRuntime } from "@/lib/ai/runtime-instructions/runtime";

import type { LoopDecision, LoopSignal } from "./types";

const LOOP_GOAL_NAMESPACE = "d9e34d06-215a-4e0f-9375-2a139c1240ec";
const PROVIDER_STARTUP_TIMEOUT_MS = 30_000;
const PROVIDER_READY_POLL_MS = 250;
const CONNECTOR_SOURCES = new Set([
  "gmail",
  "google_calendar",
  "googlecalendar",
  "github",
  "slack",
  "linear",
]);
interface LoopGoalIdentity {
  runtimeSessionId: string;
  idempotencyKey: string;
}

interface LoopGoalDependencies {
  startGoal(input: {
    ownerId: string;
    runtimeSessionId: string;
    objective: string;
    idempotencyKey: string;
    sourceId: string;
    connectorContext?: GoalContextReference;
  }): Promise<GoalCommandResult>;
  providerState(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    instructionId: string;
  }): Promise<"start" | "ready">;
  startProvider(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
    objective: string;
  }): Promise<{ ok: boolean; error?: string }>;
}

/** Start one approved Loop decision once, with stable replay identities. */
export async function startLoopDecisionGoal(
  ownerId: string,
  decision: LoopDecision,
  dependencies: LoopGoalDependencies = productionDependencies(),
) {
  if (decision.status !== "pending") {
    throw new Error(`not pending (${decision.status})`);
  }

  const identity = loopGoalIdentity(ownerId, decision.id);
  const objective = loopGoalObjective(decision);
  const connectorContext = connectorGoalContext(decision);
  const command = await dependencies.startGoal({
    ownerId,
    runtimeSessionId: identity.runtimeSessionId,
    objective,
    idempotencyKey: identity.idempotencyKey,
    sourceId: decision.id,
    ...(connectorContext ? { connectorContext } : {}),
  });

  const providerState = await dependencies.providerState({
    ownerId,
    runtimeSessionId: identity.runtimeSessionId,
    goalId: command.goal.goal.id,
    instructionId: command.instruction.id,
  });
  if (providerState === "start") {
    const provider = await dependencies.startProvider({
      ownerId,
      runtimeSessionId: identity.runtimeSessionId,
      instructionId: command.instruction.id,
      objective,
    });
    if (!provider.ok) {
      throw new Error(provider.error || "The Goal provider did not become ready");
    }
  }

  return {
    runtimeSessionId: identity.runtimeSessionId,
    goalId: command.goal.goal.id,
  };
}

export function loopGoalIdentity(
  ownerId: string,
  decisionId: string,
): LoopGoalIdentity {
  const source = `${ownerId.trim()}:${decisionId.trim()}`;
  const runtimeSessionId = uuidv5(`session:${source}`, LOOP_GOAL_NAMESPACE);
  return {
    runtimeSessionId,
    idempotencyKey: `loop-goal:${runtimeSessionId}`,
  };
}

/** Preserve connector data as untrusted Goal context, never as a command. */
export function connectorGoalContext(
  decision: LoopDecision,
): GoalContextReference | undefined {
  const signal = decision.source_signal;
  if (!signal || !isConnectorSignal(signal)) return undefined;

  const connector = signal.source.trim().slice(0, 256) || "connector";
  const accountId = signal.sourceAccount?.id?.trim();
  const sourceRef = `${connector}:${boundedRef(signal.id)}`;
  const summary = connectorSummary(signal);
  return {
    id: uuidv5(`context:${decision.id}`, LOOP_GOAL_NAMESPACE),
    kind: "connector_record",
    refId: boundedRef(signal.id),
    ...(decision.title.trim()
      ? { label: decision.title.trim().slice(0, 512) }
      : {}),
    ...(summary ? { summary } : {}),
    origin: "connector",
    sourceRef,
    attributes: {
      connector,
      signalType: signal.type.slice(0, 512),
      ...(accountId ? { accountId: accountId.slice(0, 512) } : {}),
      ...(signal.sourceAccount?.label
        ? { accountLabel: signal.sourceAccount.label.slice(0, 512) }
        : {}),
    },
  };
}

function productionDependencies(): LoopGoalDependencies {
  return {
    startGoal: async (input) =>
      (
        await import("@/lib/ai/runtime-instructions/api/server")
      ).startTrustedAgentGoal(input),
    providerState: async (input) => {
      const runtime = (
        await import("@/lib/ai/runtime-instructions/runtime")
      ).getAgentGoalRuntime();
      return resolveGoalProviderState(input, runtime);
    },
    startProvider: startGoalProvider,
  };
}

export async function resolveGoalProviderState(
  input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    instructionId: string;
  },
  runtime: AgentGoalRuntime,
): Promise<"start" | "ready"> {
  const goal = await runtime.queries.getById(input);
  const status = goal?.goal.goal.status;
  if (status === "completed") return "ready";
  if (status !== "active") {
    throw new Error(
      status ? `Goal is not active (${status})` : "Goal was not found",
    );
  }
  const live = await runtime.sessions.resolve(
    input.ownerId,
    input.runtimeSessionId,
  );
  if (!live) return "start";
  const dispatch = await runtime.dispatcher.drain({
    ownerId: input.ownerId,
    runtimeSessionId: input.runtimeSessionId,
    targetInstructionId: input.instructionId,
  });
  if (dispatch.status !== "accepted") {
    throw new Error(
      `The Goal instruction was not accepted (${dispatch.status})`,
    );
  }
  return "ready";
}

/**
 * Start the native stream in the background and wait for durable proof that
 * the provider accepted the Goal instruction. The early `session` SSE event
 * is deliberately ignored because both native providers emit it before Goal
 * Runtime registration.
 */
async function startGoalProvider(input: {
  ownerId: string;
  runtimeSessionId: string;
  instructionId: string;
  objective: string;
}): Promise<{ ok: boolean; error?: string }> {
  const [{ invokeAgentPrompt }, { getAgentGoalRuntime }] = await Promise.all([
    import("./runner"),
    import("@/lib/ai/runtime-instructions/runtime"),
  ]);
  const runtime = getAgentGoalRuntime();
  const controller = new AbortController();
  let ready = false;
  let reportEarlyError: (message: string) => void = () => undefined;
  const earlyError = new Promise<string>((resolve) => {
    reportEarlyError = resolve;
  });
  const run = invokeAgentPrompt(input.objective, {
    ownerId: input.ownerId,
    sessionId: input.runtimeSessionId,
    signal: controller.signal,
    collectOutput: false,
    onEvent: (event) => {
      if (event.type !== "error") return;
      const message = sseErrorMessage(event);
      if (!ready) {
        reportEarlyError(message);
        controller.abort(new Error(message));
      } else {
        console.error("[Loop Goal] Provider run stopped after startup", message);
      }
    },
  });
  const finished = run.then((response) => ({ type: "finished" as const, response }));
  const deadline = Date.now() + PROVIDER_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let providerReady: boolean;
    try {
      providerReady = await isGoalProviderReady(input, runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller.abort(error instanceof Error ? error : new Error(message));
      return { ok: false, error: message };
    }
    if (providerReady) {
      ready = true;
      void finished.then(({ response }) => {
        if (!response.ok) {
          console.error(
            "[Loop Goal] Provider run stopped after startup",
            response.error,
          );
        }
      });
      return { ok: true };
    }

    const outcome = await Promise.race([
      finished,
      earlyError.then((message) => ({ type: "error" as const, message })),
      delay(PROVIDER_READY_POLL_MS).then(() => ({ type: "poll" as const })),
    ]);
    if (outcome.type === "error") {
      return { ok: false, error: outcome.message };
    }
    if (outcome.type === "finished") {
      return {
        ok: false,
        error:
          outcome.response.error ||
          "The native provider stopped before Goal Runtime registration",
      };
    }
  }

  const message = "The native provider did not become ready in time";
  controller.abort(new Error(message));
  return { ok: false, error: message };
}

export async function isGoalProviderReady(input: {
  ownerId: string;
  runtimeSessionId: string;
  instructionId: string;
}, runtime: AgentGoalRuntime): Promise<boolean> {
  const [session, live] = await Promise.all([
    runtime.runtimeSessions.get(input.ownerId, input.runtimeSessionId),
    runtime.sessions.resolve(input.ownerId, input.runtimeSessionId),
  ]);
  if (!session?.providerSessionId || !live) return false;
  const dispatch = await runtime.dispatcher.drain({
    ownerId: input.ownerId,
    runtimeSessionId: input.runtimeSessionId,
    targetInstructionId: input.instructionId,
  });
  return dispatch.status === "accepted";
}

function loopGoalObjective(decision: LoopDecision): string {
  const objective = decision.title.trim();
  if (!objective) throw new Error("Goal objective is required");
  return objective;
}

function isConnectorSignal(signal: LoopSignal): boolean {
  const source = signal.source.trim().toLowerCase();
  return (
    signal._origin === "composio" ||
    signal.sourceAccount !== undefined ||
    CONNECTOR_SOURCES.has(source)
  );
}

function connectorSummary(signal: LoopSignal): string | undefined {
  try {
    const summary = JSON.stringify(signal.payload);
    return summary === "{}" ? undefined : summary.slice(0, 8_000);
  } catch {
    return undefined;
  }
}

function boundedRef(value: string): string {
  const ref = value.trim();
  return ref && ref.length <= 256
    ? ref
    : uuidv5(`signal:${ref}`, LOOP_GOAL_NAMESPACE);
}

function sseErrorMessage(event: { content?: unknown; message?: unknown }): string {
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }
  if (typeof event.content === "string" && event.content.trim()) {
    return event.content.trim();
  }
  return "The native provider reported an error before Goal Runtime registration";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
