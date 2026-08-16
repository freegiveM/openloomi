import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
  return { claude, handle, registration, runtime, sdkInput };
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
  fixture.handle.push({
    type: "result",
    subtype: "success",
    uuid: "pre-goal-turn-result",
    session_id: "goal-controller-provider",
  } as unknown as SDKMessage);
  await vi.waitFor(() => expect(fixture.claude.sdkMessageCount).toBe(1));
  return activation;
}

async function closeFixture(fixture: Fixture) {
  fixture.registration?.release();
  await fixture.claude.close();
}

async function expectPausedGoal(fixture: Fixture, goalId: string) {
  await expect(
    fixture.runtime.queries.getById({
      ownerId: OWNER_ID,
      runtimeSessionId: SESSION_ID,
      goalId,
    }),
  ).resolves.toMatchObject({
    goal: { goal: { status: "paused", revision: 2 } },
    latestRun: {
      status: "paused",
      lastEvaluation: { completed: false },
    },
  });
}

async function observeAssistantTurn(
  fixture: Fixture,
  assistantTurnId: string,
  text = "Applying the active Goal.",
) {
  const previousCount = fixture.claude.sdkMessageCount;
  fixture.handle.push({
    type: "assistant",
    uuid: assistantTurnId,
    session_id: "goal-controller-provider",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  } as unknown as SDKMessage);
  await vi.waitFor(() =>
    expect(fixture.claude.sdkMessageCount).toBe(previousCount + 1),
  );
}

async function observeFailedCommandAttempt(fixture: Fixture, attempt: number) {
  const context = await fixture.runtime.observations.captureContext({
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    runEpoch: 0,
  });
  if (!context) throw new Error("Expected an active Goal observation context");
  const eventId = `deterministic-command-failure-${attempt}`;
  const observedAt = new Date(NOW.getTime() + attempt * 1_000).toISOString();
  await fixture.runtime.observations.observeProviderEvent({
    ownerId: OWNER_ID,
    runtimeSessionId: SESSION_ID,
    runEpoch: 0,
    eventKey: eventId,
    providerEventId: eventId,
    observedAt,
    context,
    evidence: [
      {
        type: "command_result",
        sourceEventId: eventId,
        summary: "Command failed: pwsh Get-Location",
        success: false,
        payload: {
          command: "pwsh Get-Location",
          exitCode: -1,
          outputPreview:
            "windows sandbox: orchestrator_helper_launch_failed: codex-windows-sandbox-setup.exe program not found",
        },
        observedAt,
      },
    ],
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
  it("deduplicates an inline continuation and attributes its provider output", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(
        fixture,
        commandGoal({
          successCriteria: [
            ...commandGoal().successCriteria,
            {
              id: "docs-ready",
              description: "Documentation is ready",
              verification: {
                type: "command_result",
                commandPattern: "pnpm docs",
                expectedExitCode: 0,
              },
              required: true,
            },
          ],
        }),
      );
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
      if (first.instruction.kind !== "goal.continue") {
        throw new Error("Expected a Goal continuation instruction");
      }
      expect(first.instruction.payload.missingCriteria).toHaveLength(1);
      expect(first.instruction.payload).not.toHaveProperty("remainingBudget");
      expect(duplicate.outcome).toBe("continue");
      expect(duplicate.instruction.id).toBe(first.instruction.id);
      expect(duplicate.reason).toBe(first.reason);
      await expect(
        fixture.runtime.observations.listDeliveries(OWNER_ID, SESSION_ID),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructionId: first.instruction.id,
            state: "written_to_sdk",
          }),
        ]),
      );

      await observeAssistantTurn(fixture, "assistant-after-continuation");
      await vi.waitFor(async () => {
        const evidence = await fixture.runtime.observations.listEvidence(
          OWNER_ID,
          SESSION_ID,
        );
        expect(evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              instructionId: first.instruction.id,
              sourceEventId: "assistant-after-continuation:assistant",
            }),
          ]),
        );
      });
      await expect(
        fixture.runtime.observations.listDeliveries(OWNER_ID, SESSION_ID),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructionId: first.instruction.id,
            state: "observed",
          }),
        ]),
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("pauses on recursive Stop without a new assistant turn", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activateGoal(fixture, commandGoal());
      await observeAssistantTurn(fixture, "assistant-recursive-stop");
      await fixture.claude.evaluateStop({
        runEpoch: 0,
        assistantTurnId: "assistant-recursive-stop",
        lastAssistantMessage: "The test has not run yet.",
        stopHookActive: false,
      });

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-recursive-stop",
          lastAssistantMessage: "The test has not run yet.",
          stopHookActive: true,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "paused" });
      await expectPausedGoal(fixture, activation.goal.goal.id);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("fails the Stop handoff when continuation context cannot be registered", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(fixture, commandGoal());
      await observeAssistantTurn(fixture, "assistant-handoff-failure");
      vi.spyOn(
        fixture.runtime.observations,
        "recordInstructionHandoff",
      ).mockResolvedValue(false);

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-handoff-failure",
          lastAssistantMessage: "The test has not run yet.",
          stopHookActive: false,
        }),
      ).rejects.toMatchObject({ code: "instruction_handoff_failed" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("finalizes without continuation when durable command evidence satisfies the Goal", async () => {
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
        fixture.runtime.controller
          .forSession({
            ownerId: OWNER_ID,
            runtimeSessionId: SESSION_ID,
            transport: fixture.claude,
          })
          .finalizeWithoutContinuation({
            runEpoch: 0,
            evaluationId: "provider-failure-complete",
            turnContext: context,
          }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "completed" });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("continues past legacy execution limits while retaining usage", async () => {
    const fixture = await createFixture();
    try {
      await activateGoal(
        fixture,
        commandGoal({
          maxTurns: 1,
          maxTokens: 1,
          maxDurationSeconds: 1,
          deadline: "2026-08-03T07:59:00.000Z",
        }),
      );
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
      ).resolves.toMatchObject({ decision: "block", outcome: "continue" });
      await expect(
        fixture.runtime.observations.listGoalRuns(OWNER_ID, SESSION_ID),
      ).resolves.toEqual([
        expect.objectContaining({
          status: "running",
          turnsUsed: 1,
          tokensUsed: 1,
          lastEvaluation: expect.objectContaining({
            reason: expect.stringContaining("remain incomplete"),
          }),
        }),
      ]);
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

  it("pauses instead of automatically completing a manual criterion", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activateGoal(fixture, {
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
      ).resolves.toMatchObject({ decision: "allow", outcome: "paused" });
      await expectPausedGoal(fixture, activation.goal.goal.id);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("pauses when the semantic evaluator fails", async () => {
    const semanticEvaluator = {
      evaluate: vi.fn().mockRejectedValue(new Error("evaluator unavailable")),
    };
    const fixture = await createFixture({ semanticEvaluator });
    try {
      const activation = await activateGoal(fixture, {
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
      await observeAssistantTurn(
        fixture,
        "assistant-evaluator-error",
        "The implementation appears complete.",
      );

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-evaluator-error",
          lastAssistantMessage: "The implementation appears complete.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "paused" });
      await expectPausedGoal(fixture, activation.goal.goal.id);
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

      const resumed = await fixture.runtime.goals.resume({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activation.goal.goal.id,
        expectedRevision: 2,
        idempotencyKey: "resume-after-evaluator-error",
        source: { type: "user", authority: "user" },
      });
      expect(resumed).toMatchObject({
        goal: { goal: { status: "active", revision: 3 } },
        instruction: { kind: "goal.resume", goalRevision: 3 },
        dispatch: { status: "accepted" },
      });
      await fixture.sdkInput.next();
      await vi.waitFor(async () => {
        await expect(
          fixture.runtime.queries.getById({
            ownerId: OWNER_ID,
            runtimeSessionId: SESSION_ID,
            goalId: activation.goal.goal.id,
          }),
        ).resolves.toMatchObject({
          goal: { goal: { status: "active", revision: 3 } },
          latestRun: {
            status: "running",
            goalRevision: 3,
            lastEvaluation: expect.objectContaining({
              completed: false,
              reason: expect.stringContaining(
                "The semantic Goal evaluator failed",
              ),
            }),
          },
        });
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("pauses without creating a continuation when final evidence is incomplete", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activateGoal(fixture, commandGoal());
      const context = await fixture.runtime.observations.captureContext({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        runEpoch: 0,
      });
      if (context === null) {
        throw new Error("Expected an active Goal observation context");
      }

      await expect(
        fixture.runtime.controller
          .forSession({
            ownerId: OWNER_ID,
            runtimeSessionId: SESSION_ID,
            transport: fixture.claude,
          })
          .finalizeWithoutContinuation({
            runEpoch: 0,
            evaluationId: "provider-failure-incomplete",
            turnContext: context,
          }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "paused" });
      await expectPausedGoal(fixture, activation.goal.goal.id);
      await expect(
        fixture.runtime.state.listInstructions(OWNER_ID, SESSION_ID),
      ).resolves.toEqual([expect.objectContaining({ kind: "goal.activate" })]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("preserves proven criteria when final semantic evaluation fails", async () => {
    const fixture = await createFixture({
      semanticEvaluator: {
        evaluate: vi.fn().mockRejectedValue(new Error("evaluator unavailable")),
      },
    });
    try {
      const activation = await activateGoal(
        fixture,
        commandGoal({
          completionPolicy: "model_evaluator",
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
            {
              id: "behavior-correct",
              description: "The behavior is correct",
              verification: { type: "model_evidence" },
              required: true,
            },
          ],
        }),
      );
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
        eventKey: "provider-failure-test-result",
        providerEventId: "provider-failure-test-result",
        observedAt: NOW.toISOString(),
        context,
        evidence: [
          {
            type: "test_result",
            sourceEventId: "provider-failure-test-result",
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
        fixture.runtime.controller
          .forSession({
            ownerId: OWNER_ID,
            runtimeSessionId: SESSION_ID,
            transport: fixture.claude,
          })
          .finalizeWithoutContinuation({
            runEpoch: 0,
            evaluationId: "provider-failure-preserves-progress",
            turnContext: context,
          }),
      ).resolves.toMatchObject({ decision: "allow", outcome: "paused" });
      await expect(
        fixture.runtime.queries.getById({
          ownerId: OWNER_ID,
          runtimeSessionId: SESSION_ID,
          goalId: activation.goal.goal.id,
        }),
      ).resolves.toMatchObject({
        goal: { goal: { status: "paused" } },
        latestRun: {
          status: "paused",
          lastEvaluation: {
            satisfiedCriteria: ["tests-pass"],
            missingCriteria: ["behavior-correct"],
          },
        },
        progress: { completedCriteria: 1, totalCriteria: 2 },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps continuing when repeated evaluations make no progress", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activateGoal(fixture, commandGoal());
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const assistantTurnId = `assistant-no-progress-${attempt}`;
        await observeAssistantTurn(fixture, assistantTurnId);
        const decision = await fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId,
          lastAssistantMessage: "The required test has not run yet.",
          stopHookActive: false,
        });
        expect(decision).toMatchObject({
          decision: "block",
          outcome: "continue",
        });
      }

      await expect(
        fixture.runtime.queries.getById({
          ownerId: OWNER_ID,
          runtimeSessionId: SESSION_ID,
          goalId: activation.goal.goal.id,
        }),
      ).resolves.toMatchObject({
        goal: { goal: { status: "active" } },
        latestRun: { status: "running" },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("pauses after three instructions repeat one deterministic failure", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activateGoal(fixture, commandGoal());
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const assistantTurnId = `assistant-deterministic-failure-${attempt}`;
        await observeAssistantTurn(fixture, assistantTurnId);
        await observeFailedCommandAttempt(fixture, attempt);
        const decision = await fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId,
          lastAssistantMessage: "The sandbox helper is still unavailable.",
          stopHookActive: false,
        });
        expect(decision).toMatchObject(
          attempt < 3
            ? { decision: "block", outcome: "continue" }
            : { decision: "allow", outcome: "paused" },
        );
      }

      await expectPausedGoal(fixture, activation.goal.goal.id);
      await expect(
        fixture.runtime.state.listInstructions(OWNER_ID, SESSION_ID),
      ).resolves.toEqual([
        expect.objectContaining({ kind: "goal.activate" }),
        expect.objectContaining({ kind: "goal.continue" }),
        expect.objectContaining({ kind: "goal.continue" }),
      ]);
      await expect(
        fixture.runtime.queries.getById({
          ownerId: OWNER_ID,
          runtimeSessionId: SESSION_ID,
          goalId: activation.goal.goal.id,
        }),
      ).resolves.toMatchObject({
        latestRun: {
          lastEvaluation: {
            reason: expect.stringContaining(
              "paused after 3 separate Runtime Instructions",
            ),
          },
        },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("continues instead of blocking when semantic evidence is outside the evaluation snapshot", async () => {
    const semanticEvaluator = {
      evaluate: vi.fn().mockResolvedValue({
        completed: true,
        confidence: 1,
        satisfiedCriteria: ["semantic-review"],
        missingCriteria: [],
        evidence: [
          {
            criterionId: "semantic-review",
            evidenceIds: ["40000000-0000-4000-8000-000000000001"],
          },
        ],
        reason: "The implementation appears complete.",
      }),
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
      await observeAssistantTurn(
        fixture,
        "assistant-foreign-evidence",
        "The implementation appears complete.",
      );

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-foreign-evidence",
          lastAssistantMessage: "The implementation appears complete.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "block", outcome: "continue" });
      await expect(
        fixture.runtime.observations.listGoalRuns(OWNER_ID, SESSION_ID),
      ).resolves.toEqual([
        expect.objectContaining({
          status: "running",
          lastEvaluation: expect.objectContaining({
            satisfiedCriteria: [],
            missingCriteria: ["semantic-review"],
            evidence: [],
          }),
        }),
      ]);
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

  it("does not evaluate a newer Goal revision for an older active turn", async () => {
    const semanticEvaluator = { evaluate: vi.fn() };
    const fixture = await createFixture({ semanticEvaluator });
    try {
      const activated = await activateGoal(fixture, commandGoal());
      await observeAssistantTurn(fixture, "assistant-old-revision");
      await fixture.runtime.goals.update({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activated.goal.goal.id,
        expectedRevision: 1,
        idempotencyKey: "update-before-old-stop",
        source: { type: "user", authority: "user" },
        update: { priority: 90 },
      });
      await fixture.sdkInput.next();

      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-old-revision",
          lastAssistantMessage: "This turn began under revision one.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({
        decision: "allow",
        outcome: "stale",
        goalId: activated.goal.goal.id,
        goalRevision: 1,
      });
      expect(semanticEvaluator.evaluate).not.toHaveBeenCalled();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("invalidates the prior evaluation when the Goal definition changes", async () => {
    const fixture = await createFixture();
    try {
      const activated = await activateGoal(fixture, commandGoal());
      await observeAssistantTurn(fixture, "assistant-before-goal-update");
      await expect(
        fixture.claude.evaluateStop({
          runEpoch: 0,
          assistantTurnId: "assistant-before-goal-update",
          lastAssistantMessage: "The required test has not run yet.",
          stopHookActive: false,
        }),
      ).resolves.toMatchObject({ decision: "block", outcome: "continue" });
      await expect(
        fixture.runtime.queries.getById({
          ownerId: OWNER_ID,
          runtimeSessionId: SESSION_ID,
          goalId: activated.goal.goal.id,
        }),
      ).resolves.toMatchObject({
        latestRun: {
          lastEvaluation: expect.objectContaining({ completed: false }),
        },
      });

      await fixture.runtime.goals.update({
        ownerId: OWNER_ID,
        runtimeSessionId: SESSION_ID,
        goalId: activated.goal.goal.id,
        expectedRevision: 1,
        idempotencyKey: "change-goal-definition",
        source: { type: "user", authority: "user" },
        update: { objective: "Run and preserve the revised test result" },
      });
      await fixture.sdkInput.next();

      await expect(
        fixture.runtime.queries.getById({
          ownerId: OWNER_ID,
          runtimeSessionId: SESSION_ID,
          goalId: activated.goal.goal.id,
        }),
      ).resolves.toMatchObject({
        latestRun: { goalRevision: 2, lastEvaluation: undefined },
      });
    } finally {
      await closeFixture(fixture);
    }
  });
});
