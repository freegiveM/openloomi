import { fileURLToPath } from "node:url";

import {
  CodexAppServerClient,
  type CodexAppServerNotification,
  buildCodexAppServerArgs,
  createCodexAppServerTextInput,
} from "@/lib/ai/extensions/agent/codex/app-server";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakeServerPath = fileURLToPath(
  new URL("./fakes/codex-app-server.cjs", import.meta.url),
);
const clients: CodexAppServerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
});

describe("CodexAppServerClient", () => {
  it("keeps OpenLoomi as the only Goal runtime", () => {
    expect(buildCodexAppServerArgs("work")).toEqual([
      "-p",
      "work",
      "app-server",
      "--disable",
      "goals",
      "--stdio",
    ]);
  });

  it("drives one initialized app-server transport", async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fakeServerPath],
      cwd: process.cwd(),
    });
    clients.push(client);
    const notifications: CodexAppServerNotification[] = [];
    client.onNotification((event) => notifications.push(event));

    await expect(client.initialize()).resolves.toBeUndefined();
    const thread = await client.startThread({ cwd: "/workspace" });
    const turn = await client.startTurn({
      threadId: thread.thread.id,
      clientUserMessageId: "instruction-1",
      input: [createCodexAppServerTextInput("work")],
    });
    await expect(
      client.steerTurn({
        threadId: thread.thread.id,
        expectedTurnId: turn.turn.id,
        input: [createCodexAppServerTextInput("continue")],
      }),
    ).resolves.toEqual({ turnId: "turn-1" });
    await client.interruptTurn({
      threadId: thread.thread.id,
      turnId: turn.turn.id,
    });
    await expect(
      client.resumeThread({ threadId: "thread-persisted" }),
    ).resolves.toMatchObject({ thread: { id: "thread-persisted" } });

    await vi.waitFor(() =>
      expect(
        notifications.filter(({ method }) => method === "test/received"),
      ).toHaveLength(7),
    );
  });
});
