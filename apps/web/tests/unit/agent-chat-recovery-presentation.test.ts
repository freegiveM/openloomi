import { describe, expect, it } from "vitest";

import { resolveAgentChatRuntimePresentation } from "@/lib/ai/chat/runtime-presentation";

describe("AgentChatPanel recovery presentation", () => {
  it("rejects a second send and omits a fake stop during server recovery", () => {
    expect(
      resolveAgentChatRuntimePresentation({
        browserRunActive: false,
        serverRecoveryActive: true,
      }),
    ).toEqual({
      effectiveRunning: true,
      composerLocked: true,
      canStartRun: false,
      canStopFromBrowser: false,
    });
  });

  it("keeps the real browser stop available for an ordinary local run", () => {
    expect(
      resolveAgentChatRuntimePresentation({
        browserRunActive: true,
        serverRecoveryActive: false,
      }),
    ).toEqual({
      effectiveRunning: true,
      composerLocked: false,
      canStartRun: false,
      canStopFromBrowser: true,
    });
  });

  it("keeps a real browser stop when both live-state sources observe the run", () => {
    expect(
      resolveAgentChatRuntimePresentation({
        browserRunActive: true,
        serverRecoveryActive: true,
      }),
    ).toMatchObject({
      composerLocked: false,
      canStartRun: false,
      canStopFromBrowser: true,
    });
  });

  it("locks an explicit chat while recovery ownership is still loading", () => {
    expect(
      resolveAgentChatRuntimePresentation({
        browserRunActive: false,
        serverRecoveryActive: false,
        serverRecoveryPending: true,
      }),
    ).toEqual({
      effectiveRunning: false,
      composerLocked: true,
      canStartRun: false,
      canStopFromBrowser: false,
    });
  });
});
