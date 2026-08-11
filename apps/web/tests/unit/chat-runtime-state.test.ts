import { describe, expect, it, vi } from "vitest";
import {
  attachChatSessionAbort,
  finishChatSession,
  getChatSessionState,
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
});
