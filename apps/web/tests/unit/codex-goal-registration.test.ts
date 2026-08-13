import { describe, expect, it, vi } from "vitest";

import { CodexRuntimeEventObserver } from "@/lib/ai/extensions/agent/codex/runtime/event-observer";
import { startCodexGoalRuntimeSession } from "@/lib/ai/extensions/agent/codex/runtime/goal-registration";
import type { CodexRuntimeSession } from "@/lib/ai/extensions/agent/codex/runtime/session";
import { createInMemoryAgentGoalRuntime } from "@/lib/ai/runtime-instructions/runtime";

const OWNER_ID = "authenticated-owner";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function fakeRuntime() {
  const raw = {
    runtimeSessionId: SESSION_ID,
    runEpoch: 0,
    start: vi.fn(async () => undefined),
    beginInitialTurn: vi.fn(async () => undefined),
    initializeRunEpoch: vi.fn(),
    close: vi.fn(async () => undefined),
    attachEventObserver: vi.fn(),
    attachGoalStopController: vi.fn(),
    recoveredInstructionSettlements: vi.fn(() => []),
    hasActiveTurn: vi.fn(() => false),
    activateRecoveredNotifications: vi.fn(async () => undefined),
    deliver: vi.fn(),
    interrupt: vi.fn(),
  };
  return { raw, runtime: raw as unknown as CodexRuntimeSession };
}

describe("Codex Goal runtime registration", () => {
  it("registers one Codex transport and releases it", async () => {
    const { raw, runtime } = fakeRuntime();
    const goalRuntime = createInMemoryAgentGoalRuntime();
    const registration = await startCodexGoalRuntimeSession({
      ownerId: OWNER_ID,
      runtime,
      start: { initialPrompt: "initial request", cwd: "D:\\openloomi" },
      goalRuntime,
    });

    expect(raw.initializeRunEpoch).toHaveBeenCalledWith(0);
    expect(raw.start).toHaveBeenCalledOnce();
    expect(raw.beginInitialTurn).toHaveBeenCalledOnce();
    expect(raw.attachEventObserver).toHaveBeenCalledWith(
      expect.any(CodexRuntimeEventObserver),
    );
    expect(raw.attachGoalStopController).toHaveBeenCalledOnce();
    await expect(
      goalRuntime.sessions.resolve(OWNER_ID, SESSION_ID),
    ).resolves.toBe(runtime);

    await registration.release();
    await expect(
      goalRuntime.sessions.resolve(OWNER_ID, SESSION_ID),
    ).resolves.toBeNull();
  });
});
