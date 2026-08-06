import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_INSTRUCTION_SCHEMA_VERSION,
  type AgentGoal,
  type GoalCommandIdentity,
  type GoalEvidence,
  type RuntimeInstructionDraft,
  createAgentGoal,
  reviseAgentGoal,
  transitionAgentGoal,
} from "@openloomi/ai/agent/runtime-instructions";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteAgentGoalState,
  SqliteDeliveryRepository,
  SqliteEvidenceRepository,
  SqliteGoalRepository,
  SqliteGoalRuntimeDatabase,
  SqliteInstructionRepository,
  SqliteRunRepository,
} from "@/lib/ai/runtime-instructions/persistence/sqlite";
import { persistedInstantIsStrictlyAfter } from "@/lib/ai/runtime-instructions/persistence/mapping";

const OWNER_A = "10000000-0000-4000-8000-000000000001";
const OWNER_B = "10000000-0000-4000-8000-000000000002";
const SESSION_A = "sqlite-runtime-a";
const SESSION_B = "sqlite-runtime-b";
const NOW = new Date("2026-08-05T08:00:00.000Z");
const MIGRATION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../lib/db/migrations-sqlite/0107_agent_goal_runtime.sql",
  ),
  "utf8",
);

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function uuid(value: number): string {
  return `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function command(
  idempotencyKey: string,
  fingerprintCharacter: string,
): GoalCommandIdentity {
  return {
    idempotencyKey,
    requestFingerprint: fingerprintCharacter.repeat(64),
  };
}

function goal(
  id = uuid(1),
  objective = "Persist the Goal atomically",
  now = NOW,
) {
  return createAgentGoal({
    id,
    now,
    input: {
      objective,
      successCriteria: [
        {
          id: "durable-result",
          description: "The durable result is recorded",
          verification: {
            type: "tool_result",
            toolName: "test",
            expectedOutcome: "passed",
          },
          required: true,
        },
      ],
      constraints: [],
      contextRefs: [],
      priority: 80,
      maxTurns: 8,
      completionPolicy: "tool_evidence",
      source: { type: "user" },
    },
  });
}

function activationDraft(
  activeGoal: AgentGoal,
  idempotencyKey: string,
  id = uuid(101),
  runtimeSessionId = SESSION_A,
): RuntimeInstructionDraft {
  return {
    schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
    id,
    goalId: activeGoal.id,
    goalRevision: activeGoal.revision,
    kind: "goal.activate",
    deliveryMode: "steer",
    targetSessionId: runtimeSessionId,
    payload: { goal: activeGoal },
    source: { type: "user", authority: "user" },
    idempotencyKey,
    issuedAt: activeGoal.updatedAt,
  };
}

function updateDraft(
  revisedGoal: AgentGoal,
  idempotencyKey: string,
  id: string,
): RuntimeInstructionDraft {
  return {
    schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
    id,
    goalId: revisedGoal.id,
    goalRevision: revisedGoal.revision,
    kind: "goal.update",
    deliveryMode: "steer",
    targetSessionId: SESSION_A,
    payload: { goal: revisedGoal, previousRevision: revisedGoal.revision - 1 },
    source: { type: "user", authority: "user" },
    idempotencyKey,
    issuedAt: revisedGoal.updatedAt,
  };
}

function createHarness() {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
  database.exec(MIGRATION);
  database
    .prepare('INSERT INTO "User" (id) VALUES (?), (?)')
    .run(OWNER_A, OWNER_B);
  database
    .prepare(
      "INSERT INTO agent_runtime_sessions (id, owner_id) VALUES (?, ?), (?, ?)",
    )
    .run(SESSION_A, OWNER_A, SESSION_B, OWNER_B);
  let nextId = 500;
  const runtimeDatabase = new SqliteGoalRuntimeDatabase(database);
  const state = new SqliteAgentGoalState(runtimeDatabase, {
    now: () => NOW,
    generateId: () => uuid(nextId++),
  });
  return { database, runtimeDatabase, state };
}

function activationInput(activeGoal = goal()) {
  const identity = command("activate-durable-goal", "a");
  return {
    ownerId: OWNER_A,
    runtimeSessionId: SESSION_A,
    goal: activeGoal,
    instruction: activationDraft(activeGoal, identity.idempotencyKey),
    command: identity,
  };
}

function count(database: Database.Database, table: string): number {
  return (
    database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

describe("SqliteAgentGoalState", () => {
  it("atomically activates once and returns the exact commit on retry", async () => {
    const { database, state } = createHarness();
    const activation = activationInput();
    const input = {
      ...activation,
      instruction: {
        ...activation.instruction,
        // SQLite stores both instants as the same whole second while the
        // immutable snapshot retains the protocol-valid millisecond ordering.
        expiresAt: "2026-08-05T08:00:00.500Z",
      },
    };
    const committed = await state.commitActivation(input);

    expect(committed).toMatchObject({
      deduplicated: false,
      instruction: {
        sequence: 1,
        expiresAt: "2026-08-05T08:00:00.500Z",
      },
    });
    expect(
      database.prepare("SELECT status FROM agent_goal_runs").get(),
    ).toEqual({ status: "queued" });
    expect(
      database.prepare("SELECT state FROM agent_runtime_deliveries").get(),
    ).toEqual({ state: "pending" });
    expect(() =>
      database
        .prepare(
          "UPDATE agent_runtime_instructions SET goal_revision = NULL WHERE id = ?",
        )
        .run(committed.instruction.id),
    ).toThrow();
    expect(
      database
        .prepare(
          "SELECT last_instruction_sequence AS sequence FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_A),
    ).toEqual({ sequence: 1 });

    const retried = await state.commitActivation(input);
    expect(retried).toEqual({ ...committed, deduplicated: true });
    expect([
      count(database, "agent_goals"),
      count(database, "agent_goal_runs"),
      count(database, "agent_runtime_instructions"),
      count(database, "agent_runtime_deliveries"),
    ]).toEqual([1, 1, 1, 1]);

    await expect(
      state.commitActivation({
        ...input,
        command: command(input.command.idempotencyKey, "b"),
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(state.listInstructions(OWNER_A, SESSION_A)).resolves.toEqual([
      committed.instruction,
    ]);
  });

  it("applies whole-second snapshot matching to SQLite persistence", async () => {
    expect(
      persistedInstantIsStrictlyAfter(
        new Date("2026-08-05T08:00:00.500Z"),
        new Date("2026-08-05T08:00:00.100Z"),
        "whole-second",
      ),
    ).toBe(false);

    const { runtimeDatabase, state } = createHarness();
    const preciseNow = new Date("2026-08-05T08:00:00.789Z");
    const preciseGoal = goal(
      uuid(3),
      "Preserve precise authoritative timestamps",
      preciseNow,
    );
    const input = activationInput(preciseGoal);
    const committed = await state.commitActivation(input);

    await expect(state.commitActivation(input)).resolves.toMatchObject({
      deduplicated: true,
    });
    await expect(state.getGoal(OWNER_A, preciseGoal.id)).resolves.toMatchObject(
      {
        goal: {
          createdAt: preciseNow.toISOString(),
          updatedAt: preciseNow.toISOString(),
        },
      },
    );

    await expect(
      new SqliteGoalRepository(runtimeDatabase).getById({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        goalId: preciseGoal.id,
      }),
    ).resolves.toMatchObject({
      goal: { createdAt: preciseNow.toISOString() },
    });
    await expect(
      new SqliteInstructionRepository(runtimeDatabase).getById({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        instructionId: committed.instruction.id,
      }),
    ).resolves.toMatchObject({ issuedAt: preciseNow.toISOString() });
  });

  it("enforces revision CAS, owner/session scope, and runEpoch fencing", async () => {
    const { database, runtimeDatabase, state } = createHarness();
    const input = activationInput();
    await state.commitActivation(input);
    const revised = reviseAgentGoal({
      current: input.goal,
      expectedRevision: 1,
      update: { objective: "Persist the revised Goal" },
      now: new Date("2026-08-05T08:00:00.500Z"),
    });
    const update = {
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      expectedRevision: 1,
      goal: revised,
      instruction: updateDraft(revised, "revise-durable-goal", uuid(102)),
      command: command("revise-durable-goal", "c"),
    };
    await expect(state.commitRevision(update)).resolves.toMatchObject({
      goal: { goal: { revision: 2 } },
      instruction: { sequence: 2 },
    });
    const dispatchable = await new SqliteDeliveryRepository(
      runtimeDatabase,
    ).listDispatchable({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      availableAt: "2026-08-05T08:00:01.000Z",
    });
    expect(dispatchable.map(({ instructionId }) => instructionId)).toEqual([
      input.instruction.id,
      update.instruction.id,
    ]);
    await expect(
      state.commitRevision({
        ...update,
        instruction: updateDraft(revised, "stale-revision", uuid(103)),
        command: command("stale-revision", "d"),
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    await expect(
      state.commitContinuation({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        goalId: revised.id,
        expectedRevision: 2,
        expectedRunEpoch: 1,
        instruction: {
          schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
          id: uuid(104),
          goalId: revised.id,
          goalRevision: 2,
          kind: "goal.continue",
          deliveryMode: "steer",
          targetSessionId: SESSION_A,
          payload: {
            missingCriteria: [
              {
                id: "durable-result",
                description: "The durable result is recorded",
              },
            ],
            reason: "Evidence is still missing",
            remainingBudget: { turns: 7 },
          },
          source: { type: "automation", authority: "automation" },
          idempotencyKey: "stale-epoch",
          issuedAt: revised.updatedAt,
        },
        command: command("stale-epoch", "e"),
      }),
    ).rejects.toMatchObject({ code: "run_epoch_conflict" });
    await expect(state.getGoal(OWNER_B, revised.id)).resolves.toBeNull();
    const isolatedGoal = goal(uuid(2));
    const isolatedCommand = command("cross-owner-session", "f");
    await expect(
      state.commitActivation({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_B,
        goal: isolatedGoal,
        instruction: activationDraft(
          isolatedGoal,
          isolatedCommand.idempotencyKey,
          uuid(105),
          SESSION_B,
        ),
        command: isolatedCommand,
      }),
    ).rejects.toMatchObject({ code: "invalid_commit" });
    expect(count(database, "agent_runtime_instructions")).toBe(2);
  });

  it("rolls the entire activation unit of work back after a late failure", async () => {
    const { database, state } = createHarness();
    database.exec(`
      CREATE TRIGGER reject_goal_instruction
      BEFORE INSERT ON agent_runtime_instructions
      BEGIN
        SELECT RAISE(ABORT, 'forced instruction failure');
      END
    `);

    await expect(
      state.commitActivation(activationInput()),
    ).rejects.toMatchObject({
      code: "invalid_commit",
    });
    expect([
      count(database, "agent_goals"),
      count(database, "agent_goal_runs"),
      count(database, "agent_runtime_instructions"),
      count(database, "agent_runtime_deliveries"),
    ]).toEqual([0, 0, 0, 0]);
    expect(
      database
        .prepare(
          "SELECT last_instruction_sequence AS sequence FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_A),
    ).toEqual({ sequence: 0 });
  });

  it("atomically completes the Goal, releases its slot, and completes its Run", async () => {
    const { database, runtimeDatabase, state } = createHarness();
    const input = activationInput();
    await state.commitActivation(input);
    const run = database.prepare("SELECT id FROM agent_goal_runs").get() as {
      id: string;
    };
    await new SqliteRunRepository(runtimeDatabase).transition({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      runId: run.id,
      expectedRunEpoch: 0,
      expectedStatus: "queued",
      nextStatus: "running",
      updatedAt: "2026-08-05T08:00:30.000Z",
    });
    const completed = transitionAgentGoal({
      current: input.goal,
      expectedRevision: 1,
      status: "completed",
      now: new Date("2026-08-05T08:01:00.000Z"),
    });

    await expect(
      state.commitEvaluationTransition({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        expectedRevision: 1,
        expectedRunEpoch: 0,
        goal: completed,
      }),
    ).resolves.toMatchObject({ goal: { goal: { status: "completed" } } });
    expect(
      database.prepare("SELECT status, slot_state FROM agent_goals").get(),
    ).toEqual({ status: "completed", slot_state: "released" });
    expect(
      database
        .prepare("SELECT status, goal_revision FROM agent_goal_runs")
        .get(),
    ).toEqual({ status: "completed", goal_revision: 2 });
    await expect(
      state.getActivePrimaryGoal(OWNER_A, SESSION_A),
    ).resolves.toBeNull();
  });

  it("persists a cancel barrier, advances its epoch, and replays every phase exactly", async () => {
    const { database, state } = createHarness();
    const active = goal();
    await state.commitActivation(activationInput(active));
    const cancelled = transitionAgentGoal({
      current: active,
      expectedRevision: 1,
      status: "cancelled",
      now: new Date("2026-08-05T08:01:00.000Z"),
    });
    const identity = command("cancel-durable-goal", "6");
    const input = {
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      action: "cancel" as const,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      goal: cancelled,
      instruction: {
        schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
        id: uuid(106),
        goalId: active.id,
        goalRevision: cancelled.revision,
        kind: "goal.cancel",
        deliveryMode: "interrupt_replace",
        targetSessionId: SESSION_A,
        payload: { reason: "Cancel safely", expectedRunEpoch: 0 },
        source: { type: "user", authority: "user" },
        idempotencyKey: identity.idempotencyKey,
        issuedAt: cancelled.updatedAt,
      } satisfies RuntimeInstructionDraft,
      command: identity,
    };
    const prepared = await state.prepareLifecycleTransition(input);
    await expect(state.prepareLifecycleTransition(input)).resolves.toEqual({
      ...prepared,
      deduplicated: true,
    });

    const boundaryInput = {
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      goalId: active.id,
      expectedRunEpoch: 0,
      nextRunEpoch: 1,
      command: identity,
    };
    const boundary = await state.markLifecycleTransitionBoundary(boundaryInput);
    await expect(
      state.markLifecycleTransitionBoundary(boundaryInput),
    ).resolves.toEqual({ ...boundary, deduplicated: true });
    const finalized = await state.finalizeLifecycleTransition(boundaryInput);
    await expect(
      state.finalizeLifecycleTransition(boundaryInput),
    ).resolves.toEqual({ ...finalized, deduplicated: true });

    expect(
      database.prepare("SELECT status FROM agent_goal_runs").get(),
    ).toEqual({ status: "cancelled" });
    expect(
      database
        .prepare(
          "SELECT run_epoch, pending_operation FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_A),
    ).toEqual({ run_epoch: 1, pending_operation: null });
    expect(
      database.prepare("SELECT slot_state FROM agent_goals").get(),
    ).toEqual({ slot_state: "released" });
  });

  it("persists a hidden replacement through its boundary and activates it in sequence", async () => {
    const { database, state } = createHarness();
    const active = goal();
    await state.commitActivation(activationInput(active));
    const superseded = transitionAgentGoal({
      current: active,
      expectedRevision: 1,
      status: "cancelled",
      now: new Date("2026-08-05T08:01:00.000Z"),
    });
    const replacement = goal(uuid(2), "Persist the replacement Goal");
    const identity = command("replace-durable-goal", "7");
    const prepared = await state.prepareReplacement({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      supersededGoal: superseded,
      replacementGoal: replacement,
      controlInstruction: {
        schemaVersion: RUNTIME_INSTRUCTION_SCHEMA_VERSION,
        id: uuid(107),
        goalId: active.id,
        goalRevision: superseded.revision,
        kind: "control.interrupt",
        deliveryMode: "interrupt_replace",
        targetSessionId: SESSION_A,
        payload: {
          reason: "Replace safely",
          expectedRunEpoch: 0,
          replacementGoalId: replacement.id,
        },
        source: { type: "user", authority: "user" },
        idempotencyKey: identity.idempotencyKey,
        issuedAt: superseded.updatedAt,
      },
      command: identity,
    });
    expect(prepared.replacement.phase).toBe("prepared");
    await expect(state.getGoal(OWNER_A, replacement.id)).resolves.toBeNull();

    await state.markReplacementBoundary({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      replacementGoalId: replacement.id,
      expectedRunEpoch: 0,
      nextRunEpoch: 1,
      command: identity,
    });
    await state.finalizeReplacement({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      replacementGoalId: replacement.id,
      activationInstruction: {
        ...activationDraft(replacement, identity.idempotencyKey, uuid(108)),
        issuedAt: "2026-08-05T08:02:00.000Z",
      },
      command: identity,
    });

    await expect(
      state.getActivePrimaryGoal(OWNER_A, SESSION_A),
    ).resolves.toMatchObject({ goal: { id: replacement.id } });
    expect(
      database
        .prepare(
          "SELECT run_epoch, pending_operation, last_instruction_sequence FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_A),
    ).toEqual({
      run_epoch: 1,
      pending_operation: null,
      last_instruction_sequence: 3,
    });
    expect(
      database
        .prepare(
          "SELECT run_epoch, status FROM agent_goal_runs ORDER BY run_epoch",
        )
        .all(),
    ).toEqual([
      { run_epoch: 0, status: "cancelled" },
      { run_epoch: 1, status: "queued" },
    ]);
    expect(
      (await state.listInstructions(OWNER_A, SESSION_A)).map(
        ({ sequence, kind }) => ({ sequence, kind }),
      ),
    ).toEqual([
      { sequence: 1, kind: "goal.activate" },
      { sequence: 2, kind: "control.interrupt" },
      { sequence: 3, kind: "goal.activate" },
    ]);
    expect(
      database
        .prepare(
          "SELECT state FROM agent_runtime_deliveries ORDER BY created_at, id",
        )
        .all(),
    ).toEqual([
      { state: "pending" },
      { state: "pending" },
      { state: "pending" },
    ]);
  });

  it("fences provider identity and stale writes at the authoritative Runtime Session", async () => {
    const { database, runtimeDatabase, state } = createHarness();
    const committed = await state.commitActivation(activationInput());
    const runs = new SqliteRunRepository(runtimeDatabase);
    const deliveries = new SqliteDeliveryRepository(runtimeDatabase);
    const evidence = new SqliteEvidenceRepository(runtimeDatabase);
    const run = await runs.findByGoalEpoch({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      goalId: committed.goal.goal.id,
      runEpoch: 0,
    });
    const pending = await deliveries.getActiveByInstruction({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      instructionId: committed.instruction.id,
    });
    if (!run || !pending) throw new Error("Activation persistence is missing");

    database
      .prepare(
        `UPDATE agent_runtime_sessions
         SET provider_session_id = ?
         WHERE owner_id = ? AND id = ?`,
      )
      .run("claude-session-a", OWNER_A, SESSION_A);
    await expect(
      runs.updateProgress({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        expectedTurnsUsed: 0,
        turnsUsed: 1,
        providerSessionId: "claude-session-a",
        updatedAt: "2026-08-05T08:00:10.000Z",
      }),
    ).resolves.toMatchObject({
      providerSessionId: "claude-session-a",
      turnsUsed: 1,
    });
    await expect(
      runs.updateProgress({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        expectedTurnsUsed: 1,
        turnsUsed: 2,
        providerSessionId: "claude-session-b",
        updatedAt: "2026-08-05T08:00:20.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      runs.updateProgress({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        providerSessionId: null as unknown as string,
        updatedAt: "2026-08-05T08:00:20.000Z",
      }),
    ).rejects.toThrow("providerSessionId must be a string");

    database
      .prepare(
        `UPDATE agent_runtime_sessions
         SET provider_session_id = ?
         WHERE owner_id = ? AND id = ?`,
      )
      .run("claude-session-b", OWNER_A, SESSION_A);
    await expect(
      runs.updateProgress({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        expectedTurnsUsed: 1,
        turnsUsed: 2,
        providerSessionId: "claude-session-b",
        updatedAt: "2026-08-05T08:00:20.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      runs.updateProgress({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        expectedTurnsUsed: 1,
        turnsUsed: 2,
        updatedAt: "2026-08-05T08:00:20.000Z",
      }),
    ).resolves.toBeNull();
    database
      .prepare(
        `UPDATE agent_runtime_sessions
         SET provider_session_id = ?
         WHERE owner_id = ? AND id = ?`,
      )
      .run("claude-session-a", OWNER_A, SESSION_A);
    await expect(
      runs.create({
        run: { ...run, id: uuid(209) },
        recordedAt: "2026-08-05T08:00:20.000Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const observed: GoalEvidence = {
      id: uuid(210),
      goalId: committed.goal.goal.id,
      goalRunId: run.id,
      goalRevision: 1,
      instructionId: committed.instruction.id,
      type: "tool_result",
      sourceEventId: "stale-provider-event",
      summary: "Recorded before the session boundary",
      success: true,
      payload: ["test"],
      observedAt: "2026-08-05T08:00:30.000Z",
    };
    const evidenceInput = {
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      runEpoch: 0,
      evidence: observed,
      recordedAt: observed.observedAt,
    };
    await expect(evidence.appendOnce(evidenceInput)).resolves.toMatchObject({
      deduplicated: false,
    });

    const advanced = database
      .prepare(
        `UPDATE agent_runtime_sessions
         SET run_epoch = 1
         WHERE owner_id = ? AND id = ? AND run_epoch = 0`,
      )
      .run(OWNER_A, SESSION_A);
    expect(advanced.changes).toBe(1);

    await expect(
      runs.transition({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        nextStatus: "running",
        updatedAt: "2026-08-05T08:01:00.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      runs.updateProgress({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: run.id,
        expectedRunEpoch: 0,
        expectedStatus: "queued",
        expectedTurnsUsed: 1,
        turnsUsed: 2,
        updatedAt: "2026-08-05T08:01:00.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      runs.create({
        run: { ...run, id: uuid(211) },
        recordedAt: "2026-08-05T08:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "run_epoch_conflict" });

    await expect(
      deliveries.transition({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        deliveryId: pending.id,
        expectedRunEpoch: 0,
        expectedState: "pending",
        nextState: "leased",
        updatedAt: "2026-08-05T08:01:00.000Z",
        lease: {
          token: "stale-lease",
          owner: "worker-1",
          expiresAt: "2026-08-05T08:02:00.000Z",
        },
      }),
    ).resolves.toBeNull();
    await expect(
      deliveries.createPending({
        id: uuid(212),
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        instructionId: committed.instruction.id,
        goalRunId: run.id,
        runEpoch: 0,
        attempt: 2,
        availableAt: "2026-08-05T08:01:00.000Z",
        recordedAt: "2026-08-05T08:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "run_epoch_conflict" });
    await expect(
      deliveries.listDispatchable({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        availableAt: "2026-08-05T08:03:00.000Z",
      }),
    ).resolves.toEqual([]);

    await expect(
      evidence.appendOnce({
        ...evidenceInput,
        evidence: { ...observed, id: uuid(213) },
      }),
    ).rejects.toMatchObject({ code: "run_epoch_conflict" });
    expect(
      database
        .prepare("SELECT status, turns_used FROM agent_goal_runs WHERE id = ?")
        .get(run.id),
    ).toEqual({ status: "queued", turns_used: 1 });
    expect(count(database, "agent_goal_evidence")).toBe(1);
  });

  it("rejects Run, Delivery, and Evidence records whose Goal relationships disagree", async () => {
    const { database, runtimeDatabase, state } = createHarness();
    const first = await state.commitActivation(activationInput());
    const runs = new SqliteRunRepository(runtimeDatabase);
    const deliveries = new SqliteDeliveryRepository(runtimeDatabase);
    const evidence = new SqliteEvidenceRepository(runtimeDatabase);
    const firstRun = await runs.findByGoalEpoch({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      goalId: first.goal.goal.id,
      runEpoch: 0,
    });
    if (!firstRun) throw new Error("First Goal Run is missing");
    await runs.transition({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      runId: firstRun.id,
      expectedRunEpoch: 0,
      expectedStatus: "queued",
      nextStatus: "running",
      updatedAt: "2026-08-05T08:00:30.000Z",
      lastActivityAt: "2026-08-05T08:00:30.000Z",
    });
    await expect(
      runs.transition({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runId: firstRun.id,
        expectedRunEpoch: 0,
        expectedStatus: "running",
        nextStatus: "completed",
        updatedAt: "2026-08-05T08:00:40.000Z",
        completedAt: "2026-08-05T08:00:20.000Z",
      }),
    ).resolves.toBeNull();
    const completedFirst = transitionAgentGoal({
      current: first.goal.goal,
      expectedRevision: 1,
      status: "completed",
      now: new Date("2026-08-05T08:01:00.000Z"),
    });
    await state.commitEvaluationTransition({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      goal: completedFirst,
    });

    const secondGoal = goal(uuid(220), "Persist a second Goal in this epoch");
    const secondCommand = command("activate-second-goal", "9");
    const second = await state.commitActivation({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      goal: secondGoal,
      instruction: activationDraft(
        secondGoal,
        secondCommand.idempotencyKey,
        uuid(221),
      ),
      command: secondCommand,
    });
    const secondRun = await runs.findByGoalEpoch({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      goalId: secondGoal.id,
      runEpoch: 0,
    });
    if (!secondRun) throw new Error("Second Goal Run is missing");

    const retry = {
      id: uuid(228),
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      instructionId: second.instruction.id,
      runEpoch: 0,
      attempt: 2,
      availableAt: "2026-08-05T08:01:30.000Z",
      recordedAt: "2026-08-05T08:01:30.000Z",
    };
    await expect(deliveries.createPending(retry)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      deliveries.createPending({ ...retry, goalRunId: firstRun.id }),
    ).rejects.toMatchObject({ code: "conflict" });

    const secondPending = await deliveries.getActiveByInstruction({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      instructionId: second.instruction.id,
    });
    if (!secondPending) throw new Error("Second pending Delivery is missing");
    database
      .prepare("DELETE FROM agent_runtime_deliveries WHERE id = ?")
      .run(secondPending.id);
    await expect(
      deliveries.createPending({
        ...retry,
        goalRunId: secondRun.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      deliveries.createPending({
        ...retry,
        id: uuid(229),
        goalRunId: secondRun.id,
        attempt: 3,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const recreatedPending = await deliveries.createPending({
      ...retry,
      id: secondPending.id,
      goalRunId: secondRun.id,
      attempt: 1,
    });
    await deliveries.transition({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      deliveryId: recreatedPending.id,
      expectedRunEpoch: 0,
      expectedState: "pending",
      nextState: "failed",
      updatedAt: "2026-08-05T08:01:30.000Z",
    });
    await expect(
      deliveries.createPending({
        ...retry,
        goalRunId: secondRun.id,
      }),
    ).resolves.toMatchObject({
      state: "pending",
      attempt: 2,
      instructionId: second.instruction.id,
      goalRunId: secondRun.id,
    });

    const valid: GoalEvidence = {
      id: uuid(222),
      goalId: secondGoal.id,
      goalRunId: secondRun.id,
      goalRevision: 1,
      instructionId: second.instruction.id,
      type: "tool_result",
      sourceEventId: "second-goal-event",
      summary: "Evidence belongs to the second Goal Run",
      success: true,
      payload: { tool: "test" },
      observedAt: "2026-08-05T08:02:00.000Z",
    };
    const append = (candidate: GoalEvidence) =>
      evidence.appendOnce({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runEpoch: 0,
        evidence: candidate,
        recordedAt: candidate.observedAt,
      });

    await expect(
      append({
        ...valid,
        id: uuid(223),
        goalId: first.goal.goal.id,
        instructionId: undefined,
        sourceEventId: "mismatched-goal",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      append({
        ...valid,
        id: uuid(224),
        instructionId: first.instruction.id,
        sourceEventId: "mismatched-instruction",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      append({
        ...valid,
        id: uuid(225),
        goalRevision: 2,
        instructionId: undefined,
        sourceEventId: "mismatched-revision",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(append(valid)).resolves.toMatchObject({
      deduplicated: false,
    });
    const revisedSecond = reviseAgentGoal({
      current: second.goal.goal,
      expectedRevision: 1,
      update: { objective: "Persist the revised second Goal" },
      now: new Date("2026-08-05T08:03:00.000Z"),
    });
    const revisionCommand = command("revise-second-goal", "8");
    await state.commitRevision({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      expectedRevision: 1,
      goal: revisedSecond,
      instruction: updateDraft(
        revisedSecond,
        revisionCommand.idempotencyKey,
        uuid(226),
      ),
      command: revisionCommand,
    });
    await expect(append({ ...valid, id: uuid(227) })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(count(database, "agent_goal_evidence")).toBe(1);

    database
      .prepare("DELETE FROM agent_goal_runs WHERE id = ?")
      .run(secondRun.id);
    await expect(
      runs.create({
        run: { ...secondRun, id: uuid(230) },
        recordedAt: "2026-08-05T08:04:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      runs.create({
        run: {
          ...secondRun,
          id: uuid(231),
          goalRevision: 2,
          status: "running",
        },
        recordedAt: "2026-08-05T08:04:00.000Z",
      }),
    ).rejects.toThrow("A new Goal Run must be queued");
    await expect(
      runs.create({
        run: { ...secondRun, id: uuid(231), goalRevision: 2 },
        recordedAt: "2026-08-05T08:04:00.000Z",
      }),
    ).resolves.toMatchObject({
      goalId: secondGoal.id,
      goalRevision: 2,
    });
    database
      .prepare("DELETE FROM agent_goal_runs WHERE id = ?")
      .run(firstRun.id);
    await expect(
      runs.create({
        run: {
          ...firstRun,
          id: uuid(232),
          goalRevision: completedFirst.revision,
        },
        recordedAt: "2026-08-05T08:04:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("fences Delivery transitions and deduplicates Evidence by source event", async () => {
    const { database, runtimeDatabase, state } = createHarness();
    const committed = await state.commitActivation(activationInput());
    const deliveries = new SqliteDeliveryRepository(runtimeDatabase);
    const evidence = new SqliteEvidenceRepository(runtimeDatabase);
    const pending = await deliveries.getActiveByInstruction({
      ownerId: OWNER_A,
      runtimeSessionId: SESSION_A,
      instructionId: committed.instruction.id,
    });
    expect(pending).toMatchObject({
      state: "pending",
      runEpoch: 0,
      availableAt: NOW.toISOString(),
    });

    const lease = {
      token: "lease-1",
      owner: "worker-1",
      expiresAt: "2026-08-05T08:02:00.000Z",
    };
    await expect(
      deliveries.transition({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        deliveryId: pending?.id ?? "missing",
        expectedRunEpoch: (pending?.runEpoch ?? 0) + 1,
        expectedState: "pending",
        nextState: "leased",
        updatedAt: "2026-08-05T08:01:00.000Z",
        lease,
      }),
    ).resolves.toBeNull();
    await expect(
      deliveries.transition({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        deliveryId: pending?.id ?? "missing",
        expectedRunEpoch: pending?.runEpoch ?? -1,
        expectedState: "pending",
        nextState: "leased",
        updatedAt: "2026-08-05T08:01:00.000Z",
        lease,
      }),
    ).resolves.toMatchObject({ state: "leased", leaseToken: "lease-1" });

    const run = database.prepare("SELECT id FROM agent_goal_runs").get() as {
      id: string;
    };
    const observed: GoalEvidence = {
      id: uuid(201),
      goalId: committed.goal.goal.id,
      goalRunId: run.id,
      goalRevision: 1,
      instructionId: committed.instruction.id,
      type: "tool_result",
      sourceEventId: "provider-event-1",
      summary: "The tool passed",
      success: true,
      payload: { tool: "test" },
      observedAt: "2026-08-05T08:01:00.000Z",
    };
    const append = (candidate: GoalEvidence) =>
      evidence.appendOnce({
        ownerId: OWNER_A,
        runtimeSessionId: SESSION_A,
        runEpoch: 0,
        evidence: candidate,
        recordedAt: candidate.observedAt,
      });
    await expect(append(observed)).resolves.toMatchObject({
      deduplicated: false,
    });
    await expect(
      append({
        ...observed,
        id: uuid(202),
        observedAt: "2026-08-05T08:01:00.999Z",
      }),
    ).resolves.toMatchObject({
      deduplicated: true,
      evidence: { id: observed.id },
    });

    await expect(
      append({ ...observed, id: uuid(203), summary: "Conflicting result" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
