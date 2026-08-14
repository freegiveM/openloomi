import {
  RUNTIME_INSTRUCTION_SCHEMA_VERSION,
  type AgentGoalLifecycleTransition,
  type AgentGoalReplacement,
  type AgentGoalStatePort,
  type GoalCommandIdentity,
  type RuntimeClockPort,
  type RuntimeIdGeneratorPort,
  type RuntimeInstructionDraft,
} from "@openloomi/ai/agent/runtime-instructions";

import type { StoredRuntimeInstruction } from "../persistence/goal-instruction-mappers";
import type { PersistedRuntimeInstructionDelivery } from "../persistence/runtime-observation-mappers";
import type { RuntimeLifecycleObservationPort } from "../runtime-observation";

export type RuntimeRecoveryPendingOperation =
  | AgentGoalLifecycleTransition
  | AgentGoalReplacement;

export interface RuntimeRecoveryCommandReader {
  getStoredById(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
  }): Promise<StoredRuntimeInstruction | null>;
}

export interface RuntimeRecoveryDeliveryReader {
  getActiveByInstruction(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
  }): Promise<PersistedRuntimeInstructionDelivery | null>;
}

export interface PendingOperationRecoveryResult {
  disposition: "dormant" | "resume";
  runEpoch: number;
  activationInstructionId?: string;
}

/**
 * Finishes a lifecycle checkpoint after the provider process has disappeared.
 *
 * The crashed process itself is the terminal boundary: there can be no more
 * output from its old turn. We still advance the existing durable phases one
 * at a time so a second crash during recovery resumes idempotently from the
 * last committed checkpoint.
 */
export class PendingGoalOperationRecovery {
  constructor(
    private readonly state: AgentGoalStatePort,
    private readonly instructions: RuntimeRecoveryCommandReader,
    private readonly deliveries: RuntimeRecoveryDeliveryReader,
    private readonly observations: RuntimeLifecycleObservationPort,
    private readonly clock: RuntimeClockPort = { now: () => new Date() },
    private readonly ids: RuntimeIdGeneratorPort = {
      generate: () => crypto.randomUUID(),
    },
  ) {}

  async reconcile(
    operation: RuntimeRecoveryPendingOperation,
  ): Promise<PendingOperationRecoveryResult> {
    validateOperationIdentity(operation);
    return "action" in operation
      ? this.reconcileLifecycle(operation)
      : this.reconcileReplacement(operation);
  }

  private async reconcileLifecycle(
    initial: AgentGoalLifecycleTransition,
  ): Promise<PendingOperationRecoveryResult> {
    let transition = initial;
    const command = await this.commandFor(
      transition.ownerId,
      transition.runtimeSessionId,
      transition.instruction.id,
    );
    const nextRunEpoch =
      transition.action === "cancel"
        ? transition.expectedRunEpoch + 1
        : transition.expectedRunEpoch;

    if (transition.action === "cancel" && transition.phase === "prepared") {
      transition = (
        await this.state.markLifecycleTransitionBoundary({
          ownerId: transition.ownerId,
          runtimeSessionId: transition.runtimeSessionId,
          goalId: transition.transitionedGoal.goal.id,
          expectedRunEpoch: transition.expectedRunEpoch,
          nextRunEpoch,
          command,
        })
      ).transition;
    }
    if (transition.phase !== "finalized") {
      transition = (
        await this.state.finalizeLifecycleTransition({
          ownerId: transition.ownerId,
          runtimeSessionId: transition.runtimeSessionId,
          goalId: transition.transitionedGoal.goal.id,
          expectedRunEpoch: transition.expectedRunEpoch,
          nextRunEpoch,
          command,
        })
      ).transition;
    }
    await this.settleControlInstruction({
      ownerId: transition.ownerId,
      runtimeSessionId: transition.runtimeSessionId,
      instructionId: transition.instruction.id,
      runEpoch: transition.expectedRunEpoch,
      status: transition.action === "pause" ? "paused" : "cancelled",
    });
    return { disposition: "dormant", runEpoch: transition.runEpoch };
  }

  private async reconcileReplacement(
    initial: AgentGoalReplacement,
  ): Promise<PendingOperationRecoveryResult> {
    let replacement = initial;
    const command = await this.commandFor(
      replacement.ownerId,
      replacement.runtimeSessionId,
      replacement.controlInstruction.id,
    );
    if (replacement.phase === "prepared") {
      replacement = (
        await this.state.markReplacementBoundary({
          ownerId: replacement.ownerId,
          runtimeSessionId: replacement.runtimeSessionId,
          replacementGoalId: replacement.replacementGoal.goal.id,
          expectedRunEpoch: replacement.expectedRunEpoch,
          nextRunEpoch: replacement.expectedRunEpoch + 1,
          command,
        })
      ).replacement;
    }
    if (replacement.phase !== "activated") {
      replacement = (
        await this.state.finalizeReplacement({
          ownerId: replacement.ownerId,
          runtimeSessionId: replacement.runtimeSessionId,
          replacementGoalId: replacement.replacementGoal.goal.id,
          activationInstruction: this.activationInstruction(replacement),
          command,
        })
      ).replacement;
    }
    await this.settleControlInstruction({
      ownerId: replacement.ownerId,
      runtimeSessionId: replacement.runtimeSessionId,
      instructionId: replacement.controlInstruction.id,
      runEpoch: replacement.expectedRunEpoch,
      status: "cancelled",
    });
    const activationInstructionId = replacement.activationInstruction?.id;
    if (!activationInstructionId) {
      throw new Error(
        `Recovered Goal replacement ${replacement.replacementGoal.goal.id} has no activation instruction`,
      );
    }
    return {
      disposition: "resume",
      runEpoch: replacement.runEpoch,
      activationInstructionId,
    };
  }

  private activationInstruction(
    replacement: AgentGoalReplacement,
  ): RuntimeInstructionDraft {
    return {
      schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
      id: this.ids.generate(),
      goalId: replacement.replacementGoal.goal.id,
      goalRevision: replacement.replacementGoal.goal.revision,
      kind: "goal.activate",
      deliveryMode: "steer",
      targetSessionId: replacement.runtimeSessionId,
      payload: { goal: replacement.replacementGoal.goal },
      source: replacement.controlInstruction.source,
      idempotencyKey: replacement.controlInstruction.idempotencyKey,
      issuedAt: this.clock.now().toISOString(),
    };
  }

  private async settleControlInstruction(input: {
    ownerId: string;
    runtimeSessionId: string;
    instructionId: string;
    runEpoch: number;
    status: "paused" | "cancelled";
  }): Promise<void> {
    const delivery = await this.deliveries.getActiveByInstruction(input);
    if (!delivery) return;

    if (
      delivery.state === "pending" ||
      delivery.state === "leased" ||
      delivery.state === "queued"
    ) {
      // The provider process is gone, so the lifecycle boundary is real even
      // though this control message was never provider-visible. Retire the
      // stale outbox item instead of fabricating a Claude receipt or allowing
      // it to replay when the Goal is later resumed.
      await this.observations.supersedeDeliveries({
        ownerId: input.ownerId,
        runtimeSessionId: input.runtimeSessionId,
        instructionIds: [input.instructionId],
        reason: `Settled ${input.status} during Runtime recovery before provider delivery`,
      });
      return;
    }

    await this.observations.finalizeControlInstruction({
      ...input,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  private async commandFor(
    ownerId: string,
    runtimeSessionId: string,
    instructionId: string,
  ): Promise<GoalCommandIdentity> {
    const stored = await this.instructions.getStoredById({
      ownerId,
      runtimeSessionId,
      instructionId,
    });
    if (!stored || stored.instruction.id !== instructionId) {
      throw new Error(
        `Cannot recover command metadata for Runtime Instruction ${instructionId}`,
      );
    }
    return {
      idempotencyKey: stored.instruction.idempotencyKey,
      requestFingerprint: stored.requestFingerprint,
    };
  }
}

function validateOperationIdentity(
  operation: RuntimeRecoveryPendingOperation,
): void {
  for (const [field, value] of [
    ["ownerId", operation.ownerId],
    ["runtimeSessionId", operation.runtimeSessionId],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      value !== value.trim()
    ) {
      throw new TypeError(`${field} must be a non-empty identifier`);
    }
  }
}
