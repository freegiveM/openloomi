import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const existingPaths = vi.hoisted(() => new Set<string>());

vi.mock("cross-spawn", () => ({ default: spawnMock }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => existingPaths.has(path)),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock("@/lib/utils/logger", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@/lib/ai/extensions/agent/cli-process", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/ai/extensions/agent/cli-process")
    >();
  return {
    ...actual,
    shouldDetachCliProcess: vi.fn(() => false),
    terminateCliProcessTree: vi.fn(),
  };
});

const {
  clearNativeRuntimeCaches,
  probeNativeClaudeRuntime,
  probeNativeCodexRuntime,
} = await import("@/lib/ai/native-agent/runtime-probe");

function completedProcess({
  code = 0,
  stdout = "",
  stderr = "",
}: {
  code?: number;
  stdout?: string;
  stderr?: string;
} = {}): ChildProcess {
  type MutableChildProcess = {
    -readonly [Key in keyof ChildProcess]: ChildProcess[Key];
  };
  const child = new EventEmitter() as MutableChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = null;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1234;
  child.kill = vi.fn(() => true);

  queueMicrotask(() => {
    if (stdout) child.stdout?.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr?.emit("data", Buffer.from(stderr));
    child.exitCode = code;
    child.emit("close", code);
  });
  return child as ChildProcess;
}

describe("native agent runtime probes", () => {
  beforeEach(() => {
    clearNativeRuntimeCaches();
    spawnMock.mockReset();
    existingPaths.clear();
    Reflect.deleteProperty(process.env, "CLAUDE_CODE_PATH");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_CODEX_COMMAND");
  });

  afterEach(() => {
    clearNativeRuntimeCaches();
    Reflect.deleteProperty(process.env, "CLAUDE_CODE_PATH");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_CODEX_COMMAND");
  });

  test("returns a structured failure when spawning Claude fails synchronously", async () => {
    process.env.CLAUDE_CODE_PATH = "C:\\fake\\claude.exe";
    existingPaths.add(process.env.CLAUDE_CODE_PATH);
    spawnMock.mockImplementation(() => {
      throw new Error("spawn boom");
    });

    const probe = await probeNativeClaudeRuntime();

    expect(probe?.ready).toBe(false);
    expect(probe?.reason).toBe("CLAUDE_CLI_VERSION_FAILED");
    expect(probe?.probes.version?.error).toEqual({
      code: "SPAWN_FAILED",
      message: "spawn boom",
    });
  });

  test("reports an authenticated Claude CLI and reuses the short-lived cache", async () => {
    process.env.CLAUDE_CODE_PATH = "C:\\fake\\claude.exe";
    existingPaths.add(process.env.CLAUDE_CODE_PATH);
    spawnMock
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "2.1.3 (Claude Code)" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Authenticated" }),
      );

    const [first, second] = await Promise.all([
      probeNativeClaudeRuntime(),
      probeNativeClaudeRuntime(),
    ]);

    expect(first).toMatchObject({
      provider: "claude",
      available: true,
      authenticated: true,
      ready: true,
      version: "2.1.3",
      reason: "CLAUDE_CLI_AUTHENTICATED",
    });
    expect(second).toBe(first);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(["auth", "status"]);
  });

  test("distinguishes a Claude sign-in requirement from an unavailable CLI", async () => {
    process.env.CLAUDE_CODE_PATH = "C:\\fake\\claude.exe";
    existingPaths.add(process.env.CLAUDE_CODE_PATH);
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "2.1.3" }))
      .mockImplementationOnce(() =>
        completedProcess({ code: 1, stderr: "Not authenticated" }),
      );

    const needsLogin = await probeNativeClaudeRuntime();
    clearNativeRuntimeCaches();
    existingPaths.clear();
    Reflect.deleteProperty(process.env, "CLAUDE_CODE_PATH");
    const unavailable = await probeNativeClaudeRuntime();

    expect(needsLogin?.reason).toBe("CLAUDE_CLI_AUTH_REQUIRED");
    expect(needsLogin?.available).toBe(true);
    expect(unavailable?.reason).toBe("CLAUDE_CLI_UNAVAILABLE");
    expect(unavailable?.available).toBe(false);
  });

  test("checks Codex with login status and supports a forced refresh", async () => {
    process.env.OPENLOOMI_AGENT_CODEX_COMMAND = "C:\\fake\\codex.cmd";
    existingPaths.add(process.env.OPENLOOMI_AGENT_CODEX_COMMAND);
    spawnMock
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "codex-cli 1.2.0" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Logged in using ChatGPT" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "codex-cli 1.2.1" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Logged in using ChatGPT" }),
      );

    const initial = await probeNativeCodexRuntime();
    const refreshed = await probeNativeCodexRuntime({ force: true });

    expect(initial).toMatchObject({
      provider: "codex",
      ready: true,
      version: "1.2.0",
      reason: "CODEX_CLI_AUTHENTICATED",
    });
    expect(refreshed?.version).toBe("1.2.1");
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(["login", "status"]);
    expect(spawnMock).toHaveBeenCalledTimes(4);
  });
});
