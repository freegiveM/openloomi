import type { ChatMessage } from "@melandlabs/shared";

export interface ChatSessionState {
  isAgentRunning: boolean;
  abortFn: (() => void) | null;
  /** Identifies the currently authoritative stream for this chat. */
  runGeneration?: number;
}

const IDLE_CHAT_SESSION_STATE: ChatSessionState = {
  isAgentRunning: false,
  abortFn: null,
};

export function getChatSessionState(
  states: Map<string, ChatSessionState>,
  chatId: string,
): ChatSessionState {
  return states.get(chatId) ?? IDLE_CHAT_SESSION_STATE;
}

export function setChatSessionRunning(
  states: Map<string, ChatSessionState>,
  chatId: string,
  isAgentRunning: boolean,
  runGeneration?: number,
): Map<string, ChatSessionState> {
  const current = getChatSessionState(states, chatId);
  if (
    current.isAgentRunning === isAgentRunning &&
    (runGeneration === undefined || current.runGeneration === runGeneration)
  ) {
    return states;
  }
  const next = new Map(states);
  next.set(chatId, {
    ...current,
    isAgentRunning,
    ...(runGeneration === undefined ? {} : { runGeneration }),
  });
  return next;
}

export function attachChatSessionAbort(
  states: Map<string, ChatSessionState>,
  chatId: string,
  abortFn: () => void,
  runGeneration?: number,
): Map<string, ChatSessionState> {
  const current = states.get(chatId);
  if (
    !current?.isAgentRunning ||
    (runGeneration !== undefined &&
      current.runGeneration !== runGeneration) ||
    current.abortFn === abortFn
  ) {
    return states;
  }
  const next = new Map(states);
  next.set(chatId, { ...current, abortFn });
  return next;
}

export function finishChatSession(
  states: Map<string, ChatSessionState>,
  chatId: string,
  runGeneration?: number,
): Map<string, ChatSessionState> {
  const current = states.get(chatId);
  if (
    !current ||
    (runGeneration !== undefined &&
      current.runGeneration !== runGeneration) ||
    (!current.isAgentRunning && current.abortFn === null)
  ) {
    return states;
  }
  const next = new Map(states);
  next.set(chatId, {
    ...current,
    isAgentRunning: false,
    abortFn: null,
  });
  return next;
}

/**
 * A retry supplies the failed prompt again as the new current message. Remove
 * the previous failed turn from history so the provider does not receive the
 * same user request twice.
 */
export function prepareRetryConversation(
  messages: ChatMessage[],
  failedUserMessageIds: readonly string[],
): ChatMessage[] {
  let history = messages;
  const failedIds = new Set(failedUserMessageIds);
  if (history.at(-1)?.role === "assistant") history = history.slice(0, -1);
  while (
    history.at(-1)?.role === "user" &&
    failedIds.has(history.at(-1)?.id ?? "")
  ) {
    history = history.slice(0, -1);
  }
  return history;
}
