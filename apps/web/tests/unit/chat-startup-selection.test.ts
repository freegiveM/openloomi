import { describe, expect, it } from "vitest";

import { selectStartupChat } from "@/lib/ai/chat/startup-selection";

const base = {
  pathname: "/",
  page: null,
  recoveryLoaded: true,
  restoredChatId: "restored-chat",
  newChatId: "new-chat",
};

describe("selectStartupChat", () => {
  it("always gives an explicit URL chat the highest priority", () => {
    expect(
      selectStartupChat({
        ...base,
        urlChatId: "url-chat",
        claimedChatId: "claimed-chat",
        forceNewChat: true,
        recoveryChatId: "recovery-chat",
      }),
    ).toEqual({ pending: false, chatId: "url-chat", source: "url" });
  });

  it("shows the restored chat while the recovery read model loads", () => {
    expect(selectStartupChat({ ...base, recoveryLoaded: false })).toEqual({
      pending: true,
      chatId: "restored-chat",
      source: "restored",
    });
  });

  it("shows a new chat while recovery loads when nothing was restored", () => {
    expect(
      selectStartupChat({
        ...base,
        recoveryLoaded: false,
        restoredChatId: null,
      }),
    ).toEqual({ pending: true, chatId: "new-chat", source: "new" });
  });

  it("keeps a provisional chat once the user claims it", () => {
    expect(
      selectStartupChat({
        ...base,
        recoveryChatId: "recovery-chat",
        claimedChatId: "claimed-chat",
      }),
    ).toEqual({
      pending: false,
      chatId: "claimed-chat",
      source: "claimed",
    });
  });

  it("starts URL-driven send and prefill flows in a new chat", () => {
    expect(
      selectStartupChat({
        ...base,
        recoveryChatId: "recovery-chat",
        forceNewChat: true,
      }),
    ).toEqual({ pending: false, chatId: "new-chat", source: "new" });
  });

  it("restores a recoverable Goal chat before local storage", () => {
    expect(
      selectStartupChat({ ...base, recoveryChatId: "recovery-chat" }),
    ).toEqual({
      pending: false,
      chatId: "recovery-chat",
      source: "recovery",
    });
  });

  it("uses the locally restored chat when no Goal is recovering", () => {
    expect(selectStartupChat(base)).toEqual({
      pending: false,
      chatId: "restored-chat",
      source: "restored",
    });
  });

  it("does not let recovery hijack an explicit chat-page navigation", () => {
    expect(
      selectStartupChat({
        ...base,
        page: "chat",
        recoveryChatId: "recovery-chat",
      }),
    ).toEqual({
      pending: false,
      chatId: "restored-chat",
      source: "restored",
    });
  });
});
