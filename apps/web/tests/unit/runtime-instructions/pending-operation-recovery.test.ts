import { describe, expect, it, vi } from "vitest";

import { PendingGoalOperationRecovery } from "@/lib/ai/runtime-instructions/recovery/pending-operation-reconciler";

const OWNER_ID = "recovery-owner";
const SESSION_ID = "recovery-session";
const INSTRUCTION_ID = "recovery-pause-instruction";
const RECORDED_AT = new Date("2026-08-10T12:00:00.000Z");

function finalizedPause() {
  return {
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    action: "pause",
    transitionedGoal: { goal: { id: "paused-goal" } },
    instruction: {
      id: INSTRUCTION_ID,
      idempotencyKey: "pause-command",
    },
    expectedRunEpoch: 0,
    runEpoch: 0,
    phase: "finalized",
  } as const;
}

function createHarness(deliveryState: "pending" | "observed") {
  const finalizeControlInstruction = vi.fn();
  const supersedeDeliveries = vi.fn();
  const recovery = new PendingGoalOperationRecovery(
    {} as never,
    {
      getStoredById: vi.fn().mockResolvedValue({
        instruction: {
          id: INSTRUCTION_ID,
          idempotencyKey: "pause-command",
        },
        requestFingerprint: "a".repeat(64),
      }),
    },
    {
      getActiveByInstruction: vi.fn().mockResolvedValue({
        state: deliveryState,
      }),
    } as never,
    { finalizeControlInstruction, supersedeDeliveries } as never,
    { now: () => RECORDED_AT },
  );
  return { recovery, finalizeControlInstruction, supersedeDeliveries };
}

describe("pending Goal operation recovery", () => {
  it("supersedes a control instruction that never became provider-visible", async () => {
    const harness = createHarness("pending");

    await expect(
      harness.recovery.reconcile(finalizedPause() as never),
    ).resolves.toMatchObject({ disposition: "dormant", runEpoch: 0 });
    expect(harness.supersedeDeliveries).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      instructionIds: [INSTRUCTION_ID],
      reason: "Settled paused during Runtime recovery before provider delivery",
    });
    expect(harness.finalizeControlInstruction).not.toHaveBeenCalled();
  });

  it("finalizes an already provider-visible control instruction", async () => {
    const harness = createHarness("observed");

    await harness.recovery.reconcile(finalizedPause() as never);

    expect(harness.finalizeControlInstruction).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      instructionId: INSTRUCTION_ID,
      runEpoch: 0,
      status: "paused",
      recordedAt: RECORDED_AT.toISOString(),
    });
    expect(harness.supersedeDeliveries).not.toHaveBeenCalled();
  });
});
