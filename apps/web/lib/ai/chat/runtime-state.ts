export interface ChatSessionState {
  isAgentRunning: boolean;
  abortFn: (() => void) | null;
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
): Map<string, ChatSessionState> {
  const current = getChatSessionState(states, chatId);
  if (current.isAgentRunning === isAgentRunning) return states;
  const next = new Map(states);
  next.set(chatId, { ...current, isAgentRunning });
  return next;
}

export function attachChatSessionAbort(
  states: Map<string, ChatSessionState>,
  chatId: string,
  abortFn: () => void,
): Map<string, ChatSessionState> {
  const current = states.get(chatId);
  if (!current?.isAgentRunning || current.abortFn === abortFn) {
    return states;
  }
  const next = new Map(states);
  next.set(chatId, { ...current, abortFn });
  return next;
}

export function finishChatSession(
  states: Map<string, ChatSessionState>,
  chatId: string,
): Map<string, ChatSessionState> {
  const current = states.get(chatId);
  if (
    !current ||
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
