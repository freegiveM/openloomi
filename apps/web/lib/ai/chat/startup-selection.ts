export type StartupChatSelectionSource =
  | "url"
  | "recovery"
  | "restored"
  | "new";

export type StartupChatSelection =
  | { pending: true; chatId: null; source: null }
  | {
      pending: false;
      chatId: string;
      source: StartupChatSelectionSource;
    };

export function selectStartupChat(input: {
  pathname: string;
  page: string | null;
  urlChatId?: string;
  recoveryLoaded: boolean;
  recoveryChatId?: string;
  restoredChatId: string | null;
  newChatId: string;
}): StartupChatSelection {
  if (input.urlChatId) {
    return { pending: false, chatId: input.urlChatId, source: "url" };
  }

  const isColdHomeStart = input.pathname === "/" && input.page === null;
  if (isColdHomeStart && !input.recoveryLoaded) {
    return { pending: true, chatId: null, source: null };
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
