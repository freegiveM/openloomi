import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transitionAgentGoal } from "@openloomi/ai/agent/runtime-instructions";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteAgentGoalRuntime } from "@/lib/ai/runtime-instructions/runtime";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "sqlite-runtime-wiring";
const START = new Date("2026-08-06T08:00:00.000Z");
const MIGRATIONS = [
  "0107_agent_goal_runtime.sql",
  "0108_agent_goal_runtime_recovery.sql",
].map((migration) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../lib/db/migrations-sqlite",
      migration,
    ),
    "utf8",
  ),
);

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function harness() {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec('CREATE TABLE "User" ("id" text PRIMARY KEY NOT NULL)');
  for (const migration of MIGRATIONS) database.exec(migration);
  database.prepare('INSERT INTO "User" (id) VALUES (?)').run(OWNER_ID);
  let now = START;
  let nextId = 1;
  const runtime = createSqliteAgentGoalRuntime(database, {
    clock: { now: () => now },
    idGenerator: { generate: () => uuid(nextId++) },
    observationIdGenerator: { generate: () => uuid(nextId++) },
  });
  return {
    database,
    runtime,
    advance(seconds: number) {
      now = new Date(now.getTime() + seconds * 1_000);
      return now.toISOString();
    },
  };
}

function goalInput() {
  return {
    objective: "Finish the durable Claude Goal",
    successCriteria: [
      {
        id: "tests-pass",
        description: "The focused test passes",
        verification: {
          type: "tool_result" as const,
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
    completionPolicy: "tool_evidence" as const,
    source: { type: "user" as const },
  };
}

describe("SQLite Agent Goal runtime composition", () => {
  it("records a paused evaluation on the atomically paused Goal Run", async () => {
    const { runtime, advance } = harness();
    await runtime.runtimeSessions.ensure(OWNER_ID, SESSION_ID);
    const liveLease = await runtime.runtimeSessions.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: "sqlite-paused-evaluation-test",
    });
    if (!liveLease) throw new Error("Expected a live Runtime lease");
    const observationLease = runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseToken: liveLease.leaseToken,
    });
    const activation = await runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      idempotencyKey: "activate-paused-evaluation",
      source: { type: "user", authority: "user" },
      goal: goalInput(),
    });
    const evaluationKey = "stop:paused";
    expect(
      await runtime.observations.beginGoalEvaluation({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
        goalRevision: 1,
        runEpoch: 0,
        evaluationKey,
        recordedAt: advance(1),
      }),
    ).not.toBeNull();
    const evaluation = {
      completed: false,
      confidence: 0,
      satisfiedCriteria: [],
      missingCriteria: ["tests-pass"],
      evidence: [],
      reason: "Goal evaluation failed and requires a retry.",
    };
    await runtime.state.commitEvaluationTransition({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      runtimeLeaseToken: liveLease.leaseToken,
      evaluation,
      goal: transitionAgentGoal({
        current: activation.goal.goal,
        expectedRevision: 1,
        status: "paused",
        now: new Date(advance(1)),
      }),
    });
    await expect(
      runtime.queries.getById({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
      }),
    ).resolves.toMatchObject({
      goal: { goal: { status: "paused", revision: 2 } },
      latestRun: { status: "paused", lastEvaluation: evaluation },
      progress: { completedCriteria: 0, totalCriteria: 1 },
    });
    expect(
      await runtime.observations.finishGoalEvaluation({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
        goalRevision: 1,
        runEpoch: 0,
        evaluationKey,
        evaluation,
        outcome: "paused",
        recordedAt: advance(1),
      }),
    ).toBe(true);
    await expect(
      runtime.queries.getById({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
      }),
    ).resolves.toMatchObject({
      goal: { goal: { status: "paused", revision: 2 } },
      latestRun: {
        status: "paused",
        lastEvaluation: evaluation,
        completedAt: undefined,
      },
    });
    observationLease.release();
    await runtime.runtimeSessions.releaseLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: liveLease.leaseOwner,
      leaseToken: liveLease.leaseToken,
      expectedRunEpoch: 0,
    });
  });

  it("includes pre-pause evidence when evaluating a resumed Goal revision", async () => {
    const { runtime, advance } = harness();
    await runtime.runtimeSessions.ensure(OWNER_ID, SESSION_ID);
    const liveLease = await runtime.runtimeSessions.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: "sqlite-resume-evidence-test",
    });
    if (!liveLease) throw new Error("Expected a live Runtime lease");
    const observationLease = runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseToken: liveLease.leaseToken,
    });
    const activation = await runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      idempotencyKey: "activate-resume-evidence",
      source: { type: "user", authority: "user" },
      goal: goalInput(),
    });
    await runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    await runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      instructionId: activation.instruction.id,
      runEpoch: 0,
      recordedAt: advance(1),
    });
    const context = await runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      runEpoch: 0,
    });
    if (!context) throw new Error("Expected the activation observation context");
    const observedAt = advance(1);
    expect(
      await runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "pre-pause-evidence",
        providerEventId: "pre-pause-evidence",
        observedAt,
        context,
        evidence: [
          {
            type: "tool_result",
            sourceEventId: "pre-pause-tool-result",
            summary: "The focused test passed before the Goal was paused",
            success: true,
            payload: { toolName: "test", outputPreview: "passed" },
            observedAt,
          },
        ],
      }),
    ).toBe(true);

    await runtime.state.commitEvaluationTransition({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      goal: transitionAgentGoal({
        current: activation.goal.goal,
        expectedRevision: 1,
        status: "paused",
        now: new Date(advance(1)),
      }),
    });
    const resumed = await runtime.goals.resume({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId: activation.goal.goal.id,
      expectedRevision: 2,
      idempotencyKey: "resume-with-existing-evidence",
      source: { type: "user", authority: "user" },
    });
    expect(resumed.goal.goal.revision).toBe(3);

    const snapshot = await runtime.observations.beginGoalEvaluation({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId: activation.goal.goal.id,
      goalRevision: 3,
      runEpoch: 0,
      evaluationKey: "stop:after-resume",
      recordedAt: advance(1),
    });
    expect(snapshot).toMatchObject({
      evidenceRevisionFloor: 1,
      evidence: [
        {
          goalRevision: 1,
          sourceEventId: "pre-pause-tool-result",
        },
      ],
    });

    observationLease.release();
    await runtime.runtimeSessions.releaseLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: liveLease.leaseOwner,
      leaseToken: liveLease.leaseToken,
      expectedRunEpoch: 0,
    });
  });

  it("keeps an old turn result scoped to its immutable instruction context", async () => {
    const { database, runtime, advance } = harness();
    await runtime.runtimeSessions.ensure(OWNER_ID, SESSION_ID);
    const liveLease = await runtime.runtimeSessions.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: "sqlite-wiring-test",
    });
    if (!liveLease) throw new Error("Expected a live Runtime lease");
    const observationLease = runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseToken: liveLease.leaseToken,
    });
    const activation = await runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      idempotencyKey: "activate-causal-sqlite-runtime",
      source: { type: "user", authority: "user" },
      goal: goalInput(),
    });
    await runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    await runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      instructionId: activation.instruction.id,
      runEpoch: 0,
      recordedAt: advance(1),
    });
    const oldTurnContext = await runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      runEpoch: 0,
    });
    if (!oldTurnContext) throw new Error("Expected revision-one context");

    const updated = await runtime.goals.update({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId: activation.goal.goal.id,
      expectedRevision: 1,
      idempotencyKey: "update-causal-sqlite-runtime",
      source: { type: "user", authority: "user" },
      update: { priority: 90 },
    });
    await runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: updated.instruction,
    });
    await runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      instructionId: updated.instruction.id,
      runEpoch: 0,
      recordedAt: advance(1),
    });

    expect(
      await runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "old-revision-result",
        providerEventId: "old-revision-result",
        observedAt: advance(1),
        terminal: true,
        context: oldTurnContext,
      }),
    ).toBe(true);
    const deliveries = database
      .prepare(
        `SELECT instruction_id AS instructionId,
                state,
                provider_event_id AS providerEventId
           FROM agent_runtime_deliveries
          WHERE owner_id = ? AND runtime_session_id = ?`,
      )
      .all(OWNER_ID, SESSION_ID) as Array<{
      instructionId: string;
      state: string;
      providerEventId: string | null;
    }>;
    expect(
      deliveries.find(
        ({ instructionId }) => instructionId === activation.instruction.id,
      ),
    ).toMatchObject({
      state: "applied",
      providerEventId: "old-revision-result",
    });
    expect(
      deliveries.find(
        ({ instructionId }) => instructionId === updated.instruction.id,
      ),
    ).toMatchObject({ state: "written_to_sdk" });
    observationLease.release();
    await runtime.runtimeSessions.releaseLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: liveLease.leaseOwner,
      leaseToken: liveLease.leaseToken,
      expectedRunEpoch: 0,
    });
  });

  it("uses one durable source for delivery, observation, evaluation, and queries", async () => {
    const { database, runtime, advance } = harness();
    await runtime.runtimeSessions.ensure(OWNER_ID, SESSION_ID);
    const liveLease = await runtime.runtimeSessions.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: "sqlite-wiring-test",
    });
    if (!liveLease) throw new Error("Expected a live Runtime lease");
    const observationLease = runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseToken: liveLease.leaseToken,
    });
    const activation = await runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      idempotencyKey: "activate-sqlite-runtime",
      source: { type: "user", authority: "user" },
      goal: goalInput(),
    });
    expect(activation.dispatch.status).toBe("unavailable");

    await runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    // A transport failure leaves a leased attempt; preparing again is safe and
    // the later receipt can finish that same attempt.
    await runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    expect(
      await runtime.observations.recordInstructionHandoff({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        instructionId: activation.instruction.id,
        runEpoch: 0,
        recordedAt: advance(1),
      }),
    ).toBe(true);
    // The queue can hand an instruction to the SDK before transport.deliver()
    // resolves. A later queued receipt must therefore be idempotent rather
    // than downgrading the already-written durable Delivery.
    await runtime.observations.recordDeliveryReceipt({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
      receipt: {
        instructionId: activation.instruction.id,
        runtimeSessionId: SESSION_ID,
        state: "queued",
        recordedAt: advance(1),
      },
    });
    await runtime.observations.setProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      providerSessionId: "claude-query-1",
      runEpoch: 0,
    });
    const context = await runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      runEpoch: 0,
    });
    expect(context).not.toBeNull();
    if (!context) throw new Error("Expected a durable observation context");

    const observedAt = advance(1);
    expect(
      await runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "claude:event:1",
        providerEventId: "provider-event-1",
        providerSessionId: "claude-query-1",
        observedAt,
        context,
        usage: { turnsUsed: 1, tokensUsed: 25 },
        evidence: [
          {
            type: "tool_result",
            sourceEventId: "tool-result-1",
            summary: "The focused test passed",
            success: true,
            payload: { toolName: "test" },
            observedAt,
          },
        ],
      }),
    ).toBe(true);
    const replayedAt = advance(1);
    expect(
      await runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "claude:event:1",
        providerEventId: "provider-event-1",
        providerSessionId: "claude-query-1",
        observedAt: replayedAt,
        context,
        usage: { turnsUsed: 1, tokensUsed: 25 },
        evidence: [
          {
            type: "tool_result",
            sourceEventId: "tool-result-1",
            summary: "The focused test passed",
            success: true,
            payload: { toolName: "test" },
            observedAt: replayedAt,
          },
        ],
      }),
    ).toBe(false);

    const evaluationKey = "stop:1";
    const snapshot = await runtime.observations.beginGoalEvaluation({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId: activation.goal.goal.id,
      goalRevision: 1,
      runEpoch: 0,
      evaluationKey,
      recordedAt: advance(1),
    });
    expect(snapshot?.evidence).toHaveLength(1);
    const evaluationEvidence = snapshot?.evidence[0];
    if (!evaluationEvidence)
      throw new Error("Expected persisted Goal evidence");
    const evaluation = {
      completed: true,
      confidence: 1,
      satisfiedCriteria: ["tests-pass"],
      missingCriteria: [],
      evidence: [
        {
          criterionId: "tests-pass",
          evidenceIds: [evaluationEvidence.id],
        },
      ],
      reason: "The required test evidence was observed",
    };
    await runtime.state.commitEvaluationTransition({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      goal: transitionAgentGoal({
        current: activation.goal.goal,
        expectedRevision: 1,
        status: "completed",
        now: new Date(advance(1)),
      }),
    });
    expect(
      await runtime.observations.finishGoalEvaluation({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
        goalRevision: 1,
        runEpoch: 0,
        evaluationKey,
        evaluation,
        outcome: "completed",
        recordedAt: advance(1),
      }),
    ).toBe(true);
    expect(
      await runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "claude:terminal:1",
        providerEventId: "provider-terminal-1",
        providerSessionId: "claude-query-1",
        observedAt: advance(1),
        terminal: true,
        context,
      }),
    ).toBe(true);

    const detail = await runtime.queries.getById({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId: activation.goal.goal.id,
    });
    expect(detail).toMatchObject({
      goal: { goal: { status: "completed", revision: 2 } },
      latestRun: {
        status: "completed",
        turnsUsed: 1,
        tokensUsed: 25,
        lastEvaluation: { completed: true },
      },
      latestDelivery: { state: "applied" },
      evidence: [{ sourceEventId: "tool-result-1" }],
    });
    await expect(
      runtime.goals.replayPendingInstructions(OWNER_ID, SESSION_ID),
    ).resolves.toBeNull();
    expect(
      database
        .prepare("SELECT count(*) AS count FROM agent_goal_evidence")
        .get(),
    ).toEqual({ count: 1 });
    observationLease.release();
    await runtime.runtimeSessions.releaseLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: liveLease.leaseOwner,
      leaseToken: liveLease.leaseToken,
      expectedRunEpoch: 0,
    });
  });

  it("reclaims terminal-free chat rows but fails closed on unfinished Goals", async () => {
    const { database, runtime } = harness();
    database
      .prepare(
        `INSERT INTO agent_runtime_sessions
           (id, owner_id, provider_session_id)
         VALUES (?, ?, ?)`,
      )
      .run(SESSION_ID, OWNER_ID, "stale-query");

    const reclaimed = await runtime.runtimeSessions.ensure(
      OWNER_ID,
      SESSION_ID,
    );
    expect(reclaimed.providerSessionId).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT provider_session_id FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_ID),
    ).toEqual({ provider_session_id: null });
    const liveLease = await runtime.runtimeSessions.claimLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: "ordinary-chat-test",
    });
    if (!liveLease) throw new Error("Expected a live Runtime lease");
    const observationLease = runtime.observations.attachRuntimeLease({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseToken: liveLease.leaseToken,
    });
    await runtime.observations.setProviderSession({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      providerSessionId: "ordinary-chat-query",
      runEpoch: 0,
    });
    expect(
      database
        .prepare(
          "SELECT provider_session_id FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_ID),
    ).toEqual({ provider_session_id: "ordinary-chat-query" });

    await runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      idempotencyKey: "unfinished-goal",
      source: { type: "user", authority: "user" },
      goal: goalInput(),
    });
    observationLease.release();
    await runtime.runtimeSessions.releaseLiveRuntime({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      leaseOwner: liveLease.leaseOwner,
      leaseToken: liveLease.leaseToken,
      expectedRunEpoch: 0,
    });
    expect(
      database
        .prepare(
          "SELECT provider_session_id FROM agent_runtime_sessions WHERE id = ?",
        )
        .get(SESSION_ID),
    ).toEqual({ provider_session_id: "ordinary-chat-query" });
    const restarted = createSqliteAgentGoalRuntime(database);
    await expect(
      restarted.runtimeSessions.ensure(OWNER_ID, SESSION_ID),
    ).rejects.toMatchObject({ code: "runtime_session_recovery_required" });
  });

  it("ignores delayed handoffs and provider output after a Goal is blocked", async () => {
    const { runtime, advance } = harness();
    await runtime.runtimeSessions.ensure(OWNER_ID, SESSION_ID);
    const activation = await runtime.goals.activate({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      idempotencyKey: "activate-before-block",
      source: { type: "user", authority: "user" },
      goal: goalInput(),
    });
    await runtime.observations.prepareDelivery({
      ownerId: OWNER_ID,
      instruction: activation.instruction,
    });
    await runtime.observations.recordInstructionHandoff({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      instructionId: activation.instruction.id,
      runEpoch: 0,
      recordedAt: advance(1),
    });
    const context = await runtime.observations.captureContext({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      runEpoch: 0,
    });
    if (!context) throw new Error("Expected the active Goal context");

    await runtime.state.commitEvaluationTransition({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      expectedRevision: 1,
      expectedRunEpoch: 0,
      goal: transitionAgentGoal({
        current: activation.goal.goal,
        expectedRevision: 1,
        status: "blocked",
        now: new Date(advance(1)),
      }),
    });

    expect(
      await runtime.observations.recordInstructionHandoff({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        instructionId: activation.instruction.id,
        runEpoch: 0,
        recordedAt: advance(1),
      }),
    ).toBe(true);
    expect(
      await runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "late-blocked-result",
        providerEventId: "late-blocked-result",
        observedAt: advance(1),
        terminal: true,
        context,
        usage: { turnsUsed: 10, tokensUsed: 10_000 },
      }),
    ).toBe(false);
    await expect(
      runtime.observations.captureContext({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.queries.getById({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
      }),
    ).resolves.toMatchObject({
      latestRun: { status: "blocked", turnsUsed: 0, tokensUsed: 0 },
      evidence: [],
    });
  });
});

function uuid(value: number): string {
  return `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
