import { beforeEach, describe, expect, test, vi } from "vitest";

const afterState = vi.hoisted(() => ({
  callbacks: [] as Array<() => void | Promise<void>>,
}));
const authState = vi.hoisted(() => ({
  user: { id: "owner-a" } as { id: string } | null,
}));
const modeState = vi.hoisted(() => ({ tauri: true }));
const databaseState = vi.hoisted(() => ({ source: {} }));
const readPresentations = vi.hoisted(() => vi.fn());
const startRecovery = vi.hoisted(() => vi.fn());

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((callback: () => void | Promise<void>) => {
    afterState.callbacks.push(callback);
  }),
}));
vi.mock("@/lib/auth/dual-auth", () => ({
  getAuthUser: vi.fn(async () => authState.user),
}));
vi.mock("@/lib/env/constants", () => ({
  isTauriMode: vi.fn(() => modeState.tauri),
}));
vi.mock("@/lib/db/shared/helpers", () => ({
  getDbInstance: vi.fn(() => databaseState.source),
}));
vi.mock(
  "@/lib/ai/runtime-instructions/recovery/presentation-read-model",
  () => ({
    readAgentGoalRecoveryPresentations: readPresentations,
  }),
);
vi.mock("@/lib/ai/runtime-instructions/recovery/startup", () => ({
  startAgentGoalRuntimeRecovery: startRecovery,
}));

const { GET } = await import("@/app/api/agent-goals/runtime-sessions/route");

describe("Goal Runtime recovery sessions route", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        __openLoomiGoalRecoveryScheduled?: boolean;
      }
    ).__openLoomiGoalRecoveryScheduled = undefined;
    afterState.callbacks.length = 0;
    authState.user = { id: "owner-a" };
    modeState.tauri = true;
    readPresentations.mockReset();
    readPresentations.mockReturnValue([
      {
        runtimeSessionId: "chat-a",
        chat: {
          title: "Recovered chat",
          createdAt: "2026-08-14T08:00:00.000Z",
        },
      },
    ]);
    startRecovery.mockReset();
    startRecovery.mockResolvedValue({ scanned: 0, outcomes: [] });
  });

  test("returns the owner-scoped read model before recovery starts", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          runtimeSessionId: "chat-a",
          chat: {
            title: "Recovered chat",
            createdAt: "2026-08-14T08:00:00.000Z",
          },
        },
      ],
    });
    expect(readPresentations).toHaveBeenCalledWith(
      databaseState.source,
      "owner-a",
    );
    expect(startRecovery).not.toHaveBeenCalled();
    expect(afterState.callbacks).toHaveLength(1);

    await afterState.callbacks[0]?.();
    expect(startRecovery).toHaveBeenCalledTimes(1);
  });

  test("schedules recovery only once across polling requests", async () => {
    await GET(request());
    await GET(request());

    expect(readPresentations).toHaveBeenCalledTimes(2);
    expect(afterState.callbacks).toHaveLength(1);
    await afterState.callbacks[0]?.();
    expect(startRecovery).toHaveBeenCalledTimes(1);
  });

  test("allows a later request to retry a failed recovery startup", async () => {
    startRecovery.mockRejectedValueOnce(new Error("startup failed"));
    await GET(request());
    await afterState.callbacks[0]?.();

    await GET(request());
    expect(afterState.callbacks).toHaveLength(2);
    await afterState.callbacks[1]?.();
    expect(startRecovery).toHaveBeenCalledTimes(2);
  });

  test("does not read or schedule without an authenticated desktop owner", async () => {
    authState.user = null;
    const unauthorized = await GET(request());
    expect(unauthorized.status).toBe(401);

    authState.user = { id: "owner-a" };
    modeState.tauri = false;
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503);
    expect(readPresentations).not.toHaveBeenCalled();
    expect(afterState.callbacks).toHaveLength(0);
  });
});

function request(): Request {
  return new Request("http://localhost/api/agent-goals/runtime-sessions");
}
