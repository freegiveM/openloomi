import { describe, expect, it, vi } from "vitest";

import type {
  CodexAppServerExit,
  CodexAppServerNotification,
} from "@/lib/ai/extensions/agent/codex/app-server";
import type { CodexRuntimeEventObserverPort } from "@/lib/ai/extensions/agent/codex/runtime/event-observer";
import type { CodexNormalizedRuntimeEvent } from "@/lib/ai/extensions/agent/codex/runtime/events";
import {
  type CodexAppServerRuntimeClient,
  CodexRuntimeSession,
} from "@/lib/ai/extensions/agent/codex/runtime/session";
import type {
  GoalFinalEvaluationDecision,
  GoalStopDecision,
  RuntimeGoalStopControllerPort,
} from "@/lib/ai/runtime-instructions/goal-controller";
import type { RuntimeObservationContext } from "@/lib/ai/runtime-instructions/runtime-observation";
import {
  RUNTIME_INSTRUCTION_SCHEMA_VERSION,
  RuntimeInstructionSchema,
  createAgentGoal,
} from "@openloomi/ai/agent/runtime-instructions";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GOAL_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVATE_ID = "33333333-3333-4333-8333-333333333333";
const CONTINUE_ID = "44444444-4444-4444-8444-444444444444";
const PAUSE_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-12T00:00:00.000Z");

class FakeClient implements CodexAppServerRuntimeClient {
  readonly startThread = vi.fn(async () => ({ thread: { id: "thread-1" } }));
  readonly resumeThread = vi.fn(
    async (
      input: Parameters<CodexAppServerRuntimeClient["resumeThread"]>[0],
    ) => ({
      thread: {
        id: input.threadId,
        status: { type: "idle" as const },
        cwd: "D:\\repo",
        turns: [],
      },
    }),
  );
  readonly startTurn = vi.fn(
    async (input: Parameters<CodexAppServerRuntimeClient["startTurn"]>[0]) => {
      const turnId = `turn-${this.startTurn.mock.calls.length}`;
      if (input.clientUserMessageId) {
        queueMicrotask(() =>
          this.emit("item/started", {
            threadId: input.threadId,
            turnId,
            item: {
              id: `user-${input.clientUserMessageId}`,
              type: "userMessage",
              clientId: input.clientUserMessageId,
              content: input.input,
            },
          }),
        );
      }
      return { turn: { id: turnId, status: "inProgress" as const } };
    },
  );
  readonly steerTurn = vi.fn(
    async (input: Parameters<CodexAppServerRuntimeClient["steerTurn"]>[0]) => ({
      turnId: input.expectedTurnId,
    }),
  );
  readonly interruptTurn = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  readonly initialize = vi.fn(async () => undefined);
  private readonly listeners = new Set<
    (notification: CodexAppServerNotification) => void
  >();
  private resolveExit!: (exit: CodexAppServerExit) => void;
  private readonly exit = new Promise<CodexAppServerExit>((resolve) => {
    this.resolveExit = resolve;
  });

  onNotification(listener: (notification: CodexAppServerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForExit() {
    return this.exit;
  }

  emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener({ method, params });
  }

  emitExit(exit: CodexAppServerExit) {
    this.resolveExit(exit);
  }
}

class FakeObserver implements CodexRuntimeEventObserverPort {
  readonly handoffs: Array<{ instructionId: string; turnId: string }> = [];
  private readonly contexts = new Map<string, RuntimeObservationContext>();

  async providerSessionInitialized() {}

  async instructionWritten(input: {
    instructionId: string;
    turnId: string;
    runEpoch: number;
  }) {
    this.handoffs.push({
      instructionId: input.instructionId,
      turnId: input.turnId,
    });
    this.contexts.set(input.turnId, {
      ownerId: "owner-1",
      runtimeSessionId: SESSION_ID,
      goalRunId: "run-1",
      goalId: GOAL_ID,
      goalRevision: 1,
      instructionId: input.instructionId,
      runEpoch: input.runEpoch,
    });
  }

  async observeEvent(_event: CodexNormalizedRuntimeEvent) {
    return true;
  }

  captureTurnContext(input: { turnId: string }) {
    return structuredClone(this.contexts.get(input.turnId) ?? null);
  }

  async flush() {}
}

function instruction(kind: "goal.activate" | "goal.continue" | "goal.pause") {
  const common = {
    schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
    goalId: GOAL_ID,
    goalRevision: 1,
    targetSessionId: SESSION_ID,
    source: { type: "user", authority: "user" } as const,
    issuedAt: NOW.toISOString(),
  };
  if (kind === "goal.activate") {
    const goal = createAgentGoal({
      id: GOAL_ID,
      input: {
        objective: "Finish the Codex runtime task",
        successCriteria: [
          {
            id: "done",
            description: "The task is complete",
            verification: { type: "model_evidence" },
            required: true,
          },
        ],
        constraints: [],
        contextRefs: [],
        priority: 50,
        completionPolicy: "model_evaluator",
        source: { type: "user" },
      },
      now: NOW,
    });
    return RuntimeInstructionSchema.parse({
      ...common,
      id: ACTIVATE_ID,
      sequence: 1,
      kind,
      deliveryMode: "steer",
      payload: { goal },
      idempotencyKey: "activate",
    });
  }
  if (kind === "goal.continue") {
    return RuntimeInstructionSchema.parse({
      ...common,
      id: CONTINUE_ID,
      sequence: 2,
      kind,
      deliveryMode: "steer",
      payload: {
        missingCriteria: [{ id: "done", description: "Complete the work" }],
        reason: "Continue the active Goal",
        // 0.8.0 schema requires a non-empty remainingBudget on every
        // goal.continue instruction.
        remainingBudget: { turns: 3 },
      },
      source: { type: "automation", authority: "automation" },
      idempotencyKey: "continue",
    });
  }
  return RuntimeInstructionSchema.parse({
    ...common,
    id: PAUSE_ID,
    sequence: 2,
    kind,
    deliveryMode: "interrupt_replace",
    payload: { reason: "Pause", expectedRunEpoch: 0 },
    idempotencyKey: "pause",
  });
}

function fixture(stop: GoalStopDecision) {
  const client = new FakeClient();
  const observer = new FakeObserver();
  const goalController: RuntimeGoalStopControllerPort = {
    evaluateStop: vi.fn(async () => stop),
    finalizeWithoutContinuation: vi.fn(
      async (): Promise<GoalFinalEvaluationDecision> => ({
        decision: "allow",
        outcome: "paused",
      }),
    ),
  };
  const runtime = new CodexRuntimeSession(SESSION_ID, client);
  runtime.attachEventObserver(observer);
  runtime.attachGoalStopController(goalController);
  return { client, observer, goalController, runtime };
}

describe("CodexRuntimeSession", () => {
  it("runs a live Goal through continuation and completion", async () => {
    const continuation = instruction("goal.continue");
    const { client, goalController, runtime } = fixture({
      decision: "allow",
      outcome: "completed",
    });
    vi.mocked(goalController.evaluateStop)
      .mockImplementationOnce(async () => {
        await runtime.deliver(continuation);
        return {
          decision: "block",
          outcome: "continue",
          goalId: GOAL_ID,
          goalRevision: 1,
          instruction: continuation,
          reason: "Continue",
        };
      })
      .mockResolvedValueOnce({ decision: "allow", outcome: "completed" });
    const output = runtime.subscribe()[Symbol.asyncIterator]();

    await runtime.start({ initialPrompt: "Initial", cwd: "D:\\repo" });
    await runtime.deliver(instruction("goal.activate"));
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(2));
    expect(client.startTurn.mock.calls[1]?.[0]).toMatchObject({
      clientUserMessageId: CONTINUE_ID,
    });

    client.emit("item/completed", {
      threadId: "thread-1",
      turnId: "turn-2",
      item: { id: "message-2", type: "agentMessage", text: "Done" },
    });
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed" },
    });

    await expect(output.next()).resolves.toMatchObject({
      value: { type: "text", content: "Done" },
    });
    await expect(output.next()).resolves.toMatchObject({
      value: { type: "result" },
    });
    await expect(output.next()).resolves.toMatchObject({ done: true });
    expect(goalController.evaluateStop).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["without a terminal notification", false],
    ["when an interrupted notification races the RPC response", true],
  ])(
    "interrupts a live turn at a manual pause boundary %s",
    async (_, emit) => {
      const { client, goalController, runtime } = fixture({
        decision: "allow",
        outcome: "completed",
      });
      client.interruptTurn.mockImplementationOnce(async () => {
        if (emit) {
          client.emit("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted" },
          });
        }
      });
      await runtime.start({ initialPrompt: "Initial", cwd: "D:\\repo" });
      await runtime.deliver(instruction("goal.activate"));
      const { boundary, hold } =
        runtime.captureTurnBoundaryAndHoldPendingInput(0);
      const terminal = runtime.waitForTurnTerminal({
        expectedRunEpoch: 0,
        afterTerminalSequence: boundary.terminalSequence,
      });

      await expect(
        runtime.deliver(instruction("goal.pause")),
      ).resolves.toMatchObject({
        state: "written_to_sdk",
      });
      await expect(terminal).resolves.toMatchObject({ state: "idle" });
      expect(client.interruptTurn).toHaveBeenCalledOnce();
      expect(goalController.evaluateStop).not.toHaveBeenCalled();
      hold.release();
      await vi.waitFor(() => expect(client.shutdown).toHaveBeenCalledOnce());
      expect(runtime.captureTurnBoundary().state).toBe("closed");
    },
  );

  it("finalizes the Goal when Codex exits during a live turn", async () => {
    const { client, goalController, observer, runtime } = fixture({
      decision: "allow",
      outcome: "completed",
    });
    const output = runtime.subscribe()[Symbol.asyncIterator]();
    await runtime.start({ initialPrompt: "Initial", cwd: "D:\\repo" });
    await runtime.deliver(instruction("goal.activate"));
    await vi.waitFor(() => expect(observer.handoffs).toHaveLength(1));

    client.emitExit({
      exitCode: 23,
      signal: null,
      stderr: "provider failed",
      expected: false,
    });

    await expect(output.next()).resolves.toMatchObject({
      value: { type: "error" },
    });
    await vi.waitFor(() =>
      expect(goalController.finalizeWithoutContinuation).toHaveBeenCalledOnce(),
    );
  });

  it("closes an automatically paused Goal for recovery", async () => {
    const { client, runtime } = fixture({
      decision: "allow",
      outcome: "paused",
    });
    const output = runtime.subscribe()[Symbol.asyncIterator]();
    await runtime.start({ initialPrompt: "Initial", cwd: "D:\\repo" });
    await runtime.deliver(instruction("goal.activate"));
    client.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await expect(output.next()).resolves.toMatchObject({
      value: { type: "result" },
    });
    await expect(output.next()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(client.shutdown).toHaveBeenCalledOnce());
    expect(runtime.captureTurnBoundary().state).toBe("closed");
  });
});
