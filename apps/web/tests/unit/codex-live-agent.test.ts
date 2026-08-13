import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage } from "@openloomi/ai/agent/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const release = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/ai/extensions/agent/codex/runtime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/ai/extensions/agent/codex/runtime")
    >();
  return {
    ...actual,
    startCodexGoalRuntimeSession: vi.fn(
      async (input: Parameters<typeof actual.startCodexGoalRuntimeSession>[0]) => {
        await input.runtime.start({
          ...input.start,
          recovery: {
            providerSessionId: input.recovery?.providerSessionId ?? "",
            replayableInstructionIds:
              input.recovery?.replayableInstructionIds ?? [],
          },
        });
        await input.runtime.activateRecoveredNotifications();
        return { release };
      },
    ),
  };
});

import { CodexAgent } from "@/lib/ai/extensions/agent/codex";
import { clearCodexRuntimePreflightCache } from "@/lib/ai/extensions/agent/codex/runtime-preflight";
import { startCodexGoalRuntimeSession } from "@/lib/ai/extensions/agent/codex/runtime";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const fakeServerPath = fileURLToPath(
  new URL("./fakes/codex-app-server.cjs", import.meta.url),
);
const tempDirs: string[] = [];

afterEach(async () => {
  clearCodexRuntimePreflightCache();
  vi.mocked(startCodexGoalRuntimeSession).mockClear();
  while (tempDirs.length) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("CodexAgent live app-server wiring", () => {
  it("resumes the exact persisted thread without a replacement turn", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "openloomi-codex-resume-"));
    tempDirs.push(workDir);
    const requestLog = join(workDir, "requests.json");
    await copyFile(fakeServerPath, join(workDir, "app-server"));
    const agent = new CodexAgent({
      provider: "codex",
      workDir,
      providerConfig: {
        codexPath: process.execPath,
        env: { FAKE_CODEX_REQUEST_LOG: requestLog },
      },
    });

    const messages: AgentMessage[] = [];
    for await (const message of agent.run("recovery bootstrap", {
      session: { user: { id: "authenticated-owner" } },
      runtimeRecovery: {
        runtimeSessionId: SESSION_ID,
        providerSessionId: "thread-recovered",
        workingDirectory: workDir,
        runEpoch: 2,
        instructionSettlements: [],
        replayableInstructionIds: [],
      },
    })) {
      messages.push(message);
    }

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", content: "recovered reply" }),
        expect.objectContaining({ type: "result" }),
      ]),
    );
    expect(startCodexGoalRuntimeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          providerSessionId: "thread-recovered",
          runEpoch: 2,
        }),
      }),
    );
    const requests = JSON.parse(await readFile(requestLog, "utf8")) as Array<{
      method?: string;
    }>;
    expect(requests.map(({ method }) => method)).toContain("thread/resume");
    expect(requests.map(({ method }) => method)).not.toContain("thread/start");
    expect(requests.map(({ method }) => method)).not.toContain("turn/start");
  });
});
