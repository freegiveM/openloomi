import { describe, expect, it } from "vitest";

import { CodexRuntimeEventObserver } from "@/lib/ai/extensions/agent/codex/runtime";
import type {
  RuntimeObservationContext,
  RuntimeProviderEventObservation,
  RuntimeProviderObservationPort,
} from "@/lib/ai/runtime-instructions/runtime-observation";

const OWNER_ID = "codex-observer-owner";
const SESSION_ID = "codex-observer-session";
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

class FakeObservationPort implements RuntimeProviderObservationPort {
  readonly events: RuntimeProviderEventObservation[] = [];
  readonly handoffs: string[] = [];
  readonly contexts = new Map<string, RuntimeObservationContext>();
  currentContext?: RuntimeObservationContext;

  async recordInstructionHandoff(input: { instructionId: string }) {
    this.handoffs.push(input.instructionId);
    this.currentContext = this.contexts.get(input.instructionId);
    return true;
  }

  async setProviderSession() {}

  async captureContext() {
    return this.currentContext ? structuredClone(this.currentContext) : null;
  }

  async observeProviderEvent(input: RuntimeProviderEventObservation) {
    this.events.push(structuredClone(input));
    return true;
  }
}

describe("Codex runtime Goal observations", () => {
  it("records assistant, command, and terminal evidence", async () => {
    const port = new FakeObservationPort();
    port.contexts.set("instruction-1", {
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalRunId: "run-1",
      goalId: "goal-1",
      goalRevision: 1,
      instructionId: "instruction-1",
      runEpoch: 3,
    });
    const observer = new CodexRuntimeEventObserver(
      OWNER_ID,
      SESSION_ID,
      port,
      () => new Date("2026-08-12T08:00:00.000Z"),
    );
    await observer.providerSessionInitialized({
      threadId: THREAD_ID,
      runEpoch: 3,
    });
    await observer.instructionWritten({
      instructionId: "instruction-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      runEpoch: 3,
    });

    await observer.observeEvent(
      {
        kind: "item.completed",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "message-1",
          type: "agent_message",
          text: "The work is complete.",
        },
      },
      3,
    );
    await observer.observeEvent(
      {
        kind: "item.completed",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "command-1",
          type: "command_execution",
          command: "pnpm test",
          status: "completed",
          exitCode: 0,
        },
      },
      3,
    );
    await observer.observeEvent(
      {
        kind: "turn.completed",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        status: "completed",
        usage: { inputTokens: 13, cachedInputTokens: 5, outputTokens: 8 },
      },
      3,
    );

    expect(port.events).toHaveLength(3);
    expect(port.events[0]).toMatchObject({
      context: { instructionId: "instruction-1" },
      evidence: [{ type: "agent_report" }],
    });
    expect(port.events[1]).toMatchObject({
      evidence: [{ type: "test_result", success: true }],
    });
    expect(port.events[2]).toMatchObject({
      terminal: true,
      usage: { tokensUsed: 21, turnsUsed: 1 },
    });

    await observer.instructionWritten({
      instructionId: "pause-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      runEpoch: 3,
      bindContext: false,
    });
    expect(port.handoffs).toEqual(["instruction-1", "pause-1"]);
  });
});
