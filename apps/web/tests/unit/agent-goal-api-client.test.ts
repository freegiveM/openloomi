import { afterEach, describe, expect, test, vi } from "vitest";

import {
  activateAgentGoal,
  type AgentGoalApiError,
  fetchAgentGoalSession,
  removeAgentGoalContext,
  updateAgentGoal,
  upsertAgentGoalContext,
} from "@/lib/ai/runtime-instructions/api/client";

afterEach(() => vi.unstubAllGlobals());

describe("Agent Goal API client", () => {
  test("sends authenticated idempotent create commands", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { goal: { id: "goal-1" }, dispatch: { status: "unavailable" } },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const goal = {} as Parameters<typeof activateAgentGoal>[0]["goal"];
    await activateAgentGoal(
      { runtimeSessionId: "chat-a", goal },
      "create-once",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("create-once");
    expect(JSON.parse(String(init?.body))).toMatchObject({ runtimeSessionId: "chat-a" });
  });

  test("keeps revision and context commands on their dedicated routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ dispatch: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await updateAgentGoal(
      "goal/a",
      {
        runtimeSessionId: "chat-a",
        expectedRevision: 3,
        update: { objective: "Revised" },
      },
      "update-once",
    );
    await upsertAgentGoalContext(
      "goal/a",
      {
        runtimeSessionId: "chat-a",
        expectedRevision: 4,
        contextRef: { id: "doc", kind: "document", refId: "requirements" },
      },
      "context-once",
    );
    await removeAgentGoalContext(
      "goal/a",
      {
        runtimeSessionId: "chat-a",
        expectedRevision: 5,
        contextRefId: "doc",
      },
      "remove-once",
    );
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/agent-goals/goal%2Fa", "PATCH"],
      ["/api/agent-goals/goal%2Fa/context", "PUT"],
      ["/api/agent-goals/goal%2Fa/context", "DELETE"],
    ]);
    const removeInit = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(removeInit?.body))).toMatchObject({
      expectedRevision: 5,
      contextRefId: "doc",
    });
  });

  test("surfaces structured API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { code: "revision_conflict", cause: "Expected revision 3" },
          409,
        ),
      ),
    );
    await expect(fetchAgentGoalSession("chat-a")).rejects.toMatchObject({
      name: "AgentGoalApiError",
      status: 409,
      code: "revision_conflict",
      details: "Expected revision 3",
    } satisfies Partial<AgentGoalApiError>);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
