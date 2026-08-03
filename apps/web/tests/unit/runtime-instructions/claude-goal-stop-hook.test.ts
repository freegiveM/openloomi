import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { createClaudeSupplementalInputHooks } from "@/lib/ai/extensions/agent/claude/runtime";

const PROVIDER_SESSION_ID = "claude-provider-session";

function stopHookInput(stopHookActive: boolean) {
  return {
    hook_event_name: "Stop",
    session_id: PROVIDER_SESSION_ID,
    transcript_path: "transcript.jsonl",
    cwd: "D:/workspace",
    stop_hook_active: stopHookActive,
    last_assistant_message: "The Goal is not complete yet.",
  } as never;
}

describe("Claude Goal Stop hook", () => {
  it("returns Claude's block shape and forwards the Stop context", async () => {
    const stopObserver = {
      evaluateStop: vi.fn().mockResolvedValue({
        decision: "block",
        outcome: "continue",
        reason: "Continue working on the missing criterion.",
      } as never),
    };
    const hooks = createClaudeSupplementalInputHooks({
      stopObserver,
      sessionId: "runtime-session",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const stop = hooks?.Stop?.[0]?.hooks[0] as HookCallback;

    await expect(
      stop(stopHookInput(false), undefined, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      decision: "block",
      reason: "Continue working on the missing criterion.",
    });
    expect(stopObserver.evaluateStop).toHaveBeenCalledWith({
      providerSessionId: PROVIDER_SESSION_ID,
      lastAssistantMessage: "The Goal is not complete yet.",
      stopHookActive: false,
    });
  });

  it("allows Claude to emit its result after a terminal Goal decision", async () => {
    const stopObserver = {
      evaluateStop: vi.fn().mockResolvedValue({
        decision: "allow",
        outcome: "completed",
      } as never),
    };
    const hooks = createClaudeSupplementalInputHooks({
      stopObserver,
      sessionId: "runtime-session",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const stop = hooks?.Stop?.[0]?.hooks[0] as HookCallback;

    await expect(
      stop(stopHookInput(false), undefined, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({});
  });
});
