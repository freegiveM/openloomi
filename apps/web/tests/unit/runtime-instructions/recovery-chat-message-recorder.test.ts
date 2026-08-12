import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeRecoveryChatRecorder,
  recoveryAssistantMessageId,
} from "@/lib/ai/runtime-instructions/recovery/chat-message-recorder";
import { MESSAGE_ID_SCOPE_CONFLICT } from "@/lib/db/queries";

const input = {
  ownerId: "owner-a",
  runtimeSessionId: "chat-a",
  providerSessionId: "provider-a",
  runEpoch: 3,
};

describe("Runtime recovery chat recorder", () => {
  it("reopens the same recovery epoch in one deterministic message row", async () => {
    let storedMessage: any;
    const save = vi.fn(async ({ messages }) => {
      storedMessage = structuredClone(messages[0]);
    });
    const dependencies = {
      getChatById: vi.fn(async () => ({ id: "chat-a", userId: "owner-a" })),
      getMessageById: vi.fn(async () =>
        storedMessage ? [structuredClone(storedMessage)] : [],
      ),
      saveMessages: save,
      flushDelayMs: 60_000,
      now: () => new Date("2026-08-11T01:00:00.000Z"),
    };

    const first = await createRuntimeRecoveryChatRecorder(
      input,
      dependencies as never,
    );
    await first.record({ type: "text", content: "first" });
    await first.close();

    const second = await createRuntimeRecoveryChatRecorder(
      input,
      dependencies as never,
    );
    await second.record({ type: "text", content: " second" });
    await second.close();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0].messages[0].id).toBe(
      recoveryAssistantMessageId(input),
    );
    expect(save.mock.calls[1]?.[0].messages[0]).toMatchObject({
      id: recoveryAssistantMessageId(input),
      chatId: "chat-a",
      parts: [{ type: "text", text: "first second" }],
    });
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      expectedUserId: "owner-a",
      expectedMessages: [
        {
          id: recoveryAssistantMessageId(input),
          chatId: "chat-a",
          parts: [{ type: "text", text: "first" }],
        },
      ],
    });
  });

  it("rebases pending output when another recovery writer wins the message CAS", async () => {
    let storedMessage: any;
    const save = vi.fn(async ({ messages, expectedMessages }) => {
      const expected = expectedMessages[0];
      if (
        (storedMessage && !expected) ||
        (!storedMessage && expected) ||
        (storedMessage &&
          JSON.stringify(storedMessage.parts) !==
            JSON.stringify(expected?.parts))
      ) {
        throw new Error(MESSAGE_ID_SCOPE_CONFLICT);
      }
      storedMessage = structuredClone(messages[0]);
    });
    const dependencies = {
      getChatById: vi.fn(async () => ({ id: "chat-a", userId: "owner-a" })),
      getMessageById: vi.fn(async () =>
        storedMessage ? [structuredClone(storedMessage)] : [],
      ),
      saveMessages: save,
      flushDelayMs: 60_000,
      now: () => new Date("2026-08-11T01:00:00.000Z"),
    };
    // Both recorders deliberately start from the same absent-row snapshot.
    const first = await createRuntimeRecoveryChatRecorder(
      input,
      dependencies as never,
    );
    const stale = await createRuntimeRecoveryChatRecorder(
      input,
      dependencies as never,
    );

    await first.record({ type: "text", content: "first writer" });
    await first.close();
    await stale.record({ type: "text", content: " + stale writer" });
    await stale.close();

    expect(save).toHaveBeenCalledTimes(3);
    expect(storedMessage).toMatchObject({
      id: recoveryAssistantMessageId(input),
      chatId: "chat-a",
      role: "assistant",
      parts: [{ type: "text", text: "first writer + stale writer" }],
    });
    expect(dependencies.getChatById).toHaveBeenCalledTimes(3);
    expect(dependencies.getMessageById).toHaveBeenCalledTimes(3);
  });

  it("rejects a chat outside the recovery owner scope", async () => {
    const save = vi.fn();
    await expect(
      createRuntimeRecoveryChatRecorder(input, {
        getChatById: vi.fn(async () => ({
          id: "chat-a",
          userId: "another-owner",
        })) as never,
        getMessageById: vi.fn() as never,
        saveMessages: save as never,
      }),
    ).rejects.toThrow("is not owned by owner-a");
    expect(save).not.toHaveBeenCalled();
  });

  it("flushes buffered text when the recovered generator closes", async () => {
    const save = vi.fn(async () => undefined);
    const recorder = await createRuntimeRecoveryChatRecorder(input, {
      getChatById: vi.fn(async () => ({
        id: "chat-a",
        userId: "owner-a",
      })) as never,
      getMessageById: vi.fn(async () => []) as never,
      saveMessages: save as never,
      flushDelayMs: 60_000,
    });

    await recorder.record({ type: "text", content: "buffered output" });
    expect(save).not.toHaveBeenCalled();
    await recorder.close();
    expect(save).toHaveBeenCalledOnce();
  });

  it("marks an unfinished recovered tool as failed on final close", async () => {
    const save = vi.fn(async (_input: any) => undefined);
    const recorder = await createRuntimeRecoveryChatRecorder(input, {
      getChatById: vi.fn(async () => ({
        id: "chat-a",
        userId: "owner-a",
      })) as never,
      getMessageById: vi.fn(async () => []) as never,
      saveMessages: save as never,
      flushDelayMs: 60_000,
    });

    await recorder.record({
      type: "tool_use",
      id: "tool-a",
      name: "shell",
      input: { command: "pnpm test" },
    });
    await recorder.close();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].messages[0].parts).toEqual([
      expect.objectContaining({
        type: "tool-native",
        toolUseId: "tool-a",
        status: "error",
        isError: true,
      }),
    ]);
  });
});
