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
        recoveryChatId: "recovery-chat",
      }),
    ).toEqual({ pending: false, chatId: "url-chat", source: "url" });
  });

  it("waits for the recovery read model on a cold home start", () => {
    expect(selectStartupChat({ ...base, recoveryLoaded: false })).toEqual({
      pending: true,
      chatId: null,
      source: null,
    });
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
