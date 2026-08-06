import {
  type AgentGoal,
  type AgentGoalLifecycleTransition,
  type AgentGoalReplacement,
  AgentGoalSchema,
  type GoalCommandIdentity,
  type GoalLifecycleTransitionAction,
  type GoalStatus,
  type RuntimeInstruction,
  type RuntimeInstructionDraft,
  RuntimeInstructionSchema,
  assertGoalStatusTransition,
  canonicalJson,
} from "@openloomi/ai/agent/runtime-instructions";

import { AgentGoalStateError as DurableAgentGoalStateError } from "./goal-state-error";

export interface ValidatedGoalStateScope {
  ownerId: string;
  runtimeSessionId: string;
}

export function validateGoalStateScope(
  ownerId: string,
  runtimeSessionId: string,
): ValidatedGoalStateScope {
  return {
    ownerId: requireGoalStateIdentifier(ownerId, "ownerId"),
    runtimeSessionId: requireGoalStateIdentifier(
      runtimeSessionId,
      "runtimeSessionId",
    ),
  };
}

export function requireGoalStateIdentifier(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `${field} must be a string`,
    );
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    normalized !== value
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `${field} must contain 1 to 256 characters without surrounding whitespace`,
    );
  }
  return value;
}

export function requirePositiveGoalStateInteger(
  value: unknown,
  field: string,
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `${field} must be a positive integer`,
    );
  }
  return value as number;
}

export function requireNonNegativeGoalStateInteger(
  value: unknown,
  field: string,
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `${field} must be a non-negative integer`,
    );
  }
  return value as number;
}

export function parseGoalState(candidate: AgentGoal): AgentGoal {
  try {
    return AgentGoalSchema.parse(candidate);
  } catch (cause) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Goal state is invalid",
      cause,
    );
  }
}

export function validateGoalCommandIdentity(
  command: GoalCommandIdentity,
): GoalCommandIdentity {
  const idempotencyKey = requireGoalStateIdentifier(
    command.idempotencyKey,
    "idempotencyKey",
  );
  if (!/^[a-f0-9]{64}$/i.test(command.requestFingerprint)) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Goal command request fingerprint must be a SHA-256 digest",
    );
  }
  return { idempotencyKey, requestFingerprint: command.requestFingerprint };
}

export function materializeGoalInstruction(
  draft: RuntimeInstructionDraft,
  command: GoalCommandIdentity,
  sequence: number,
): RuntimeInstruction {
  if (draft.idempotencyKey !== command.idempotencyKey) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Instruction and Goal command idempotency keys must match",
    );
  }
  try {
    return RuntimeInstructionSchema.parse({ ...draft, sequence });
  } catch (cause) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Runtime Instruction draft is invalid",
      cause,
    );
  }
}

export function assertGoalActivationCommit(
  goal: AgentGoal,
  instruction: RuntimeInstruction,
  runtimeSessionId: string,
): void {
  if (
    goal.revision !== 1 ||
    goal.status !== "active" ||
    instruction.kind !== "goal.activate" ||
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== goal.id ||
    instruction.goalRevision !== goal.revision ||
    canonicalJson(instruction.payload.goal) !== canonicalJson(goal)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Activation must atomically commit an active revision-one Goal and its matching instruction",
    );
  }
}

export function assertGoalRevisionCommit(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  instruction: RuntimeInstruction,
  runtimeSessionId: string,
  expectedRevision: number,
): void {
  if (
    goal.revision !== expectedRevision + 1 ||
    goal.createdAt !== previousGoal.createdAt ||
    goal.status !== "active" ||
    canonicalJson(goal.source) !== canonicalJson(previousGoal.source) ||
    Date.parse(goal.updatedAt) < Date.parse(previousGoal.updatedAt)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "A Goal revision commit must advance the active Goal exactly once without changing immutable state or moving time backwards",
    );
  }

  const supportedKind =
    instruction.kind === "goal.update" ||
    instruction.kind === "context.upsert" ||
    instruction.kind === "context.remove";
  if (
    !supportedKind ||
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== goal.id ||
    instruction.goalRevision !== goal.revision
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Goal revision commits must use a supported update instruction with matching identity",
    );
  }

  switch (instruction.kind) {
    case "goal.update":
      if (
        instruction.payload.previousRevision !== expectedRevision ||
        canonicalJson(instruction.payload.goal) !== canonicalJson(goal) ||
        canonicalJson(previousGoal.contextRefs) !==
          canonicalJson(goal.contextRefs)
      ) {
        throw new DurableAgentGoalStateError(
          "invalid_commit",
          "A Goal update instruction must contain the authoritative Goal revision, preserve context, and identify its exact previous revision",
        );
      }
      return;
    case "context.upsert":
      assertContextUpsertTransition(
        previousGoal,
        goal,
        instruction.payload.contextRef,
      );
      return;
    case "context.remove":
      assertContextRemoveTransition(
        previousGoal,
        goal,
        instruction.payload.contextRefId,
      );
      return;
  }
}

export function assertGoalResumeCommit(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  instruction: RuntimeInstruction,
  runtimeSessionId: string,
  expectedRevision: number,
): void {
  if (
    previousGoal.status !== "paused" ||
    goal.status !== "active" ||
    goal.revision !== expectedRevision + 1 ||
    instruction.kind !== "goal.resume" ||
    instruction.deliveryMode !== "steer" ||
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== goal.id ||
    instruction.goalRevision !== goal.revision
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "An ordinary Goal transition may only resume a paused Goal with its matching steer instruction",
    );
  }

  assertStatusTransition(previousGoal.status, goal.status, "lifecycle");
  const expected: AgentGoal = {
    ...previousGoal,
    revision: expectedRevision + 1,
    status: goal.status,
    updatedAt: goal.updatedAt,
  };
  if (
    Date.parse(goal.updatedAt) < Date.parse(previousGoal.updatedAt) ||
    canonicalJson(expected) !== canonicalJson(goal)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "A Goal lifecycle commit may change only status, revision, and updatedAt",
    );
  }
}

export function assertGoalContinuationCommit(
  goal: AgentGoal,
  instruction: RuntimeInstruction,
  runtimeSessionId: string,
  expectedRevision: number,
): void {
  if (
    goal.status !== "active" ||
    goal.revision !== expectedRevision ||
    instruction.kind !== "goal.continue" ||
    instruction.deliveryMode !== "steer" ||
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== goal.id ||
    instruction.goalRevision !== expectedRevision
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "A Goal continuation must append a matching steer instruction without revising the active Goal",
    );
  }

  assertGoalContinuationCriteria(goal, instruction);
}

export function assertGoalContinuationCriteria(
  goal: AgentGoal,
  instruction: RuntimeInstruction,
): void {
  if (instruction.kind !== "goal.continue") {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "A Goal continuation must use a goal.continue instruction",
    );
  }

  const requiredCriteria = new Map(
    goal.successCriteria
      .filter((criterion) => criterion.required)
      .map((criterion) => [criterion.id, criterion.description] as const),
  );
  const seenCriteria = new Set<string>();
  const hasInvalidCriterion = instruction.payload.missingCriteria.some(
    (criterion) => {
      if (seenCriteria.has(criterion.id)) return true;
      seenCriteria.add(criterion.id);
      return requiredCriteria.get(criterion.id) !== criterion.description;
    },
  );
  if (instruction.payload.missingCriteria.length === 0 || hasInvalidCriterion) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "A Goal continuation may reference only unique, current required success criteria with their exact descriptions",
    );
  }
}

export function assertGoalEvaluationTransition(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  expectedRevision: number,
): void {
  const allowedStatus =
    goal.status === "blocked" ||
    goal.status === "completed" ||
    goal.status === "expired" ||
    goal.status === "budget_limited" ||
    goal.status === "failed";
  if (
    previousGoal.status !== "active" ||
    !allowedStatus ||
    goal.revision !== expectedRevision + 1
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "An evaluator transition must advance an active Goal exactly once to an evaluator-owned outcome",
    );
  }
  assertStatusTransition(previousGoal.status, goal.status, "evaluation");

  const expected: AgentGoal = {
    ...previousGoal,
    revision: expectedRevision + 1,
    status: goal.status,
    updatedAt: goal.updatedAt,
  };
  if (
    Date.parse(goal.updatedAt) < Date.parse(previousGoal.updatedAt) ||
    canonicalJson(expected) !== canonicalJson(goal)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "A Goal evaluation transition may change only status, revision, and updatedAt",
    );
  }
}

export function assertGoalLifecyclePreparation(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  instruction: RuntimeInstruction,
  action: GoalLifecycleTransitionAction,
  runtimeSessionId: string,
  expectedRevision: number,
  expectedRunEpoch: number,
): void {
  const expectedStatus = action === "pause" ? "paused" : "cancelled";
  const instructionExpectedRunEpoch =
    instruction.kind === "goal.pause" || instruction.kind === "goal.cancel"
      ? instruction.payload.expectedRunEpoch
      : undefined;
  const validSourceStatus =
    action === "pause"
      ? previousGoal.status === "active"
      : previousGoal.status === "active" || previousGoal.status === "paused";
  if (
    !validSourceStatus ||
    goal.status !== expectedStatus ||
    goal.revision !== expectedRevision + 1 ||
    instruction.kind !== `goal.${action}` ||
    instruction.deliveryMode !== "interrupt_replace" ||
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== goal.id ||
    instruction.goalRevision !== goal.revision ||
    instructionExpectedRunEpoch !== expectedRunEpoch
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `A Goal ${action} barrier must advance the authoritative Goal exactly once with its matching interrupting steer instruction`,
    );
  }

  assertStatusTransition(previousGoal.status, goal.status, "lifecycle");
  const expected: AgentGoal = {
    ...previousGoal,
    revision: expectedRevision + 1,
    status: expectedStatus,
    updatedAt: goal.updatedAt,
  };
  if (
    Date.parse(goal.updatedAt) < Date.parse(previousGoal.updatedAt) ||
    canonicalJson(expected) !== canonicalJson(goal)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `A Goal ${action} barrier may change only status, revision, and updatedAt`,
    );
  }
}

export function assertGoalReplacementPreparation(
  previousGoal: AgentGoal,
  supersededGoal: AgentGoal,
  replacementGoal: AgentGoal,
  instruction: RuntimeInstruction,
  runtimeSessionId: string,
  expectedRevision: number,
  expectedRunEpoch: number,
): void {
  try {
    assertGoalStatusTransition(previousGoal.status, "cancelled");
  } catch (cause) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `Goal replacement cannot supersede a ${previousGoal.status} Goal`,
      cause,
    );
  }

  const expectedSupersededGoal: AgentGoal = {
    ...previousGoal,
    revision: expectedRevision + 1,
    status: "cancelled",
    updatedAt: supersededGoal.updatedAt,
  };
  if (
    supersededGoal.id === replacementGoal.id ||
    supersededGoal.revision !== expectedRevision + 1 ||
    Date.parse(supersededGoal.updatedAt) < Date.parse(previousGoal.updatedAt) ||
    canonicalJson(expectedSupersededGoal) !== canonicalJson(supersededGoal) ||
    replacementGoal.revision !== 1 ||
    replacementGoal.status !== "active"
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Replacement preparation must only cancel the current Goal and reserve a distinct active revision-one Goal",
    );
  }
  if (
    instruction.kind !== "control.interrupt" ||
    instruction.deliveryMode !== "interrupt_replace" ||
    instruction.targetSessionId !== runtimeSessionId ||
    instruction.goalId !== supersededGoal.id ||
    instruction.goalRevision !== supersededGoal.revision ||
    instruction.payload.replacementGoalId !== replacementGoal.id ||
    instruction.payload.expectedRunEpoch !== expectedRunEpoch
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Replacement preparation requires a matching control.interrupt instruction and run epoch",
    );
  }
}

export function assertGoalReplacementActivation(
  replacement: AgentGoalReplacement,
  instruction: RuntimeInstruction,
  runtimeSessionId: string,
): void {
  assertGoalActivationCommit(
    replacement.replacementGoal.goal,
    instruction,
    runtimeSessionId,
  );
  if (
    canonicalJson(instruction.source) !==
      canonicalJson(replacement.controlInstruction.source) ||
    Date.parse(instruction.issuedAt) <
      Date.parse(replacement.controlInstruction.issuedAt)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Replacement activation must preserve command authority and monotonic instruction time",
    );
  }
}

export function assertReplacementEpochAdvance(
  replacement: AgentGoalReplacement,
  expectedRunEpoch: number,
  nextRunEpoch: number,
): void {
  if (
    expectedRunEpoch !== replacement.expectedRunEpoch ||
    nextRunEpoch !== expectedRunEpoch + 1
  ) {
    throw new DurableAgentGoalStateError(
      "run_epoch_conflict",
      `Replacement must advance Runtime Session epoch ${replacement.expectedRunEpoch} exactly once`,
    );
  }
  if (
    replacement.phase !== "prepared" &&
    replacement.runEpoch !== nextRunEpoch
  ) {
    throw new DurableAgentGoalStateError(
      "run_epoch_conflict",
      `Replacement already observed Runtime Session epoch ${replacement.runEpoch}`,
    );
  }
}

export function assertLifecycleEpochAdvance(
  transition: AgentGoalLifecycleTransition,
  expectedRunEpoch: number,
  nextRunEpoch: number,
): void {
  const requiredNextRunEpoch =
    transition.action === "pause"
      ? transition.expectedRunEpoch
      : transition.expectedRunEpoch + 1;
  if (
    expectedRunEpoch !== transition.expectedRunEpoch ||
    nextRunEpoch !== requiredNextRunEpoch
  ) {
    throw new DurableAgentGoalStateError(
      "run_epoch_conflict",
      `Goal ${transition.action} must finalize Runtime Session epoch ${transition.expectedRunEpoch} as epoch ${requiredNextRunEpoch}`,
    );
  }
  if (
    transition.phase === "finalized" &&
    transition.runEpoch !== nextRunEpoch
  ) {
    throw new DurableAgentGoalStateError(
      "run_epoch_conflict",
      `Goal ${transition.action} already finalized Runtime Session epoch ${transition.runEpoch}`,
    );
  }
}

export function validateLifecycleTransitionAction(
  value: unknown,
): GoalLifecycleTransitionAction {
  if (value !== "pause" && value !== "cancel") {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      "Lifecycle transition action must be pause or cancel",
    );
  }
  return value;
}

export function goalOccupiesPrimarySlot(status: GoalStatus): boolean {
  return status === "active" || status === "paused" || status === "blocked";
}

function assertContextUpsertTransition(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  contextRef: AgentGoal["contextRefs"][number],
): void {
  const contextRefs = structuredClone(previousGoal.contextRefs);
  const existingIndex = contextRefs.findIndex(
    (candidate) => candidate.id === contextRef.id,
  );
  if (
    existingIndex >= 0 &&
    canonicalJson(contextRefs[existingIndex]) === canonicalJson(contextRef)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `Context upsert ${contextRef.id} does not change authoritative Goal context`,
    );
  }
  if (existingIndex >= 0)
    contextRefs[existingIndex] = structuredClone(contextRef);
  else contextRefs.push(structuredClone(contextRef));

  assertExactContextTransition(previousGoal, goal, contextRefs, "upsert");
}

function assertContextRemoveTransition(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  contextRefId: string,
): void {
  if (
    !previousGoal.contextRefs.some((candidate) => candidate.id === contextRefId)
  ) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `Context remove ${contextRefId} does not reference existing authoritative Goal context`,
    );
  }
  assertExactContextTransition(
    previousGoal,
    goal,
    previousGoal.contextRefs.filter(
      (candidate) => candidate.id !== contextRefId,
    ),
    "remove",
  );
}

function assertExactContextTransition(
  previousGoal: AgentGoal,
  goal: AgentGoal,
  contextRefs: AgentGoal["contextRefs"],
  operation: "upsert" | "remove",
): void {
  const expected: AgentGoal = {
    ...previousGoal,
    revision: goal.revision,
    updatedAt: goal.updatedAt,
    contextRefs,
  };
  if (canonicalJson(expected) !== canonicalJson(goal)) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `Context ${operation} must change only the referenced authoritative Goal context`,
    );
  }
}

function assertStatusTransition(
  previous: GoalStatus,
  next: GoalStatus,
  source: "lifecycle" | "evaluation",
): void {
  try {
    assertGoalStatusTransition(previous, next);
  } catch (cause) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `Goal ${source} transition ${previous} -> ${next} is invalid`,
      cause,
    );
  }
}
