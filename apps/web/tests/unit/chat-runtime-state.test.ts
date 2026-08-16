import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@melandlabs/shared";
import {
  attachChatSessionAbort,
  finishChatSession,
  getChatSessionState,
  prepareRetryConversation,
  setChatSessionRunning,
} from "@/lib/ai/chat/runtime-state";

describe("chat runtime state", () => {
  it("keeps a completed session idle when a late abort callback arrives", () => {
    const abort = vi.fn();
    let states = setChatSessionRunning(new Map(), "chat-a", true);
    states = attachChatSessionAbort(states, "chat-a", abort);

    states = finishChatSession(states, "chat-a");
    const finishedStates = states;
    states = attachChatSessionAbort(states, "chat-a", vi.fn());

    expect(states).toBe(finishedStates);
    expect(getChatSessionState(states, "chat-a")).toEqual({
      isAgentRunning: false,
      abortFn: null,
    });
  });

  it("finishes only the terminal chat session", () => {
    const chatBAbort = vi.fn();
    let states = setChatSessionRunning(new Map(), "chat-a", true);
    states = setChatSessionRunning(states, "chat-b", true);
    states = attachChatSessionAbort(states, "chat-b", chatBAbort);

    states = finishChatSession(states, "chat-a");

    expect(getChatSessionState(states, "chat-a").isAgentRunning).toBe(false);
    expect(getChatSessionState(states, "chat-b")).toEqual({
      isAgentRunning: true,
      abortFn: chatBAbort,
    });
  });

  it("ignores terminal callbacks from an older run generation", () => {
    const oldAbort = vi.fn();
    const currentAbort = vi.fn();
    let states = setChatSessionRunning(new Map(), "chat-a", true, 1);
    states = attachChatSessionAbort(states, "chat-a", oldAbort, 1);
    states = setChatSessionRunning(states, "chat-a", true, 2);
    states = attachChatSessionAbort(states, "chat-a", currentAbort, 2);

    const currentStates = states;
    states = finishChatSession(states, "chat-a", 1);
    states = attachChatSessionAbort(states, "chat-a", oldAbort, 1);

    expect(states).toBe(currentStates);
    expect(getChatSessionState(states, "chat-a")).toMatchObject({
      isAgentRunning: true,
      abortFn: currentAbort,
      runGeneration: 2,
    });
  });

  it("removes the failed turn before retrying the same prompt", () => {
    const earlier = {
      id: "a",
      role: "assistant",
      content: "earlier",
      parts: [],
    } as ChatMessage;
    const failedUser = {
      id: "u",
      role: "user",
      content: "retry me",
      parts: [],
    } as ChatMessage;
    const failedAssistant = {
      id: "e",
      role: "assistant",
      content: "",
      parts: [],
    } as ChatMessage;
    const failedRetry = {
      id: "r",
      role: "user",
      content: "continue retry me",
      parts: [],
    } as ChatMessage;

    expect(
      prepareRetryConversation(
        [earlier, failedUser, failedRetry, failedAssistant],
        [failedUser.id, failedRetry.id],
      ),
    ).toEqual([earlier]);
    expect(
      prepareRetryConversation([earlier, failedUser], [failedUser.id]),
    ).toEqual([earlier]);
    expect(
      prepareRetryConversation([earlier, failedUser], ["another-user"]),
    ).toEqual([earlier, failedUser]);
  });
});
