import { describe, expect, test, vi } from "vitest";

import type { GoalCommandResult } from "@/lib/ai/runtime-instructions/goal-service";
import type { AgentGoalRuntime } from "@/lib/ai/runtime-instructions/runtime";
import {
  connectorGoalContext,
  isGoalProviderReady,
  loopGoalIdentity,
  resolveGoalProviderState,
  startLoopDecisionGoal,
} from "@/lib/loop/goal-adapter";
import { invokeAgentPrompt } from "@/lib/loop/runner";
import type { LoopDecision } from "@/lib/loop/types";

vi.mock("@/lib/db/queries", () => ({
  getUserById: vi.fn(async (id: string) => ({ id, email: "owner@example.com" })),
}));
vi.mock("@/lib/auth/remote-auth-utils", () => ({
  generateToken: vi.fn(() => "owner-token"),
}));

const decision: LoopDecision = {
  id: "decision-42",
  ts: "2026-08-14T08:00:00.000Z",
  status: "pending",
  type: "todo",
  title: "Prepare the launch checklist",
  action: {
    kind: "agent_goal",
    params: { objective: "Ship the release with a verified checklist" },
  },
  source_signal: {
    id: "gmail-message-7",
    ts: "2026-08-14T07:55:00.000Z",
    source: "gmail",
    type: "email",
    payload: { subject: "Launch approval", body: "Finish the checklist" },
    _origin: "composio",
    sourceAccount: { id: "gmail-work", label: "work@example.com" },
  },
};

describe("Loop Goal adapter", () => {
  test("derives stable identities scoped by owner and decision", () => {
    expect(loopGoalIdentity("user-a", decision.id)).toEqual(
      loopGoalIdentity("user-a", decision.id),
    );
    expect(loopGoalIdentity("user-a", decision.id)).not.toEqual(
      loopGoalIdentity("user-b", decision.id),
    );
  });

  test("starts through the trusted boundary with connector-only context", async () => {
    const startGoal = vi.fn(async () => command());
    const startProvider = vi.fn(async () => ({ ok: true }));
    const result = await startLoopDecisionGoal("user-a", decision, {
      startGoal,
      startProvider,
      providerState: vi.fn(async () => "start" as const),
    });
    const identity = loopGoalIdentity("user-a", decision.id);

    expect(startGoal).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId: identity.runtimeSessionId,
      objective: "Prepare the launch checklist",
      idempotencyKey: identity.idempotencyKey,
      sourceId: decision.id,
      connectorContext: expect.objectContaining({
        kind: "connector_record",
        refId: "gmail-message-7",
        origin: "connector",
        sourceRef: "gmail:gmail-message-7",
      }),
    });
    expect(startProvider).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId: identity.runtimeSessionId,
      instructionId: "instruction-1",
      objective: "Prepare the launch checklist",
    });
    expect(result).toMatchObject({
      runtimeSessionId: identity.runtimeSessionId,
      goalId: "10000000-0000-4000-8000-000000000001",
    });
  });

  test("requires the decision to remain pending", async () => {
    const startGoal = vi.fn();
    await expect(
      startLoopDecisionGoal(
        "user-a",
        { ...decision, status: "done" },
        {
          startGoal,
          providerState: vi.fn(),
          startProvider: vi.fn(),
        },
      ),
    ).rejects.toThrow("not pending (done)");
    expect(startGoal).not.toHaveBeenCalled();
  });

  test.each(["rejected", "superseded"] as const)(
    "rejects a live runtime whose instruction is %s",
    async (status) => {
      const runtime = providerStateRuntime("active", {}, status);
      await expect(
        resolveGoalProviderState(providerStateInput(), runtime),
      ).rejects.toThrow(`not accepted (${status})`);
    },
  );

  test("starts only an active Goal without a live runtime", async () => {
    const runtime = providerStateRuntime("active", undefined, "accepted");
    await expect(
      resolveGoalProviderState(providerStateInput(), runtime),
    ).resolves.toBe("start");
    expect(runtime.dispatcher.drain).not.toHaveBeenCalled();
  });

  test("rejects a paused Goal", async () => {
    const runtime = providerStateRuntime("paused", {}, "accepted");
    await expect(
      resolveGoalProviderState(providerStateInput(), runtime),
    ).rejects.toThrow("Goal is not active (paused)");
    expect(runtime.sessions.resolve).not.toHaveBeenCalled();
  });

  test("converges a completed replay without starting another provider", async () => {
    const runtime = providerStateRuntime("completed", {}, "superseded");
    const startProvider = vi.fn();
    await startLoopDecisionGoal("user-a", decision, {
      startGoal: vi.fn(async () => command()),
      providerState: (input) => resolveGoalProviderState(input, runtime),
      startProvider,
    });

    expect(startProvider).not.toHaveBeenCalled();
    expect(runtime.sessions.resolve).not.toHaveBeenCalled();
    expect(runtime.dispatcher.drain).not.toHaveBeenCalled();
  });

  test("does not attach non-connector signals as connector context", () => {
    const sourceSignal = decision.source_signal;
    if (!sourceSignal) throw new Error("source signal fixture is required");
    expect(
      connectorGoalContext({
        ...decision,
        source_signal: {
          ...sourceSignal,
          source: "openloomi-memory",
          _origin: "insights",
          sourceAccount: undefined,
        },
      }),
    ).toBeUndefined();
  });

  test("requires a current live transport before draining this instruction", async () => {
    const drain = vi.fn(async () => ({
      status: "accepted" as "accepted" | "superseded",
    }));
    const runtime = {
      runtimeSessions: {
        get: vi.fn(async () => ({ providerSessionId: "provider-old" })),
      },
      sessions: { resolve: vi.fn(async () => undefined) },
      dispatcher: { drain },
    } as unknown as AgentGoalRuntime;
    const input = {
      ownerId: "user-a",
      runtimeSessionId: "runtime-a",
      goalId: "goal-a",
      instructionId: "instruction-1",
    };

    await expect(isGoalProviderReady(input, runtime)).resolves.toBe(false);
    expect(drain).not.toHaveBeenCalled();
    vi.mocked(runtime.sessions.resolve).mockResolvedValue({} as never);
    drain.mockResolvedValueOnce({ status: "superseded" as const });
    await expect(isGoalProviderReady(input, runtime)).resolves.toBe(false);
    await expect(isGoalProviderReady(input, runtime)).resolves.toBe(true);
    expect(drain).toHaveBeenCalledWith({
      ownerId: "user-a",
      runtimeSessionId: "runtime-a",
      targetInstructionId: "instruction-1",
    });
  });

  test("streams a Goal session without accumulating its output", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          [
            'data: {"type":"session","sessionId":"early-session"}',
            'data: {"type":"text","content":"large output"}',
            'data: {"type":"result","content":{"ok":true}}',
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await invokeAgentPrompt("Finish the Goal", {
        ownerId: "user-a",
        sessionId: "goal-session-1",
        signal: controller.signal,
        collectOutput: false,
      });

      expect(result).toEqual({
        ok: true,
        status: 200,
        result: { ok: true },
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        prompt: "Finish the Goal",
        sessionId: "goal-session-1",
      });
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: "Bearer owner-token",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function command(): GoalCommandResult {
  return {
    goal: {
      goal: {
        id: "10000000-0000-4000-8000-000000000001",
        revision: 1,
      },
    },
    dispatch: { status: "accepted" },
    instruction: { id: "instruction-1" },
  } as GoalCommandResult;
}

function providerStateInput() {
  return {
    ownerId: "user-a",
    runtimeSessionId: "runtime-a",
    goalId: "goal-a",
    instructionId: "instruction-1",
  };
}

function providerStateRuntime(
  status: "active" | "paused" | "completed",
  live: unknown,
  dispatchStatus: GoalCommandResult["dispatch"]["status"],
): AgentGoalRuntime {
  return {
    queries: {
      getById: vi.fn(async () => ({ goal: { goal: { status } } })),
    },
    sessions: { resolve: vi.fn(async () => live) },
    dispatcher: { drain: vi.fn(async () => ({ status: dispatchStatus })) },
  } as unknown as AgentGoalRuntime;
}
