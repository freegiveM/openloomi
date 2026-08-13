import { randomUUID } from "node:crypto";

import {
  type AgentGoal,
  type AgentGoalEvaluationStatePort,
  type AgentGoalLifecycleTransition,
  type AgentGoalReplacement,
  type AgentGoalRun,
  type AgentGoalStatePort,
  type GoalEvaluationResult,
  type GoalRunStatus,
  type GoalCommandIdentity,
  type GoalEvaluationTransitionCommit,
  type GoalInstructionCommit,
  type GoalLifecycleTransitionAction,
  type GoalLifecycleTransitionCommit,
  type GoalReplacementCommit,
  type PersistedAgentGoal,
  type RuntimeInstruction,
  type RuntimeInstructionDraft,
  GoalEvaluationResultSchema,
  canonicalJson,
} from "@openloomi/ai/agent/runtime-instructions";

import type { AgentGoalCommandCheckpoint } from "@/lib/db/agent-goal-runtime-schema-types";

import { AgentGoalStateError as DurableAgentGoalStateError } from "../../goal-state-error";
import {
  assertGoalActivationCommit,
  assertGoalContinuationCommit,
  assertGoalEvaluationTransition,
  assertGoalLifecyclePreparation,
  assertGoalReplacementActivation,
  assertGoalReplacementPreparation,
  assertGoalResumeCommit,
  assertGoalRevisionCommit,
  assertLifecycleEpochAdvance,
  assertReplacementEpochAdvance,
  goalOccupiesPrimarySlot,
  materializeGoalInstruction,
  parseGoalState,
  requireGoalStateIdentifier,
  requireNonNegativeGoalStateInteger,
  requirePositiveGoalStateInteger,
  validateGoalCommandIdentity,
  validateGoalStateScope,
  validateLifecycleTransitionAction,
} from "../../goal-state-validation";
import {
  goalInstructionCommitFromRoot,
  lifecycleTransitionFromRoot,
  replacementFromRoot,
} from "../checkpoints";
import { AgentGoalPersistenceError } from "../errors";
import {
  assertGoalRunMutationTransition as assertRunStatusTransition,
  goalRunStatusForEvaluation as evaluationRunStatus,
  isTerminalGoalRunStatus as isTerminalRunStatus,
  monotonicGoalRunActivity,
} from "../goal-run-state";
import type { StoredRuntimeInstruction } from "../goal-instruction-mappers";
import type { SqliteGoalRuntimeStore, SqliteGoalSessionRecord } from "./store";
import {
  resolveSqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabase,
  type SqliteGoalRuntimeDatabaseSource,
} from "./database";

export interface SqliteAgentGoalStateOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

/**
 * SQLite authoritative Goal state and transactional instruction outbox.
 *
 * Every mutation executes synchronously inside a native better-sqlite3
 * `BEGIN IMMEDIATE` transaction. Goal/session/run state, the exact historical
 * command checkpoint, the immutable instruction, and its initial pending
 * delivery therefore commit or roll back as one unit.
 */
export class SqliteAgentGoalState
  implements AgentGoalStatePort, AgentGoalEvaluationStatePort
{
  private readonly database: SqliteGoalRuntimeDatabase;
  private readonly storage: SqliteGoalRuntimeStore;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(
    source: SqliteGoalRuntimeDatabaseSource,
    options: SqliteAgentGoalStateOptions = {},
  ) {
    this.database = resolveSqliteGoalRuntimeDatabase(source);
    this.storage = this.database.store;
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
  }

  async getRuntimeSessionRunEpoch(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<number> {
    const scope = validateGoalStateScope(ownerId, runtimeSessionId);
    return (
      this.storage.getSession(scope.ownerId, scope.runtimeSessionId)
        ?.runEpoch ?? 0
    );
  }

  async getGoal(
    ownerId: string,
    goalId: string,
  ): Promise<PersistedAgentGoal | null> {
    const normalizedOwnerId = requireGoalStateIdentifier(ownerId, "ownerId");
    const normalizedGoalId = requireGoalStateIdentifier(goalId, "goalId");
    const stored = this.storage.getGoalForOwner(
      normalizedOwnerId,
      normalizedGoalId,
    );
    return stored && stored.slotState !== "reserved"
      ? clone(stored.persistedGoal)
      : null;
  }

  async getActivePrimaryGoal(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<PersistedAgentGoal | null> {
    const scope = validateGoalStateScope(ownerId, runtimeSessionId);
    const stored = this.storage.getAssignedPrimaryGoal(
      scope.ownerId,
      scope.runtimeSessionId,
    );
    return stored?.persistedGoal.goal.status === "active"
      ? clone(stored.persistedGoal)
      : null;
  }

  async listInstructions(
    ownerId: string,
    runtimeSessionId: string,
  ): Promise<RuntimeInstruction[]> {
    const scope = validateGoalStateScope(ownerId, runtimeSessionId);
    return clone(
      this.storage.listInstructions(scope.ownerId, scope.runtimeSessionId),
    );
  }

  async findCommitByIdempotency(input: {
    ownerId: string;
    runtimeSessionId: string;
    command: GoalCommandIdentity;
  }): Promise<GoalInstructionCommit | null> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const command = validateGoalCommandIdentity(input.command);
    const stored = this.storage.findCommand(
      scope.ownerId,
      scope.runtimeSessionId,
      command.idempotencyKey,
    );
    if (!stored) return null;
    assertCommandFingerprint(stored, command);
    if (stored.commandType !== "goal_instruction") {
      throwIdempotencyNamespaceConflict(command);
    }
    return goalInstructionCommitFromRoot(stored, scope, true);
  }

  async findReplacementByIdempotency(input: {
    ownerId: string;
    runtimeSessionId: string;
    command: GoalCommandIdentity;
  }): Promise<GoalReplacementCommit | null> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const command = validateGoalCommandIdentity(input.command);
    const stored = this.storage.findCommand(
      scope.ownerId,
      scope.runtimeSessionId,
      command.idempotencyKey,
    );
    if (!stored) return null;
    assertCommandFingerprint(stored, command);
    if (stored.commandType !== "replacement") {
      throwIdempotencyNamespaceConflict(command);
    }
    return {
      replacement: replacementFromRoot(stored, scope),
      deduplicated: true,
    };
  }

  async findLifecycleTransitionByIdempotency(input: {
    ownerId: string;
    runtimeSessionId: string;
    command: GoalCommandIdentity;
  }): Promise<GoalLifecycleTransitionCommit | null> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const command = validateGoalCommandIdentity(input.command);
    const stored = this.storage.findCommand(
      scope.ownerId,
      scope.runtimeSessionId,
      command.idempotencyKey,
    );
    if (!stored) return null;
    assertCommandFingerprint(stored, command);
    if (stored.commandType !== "lifecycle") {
      throwIdempotencyNamespaceConflict(command);
    }
    return {
      transition: lifecycleTransitionFromRoot(stored, scope),
      deduplicated: true,
    };
  }

  async commitActivation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goal: AgentGoal;
    instruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalInstructionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const command = validateGoalCommandIdentity(input.command);
    const goal = parseGoalState(input.goal);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const duplicate = this.findCommand(scope, command);
      if (duplicate) {
        if (duplicate.commandType !== "goal_instruction") {
          throwIdempotencyNamespaceConflict(command);
        }
        return goalInstructionCommitFromRoot(duplicate, scope, true);
      }
      assertNoPendingOperation(session);
      const existing = this.storage.getGoalForOwner(scope.ownerId, goal.id);
      if (existing) {
        throw new DurableAgentGoalStateError(
          "goal_conflict",
          `Goal ${goal.id} already exists in Runtime Session ${existing.persistedGoal.runtimeSessionId} for this owner`,
        );
      }
      const primary = this.storage.getAssignedPrimaryGoal(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      if (
        primary &&
        goalOccupiesPrimarySlot(primary.persistedGoal.goal.status)
      ) {
        throw new DurableAgentGoalStateError(
          "active_primary_goal_conflict",
          `Runtime Session ${scope.runtimeSessionId} already has primary Goal ${primary.persistedGoal.goal.id}`,
        );
      }

      const instruction = materializeGoalInstruction(
        input.instruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalActivationCommit(goal, instruction, scope.runtimeSessionId);
      const persisted = persistedGoal(scope, goal);
      const checkpoint = goalInstructionCheckpoint(persisted, instruction);
      const recordedAt = this.recordedAt();

      this.storage.insertGoal(persisted, "assigned");
      const runId = this.createQueuedRun(
        session,
        persisted,
        instruction.issuedAt,
        recordedAt,
      );
      this.commitInstruction({
        session,
        instruction,
        command,
        checkpoint,
        commandOrder: 0,
        commandType: "goal_instruction",
        commandPhase: "committed",
        goalRunId: runId,
        expectedPendingOperation: null,
        pendingOperation: null,
        runEpoch: session.runEpoch,
        recordedAt,
      });
      return {
        goal: clone(persisted),
        instruction: clone(instruction),
        deduplicated: false,
      };
    });
  }

  async commitRevision(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedRevision: number;
    goal: AgentGoal;
    instruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalInstructionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const command = validateGoalCommandIdentity(input.command);
    const goal = parseGoalState(input.goal);
    const expectedRevision = requirePositiveGoalStateInteger(
      input.expectedRevision,
      "expectedRevision",
    );

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const duplicate = this.findCommand(scope, command);
      if (duplicate) {
        if (duplicate.commandType !== "goal_instruction") {
          throwIdempotencyNamespaceConflict(command);
        }
        return goalInstructionCommitFromRoot(duplicate, scope, true);
      }
      assertNoPendingOperation(session);
      const current = this.requireGoal(scope, goal.id);
      assertAssignedActiveGoal(
        current,
        expectedRevision,
        scope.runtimeSessionId,
      );

      const instruction = materializeGoalInstruction(
        input.instruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalRevisionCommit(
        current.goal,
        goal,
        instruction,
        scope.runtimeSessionId,
        expectedRevision,
      );
      const revised = persistedGoal(scope, goal);
      const recordedAt = this.recordedAt();
      if (
        !this.storage.updateGoal(
          revised,
          expectedRevision,
          "assigned",
          "assigned",
        )
      ) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const run = this.requireRun(session, goal.id);
      this.updateRun(
        run,
        { goalRevision: goal.revision, lastEvaluation: null },
        recordedAt,
      );
      this.commitInstruction({
        session,
        instruction,
        command,
        checkpoint: goalInstructionCheckpoint(revised, instruction),
        commandOrder: 0,
        commandType: "goal_instruction",
        commandPhase: "committed",
        goalRunId: run.id,
        expectedPendingOperation: null,
        pendingOperation: null,
        runEpoch: session.runEpoch,
        recordedAt,
      });
      return {
        goal: clone(revised),
        instruction: clone(instruction),
        deduplicated: false,
      };
    });
  }

  async commitTransition(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedRevision: number;
    goal: AgentGoal;
    instruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalInstructionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const command = validateGoalCommandIdentity(input.command);
    const goal = parseGoalState(input.goal);
    const expectedRevision = requirePositiveGoalStateInteger(
      input.expectedRevision,
      "expectedRevision",
    );

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const duplicate = this.findCommand(scope, command);
      if (duplicate) {
        if (duplicate.commandType !== "goal_instruction") {
          throwIdempotencyNamespaceConflict(command);
        }
        return goalInstructionCommitFromRoot(duplicate, scope, true);
      }
      assertNoPendingOperation(session);
      const current = this.requireGoal(scope, goal.id);
      if (current.slotState !== "assigned") {
        throw invalidPrimaryGoal(goal.id, scope.runtimeSessionId);
      }
      if (current.goal.revision !== expectedRevision) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const instruction = materializeGoalInstruction(
        input.instruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalResumeCommit(
        current.goal,
        goal,
        instruction,
        scope.runtimeSessionId,
        expectedRevision,
      );
      const transitioned = persistedGoal(scope, goal);
      const recordedAt = this.recordedAt();
      if (
        !this.storage.updateGoal(
          transitioned,
          expectedRevision,
          "assigned",
          "assigned",
        )
      ) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const run = this.requireRun(session, goal.id);
      this.updateRun(
        run,
        {
          goalRevision: goal.revision,
          status: "running",
        },
        recordedAt,
      );
      this.commitInstruction({
        session,
        instruction,
        command,
        checkpoint: goalInstructionCheckpoint(transitioned, instruction),
        commandOrder: 0,
        commandType: "goal_instruction",
        commandPhase: "committed",
        goalRunId: run.id,
        expectedPendingOperation: null,
        pendingOperation: null,
        runEpoch: session.runEpoch,
        recordedAt,
      });
      return {
        goal: clone(transitioned),
        instruction: clone(instruction),
        deduplicated: false,
      };
    });
  }

  async commitContinuation(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    expectedRevision: number;
    expectedRunEpoch: number;
    instruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalInstructionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const goalId = requireGoalStateIdentifier(input.goalId, "goalId");
    const expectedRevision = requirePositiveGoalStateInteger(
      input.expectedRevision,
      "expectedRevision",
    );
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const duplicate = this.findCommand(scope, command);
      if (duplicate) {
        if (duplicate.commandType !== "goal_instruction") {
          throwIdempotencyNamespaceConflict(command);
        }
        return goalInstructionCommitFromRoot(duplicate, scope, true);
      }
      assertNoPendingOperation(session);
      assertRunEpoch(session, expectedRunEpoch);
      const current = this.requireGoal(scope, goalId);
      assertAssignedActiveGoal(
        current,
        expectedRevision,
        scope.runtimeSessionId,
      );
      const instruction = materializeGoalInstruction(
        input.instruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalContinuationCommit(
        current.goal,
        instruction,
        scope.runtimeSessionId,
        expectedRevision,
      );
      const checkpoint = goalInstructionCheckpoint(current, instruction);
      const recordedAt = this.recordedAt();
      const run = this.requireRun(session, goalId);
      this.commitInstruction({
        session,
        instruction,
        command,
        checkpoint,
        commandOrder: 0,
        commandType: "goal_instruction",
        commandPhase: "committed",
        goalRunId: run.id,
        expectedPendingOperation: null,
        pendingOperation: null,
        runEpoch: session.runEpoch,
        recordedAt,
      });
      return {
        goal: clone(current),
        instruction: clone(instruction),
        deduplicated: false,
      };
    });
  }

  async commitEvaluationTransition(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedRevision: number;
    expectedRunEpoch: number;
    goal: AgentGoal;
    evaluation?: GoalEvaluationResult;
    runtimeLeaseToken?: string;
  }): Promise<GoalEvaluationTransitionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const expectedRevision = requirePositiveGoalStateInteger(
      input.expectedRevision,
      "expectedRevision",
    );
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const goal = parseGoalState(input.goal);
    const evaluation =
      input.evaluation === undefined
        ? undefined
        : GoalEvaluationResultSchema.parse(input.evaluation);
    const runtimeLeaseToken =
      input.runtimeLeaseToken === undefined
        ? undefined
        : requireGoalStateIdentifier(
            input.runtimeLeaseToken,
            "runtimeLeaseToken",
          );

    return this.mutate(() => {
      const recordedAt = this.recordedAt();
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      if (
        runtimeLeaseToken !== undefined &&
        (session.recoveryLeaseToken !== runtimeLeaseToken ||
          session.recoveryLeaseExpiresAtSeconds === undefined ||
          session.recoveryLeaseExpiresAtSeconds <=
            Math.floor(Date.parse(recordedAt) / 1_000))
      ) {
        throw new DurableAgentGoalStateError(
          "invalid_commit",
          `Runtime Session ${scope.runtimeSessionId} recovery lease is no longer current`,
        );
      }
      assertNoPendingOperation(session);
      assertRunEpoch(session, expectedRunEpoch);
      const current = this.requireGoal(scope, goal.id);
      assertAssignedActiveGoal(
        current,
        expectedRevision,
        scope.runtimeSessionId,
      );
      assertGoalEvaluationTransition(current.goal, goal, expectedRevision);
      const transitioned = persistedGoal(scope, goal);
      const nextSlotState = goalOccupiesPrimarySlot(goal.status)
        ? "assigned"
        : "released";
      if (
        !this.storage.updateGoal(
          transitioned,
          expectedRevision,
          "assigned",
          nextSlotState,
        )
      ) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const run = this.requireRun(session, goal.id, expectedRunEpoch);
      const nextRunStatus = evaluationRunStatus(goal.status);
      this.updateRun(
        run,
        {
          goalRevision: goal.revision,
          status: nextRunStatus,
          terminal: isTerminalRunStatus(nextRunStatus),
          ...(evaluation === undefined ? {} : { lastEvaluation: evaluation }),
        },
        recordedAt,
      );
      return { goal: clone(transitioned) };
    });
  }

  async prepareLifecycleTransition(input: {
    ownerId: string;
    runtimeSessionId: string;
    action: GoalLifecycleTransitionAction;
    expectedRevision: number;
    expectedRunEpoch: number;
    goal: AgentGoal;
    instruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalLifecycleTransitionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const action = validateLifecycleTransitionAction(input.action);
    const expectedRevision = requirePositiveGoalStateInteger(
      input.expectedRevision,
      "expectedRevision",
    );
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const goal = parseGoalState(input.goal);
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const duplicate = this.findCommand(scope, command);
      if (duplicate) {
        if (duplicate.commandType !== "lifecycle") {
          throwIdempotencyNamespaceConflict(command);
        }
        return {
          transition: lifecycleTransitionFromRoot(duplicate, scope),
          deduplicated: true,
        };
      }
      assertNoPendingOperation(session);
      assertRunEpoch(session, expectedRunEpoch);
      const current = this.requireGoal(scope, goal.id);
      if (current.slotState !== "assigned") {
        throw invalidPrimaryGoal(goal.id, scope.runtimeSessionId);
      }
      if (current.goal.revision !== expectedRevision) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const instruction = materializeGoalInstruction(
        input.instruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalLifecyclePreparation(
        current.goal,
        goal,
        instruction,
        action,
        scope.runtimeSessionId,
        expectedRevision,
        expectedRunEpoch,
      );
      const transitionedGoal = persistedGoal(scope, goal);
      const transition: AgentGoalLifecycleTransition = {
        ownerId: scope.ownerId,
        runtimeSessionId: scope.runtimeSessionId,
        action,
        transitionedGoal,
        instruction,
        expectedRunEpoch,
        runEpoch: expectedRunEpoch,
        phase: "prepared",
      };
      const recordedAt = this.recordedAt();
      if (
        !this.storage.updateGoal(
          transitionedGoal,
          expectedRevision,
          "assigned",
          "assigned",
        )
      ) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const run = this.requireRun(session, goal.id, expectedRunEpoch);
      this.updateRun(
        run,
        {
          goalRevision: goal.revision,
          ...(action === "pause" ? { status: "paused" as const } : {}),
        },
        recordedAt,
      );
      this.commitInstruction({
        session,
        instruction,
        command,
        checkpoint: lifecycleCheckpoint(transition),
        commandOrder: 0,
        commandType: "lifecycle",
        commandPhase: "prepared",
        goalRunId: run.id,
        expectedPendingOperation: null,
        pendingOperation: transition,
        runEpoch: session.runEpoch,
        recordedAt,
      });
      return { transition: clone(transition), deduplicated: false };
    });
  }

  async markLifecycleTransitionBoundary(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    expectedRunEpoch: number;
    nextRunEpoch: number;
    command: GoalCommandIdentity;
  }): Promise<GoalLifecycleTransitionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const goalId = requireGoalStateIdentifier(input.goalId, "goalId");
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const nextRunEpoch = requireNonNegativeGoalStateInteger(
      input.nextRunEpoch,
      "nextRunEpoch",
    );
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const stored = this.requireCommand(scope, command, "lifecycle");
      const transition = lifecycleTransitionFromRoot(stored, scope);
      assertLifecycleIdentity(transition, goalId);
      assertLifecycleEpochAdvance(transition, expectedRunEpoch, nextRunEpoch);
      if (
        transition.phase === "boundary_observed" ||
        transition.phase === "finalized"
      ) {
        return { transition: clone(transition), deduplicated: true };
      }
      if (transition.action !== "cancel" || transition.phase !== "prepared") {
        throw new DurableAgentGoalStateError(
          "invalid_commit",
          "Only a prepared Goal cancel can record a Runtime Session terminal boundary",
        );
      }
      assertPendingOperation(session, transition, "lifecycle");
      assertRunEpoch(session, expectedRunEpoch);
      const updated: AgentGoalLifecycleTransition = {
        ...clone(transition),
        phase: "boundary_observed",
        runEpoch: nextRunEpoch,
      };
      const recordedAt = this.recordedAt();
      const run = this.requireRun(session, goalId, expectedRunEpoch);
      this.updateRun(run, { status: "cancelled", terminal: true }, recordedAt);
      this.updateBarrier({
        session,
        command,
        expectedPhase: "prepared",
        phase: "boundary_observed",
        checkpoint: lifecycleCheckpoint(updated),
        pendingOperation: updated,
        runEpoch: nextRunEpoch,
        recordedAt,
        commandType: "lifecycle",
      });
      return { transition: clone(updated), deduplicated: false };
    });
  }

  async finalizeLifecycleTransition(input: {
    ownerId: string;
    runtimeSessionId: string;
    goalId: string;
    expectedRunEpoch: number;
    nextRunEpoch: number;
    command: GoalCommandIdentity;
  }): Promise<GoalLifecycleTransitionCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const goalId = requireGoalStateIdentifier(input.goalId, "goalId");
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const nextRunEpoch = requireNonNegativeGoalStateInteger(
      input.nextRunEpoch,
      "nextRunEpoch",
    );
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const stored = this.requireCommand(scope, command, "lifecycle");
      const transition = lifecycleTransitionFromRoot(stored, scope);
      assertLifecycleIdentity(transition, goalId);
      assertLifecycleEpochAdvance(transition, expectedRunEpoch, nextRunEpoch);
      if (transition.phase === "finalized") {
        return { transition: clone(transition), deduplicated: true };
      }
      assertPendingOperation(session, transition, "lifecycle");
      if (
        (transition.action === "pause" && transition.phase !== "prepared") ||
        (transition.action === "cancel" &&
          transition.phase !== "boundary_observed")
      ) {
        throw new DurableAgentGoalStateError(
          "invalid_commit",
          transition.action === "cancel"
            ? "A Goal cancel must record its provider terminal boundary before finalization"
            : "A Goal pause can only finalize directly from its prepared state",
        );
      }
      const requiredEpoch =
        transition.action === "pause" ? expectedRunEpoch : nextRunEpoch;
      assertRunEpoch(session, requiredEpoch);
      const updated: AgentGoalLifecycleTransition = {
        ...clone(transition),
        phase: "finalized",
        runEpoch: nextRunEpoch,
      };
      const recordedAt = this.recordedAt();
      if (
        transition.action === "cancel" &&
        !this.storage.updateGoalSlotState({
          ownerId: scope.ownerId,
          runtimeSessionId: scope.runtimeSessionId,
          goalId,
          expectedSlotState: "assigned",
          slotState: "released",
        })
      ) {
        throw invalidPrimaryGoal(goalId, scope.runtimeSessionId);
      }
      this.updateBarrier({
        session,
        command,
        expectedPhase: transition.phase,
        phase: "finalized",
        checkpoint: lifecycleCheckpoint(updated),
        pendingOperation: null,
        runEpoch: nextRunEpoch,
        recordedAt,
        commandType: "lifecycle",
      });
      return { transition: clone(updated), deduplicated: false };
    });
  }

  async prepareReplacement(input: {
    ownerId: string;
    runtimeSessionId: string;
    expectedRevision: number;
    expectedRunEpoch: number;
    supersededGoal: AgentGoal;
    replacementGoal: AgentGoal;
    controlInstruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalReplacementCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const expectedRevision = requirePositiveGoalStateInteger(
      input.expectedRevision,
      "expectedRevision",
    );
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const supersededGoal = parseGoalState(input.supersededGoal);
    const replacementGoal = parseGoalState(input.replacementGoal);
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const duplicate = this.findCommand(scope, command);
      if (duplicate) {
        if (duplicate.commandType !== "replacement") {
          throwIdempotencyNamespaceConflict(command);
        }
        return {
          replacement: replacementFromRoot(duplicate, scope),
          deduplicated: true,
        };
      }
      assertNoPendingOperation(session);
      assertRunEpoch(session, expectedRunEpoch);
      const current = this.requireGoal(scope, supersededGoal.id);
      if (current.slotState !== "assigned") {
        throw invalidPrimaryGoal(supersededGoal.id, scope.runtimeSessionId);
      }
      if (current.goal.revision !== expectedRevision) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      const existingReplacement = this.storage.getGoalForOwner(
        scope.ownerId,
        replacementGoal.id,
      );
      if (existingReplacement) {
        throw new DurableAgentGoalStateError(
          "goal_conflict",
          `Goal ${replacementGoal.id} already exists in Runtime Session ${existingReplacement.persistedGoal.runtimeSessionId} for this owner`,
        );
      }
      const controlInstruction = materializeGoalInstruction(
        input.controlInstruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalReplacementPreparation(
        current.goal,
        supersededGoal,
        replacementGoal,
        controlInstruction,
        scope.runtimeSessionId,
        expectedRevision,
        expectedRunEpoch,
      );
      const superseded = persistedGoal(scope, supersededGoal);
      const replacementGoalState = persistedGoal(scope, replacementGoal);
      const replacement: AgentGoalReplacement = {
        ownerId: scope.ownerId,
        runtimeSessionId: scope.runtimeSessionId,
        supersededGoal: superseded,
        replacementGoal: replacementGoalState,
        controlInstruction,
        expectedRunEpoch,
        runEpoch: expectedRunEpoch,
        phase: "prepared",
      };
      const recordedAt = this.recordedAt();
      if (
        !this.storage.updateGoal(
          superseded,
          expectedRevision,
          "assigned",
          "assigned",
        )
      ) {
        throw revisionConflict(expectedRevision, current.goal.revision);
      }
      this.storage.insertGoal(replacementGoalState, "reserved");
      const run = this.requireRun(session, supersededGoal.id, expectedRunEpoch);
      this.updateRun(
        run,
        { goalRevision: supersededGoal.revision },
        recordedAt,
      );
      this.commitInstruction({
        session,
        instruction: controlInstruction,
        command,
        checkpoint: replacementCheckpoint(replacement),
        commandOrder: 0,
        commandType: "replacement",
        commandPhase: "prepared",
        goalRunId: run.id,
        expectedPendingOperation: null,
        pendingOperation: replacement,
        runEpoch: session.runEpoch,
        recordedAt,
      });
      return { replacement: clone(replacement), deduplicated: false };
    });
  }

  async markReplacementBoundary(input: {
    ownerId: string;
    runtimeSessionId: string;
    replacementGoalId: string;
    expectedRunEpoch: number;
    nextRunEpoch: number;
    command: GoalCommandIdentity;
  }): Promise<GoalReplacementCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const replacementGoalId = requireGoalStateIdentifier(
      input.replacementGoalId,
      "replacementGoalId",
    );
    const expectedRunEpoch = requireNonNegativeGoalStateInteger(
      input.expectedRunEpoch,
      "expectedRunEpoch",
    );
    const nextRunEpoch = requireNonNegativeGoalStateInteger(
      input.nextRunEpoch,
      "nextRunEpoch",
    );
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const stored = this.requireCommand(scope, command, "replacement");
      const replacement = replacementFromRoot(stored, scope);
      assertReplacementIdentity(replacement, replacementGoalId);
      assertReplacementEpochAdvance(
        replacement,
        expectedRunEpoch,
        nextRunEpoch,
      );
      if (replacement.phase !== "prepared") {
        return { replacement: clone(replacement), deduplicated: true };
      }
      assertPendingOperation(session, replacement, "replacement");
      assertRunEpoch(session, expectedRunEpoch);
      const updated: AgentGoalReplacement = {
        ...clone(replacement),
        phase: "boundary_observed",
        runEpoch: nextRunEpoch,
      };
      const recordedAt = this.recordedAt();
      const run = this.requireRun(
        session,
        replacement.supersededGoal.goal.id,
        expectedRunEpoch,
      );
      this.updateRun(run, { status: "cancelled", terminal: true }, recordedAt);
      this.updateBarrier({
        session,
        command,
        expectedPhase: "prepared",
        phase: "boundary_observed",
        checkpoint: replacementCheckpoint(updated),
        pendingOperation: updated,
        runEpoch: nextRunEpoch,
        recordedAt,
        commandType: "replacement",
      });
      return { replacement: clone(updated), deduplicated: false };
    });
  }

  async finalizeReplacement(input: {
    ownerId: string;
    runtimeSessionId: string;
    replacementGoalId: string;
    activationInstruction: RuntimeInstructionDraft;
    command: GoalCommandIdentity;
  }): Promise<GoalReplacementCommit> {
    const scope = validateGoalStateScope(input.ownerId, input.runtimeSessionId);
    const replacementGoalId = requireGoalStateIdentifier(
      input.replacementGoalId,
      "replacementGoalId",
    );
    const command = validateGoalCommandIdentity(input.command);

    return this.mutate(() => {
      const session = this.requireSession(
        scope.ownerId,
        scope.runtimeSessionId,
      );
      const stored = this.requireCommand(scope, command, "replacement");
      const replacement = replacementFromRoot(stored, scope);
      assertReplacementIdentity(replacement, replacementGoalId);
      if (replacement.phase === "activated") {
        return { replacement: clone(replacement), deduplicated: true };
      }
      if (replacement.phase !== "boundary_observed") {
        throw new DurableAgentGoalStateError(
          "invalid_commit",
          "A replacement cannot activate before its Runtime Session boundary is observed",
        );
      }
      assertPendingOperation(session, replacement, "replacement");
      assertRunEpoch(session, replacement.runEpoch);
      const activationInstruction = materializeGoalInstruction(
        input.activationInstruction,
        command,
        session.lastInstructionSequence + 1,
      );
      assertGoalReplacementActivation(
        replacement,
        activationInstruction,
        scope.runtimeSessionId,
      );
      const updated: AgentGoalReplacement = {
        ...clone(replacement),
        phase: "activated",
        activationInstruction,
      };
      const recordedAt = this.recordedAt();

      if (
        !this.storage.updateGoalSlotState({
          ownerId: scope.ownerId,
          runtimeSessionId: scope.runtimeSessionId,
          goalId: replacement.supersededGoal.goal.id,
          expectedSlotState: "assigned",
          slotState: "released",
        })
      ) {
        throw invalidPrimaryGoal(
          replacement.supersededGoal.goal.id,
          scope.runtimeSessionId,
        );
      }
      if (
        !this.storage.updateGoalSlotState({
          ownerId: scope.ownerId,
          runtimeSessionId: scope.runtimeSessionId,
          goalId: replacementGoalId,
          expectedSlotState: "reserved",
          slotState: "assigned",
        })
      ) {
        throw new DurableAgentGoalStateError(
          "replacement_not_found",
          `Replacement Goal ${replacementGoalId} is not the pending primary reservation`,
        );
      }
      const runId = this.createQueuedRun(
        session,
        replacement.replacementGoal,
        activationInstruction.issuedAt,
        recordedAt,
      );
      this.updateBarrier({
        session,
        command,
        expectedPhase: "boundary_observed",
        phase: "activated",
        checkpoint: replacementCheckpoint(updated),
        pendingOperation: null,
        runEpoch: session.runEpoch,
        recordedAt,
        commandType: "replacement",
        nextInstruction: {
          instruction: activationInstruction,
          commandOrder: 1,
          goalRunId: runId,
        },
      });
      return { replacement: clone(updated), deduplicated: false };
    });
  }

  private mutate<T>(work: () => T): T {
    try {
      return this.database.immediate(() => work());
    } catch (cause) {
      if (
        cause instanceof DurableAgentGoalStateError ||
        cause instanceof AgentGoalPersistenceError
      ) {
        throw cause;
      }
      throw mapSqliteMutationError(cause);
    }
  }

  private requireSession(
    ownerId: string,
    runtimeSessionId: string,
  ): SqliteGoalSessionRecord {
    const session = this.storage.getSession(ownerId, runtimeSessionId);
    if (!session) {
      throw new DurableAgentGoalStateError(
        "invalid_commit",
        `Runtime Session ${runtimeSessionId} does not exist for this owner`,
      );
    }
    return session;
  }

  private requireGoal(
    scope: { ownerId: string; runtimeSessionId: string },
    goalId: string,
  ): PersistedAgentGoal & { slotState: "assigned" | "reserved" | "released" } {
    const stored = this.storage.getGoal(
      scope.ownerId,
      scope.runtimeSessionId,
      goalId,
    );
    if (!stored) {
      throw new DurableAgentGoalStateError(
        "goal_not_found",
        `Goal ${goalId} does not exist in Runtime Session ${scope.runtimeSessionId}`,
      );
    }
    return { ...stored.persistedGoal, slotState: stored.slotState };
  }

  private findCommand(
    scope: { ownerId: string; runtimeSessionId: string },
    command: GoalCommandIdentity,
  ): StoredRuntimeInstruction | null {
    const stored = this.storage.findCommand(
      scope.ownerId,
      scope.runtimeSessionId,
      command.idempotencyKey,
    );
    if (stored) assertCommandFingerprint(stored, command);
    return stored;
  }

  private requireCommand(
    scope: { ownerId: string; runtimeSessionId: string },
    command: GoalCommandIdentity,
    type: "lifecycle" | "replacement",
  ): StoredRuntimeInstruction {
    const stored = this.findCommand(scope, command);
    if (!stored) {
      throw new DurableAgentGoalStateError(
        type === "lifecycle"
          ? "lifecycle_transition_not_found"
          : "replacement_not_found",
        type === "lifecycle"
          ? `No Goal lifecycle transition exists for idempotency key ${command.idempotencyKey}`
          : `No Goal replacement exists for idempotency key ${command.idempotencyKey}`,
      );
    }
    if (stored.commandType !== type) throwIdempotencyNamespaceConflict(command);
    return stored;
  }

  private requireRun(
    session: SqliteGoalSessionRecord,
    goalId: string,
    runEpoch = session.runEpoch,
  ): AgentGoalRun {
    const run = this.storage.findRun(
      session.ownerId,
      session.runtimeSessionId,
      goalId,
      runEpoch,
    );
    if (!run) {
      throw new DurableAgentGoalStateError(
        "invalid_commit",
        `Goal ${goalId} has no durable Run for Runtime Session epoch ${runEpoch}`,
      );
    }
    return run;
  }

  private updateRun(
    run: AgentGoalRun,
    input: {
      goalRevision?: number;
      status?: GoalRunStatus;
      terminal?: boolean;
      lastEvaluation?: GoalEvaluationResult | null;
    },
    recordedAt: string,
  ): AgentGoalRun {
    const status = input.status ?? run.status;
    if (status !== run.status) assertRunStatusTransition(run.status, status);
    const lastActivityAt = monotonicGoalRunActivity(
      run,
      recordedAt,
    ).toISOString();
    const next: AgentGoalRun = {
      ...run,
      goalRevision: input.goalRevision ?? run.goalRevision,
      status,
      lastActivityAt,
      ...(input.terminal ? { completedAt: lastActivityAt } : {}),
      ...(input.lastEvaluation === undefined
        ? {}
        : {
            lastEvaluation:
              input.lastEvaluation === null ? undefined : input.lastEvaluation,
          }),
    };
    if (!this.storage.updateRun(run, next, recordedAt)) {
      throw new DurableAgentGoalStateError(
        "invalid_commit",
        `Goal Run ${run.id} changed during its authoritative Goal mutation`,
      );
    }
    return next;
  }

  private createQueuedRun(
    session: SqliteGoalSessionRecord,
    goal: PersistedAgentGoal,
    startedAt: string,
    recordedAt: string,
  ): string {
    const existing = this.storage.findRun(
      session.ownerId,
      session.runtimeSessionId,
      goal.goal.id,
      session.runEpoch,
    );
    if (existing) {
      throw new DurableAgentGoalStateError(
        "invalid_commit",
        `Goal ${goal.goal.id} already has a durable Run for Runtime Session epoch ${session.runEpoch}`,
      );
    }
    const id = this.generateId();
    this.storage.insertRun(
      {
        id,
        ownerId: session.ownerId,
        goalId: goal.goal.id,
        goalRevision: goal.goal.revision,
        runtimeSessionId: session.runtimeSessionId,
        ...(session.providerSessionId === undefined
          ? {}
          : { providerSessionId: session.providerSessionId }),
        runEpoch: session.runEpoch,
        status: "queued",
        turnsUsed: 0,
        tokensUsed: 0,
        startedAt,
        lastActivityAt: startedAt,
      },
      recordedAt,
    );
    return id;
  }

  private commitInstruction(input: {
    session: SqliteGoalSessionRecord;
    instruction: RuntimeInstruction;
    command: GoalCommandIdentity;
    checkpoint: AgentGoalCommandCheckpoint;
    commandOrder: number;
    commandType: "goal_instruction" | "lifecycle" | "replacement";
    commandPhase: "committed" | "prepared";
    goalRunId?: string;
    expectedPendingOperation:
      | AgentGoalLifecycleTransition
      | AgentGoalReplacement
      | null;
    pendingOperation:
      | AgentGoalLifecycleTransition
      | AgentGoalReplacement
      | null;
    runEpoch: number;
    recordedAt: string;
  }): void {
    if (this.storage.findInstructionId(input.instruction.id)) {
      throw new DurableAgentGoalStateError(
        "idempotency_conflict",
        `Instruction ID ${input.instruction.id} is already present in the outbox`,
      );
    }
    const nextSequence = input.instruction.sequence;
    if (
      nextSequence !== input.session.lastInstructionSequence + 1 ||
      !this.storage.updateSession({
        ownerId: input.session.ownerId,
        runtimeSessionId: input.session.runtimeSessionId,
        expectedRunEpoch: input.session.runEpoch,
        expectedInstructionSequence: input.session.lastInstructionSequence,
        expectedPendingOperation: input.expectedPendingOperation,
        runEpoch: input.runEpoch,
        instructionSequence: nextSequence,
        pendingOperation: input.pendingOperation,
        updatedAtSeconds: sessionTimestamp(input.session, input.recordedAt),
      })
    ) {
      throw new DurableAgentGoalStateError(
        "run_epoch_conflict",
        `Runtime Session ${input.session.runtimeSessionId} changed while committing its instruction outbox`,
      );
    }
    this.storage.insertInstructionAndPendingDelivery({
      ownerId: input.session.ownerId,
      runtimeSessionId: input.session.runtimeSessionId,
      runEpoch: input.runEpoch,
      instruction: input.instruction,
      requestFingerprint: input.command.requestFingerprint,
      commandOrder: input.commandOrder,
      commandType: input.commandType,
      commandPhase: input.commandPhase,
      commandCheckpoint: input.checkpoint,
      ...(input.goalRunId === undefined ? {} : { goalRunId: input.goalRunId }),
      deliveryId: this.generateId(),
      recordedAt: input.recordedAt,
    });
  }

  private updateBarrier(input: {
    session: SqliteGoalSessionRecord;
    command: GoalCommandIdentity;
    expectedPhase: "prepared" | "boundary_observed";
    phase: "boundary_observed" | "finalized" | "activated";
    checkpoint: AgentGoalCommandCheckpoint;
    pendingOperation:
      | AgentGoalLifecycleTransition
      | AgentGoalReplacement
      | null;
    runEpoch: number;
    recordedAt: string;
    commandType: "lifecycle" | "replacement";
    nextInstruction?: {
      instruction: RuntimeInstruction;
      commandOrder: number;
      goalRunId?: string;
    };
  }): void {
    const nextSequence = input.nextInstruction
      ? input.nextInstruction.instruction.sequence
      : input.session.lastInstructionSequence;
    if (
      input.nextInstruction &&
      this.storage.findInstructionId(input.nextInstruction.instruction.id)
    ) {
      throw new DurableAgentGoalStateError(
        "idempotency_conflict",
        `Instruction ID ${input.nextInstruction.instruction.id} is already present in the outbox`,
      );
    }
    if (
      !this.storage.updateSession({
        ownerId: input.session.ownerId,
        runtimeSessionId: input.session.runtimeSessionId,
        expectedRunEpoch: input.session.runEpoch,
        expectedInstructionSequence: input.session.lastInstructionSequence,
        expectedPendingOperation: requirePendingOperation(input.session),
        runEpoch: input.runEpoch,
        instructionSequence: nextSequence,
        pendingOperation: input.pendingOperation,
        updatedAtSeconds: sessionTimestamp(input.session, input.recordedAt),
      })
    ) {
      throw new DurableAgentGoalStateError(
        "run_epoch_conflict",
        `Runtime Session ${input.session.runtimeSessionId} changed during its Goal control barrier`,
      );
    }
    if (
      !this.storage.updateCommandCheckpoint({
        ownerId: input.session.ownerId,
        runtimeSessionId: input.session.runtimeSessionId,
        idempotencyKey: input.command.idempotencyKey,
        requestFingerprint: input.command.requestFingerprint,
        commandType: input.commandType,
        expectedPhase: input.expectedPhase,
        phase: input.phase,
        checkpoint: input.checkpoint,
        updatedAt: input.recordedAt,
      })
    ) {
      throw new DurableAgentGoalStateError(
        "invalid_commit",
        `Goal ${input.commandType} checkpoint changed during its control barrier`,
      );
    }
    if (input.nextInstruction) {
      this.storage.insertInstructionAndPendingDelivery({
        ownerId: input.session.ownerId,
        runtimeSessionId: input.session.runtimeSessionId,
        runEpoch: input.runEpoch,
        instruction: input.nextInstruction.instruction,
        requestFingerprint: input.command.requestFingerprint,
        commandOrder: input.nextInstruction.commandOrder,
        ...(input.nextInstruction.goalRunId === undefined
          ? {}
          : { goalRunId: input.nextInstruction.goalRunId }),
        deliveryId: this.generateId(),
        recordedAt: input.recordedAt,
      });
    }
  }

  private recordedAt(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new DurableAgentGoalStateError(
        "invalid_commit",
        "Goal persistence clock returned an invalid Date",
      );
    }
    return value.toISOString();
  }
}

function persistedGoal(
  scope: { ownerId: string; runtimeSessionId: string },
  goal: AgentGoal,
): PersistedAgentGoal {
  return {
    ownerId: scope.ownerId,
    runtimeSessionId: scope.runtimeSessionId,
    slot: "primary",
    goal,
  };
}

function goalInstructionCheckpoint(
  goal: PersistedAgentGoal,
  instruction: RuntimeInstruction,
): AgentGoalCommandCheckpoint {
  return { type: "goal_instruction", goal, instruction };
}

function lifecycleCheckpoint(
  transition: AgentGoalLifecycleTransition,
): AgentGoalCommandCheckpoint {
  return { type: "lifecycle", transition };
}

function replacementCheckpoint(
  replacement: AgentGoalReplacement,
): AgentGoalCommandCheckpoint {
  return { type: "replacement", replacement };
}

function assertCommandFingerprint(
  stored: StoredRuntimeInstruction,
  command: GoalCommandIdentity,
): void {
  if (stored.requestFingerprint !== command.requestFingerprint) {
    throw new DurableAgentGoalStateError(
      "idempotency_conflict",
      `Idempotency key ${command.idempotencyKey} was already used for a different Goal command`,
    );
  }
}

function throwIdempotencyNamespaceConflict(
  command: GoalCommandIdentity,
): never {
  throw new DurableAgentGoalStateError(
    "idempotency_conflict",
    `Idempotency key ${command.idempotencyKey} was already used by another Runtime Goal command`,
  );
}

function assertNoPendingOperation(session: SqliteGoalSessionRecord): void {
  if (!session.pendingOperation) return;
  if (isLifecycleTransition(session.pendingOperation)) {
    throw new DurableAgentGoalStateError(
      "lifecycle_transition_in_progress",
      `Runtime Session ${session.runtimeSessionId} is finalizing ${session.pendingOperation.action} for Goal ${session.pendingOperation.transitionedGoal.goal.id}`,
    );
  }
  throw new DurableAgentGoalStateError(
    "replacement_in_progress",
    `Runtime Session ${session.runtimeSessionId} is reserving replacement Goal ${session.pendingOperation.replacementGoal.goal.id}`,
  );
}

function assertPendingOperation(
  session: SqliteGoalSessionRecord,
  expected: AgentGoalLifecycleTransition | AgentGoalReplacement,
  type: "lifecycle" | "replacement",
): void {
  if (
    !session.pendingOperation ||
    canonicalJson(session.pendingOperation) !== canonicalJson(expected)
  ) {
    throw new DurableAgentGoalStateError(
      type === "lifecycle"
        ? "lifecycle_transition_not_found"
        : "replacement_not_found",
      type === "lifecycle"
        ? `Lifecycle transition for Goal ${(expected as AgentGoalLifecycleTransition).transitionedGoal.goal.id} is not the pending primary reservation`
        : `Replacement Goal ${(expected as AgentGoalReplacement).replacementGoal.goal.id} is not the pending primary reservation`,
    );
  }
}

function requirePendingOperation(
  session: SqliteGoalSessionRecord,
): AgentGoalLifecycleTransition | AgentGoalReplacement {
  if (!session.pendingOperation) {
    throw new DurableAgentGoalStateError(
      "invalid_commit",
      `Runtime Session ${session.runtimeSessionId} has no pending Goal control barrier`,
    );
  }
  return session.pendingOperation;
}

function isLifecycleTransition(
  operation: AgentGoalLifecycleTransition | AgentGoalReplacement,
): operation is AgentGoalLifecycleTransition {
  return "action" in operation;
}

function assertAssignedActiveGoal(
  goal: PersistedAgentGoal & { slotState: string },
  expectedRevision: number,
  runtimeSessionId: string,
): void {
  if (goal.slotState !== "assigned" || goal.goal.status !== "active") {
    throw invalidPrimaryGoal(goal.goal.id, runtimeSessionId);
  }
  if (goal.goal.revision !== expectedRevision) {
    throw revisionConflict(expectedRevision, goal.goal.revision);
  }
}

function invalidPrimaryGoal(
  goalId: string,
  runtimeSessionId: string,
): DurableAgentGoalStateError {
  return new DurableAgentGoalStateError(
    "invalid_commit",
    `Goal ${goalId} is not the active primary Goal for Runtime Session ${runtimeSessionId}`,
  );
}

function revisionConflict(
  expected: number,
  actual: number,
): DurableAgentGoalStateError {
  return new DurableAgentGoalStateError(
    "revision_conflict",
    `Expected Goal revision ${expected}, received ${actual}`,
  );
}

function assertRunEpoch(
  session: SqliteGoalSessionRecord,
  expectedRunEpoch: number,
): void {
  if (session.runEpoch !== expectedRunEpoch) {
    throw new DurableAgentGoalStateError(
      "run_epoch_conflict",
      `Expected Runtime Session epoch ${expectedRunEpoch}, received ${session.runEpoch}`,
    );
  }
}

function assertLifecycleIdentity(
  transition: AgentGoalLifecycleTransition,
  goalId: string,
): void {
  if (transition.transitionedGoal.goal.id !== goalId) {
    throw new DurableAgentGoalStateError(
      "lifecycle_transition_not_found",
      `Goal ${goalId} does not match the stored lifecycle transition`,
    );
  }
}

function assertReplacementIdentity(
  replacement: AgentGoalReplacement,
  replacementGoalId: string,
): void {
  if (replacement.replacementGoal.goal.id !== replacementGoalId) {
    throw new DurableAgentGoalStateError(
      "replacement_not_found",
      `Replacement Goal ${replacementGoalId} does not match the stored replacement`,
    );
  }
}

function sessionTimestamp(
  session: SqliteGoalSessionRecord,
  recordedAt: string,
): number {
  return Math.max(
    session.createdAtSeconds,
    session.updatedAtSeconds,
    Math.floor(Date.parse(recordedAt) / 1000),
  );
}

function mapSqliteMutationError(cause: unknown): DurableAgentGoalStateError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    message.includes("agent_goals_assigned_primary_idx") ||
    message.includes("agent_goals.owner_id, agent_goals.runtime_session_id")
  ) {
    return new DurableAgentGoalStateError(
      "active_primary_goal_conflict",
      "Runtime Session already has an assigned primary Goal",
      cause,
    );
  }
  if (
    message.includes("agent_runtime_instructions_idempotency_key") ||
    message.includes("agent_runtime_instructions.id")
  ) {
    return new DurableAgentGoalStateError(
      "idempotency_conflict",
      "Runtime Goal command or instruction identity already exists",
      cause,
    );
  }
  if (message.includes("agent_goals.id")) {
    return new DurableAgentGoalStateError(
      "goal_conflict",
      "Goal identity already exists",
      cause,
    );
  }
  return new DurableAgentGoalStateError(
    "invalid_commit",
    "SQLite could not atomically commit the Runtime Goal mutation",
    cause,
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
