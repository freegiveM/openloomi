import {
  RUNTIME_INSTRUCTION_SCHEMA_VERSION,
  RuntimeInstructionSchema,
  createAgentGoal,
  transitionAgentGoal,
  type AgentGoal,
  type PersistedAgentGoal,
  type RuntimeInstruction,
} from "@openloomi/ai/agent/runtime-instructions";
import { describe, expect, it } from "vitest";

import {
  goalInstructionCommitFromRoot,
  lifecycleTransitionFromRoot,
  replacementFromRoot,
} from "@/lib/ai/runtime-instructions/persistence/checkpoints";
import type { StoredRuntimeInstruction } from "@/lib/ai/runtime-instructions/persistence/goal-instruction-mappers";
import type { AgentGoalCommandCheckpoint } from "@/lib/db/agent-goal-runtime-schema-types";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "checkpoint-runtime";
const OTHER_SESSION_ID = "other-checkpoint-runtime";
const GOAL_ID = "20000000-0000-4000-8000-000000000001";
const REPLACEMENT_GOAL_ID = "20000000-0000-4000-8000-000000000002";
const OTHER_GOAL_ID = "20000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-05T08:00:00.000Z");
const LATER = new Date("2026-08-05T08:01:00.000Z");
const IDEMPOTENCY_KEY = "checkpoint-command";

const SCOPE = { ownerId: OWNER_ID, runtimeSessionId: SESSION_ID };

function goal(id = GOAL_ID, objective = "Validate durable Goal identity") {
  return createAgentGoal({
    id,
    now: NOW,
    input: {
      objective,
      successCriteria: [
        {
          id: "checkpoint-valid",
          description: "The checkpoint remains internally consistent",
          verification: { type: "model_evidence" },
          required: true,
        },
      ],
      constraints: [],
      contextRefs: [],
      priority: 50,
      completionPolicy: "model_evaluator",
      source: { type: "user" },
    },
  });
}

function persistedGoal(value: AgentGoal): PersistedAgentGoal {
  return {
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    slot: "primary",
    goal: value,
  };
}

function instruction(
  value: Omit<RuntimeInstruction, "schemaVersion" | "sequence">,
  sequence = 1,
): RuntimeInstruction {
  return RuntimeInstructionSchema.parse({
    ...value,
    schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
    sequence,
  });
}

function commandRoot(
  commandType: NonNullable<StoredRuntimeInstruction["commandType"]>,
  commandPhase: NonNullable<StoredRuntimeInstruction["commandPhase"]>,
  rootInstruction: RuntimeInstruction,
  commandCheckpoint: AgentGoalCommandCheckpoint,
  runEpoch = 0,
): StoredRuntimeInstruction {
  return {
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    runEpoch,
    instruction: rootInstruction,
    requestFingerprint: "a".repeat(64),
    commandOrder: 0,
    commandType,
    commandPhase,
    commandCheckpoint,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function activationInstruction(activeGoal: AgentGoal, sequence = 1) {
  return instruction(
    {
      id: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      goalId: activeGoal.id,
      goalRevision: activeGoal.revision,
      kind: "goal.activate",
      deliveryMode: "steer",
      targetSessionId: SESSION_ID,
      payload: { goal: activeGoal },
      source: { type: "user", authority: "user" },
      idempotencyKey: IDEMPOTENCY_KEY,
      issuedAt: activeGoal.updatedAt,
    },
    sequence,
  );
}

function activationRoot(): StoredRuntimeInstruction {
  const activeGoal = goal();
  const activate = activationInstruction(activeGoal);
  return commandRoot("goal_instruction", "committed", activate, {
    type: "goal_instruction",
    goal: persistedGoal(activeGoal),
    instruction: activate,
  });
}

function lifecycleRoot(): StoredRuntimeInstruction {
  const cancelledGoal = transitionAgentGoal({
    current: goal(),
    expectedRevision: 1,
    status: "cancelled",
    now: LATER,
  });
  const cancel = instruction({
    id: "30000000-0000-4000-8000-000000000010",
    goalId: cancelledGoal.id,
    goalRevision: cancelledGoal.revision,
    kind: "goal.cancel",
    deliveryMode: "interrupt_replace",
    targetSessionId: SESSION_ID,
    payload: { reason: "Cancel safely", expectedRunEpoch: 0 },
    source: { type: "user", authority: "user" },
    idempotencyKey: IDEMPOTENCY_KEY,
    issuedAt: cancelledGoal.updatedAt,
  });
  return commandRoot("lifecycle", "prepared", cancel, {
    type: "lifecycle",
    transition: {
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      action: "cancel",
      transitionedGoal: persistedGoal(cancelledGoal),
      instruction: cancel,
      expectedRunEpoch: 0,
      runEpoch: 0,
      phase: "prepared",
    },
  });
}

function replacementRoot(): StoredRuntimeInstruction {
  const supersededGoal = transitionAgentGoal({
    current: goal(),
    expectedRevision: 1,
    status: "cancelled",
    now: LATER,
  });
  const replacementGoal = goal(
    REPLACEMENT_GOAL_ID,
    "Validate replacement identity",
  );
  const control = instruction({
    id: "30000000-0000-4000-8000-000000000020",
    goalId: supersededGoal.id,
    goalRevision: supersededGoal.revision,
    kind: "control.interrupt",
    deliveryMode: "interrupt_replace",
    targetSessionId: SESSION_ID,
    payload: {
      reason: "Replace safely",
      expectedRunEpoch: 0,
      replacementGoalId: replacementGoal.id,
    },
    source: { type: "user", authority: "user" },
    idempotencyKey: IDEMPOTENCY_KEY,
    issuedAt: supersededGoal.updatedAt,
  });
  return commandRoot("replacement", "prepared", control, {
    type: "replacement",
    replacement: {
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      supersededGoal: persistedGoal(supersededGoal),
      replacementGoal: persistedGoal(replacementGoal),
      controlInstruction: control,
      expectedRunEpoch: 0,
      runEpoch: 0,
      phase: "prepared",
    },
  });
}

function expectInvalidCheckpoint(run: () => unknown, message: RegExp): void {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toMatchObject({ code: "invalid_record" });
  expect(String(captured)).toMatch(message);
}

describe("durable Goal command checkpoint identity", () => {
  it("rejects Goal checkpoints whose Goal, root, or Session identity diverges", () => {
    const valid = activationRoot();
    const checkpoint = valid.commandCheckpoint;
    if (checkpoint?.type !== "goal_instruction") throw new Error("fixture");

    const revisedGoal = { ...checkpoint.goal.goal, revision: 2 };
    expectInvalidCheckpoint(
      () =>
        goalInstructionCommitFromRoot(
          {
            ...valid,
            commandCheckpoint: {
              ...checkpoint,
              goal: { ...checkpoint.goal, goal: revisedGoal },
            },
          },
          SCOPE,
          true,
        ),
      /instruction Goal identity/,
    );

    const sessionMismatch = RuntimeInstructionSchema.parse({
      ...valid.instruction,
      targetSessionId: OTHER_SESSION_ID,
    });
    expectInvalidCheckpoint(
      () =>
        goalInstructionCommitFromRoot(
          {
            ...valid,
            instruction: sessionMismatch,
            commandCheckpoint: {
              ...checkpoint,
              instruction: sessionMismatch,
            },
          },
          SCOPE,
          true,
        ),
      /instruction Goal identity/,
    );

    expectInvalidCheckpoint(
      () =>
        goalInstructionCommitFromRoot(
          { ...valid, ownerId: OTHER_OWNER_ID },
          SCOPE,
          true,
        ),
      /root instruction crosses its command scope/,
    );
  });

  it("rejects lifecycle checkpoints whose Goal, action, or epoch identity diverges", () => {
    const valid = lifecycleRoot();
    const checkpoint = valid.commandCheckpoint;
    if (checkpoint?.type !== "lifecycle") throw new Error("fixture");

    const otherGoal = {
      ...checkpoint.transition.transitionedGoal.goal,
      id: OTHER_GOAL_ID,
    };
    expectInvalidCheckpoint(
      () =>
        lifecycleTransitionFromRoot(
          {
            ...valid,
            commandCheckpoint: {
              ...checkpoint,
              transition: {
                ...checkpoint.transition,
                transitionedGoal: {
                  ...checkpoint.transition.transitionedGoal,
                  goal: otherGoal,
                },
              },
            },
          },
          SCOPE,
        ),
      /instruction Goal identity/,
    );

    expectInvalidCheckpoint(
      () => lifecycleTransitionFromRoot({ ...valid, runEpoch: 1 }, SCOPE),
      /action or run epoch/,
    );
  });

  it("rejects replacement checkpoints whose Goal linkage or activation command identity diverges", () => {
    const valid = replacementRoot();
    const checkpoint = valid.commandCheckpoint;
    if (checkpoint?.type !== "replacement") throw new Error("fixture");

    const wrongReplacementGoal = {
      ...checkpoint.replacement.replacementGoal.goal,
      id: OTHER_GOAL_ID,
    };
    expectInvalidCheckpoint(
      () =>
        replacementFromRoot(
          {
            ...valid,
            commandCheckpoint: {
              ...checkpoint,
              replacement: {
                ...checkpoint.replacement,
                replacementGoal: {
                  ...checkpoint.replacement.replacementGoal,
                  goal: wrongReplacementGoal,
                },
              },
            },
          },
          SCOPE,
        ),
      /control instruction does not identify its Goals/,
    );

    const replacementGoal = checkpoint.replacement.replacementGoal.goal;
    const activated = {
      ...checkpoint.replacement,
      phase: "activated" as const,
      runEpoch: 1,
      activationInstruction: activationInstruction(replacementGoal, 2),
    };
    const wrongActivation = RuntimeInstructionSchema.parse({
      ...activated.activationInstruction,
      idempotencyKey: "different-command",
    });
    expectInvalidCheckpoint(
      () =>
        replacementFromRoot(
          {
            ...valid,
            commandPhase: "activated",
            commandCheckpoint: {
              ...checkpoint,
              replacement: {
                ...activated,
                activationInstruction: wrongActivation,
              },
            },
          },
          SCOPE,
        ),
      /activation instruction does not identify/,
    );
  });
});
