import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeRuntimeSession,
  startClaudeGoalRuntimeSession,
} from "@/lib/ai/extensions/agent/claude/runtime";
import { createInMemoryAgentGoalRuntime } from "@/lib/ai/runtime-instructions/runtime";

import {
  createControlledClaudeQuery,
  createFakeClaudeSdkTransport,
} from "../../helpers/claude-runtime";
import {
  DeterministicRuntimeIds,
  FixedRuntimeClock,
} from "../../helpers/goal-runtime";

const OWNER_ID = "goal-controller-owner";
const SESSION_ID = "goal-controller-session";
const NOW = new Date("2026-08-03T08:00:00.000Z");

type GoalRuntimeOptions = NonNullable<
  Parameters<typeof createInMemoryAgentGoalRuntime>[0]
>;
type RuntimeOverrides = Pick<GoalRuntimeOptions, "semanticEvaluator">;
type GoalDraft = Parameters<
  ReturnType<typeof createInMemoryAgentGoalRuntime>["goals"]["activate"]
>[0]["goal"];

async function createFixture(runtimeOptions: RuntimeOverrides = {}) {
  const handle = createControlledClaudeQuery();
  const sdk = createFakeClaudeSdkTransport(handle);
  const claude = new ClaudeRuntimeSession({
    runtimeSessionId: SESSION_ID,
    runEpoch: 0,
    sdkTransport: sdk.transport,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createMessageId: () => "agent-message-id",
  });
  const runtime = createInMemoryAgentGoalRuntime({
    clock: new FixedRuntimeClock(NOW),
    idGenerator: new DeterministicRuntimeIds("10000000"),
    observationIdGenerator: new DeterministicRuntimeIds("90000000"),
    ...runtimeOptions,
  });
  const registration = await startClaudeGoalRuntimeSession({
    session: { user: { id: OWNER_ID } },
    runtime: claude,
    start: { initialPrompt: "Start Goal" },
    goalRuntime: runtime,
  });
  const sdkInput = (sdk.queryInput?.prompt as AsyncIterable<SDKUserMessage>)[
    Symbol.asyncIterator
  ]();
  await sdkInput.next();
  return { claude, registration, runtime, sdkInput };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function activateGoal(fixture: Fixture, goal: GoalDraft) {
  const activation = await fixture.runtime.goals.activate({
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    idempotencyKey: "activate-goal",
    source: { type: "user", authority: "user" },
    goal,
  });
  // Activation uses the normal SDK input channel. Continuation guidance is
  // delivered inline by the Stop hook and must not enter this queue again.
  await fixture.sdkInput.next();
  return activation;
}

async function closeFixture(fixture: Fixture) {
  fixture.registration?.release();
  await fixture.claude.close();
}

async function observeAssistantTurn(fixture: Fixture, assistantTurnId: string) {
  await fixture.runtime.observations.observeProviderEvent({
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    runEpoch: 0,
    eventKey: assistantTurnId,
    providerEventId: assistantTurnId,
    observedAt: NOW.toISOString(),
    usage: { tokensUsed: 1, turnsUsed: 1 },
  });
}

function commandGoal(overrides: Partial<GoalDraft> = {}): GoalDraft {
  return {
    objective: "Run the required test",
    successCriteria: [
      {
        id: "tests-pass",
        description: "Required tests pass",
        verification: {
          type: "command_result",
          commandPattern: "pnpm test",
          expectedExitCode: 0,
        },
        required: true,
      },
    ],
    constraints: [],
    contextRefs: [],
    priority: 80,
    maxTurns: 5,
    completionPolicy: "tool_evidence",
    source: { type: "user" },
    ...overrides,
  };
}

describe("GoalController Claude Stop integration", () => {
  it("deduplicates one inline continuation and fails closed on recursive Stop", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, commandGoal());
      await observeAssistantTurn(fixture, "assistant-turn-1");
      const first = await fixture.claude.evaluateStop({
        runEpoch: 0,
        assistantTurnId: "assistant-turn-1",
        lastAssistantMessage: "The test has not run yet.",
        stopHookActive: false,
      });
      const duplicate = await fixture.claude.evaluateStop({
        runEpoch: 0,
        assistantTurnId: "assistant-turn-1",
        lastAssistantMessage: "The test has not run yet.",
        stopHookActive: false,
      });
      const recursion = await fixture.claude.evaluateStop({
        runEpoch: 0,
        assistantTurnId: "assistant-turn-1",
        lastAssistantMessage: "The test has not run yet.",
        stopHookActive: true,
      });

      expect(first).toMatchObject({
        decision: "block",
        outcome: "continue",
      });
      if (first.decision !== "block" || duplicate.decision !== "block") {
        throw new Error("Expected both Stop decisions to block");
      }
      expect(first.reason).toContain("Required tests pass");
      expect(first.instruction).toMatchObject({
        kind: "goal.continue",
        payload: {
          missingCriteria: [
            { id: "tests-pass", description: "Required tests pass" },
          ],
        },
      });
      expect(duplicate.outcome).toBe("continue");
      expect(duplicate.instruction.id).toBe(first.instruction.id);
      expect(duplicate.reason).toBe(first.reason);
      expect(recursion).toMatchObject({
        decision: "allow",
        outcome: "blocked",
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("allows Stop and completes the Goal when deterministic command evidence satisfies it", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, commandGoal());
      const context = await fixture.runtime.observations.captureContext({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
      });
      if (context === null) {
        throw new Error("Expected an active Goal observation context");
      }
      await fixture.runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "tool-event",
        providerEventId: "tool-event",
        observedAt: NOW.toISOString(),
        context,
        evidence: [
          {
            type: "test_result",
            sourceEventId: "tool-event",
            summary: "Test command succeeded: pnpm test",
            success: true,
            payload: {
              provider: "claude",
              toolName: "Bash",
              command: "pnpm test",
              exitCode: 0,
            },
            observedAt: NOW.toISOString(),
          },
        ],
      });

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-turn-complete",
          lastAssistantMessage: "The required test passed.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "completed" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("allows Stop with budget_limited instead of creating an unusable continuation", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, commandGoal({ maxTurns: 1 }));
      await fixture.runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "assistant-budget",
        providerEventId: "assistant-budget",
        observedAt: NOW.toISOString(),
        usage: { tokensUsed: 1, turnsUsed: 1 },
      });

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-budget",
          lastAssistantMessage: "The required test is still pending.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({
        decision: "allow",
        outcome: "budget_limited",
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("lets deterministic completion win exactly at the turn-budget boundary", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, commandGoal({ maxTurns: 1 }));
      const context = await fixture.runtime.observations.captureContext({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
      });
      if (context === null) {
        throw new Error("Expected an active Goal observation context");
      }
      await fixture.runtime.observations.observeProviderEvent({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
        eventKey: "assistant-budget-complete",
        providerEventId: "assistant-budget-complete",
        observedAt: NOW.toISOString(),
        context,
        usage: { tokensUsed: 1, turnsUsed: 1 },
        evidence: [
          {
            type: "test_result",
            sourceEventId: "assistant-budget-complete",
            summary: "Test command succeeded at the final turn: pnpm test",
            success: true,
            payload: {
              provider: "claude",
              toolName: "Bash",
              command: "pnpm test",
              exitCode: 0,
            },
            observedAt: NOW.toISOString(),
          },
        ],
      });

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-budget-complete",
          lastAssistantMessage: "The required test passed on the final turn.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "completed" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("never automatically completes a manual criterion", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, {
        objective: "Obtain approval",
        successCriteria: [
          {
            id: "approval",
            description: "A person approves the result",
            verification: { type: "manual" },
            required: true,
          },
        ],
        constraints: [],
        contextRefs: [],
        priority: 80,
        maxTurns: 5,
        completionPolicy: "manual",
        source: { type: "user" },
      });
      await observeAssistantTurn(fixture, "assistant-manual");

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-manual",
          lastAssistantMessage: "I believe the result is ready.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "blocked" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("fails closed when the semantic evaluator fails", async () => {
    const semanticEvaluator = {
      evaluate: vi.fn().mockRejectedValue(new Error("evaluator unavailable")),
    };
    const fixture = await createFixture({ semanticEvaluator });
    try {
      await activateGoal(fixture, {
        objective: "Verify the implementation semantically",
        successCriteria: [
          {
            id: "semantic-review",
            description: "The implementation satisfies the requested behavior",
            verification: { type: "model_evidence" },
            required: true,
          },
        ],
        constraints: [],
        contextRefs: [],
        priority: 80,
        maxTurns: 5,
        completionPolicy: "model_evaluator",
        source: { type: "user" },
      });
      await observeAssistantTurn(fixture, "assistant-evaluator-error");

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-evaluator-error",
          lastAssistantMessage: "The implementation appears complete.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "blocked" });
      expect(semanticEvaluator.evaluate).toHaveBeenCalledTimes(1);
      expect(semanticEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.objectContaining({
              type: "agent_report",
              sourceEventId: "assistant-evaluator-error:assistant",
              payload: expect.objectContaining({
                outputPreview: "The implementation appears complete.",
              }),
            }),
          ]),
        }),
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("allows a stale Stop callback without evaluating or continuing the current run", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, commandGoal());

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 1,
          assistantTurnId: "assistant-stale",
          lastAssistantMessage: "This belongs to an obsolete epoch.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "stale" });
    } finally {
      await closeFixture(fixture);
    }
  });
});
