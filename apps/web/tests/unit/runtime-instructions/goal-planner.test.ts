import type { AgentMessage, TaskPlan } from "@openloomi/ai/agent/types";
import { describe, expect, it, vi } from "vitest";

const nativeRunner = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/native-agent/runner", () => ({
  runNativeAgentRequest: nativeRunner.run,
}));
vi.mock("@/lib/ai/native-agent/provider-env", () => ({
  resolveNativeAgentProviderRequest: vi.fn(
    (body: object, _env: unknown, options: { trustedProviderOverride: string }) =>
      ({ ...body, provider: options.trustedProviderOverride }),
  ),
}));

import {
  GoalPlanningError,
  NativeGoalPlanner,
  collectGoalSteps,
} from "@/lib/ai/runtime-instructions/api/goal-planner";

function plan(descriptions: string[]): TaskPlan {
  return {
    id: "provider-plan",
    goal: "Build the feature",
    steps: descriptions.map((description, index) => ({
      id: String(index),
      description,
      status: "pending",
    })),
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
  };
}

async function* messages(...items: AgentMessage[]): AsyncGenerator<AgentMessage> {
  yield* items;
  yield { type: "done" };
}

describe("Goal planner", () => {
  it("uses the pinned Runtime and returns normalized objective steps", async () => {
    nativeRunner.run.mockResolvedValueOnce({
      generator: messages({
        type: "plan",
        plan: plan(["  Inspect requirements  ", " ", "Implement and verify"]),
      }),
      memoryContext: { status: "no-op", reasonCodes: [], sourceCount: 0 },
      shouldAbortOnClose: () => false,
    });

    await expect(
      new NativeGoalPlanner().plan({
        ownerId: "owner-1",
        provider: "codex",
        objective: "Build the feature",
      }),
    ).resolves.toEqual(["Inspect requirements", "Implement and verify"]);
    expect(nativeRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "plan",
        provider: "codex",
        prompt: expect.stringContaining("non-overlapping steps"),
      }),
      expect.objectContaining({
        userId: "owner-1",
        goalRuntimeSessionId: null,
      }),
    );
  });

  it("rejects missing, oversized, and provider-error plans", async () => {
    await expect(collectGoalSteps(messages())).rejects.toBeInstanceOf(
      GoalPlanningError,
    );
    await expect(
      collectGoalSteps(
        messages({ type: "plan", plan: plan(Array(65).fill("step")) }),
      ),
    ).rejects.toThrow("more than 64");
    await expect(
      collectGoalSteps(messages({ type: "error", message: "unavailable" })),
    ).rejects.toThrow("unavailable");
  });

  it("aborts a provider that does not finish planning", async () => {
    nativeRunner.run.mockResolvedValueOnce({
      generator: (async function* () {
        await new Promise<never>(() => undefined);
      })(),
      memoryContext: { status: "no-op", reasonCodes: [], sourceCount: 0 },
      shouldAbortOnClose: () => true,
    });

    await expect(
      new NativeGoalPlanner(5).plan({
        ownerId: "owner-1",
        provider: "claude",
        objective: "Build the feature",
      }),
    ).rejects.toThrow("timed out");
    expect(nativeRunner.run.mock.calls.at(-1)?.[1].abortController.signal.aborted)
      .toBe(true);
  });
});
