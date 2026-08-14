import { describe, expect, it } from "vitest";

import { createCodexWireEventProjector } from "@/lib/ai/extensions/agent/codex/runtime/wire-events";
import { goalStepCompletionMarker } from "@openloomi/ai/agent/runtime-instructions";

describe("Codex app-server wire event projection", () => {
  it("projects user acknowledgements and completed output", () => {
    const projector = createCodexWireEventProjector();
    const acknowledgement = projector.project({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "user-1",
          clientId: "instruction-1",
          content: [],
        },
      },
    });
    const assistant = projector.project({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-1",
          text: `${goalStepCompletionMarker("step-1")}\nStep complete.`,
        },
      },
    });
    const command = projector.project({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "pnpm test",
          status: "completed",
          aggregatedOutput: "passed",
          exitCode: 0,
        },
      },
    });

    expect(acknowledgement.instructionAcks).toEqual([
      expect.objectContaining({ instructionId: "instruction-1" }),
    ]);
    expect(assistant).toMatchObject({
      events: [{ kind: "item.completed", item: { type: "agent_message" } }],
      messages: [{ type: "text", content: "Step complete." }],
    });
    expect(command).toMatchObject({
      events: [
        {
          item: {
            type: "command_execution",
            command: "pnpm test",
            status: "completed",
            exitCode: 0,
          },
        },
      ],
      messages: [
        {
          type: "tool_result",
          toolUseId: "command-1",
          output: "passed",
          isError: false,
        },
      ],
    });
  });
});
