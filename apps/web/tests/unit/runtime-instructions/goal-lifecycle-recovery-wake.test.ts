import type { AgentGoalStatePort } from "@openloomi/ai/agent/runtime-instructions";
import { describe, expect, it, vi } from "vitest";

import {
  GoalLifecycleService,
  type RuntimeSessionRecoveryWakePort,
} from "@/lib/ai/runtime-instructions/goal-lifecycle-service";
import type { RuntimeInstructionDispatcher } from "@/lib/ai/runtime-instructions/instruction-dispatcher";
import { RuntimeSessionRegistry } from "@/lib/ai/runtime-instructions/runtime-session-registry";

const OWNER_ID = "recovery-wake-owner";
const SESSION_ID = "recovery-wake-session";
const INSTRUCTION_ID = "recovery-wake-resume-instruction";
const NOW = "2026-08-10T12:00:00.000Z";

describe("Goal lifecycle recovery wake", () => {
  it("wakes a dormant recovered runtime and returns the resumed delivery receipt", async () => {
    const replay = {
      instruction: { id: INSTRUCTION_ID },
    };
    const state = {
      findCommitByIdempotency: vi.fn(async () => replay),
    } as unknown as AgentGoalStatePort;
    const unavailable = {
      status: "unavailable" as const,
      runtimeSessionId: SESSION_ID,
      instructionId: INSTRUCTION_ID,
    };
    const accepted = {
      status: "accepted" as const,
      instructionId: INSTRUCTION_ID,
      receipt: {
        instructionId: INSTRUCTION_ID,
        runtimeSessionId: SESSION_ID,
        state: "written_to_sdk" as const,
        recordedAt: NOW,
      },
    };
    const drain = vi
      .fn()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(accepted);
    const dispatcher = { drain } as unknown as RuntimeInstructionDispatcher;
    const recoveryWake: RuntimeSessionRecoveryWakePort = {
      wake: vi.fn(async () => true),
    };
    const lifecycle = new GoalLifecycleService(
      state,
      dispatcher,
      new RuntimeSessionRegistry(),
      { now: () => new Date(NOW) },
      { generate: () => "unused-id" },
      30_000,
      undefined,
      recoveryWake,
    );

    const result = await lifecycle.resume({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId: "paused-goal",
      expectedRevision: 2,
      idempotencyKey: "resume-after-restart",
      source: { type: "user", authority: "user" },
    });

    expect(recoveryWake.wake).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
    });
    expect(drain).toHaveBeenCalledTimes(2);
    expect(result.dispatch).toEqual(accepted);
  });
});
