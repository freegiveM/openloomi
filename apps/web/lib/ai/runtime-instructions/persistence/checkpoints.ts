import {
  AgentGoalSchema,
  RuntimeInstructionSchema,
  canonicalJson,
  type AgentGoalLifecycleTransition,
  type AgentGoalReplacement,
  type GoalInstructionCommit,
  type PersistedAgentGoal,
} from "@melandlabs/ai/agent/runtime-instructions";

import type { AgentGoalCommandCheckpoint } from "@/lib/db/agent-goal-runtime-schema-types";
import { invalidPersistenceRecord } from "./errors";
import type { StoredRuntimeInstruction } from "./goal-instruction-mappers";

export function goalInstructionCommitFromRoot(
  root: StoredRuntimeInstruction,
  scope: { ownerId: string; runtimeSessionId: string },
  deduplicated: boolean,
): GoalInstructionCommit {
  assertRootScope(root, scope, "Goal command");
  const checkpoint = requireCheckpoint(root, "goal_instruction");
  const goal = parsePersistedGoal(checkpoint.goal, scope, "Goal command");
  const instruction = parseCheckpointInstruction(
    checkpoint.instruction,
    "Goal command",
  );
  assertInstructionGoalIdentity(
    instruction,
    goal,
    scope.runtimeSessionId,
    "Goal command",
  );
  assertSameInstruction(root, instruction, "Goal command");
  return {
    goal,
    instruction,
    deduplicated,
  };
}

export function lifecycleTransitionFromRoot(
  root: StoredRuntimeInstruction,
  scope: { ownerId: string; runtimeSessionId: string },
): AgentGoalLifecycleTransition {
  assertRootScope(root, scope, "Goal lifecycle checkpoint");
  const checkpoint = requireCheckpoint(root, "lifecycle");
  const transition = checkpoint.transition;
  if (
    transition.ownerId !== scope.ownerId ||
    transition.runtimeSessionId !== scope.runtimeSessionId ||
    (transition.action !== "pause" && transition.action !== "cancel") ||
    !["prepared", "boundary_observed", "finalized"].includes(
      transition.phase,
    ) ||
    transition.phase !== root.commandPhase ||
    !Number.isSafeInteger(transition.expectedRunEpoch) ||
    transition.expectedRunEpoch < 0 ||
    !Number.isSafeInteger(transition.runEpoch) ||
    transition.runEpoch < 0
  ) {
    invalidPersistenceRecord(
      "Goal lifecycle checkpoint",
      "scope, phase, action, or run epoch is invalid",
    );
  }
  const parsed: AgentGoalLifecycleTransition = {
    ...structuredClone(transition),
    transitionedGoal: parsePersistedGoal(
      transition.transitionedGoal,
      scope,
      "Goal lifecycle checkpoint",
    ),
    instruction: parseCheckpointInstruction(
      transition.instruction,
      "Goal lifecycle checkpoint",
    ),
  };
  const expectedEpoch =
    parsed.action === "pause" || parsed.phase === "prepared"
      ? parsed.expectedRunEpoch
      : parsed.expectedRunEpoch + 1;
  if (
    parsed.runEpoch !== expectedEpoch ||
    (parsed.action === "pause" && parsed.phase === "boundary_observed")
  ) {
    invalidPersistenceRecord(
      "Goal lifecycle checkpoint",
      "phase and run epoch do not describe a reachable lifecycle barrier",
    );
  }
  assertLifecycleIdentity(root, parsed, scope.runtimeSessionId);
  assertSameInstruction(root, parsed.instruction, "Goal lifecycle checkpoint");
  return parsed;
}

export function replacementFromRoot(
  root: StoredRuntimeInstruction,
  scope: { ownerId: string; runtimeSessionId: string },
): AgentGoalReplacement {
  assertRootScope(root, scope, "Goal replacement checkpoint");
  const checkpoint = requireCheckpoint(root, "replacement");
  const replacement = checkpoint.replacement;
  if (
    replacement.ownerId !== scope.ownerId ||
    replacement.runtimeSessionId !== scope.runtimeSessionId ||
    !["prepared", "boundary_observed", "activated"].includes(
      replacement.phase,
    ) ||
    replacement.phase !== root.commandPhase ||
    !Number.isSafeInteger(replacement.expectedRunEpoch) ||
    replacement.expectedRunEpoch < 0 ||
    !Number.isSafeInteger(replacement.runEpoch) ||
    replacement.runEpoch < 0
  ) {
    invalidPersistenceRecord(
      "Goal replacement checkpoint",
      "scope, phase, or run epoch is invalid",
    );
  }
  const parsed: AgentGoalReplacement = {
    ...structuredClone(replacement),
    supersededGoal: parsePersistedGoal(
      replacement.supersededGoal,
      scope,
      "Goal replacement checkpoint",
    ),
    replacementGoal: parsePersistedGoal(
      replacement.replacementGoal,
      scope,
      "Goal replacement checkpoint",
    ),
    controlInstruction: parseCheckpointInstruction(
      replacement.controlInstruction,
      "Goal replacement checkpoint",
    ),
    ...(replacement.activationInstruction === undefined
      ? {}
      : {
          activationInstruction: parseCheckpointInstruction(
            replacement.activationInstruction,
            "Goal replacement checkpoint",
          ),
        }),
  };
  const expectedEpoch =
    parsed.phase === "prepared"
      ? parsed.expectedRunEpoch
      : parsed.expectedRunEpoch + 1;
  if (
    parsed.runEpoch !== expectedEpoch ||
    (parsed.phase === "activated") !==
      (parsed.activationInstruction !== undefined)
  ) {
    invalidPersistenceRecord(
      "Goal replacement checkpoint",
      "phase, run epoch, and activation snapshot are inconsistent",
    );
  }
  assertReplacementIdentity(root, parsed, scope.runtimeSessionId);
  assertSameInstruction(
    root,
    parsed.controlInstruction,
    "Goal replacement checkpoint",
  );
  return parsed;
}

function assertRootScope(
  root: StoredRuntimeInstruction,
  scope: { ownerId: string; runtimeSessionId: string },
  entity: string,
): void {
  if (
    root.ownerId !== scope.ownerId ||
    root.runtimeSessionId !== scope.runtimeSessionId
  ) {
    invalidPersistenceRecord(
      entity,
      "root instruction crosses its command scope",
    );
  }
}

function assertLifecycleIdentity(
  root: StoredRuntimeInstruction,
  transition: AgentGoalLifecycleTransition,
  runtimeSessionId: string,
): void {
  const instruction = transition.instruction;
  assertInstructionGoalIdentity(
    instruction,
    transition.transitionedGoal,
    runtimeSessionId,
    "Goal lifecycle checkpoint",
  );
  const instructionExpectedRunEpoch =
    instruction.kind === "goal.pause" || instruction.kind === "goal.cancel"
      ? instruction.payload.expectedRunEpoch
      : undefined;
  if (
    instruction.kind !== `goal.${transition.action}` ||
    instructionExpectedRunEpoch !== transition.expectedRunEpoch ||
    root.runEpoch !== transition.expectedRunEpoch
  ) {
    invalidPersistenceRecord(
      "Goal lifecycle checkpoint",
      "action or run epoch does not match its root instruction",
    );
  }
}

function assertReplacementIdentity(
  root: StoredRuntimeInstruction,
  replacement: AgentGoalReplacement,
  runtimeSessionId: string,
): void {
  const controlInstruction = replacement.controlInstruction;
  assertInstructionGoalIdentity(
    controlInstruction,
    replacement.supersededGoal,
    runtimeSessionId,
    "Goal replacement checkpoint",
  );
  if (
    controlInstruction.kind !== "control.interrupt" ||
    controlInstruction.payload.replacementGoalId !==
      replacement.replacementGoal.goal.id ||
    controlInstruction.payload.expectedRunEpoch !==
      replacement.expectedRunEpoch ||
    root.runEpoch !== replacement.expectedRunEpoch
  ) {
    invalidPersistenceRecord(
      "Goal replacement checkpoint",
      "control instruction does not identify its Goals or root run epoch",
    );
  }

  const activationInstruction = replacement.activationInstruction;
  if (activationInstruction === undefined) return;
  assertInstructionGoalIdentity(
    activationInstruction,
    replacement.replacementGoal,
    runtimeSessionId,
    "Goal replacement checkpoint",
  );
  if (
    activationInstruction.kind !== "goal.activate" ||
    activationInstruction.idempotencyKey !==
      controlInstruction.idempotencyKey ||
    activationInstruction.payload.goal.id !==
      replacement.replacementGoal.goal.id ||
    activationInstruction.payload.goal.revision !==
      replacement.replacementGoal.goal.revision
  ) {
    invalidPersistenceRecord(
      "Goal replacement checkpoint",
      "activation instruction does not identify the reserved replacement Goal or command",
    );
  }
}

function assertInstructionGoalIdentity(
  instruction: ReturnType<typeof parseCheckpointInstruction>,
  goal: PersistedAgentGoal,
  runtimeSessionId: string,
  entity: string,
): void {
  if (
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== goal.goal.id ||
    instruction.goalRevision !== goal.goal.revision
  ) {
    invalidPersistenceRecord(
      entity,
      "instruction Goal identity does not match its authoritative Goal snapshot and Runtime Session",
    );
  }
}

function requireCheckpoint<T extends AgentGoalCommandCheckpoint["type"]>(
  root: StoredRuntimeInstruction,
  type: T,
): Extract<AgentGoalCommandCheckpoint, { type: T }> {
  if (
    root.commandOrder !== 0 ||
    root.commandType !== type ||
    root.commandCheckpoint?.type !== type
  ) {
    invalidPersistenceRecord(
      "Runtime Instruction command checkpoint",
      `expected a ${type} root command`,
    );
  }
  return root.commandCheckpoint as Extract<
    AgentGoalCommandCheckpoint,
    { type: T }
  >;
}

function parsePersistedGoal(
  value: unknown,
  scope: { ownerId: string; runtimeSessionId: string },
  entity: string,
): PersistedAgentGoal {
  if (typeof value !== "object" || value === null) {
    invalidPersistenceRecord(entity, "Goal snapshot is not an object");
  }
  const candidate = value as PersistedAgentGoal;
  if (
    candidate.ownerId !== scope.ownerId ||
    candidate.runtimeSessionId !== scope.runtimeSessionId ||
    candidate.slot !== "primary"
  ) {
    invalidPersistenceRecord(entity, "Goal snapshot crosses its command scope");
  }
  const parsedGoal = AgentGoalSchema.safeParse(candidate.goal);
  if (!parsedGoal.success) {
    invalidPersistenceRecord(
      entity,
      "Goal snapshot failed protocol validation",
      parsedGoal.error,
    );
  }
  return {
    ownerId: scope.ownerId,
    runtimeSessionId: scope.runtimeSessionId,
    slot: "primary",
    goal: parsedGoal.data,
  };
}

function parseCheckpointInstruction(value: unknown, entity: string) {
  const parsed = RuntimeInstructionSchema.safeParse(value);
  if (!parsed.success) {
    invalidPersistenceRecord(
      entity,
      "instruction snapshot failed protocol validation",
      parsed.error,
    );
  }
  return parsed.data;
}

function assertSameInstruction(
  root: StoredRuntimeInstruction,
  checkpointInstruction: unknown,
  entity: string,
): void {
  if (
    canonicalJson(root.instruction) !== canonicalJson(checkpointInstruction)
  ) {
    invalidPersistenceRecord(
      entity,
      "checkpoint instruction does not match the immutable outbox snapshot",
    );
  }
}
