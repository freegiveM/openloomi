export type StartupChatSelectionSource =
  | "url"
  | "claimed"
  | "recovery"
  | "restored"
  | "new";

export type StartupChatSelection =
  | {
      pending: true;
      chatId: string;
      source: "restored" | "new";
    }
  | {
      pending: false;
      chatId: string;
      source: StartupChatSelectionSource;
    };

export function selectStartupChat(input: {
  pathname: string;
  page: string | null;
  urlChatId?: string;
  claimedChatId?: string;
  forceNewChat?: boolean;
  recoveryLoaded: boolean;
  recoveryChatId?: string;
  restoredChatId: string | null;
  newChatId: string;
}): StartupChatSelection {
  if (input.urlChatId) {
    return { pending: false, chatId: input.urlChatId, source: "url" };
  }
  if (input.claimedChatId) {
    return {
      pending: false,
      chatId: input.claimedChatId,
      source: "claimed",
    };
  }
  if (input.forceNewChat) {
    return { pending: false, chatId: input.newChatId, source: "new" };
  }

  const isColdHomeStart = input.pathname === "/" && input.page === null;
  if (isColdHomeStart && !input.recoveryLoaded) {
    return input.restoredChatId
      ? {
          pending: true,
          chatId: input.restoredChatId,
          source: "restored",
        }
      : { pending: true, chatId: input.newChatId, source: "new" };
  }
  if (isColdHomeStart && input.recoveryChatId) {
    return {
      pending: false,
      chatId: input.recoveryChatId,
      source: "recovery",
    };
  }
  if (input.restoredChatId) {
    return {
      pending: false,
      chatId: input.restoredChatId,
      source: "restored",
    };
  }
  return { pending: false, chatId: input.newChatId, source: "new" };
}
