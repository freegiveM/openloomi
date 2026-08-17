import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter, join } from "node:path";
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
  probeNativeHermesRuntime,
  probeNativeOpenClawRuntime,
  probeNativeOpenCodeRuntime,
} = await import("@/lib/ai/native-agent/runtime-probe");
const { resolveCodexCommand } =
  await import("@/lib/ai/extensions/agent/codex/command-resolver");

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

function hangingProcess(): ChildProcess {
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
  return child as ChildProcess;
}

describe("native agent runtime probes", () => {
  beforeEach(() => {
    clearNativeRuntimeCaches();
    spawnMock.mockReset();
    existingPaths.clear();
    Reflect.deleteProperty(process.env, "CLAUDE_CODE_PATH");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_CODEX_COMMAND");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_OPENCODE_COMMAND");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_HERMES_COMMAND");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_HERMES_PROFILE");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_OPENCLAW_COMMAND");
  });

  afterEach(() => {
    vi.useRealTimers();
    clearNativeRuntimeCaches();
    Reflect.deleteProperty(process.env, "CLAUDE_CODE_PATH");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_CODEX_COMMAND");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_OPENCODE_COMMAND");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_HERMES_COMMAND");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_HERMES_PROFILE");
    Reflect.deleteProperty(process.env, "OPENLOOMI_AGENT_OPENCLAW_COMMAND");
    vi.unstubAllEnvs();
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

  test("uses a least-privilege environment for readiness commands", async () => {
    process.env.CLAUDE_CODE_PATH = "C:\\fake\\claude.exe";
    existingPaths.add(process.env.CLAUDE_CODE_PATH);
    vi.stubEnv("DATABASE_URL", "postgres://must-not-leak");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "C:\\fake\\claude-config");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "claude-auth-token");
    vi.stubEnv("OPENAI_API_KEY", "must-not-reach-claude");
    vi.stubEnv("CODEX_API_KEY", "must-not-reach-claude");
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "2.1.3" }))
      .mockImplementationOnce(() => completedProcess({ stdout: "ok" }));

    await probeNativeClaudeRuntime();

    const spawnedEnvironment = spawnMock.mock.calls[0]?.[2]?.env;
    expect(spawnedEnvironment).not.toHaveProperty("DATABASE_URL");
    expect(spawnedEnvironment).not.toHaveProperty("OPENAI_API_KEY");
    expect(spawnedEnvironment).not.toHaveProperty("CODEX_API_KEY");
    expect(spawnedEnvironment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "claude-auth-token",
      CLAUDE_CONFIG_DIR: "C:\\fake\\claude-config",
      CLAUDECODE: "",
    });
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

  test("probes a bundled legacy cli.js with its bundled Node runtime", async () => {
    const bundleDirectory = join(process.cwd(), "apps", "web", "cli-bundle");
    const cliPath = join(bundleDirectory, "cli.js");
    const nodePath = join(
      bundleDirectory,
      process.platform === "win32" ? "node.exe" : "node",
    );
    existingPaths.add(cliPath);
    existingPaths.add(join(bundleDirectory, "vendor"));
    existingPaths.add(nodePath);
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "2.1.3" }))
      .mockImplementationOnce(() => completedProcess({ stdout: "ok" }));

    const probe = await probeNativeClaudeRuntime();

    expect(probe).toMatchObject({
      ready: true,
      cliPathSource: "BUNDLED",
    });
    expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual([
      nodePath,
      ["--max-old-space-size=8192", cliPath, "--version"],
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "--max-old-space-size=8192",
      cliPath,
      "auth",
      "status",
    ]);
  });

  test("checks Codex with login status and supports a forced refresh", async () => {
    process.env.OPENLOOMI_AGENT_CODEX_COMMAND = "C:\\fake\\codex.cmd";
    existingPaths.add(process.env.OPENLOOMI_AGENT_CODEX_COMMAND);
    vi.stubEnv("OPENAI_API_KEY", "codex-model-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "must-not-reach-codex");
    spawnMock
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "codex-cli 1.2.0" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Logged in using ChatGPT" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "--json  Print events as JSONL" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "codex-cli 1.2.1" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Logged in using ChatGPT" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "--json  Print events as JSONL" }),
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
    expect(spawnMock.mock.calls[2]?.[1]).toEqual(["exec", "--help"]);
    expect(spawnMock.mock.calls[0]?.[2]?.env).toMatchObject({
      OPENAI_API_KEY: "codex-model-key",
    });
    expect(spawnMock.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      "ANTHROPIC_AUTH_TOKEN",
    );
    expect(spawnMock).toHaveBeenCalledTimes(6);
  });

  test("does not report an incomplete native Codex bundle as ready", async () => {
    const incompleteDirectory = join(process.cwd(), "incomplete-codex");
    existingPaths.add(join(incompleteDirectory, "codex.exe"));
    spawnMock
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "codex-cli 1.2.0" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Logged in using ChatGPT" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "--json  Print events as JSONL" }),
      );

    const probe = await probeNativeCodexRuntime({
      force: true,
      resolverOptions: {
        platform: "win32",
        searchPath: incompleteDirectory,
      },
    });

    expect(probe).toMatchObject({
      available: false,
      ready: false,
      reason: "CODEX_CLI_UNAVAILABLE",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("probes the same complete PATH bundle selected by the runtime resolver", async () => {
    const incompleteDirectory = join(process.cwd(), "incomplete-codex");
    const completeDirectory = join(process.cwd(), "complete-codex");
    existingPaths.add(join(incompleteDirectory, "codex.exe"));
    existingPaths.add(join(completeDirectory, "codex.exe"));
    existingPaths.add(
      join(completeDirectory, "codex-windows-sandbox-setup.exe"),
    );
    existingPaths.add(join(completeDirectory, "codex-command-runner.exe"));
    const resolverOptions = {
      platform: "win32" as const,
      searchPath: [incompleteDirectory, completeDirectory].join(delimiter),
    };
    const expectedCommand = resolveCodexCommand(resolverOptions);
    spawnMock
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "codex-cli 1.2.0" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Logged in using ChatGPT" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "--json  Print events as JSONL" }),
      );

    const probe = await probeNativeCodexRuntime({
      force: true,
      resolverOptions,
    });

    expect(probe?.ready).toBe(true);
    expect(spawnMock.mock.calls[0]?.[0]).toBe(expectedCommand);
    expect(spawnMock.mock.calls[1]?.[0]).toBe(expectedCommand);
    expect(spawnMock.mock.calls[2]?.[0]).toBe(expectedCommand);
  });

  test("checks OpenCode credentials and JSON output capability", async () => {
    process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND = "C:\\fake\\opencode.exe";
    existingPaths.add(process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND);
    spawnMock
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "opencode 1.0.12" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "anthropic\nopenai" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "--format <format>  default or json" }),
      );

    const probe = await probeNativeOpenCodeRuntime();

    expect(probe).toMatchObject({
      provider: "opencode",
      ready: true,
      authenticated: true,
      version: "1.0.12",
      reason: "OPENCODE_CLI_AUTHENTICATED",
    });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(["auth", "list"]);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual(["run", "--help"]);
  });

  test("reports OpenCode as needing sign-in when no credentials are listed", async () => {
    process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND = "C:\\fake\\opencode.exe";
    existingPaths.add(process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND);
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "1.0.12" }))
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "No credentials found" }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "--format <format>  default or json" }),
      );

    const probe = await probeNativeOpenCodeRuntime();

    expect(probe).toMatchObject({
      available: true,
      ready: false,
      reason: "OPENCODE_CLI_AUTH_REQUIRED",
    });
  });

  test("checks Hermes setup and ACP capability", async () => {
    process.env.OPENLOOMI_AGENT_HERMES_COMMAND = "C:\\fake\\hermes.exe";
    process.env.OPENLOOMI_AGENT_HERMES_PROFILE = "coding";
    existingPaths.add(process.env.OPENLOOMI_AGENT_HERMES_COMMAND);
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "0.9.0" }))
      .mockImplementationOnce(() =>
        completedProcess({
          stdout:
            "Provider: OpenRouter\nModel: test\nOpenRouter    ✓ configured",
        }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Commands:\n  acp" }),
      );

    const probe = await probeNativeHermesRuntime();

    expect(probe).toMatchObject({
      provider: "hermes",
      ready: true,
      version: "0.9.0",
      reason: "HERMES_CLI_AUTHENTICATED",
    });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "--profile",
      "coding",
      "status",
    ]);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual(["--help"]);
  });

  test("does not report an unconfigured Hermes install as ready", async () => {
    process.env.OPENLOOMI_AGENT_HERMES_COMMAND = "C:\\fake\\hermes.exe";
    existingPaths.add(process.env.OPENLOOMI_AGENT_HERMES_COMMAND);
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "0.9.0" }))
      .mockImplementationOnce(() =>
        completedProcess({
          stdout:
            "Provider: OpenRouter\nModel: (not set)\nOpenRouter    ✗ (not set)",
        }),
      )
      .mockImplementationOnce(() =>
        completedProcess({ stdout: "Commands:\n  acp" }),
      );

    const probe = await probeNativeHermesRuntime();

    expect(probe).toMatchObject({
      provider: "hermes",
      ready: false,
      reason: "HERMES_CLI_AUTH_REQUIRED",
    });
  });

  test("checks OpenClaw Gateway readiness without starting a task", async () => {
    process.env.OPENLOOMI_AGENT_OPENCLAW_COMMAND = "C:\\fake\\openclaw.cmd";
    existingPaths.add(process.env.OPENLOOMI_AGENT_OPENCLAW_COMMAND);
    spawnMock
      .mockImplementationOnce(() => completedProcess({ stdout: "2026.7.1" }))
      .mockImplementationOnce(() =>
        completedProcess({ stdout: '{"rpc":{"ok":true}}' }),
      );

    const probe = await probeNativeOpenClawRuntime();

    expect(probe).toMatchObject({
      provider: "openclaw",
      ready: true,
      version: "2026.7.1",
      reason: "OPENCLAW_CLI_AUTHENTICATED",
    });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "gateway",
      "status",
      "--require-rpc",
      "--json",
      "--timeout",
      "4000",
    ]);
  });

  test("bounds all checks for one runtime to a single timeout window", async () => {
    vi.useFakeTimers();
    process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND = "C:\\fake\\opencode.exe";
    existingPaths.add(process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND);
    spawnMock.mockImplementation(() => hangingProcess());

    const pending = probeNativeOpenCodeRuntime();
    await vi.advanceTimersByTimeAsync(10_000);
    const probe = await pending;

    expect(probe).toMatchObject({
      ready: false,
      reason: "OPENCODE_CLI_VERSION_TIMEOUT",
    });
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });
});
