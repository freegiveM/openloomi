/**
 * Server-side readiness probes for the local Claude Code and Codex CLIs.
 *
 * Probes are deliberately read-only: they check the executable version and
 * the CLI's own authentication status without starting a model request. Raw
 * probe output stays server-side; UI routes must translate these structures
 * into the safe summary exported by `runtime-settings.ts`.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import spawn from "cross-spawn";

import {
  appendCapturedCliOutput,
  shouldDetachCliProcess,
  terminateCliProcessTree,
} from "@/lib/ai/extensions/agent/cli-process";
import { createLogger } from "@/lib/utils/logger";

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;

const logger = createLogger("NativeAgentRuntime");

export type NativeRuntimeStatus =
  | "CLAUDE_CLI_AUTHENTICATED"
  | "CLAUDE_CLI_AUTH_REQUIRED"
  | "CLAUDE_CLI_AUTH_STATUS_TIMEOUT"
  | "CLAUDE_CLI_AUTH_STATUS_UNAVAILABLE"
  | "CLAUDE_CLI_VERSION_FAILED"
  | "CLAUDE_CLI_VERSION_TIMEOUT"
  | "CLAUDE_CLI_UNAVAILABLE";

export type CodexRuntimeStatus =
  | "CODEX_CLI_AUTHENTICATED"
  | "CODEX_CLI_AUTH_REQUIRED"
  | "CODEX_CLI_AUTH_STATUS_TIMEOUT"
  | "CODEX_CLI_AUTH_STATUS_UNAVAILABLE"
  | "CODEX_CLI_VERSION_FAILED"
  | "CODEX_CLI_VERSION_TIMEOUT"
  | "CODEX_CLI_UNAVAILABLE";

export type ProbeResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: { code: string; message: string } | null;
  elapsedMs: number;
  timedOut: boolean;
};

type CliPathSource =
  | "BUNDLED"
  | "PATH"
  | "CLAUDE_CODE_PATH"
  | "OPENLOOMI_AGENT_CODEX_COMMAND"
  | "FALLBACK"
  | null;

type BaseRuntimeProbe<
  Provider extends "claude" | "codex",
  Status extends string,
> = {
  checked: true;
  provider: Provider;
  available: boolean;
  authenticated: boolean;
  active: boolean;
  ready: boolean;
  reason: Status;
  cliPathPresent: boolean;
  cliPathSource: CliPathSource;
  versionPresent: boolean;
  version: string | null;
  probes: {
    version?: ProbeResult;
    auth?: ProbeResult;
  };
};

export type NativeRuntimeProbe = BaseRuntimeProbe<
  "claude",
  NativeRuntimeStatus
> & {
  // Kept for the existing `/api/preferences/ai` plugin contract.
  defaultAgent: "claude";
};

export type CodexRuntimeProbe = BaseRuntimeProbe<"codex", CodexRuntimeStatus>;

type RuntimeDefinition<
  Provider extends "claude" | "codex",
  Status extends string,
> = {
  provider: Provider;
  binary: Provider;
  explicitCommand: string | undefined;
  explicitSource: Exclude<CliPathSource, null>;
  authArgs: readonly string[];
  status: {
    ready: Status;
    authRequired: Status;
    authTimeout: Status;
    authUnavailable: Status;
    versionFailed: Status;
    versionTimeout: Status;
    unavailable: Status;
  };
};

let claudeCache: { at: number; value: NativeRuntimeProbe } | null = null;
let codexCache: { at: number; value: CodexRuntimeProbe } | null = null;
let claudeInFlight: Promise<NativeRuntimeProbe> | null = null;
let codexInFlight: Promise<CodexRuntimeProbe> | null = null;

function candidateBinaries(binary: string): string[] {
  if (platform() === "win32") {
    return [`${binary}.exe`, `${binary}.cmd`, binary];
  }
  return [binary];
}

/**
 * Desktop apps do not inherit the user's interactive shell PATH. Include the
 * common package-manager locations used by both supported runtimes.
 */
function buildCliSearchPath(): string {
  const home = homedir();
  const dirs: string[] = [process.env.PATH || ""];

  if (platform() === "win32") {
    dirs.push(
      join(home, "AppData", "Roaming", "npm"),
      join(home, "AppData", "Local", "Programs", "nodejs"),
      join(home, ".volta", "bin"),
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
    );
  } else {
    dirs.push(
      "/usr/local/bin",
      "/opt/homebrew/bin",
      join(home, ".local", "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".volta", "bin"),
      join(home, ".bun", "bin"),
      join(home, "Library", "pnpm"),
      join(home, ".local", "share", "pnpm"),
      join(home, "code", "node", "npm_global", "bin"),
    );
  }

  return Array.from(new Set(dirs.filter(Boolean))).join(delimiter);
}

function listNvmBinaries(binary: string): string[] {
  try {
    const nvmBase = join(homedir(), ".nvm", "versions", "node");
    if (!existsSync(nvmBase)) return [];
    return readdirSync(nvmBase)
      .sort()
      .reverse()
      .map((version) => join(nvmBase, version, "bin", binary))
      .filter((candidate) => existsSync(candidate));
  } catch {
    return [];
  }
}

/** Current desktop bundles include a platform-native Claude executable. */
function resolveBundledClaudePath(): string | null {
  const executableDirectory = dirname(process.execPath);
  const bundleDirectories = [
    join(process.cwd(), "apps", "web", "cli-bundle"),
    join(process.cwd(), "cli-bundle"),
    join(process.cwd(), "..", "web", "cli-bundle"),
    join(executableDirectory, "cli-bundle"),
    join(executableDirectory, "..", "Resources", "cli-bundle"),
    join(
      executableDirectory,
      "..",
      "Resources",
      "_up_",
      "src-api",
      "dist",
      "cli-bundle",
    ),
    join(executableDirectory, "_up_", "src-api", "dist", "cli-bundle"),
  ];
  const executable = platform() === "win32" ? "claude.exe" : "claude";

  for (const directory of bundleDirectories) {
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isBareCommand(command: string): boolean {
  const parsed = parse(command);
  return parsed.dir.length === 0 && parsed.base === command;
}

function resolveCliPath(
  definition: RuntimeDefinition<"claude" | "codex", string>,
): { path: string | null; source: CliPathSource; searchPath: string } {
  const searchPath = buildCliSearchPath();

  if (definition.provider === "claude") {
    const bundled = resolveBundledClaudePath();
    if (bundled) {
      return { path: bundled, source: "BUNDLED", searchPath };
    }
  }

  const explicit = definition.explicitCommand?.trim();
  if (explicit) {
    if (existsSync(explicit) || isBareCommand(explicit)) {
      return {
        path: explicit,
        source: definition.explicitSource,
        searchPath,
      };
    }
  }

  const pathDirectories = searchPath
    .split(delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const binary of candidateBinaries(definition.binary)) {
    for (const directory of pathDirectories) {
      const candidate = join(directory, binary);
      if (existsSync(candidate)) {
        return { path: candidate, source: "PATH", searchPath };
      }
    }
  }

  const [fallback] = listNvmBinaries(definition.binary);
  if (fallback) {
    return { path: fallback, source: "FALLBACK", searchPath };
  }

  return { path: null, source: null, searchPath };
}

function runCli(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  searchPath: string,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let processHandle: ChildProcess;
    try {
      processHandle = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: shouldDetachCliProcess(),
        env: { ...process.env, PATH: searchPath, CLAUDECODE: "" },
        windowsHide: true,
      });
    } catch (error) {
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        error: {
          code: "SPAWN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
      });
      return;
    }

    processHandle.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendCapturedCliOutput(stdout, chunk.toString());
    });
    processHandle.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendCapturedCliOutput(stderr, chunk.toString());
    });

    timer = setTimeout(() => {
      terminateCliProcessTree(processHandle);
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode: processHandle.exitCode,
        error: null,
        elapsedMs: Date.now() - startedAt,
        timedOut: true,
      });
    }, timeoutMs);

    processHandle.once("error", (error) => {
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        error: { code: "SPAWN_FAILED", message: error.message },
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    processHandle.once("close", (code) => {
      settle({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        error: null,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}

function cleanVersion(result: ProbeResult): string | null {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) return null;
  // Only publish the semantic version token. A CLI can print warnings,
  // usernames, or local paths around it; those details stay server-side.
  return (
    line.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null
  );
}

function isAuthCommandUnavailable(result: ProbeResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("unknown command") ||
    combined.includes("unrecognized subcommand") ||
    combined.includes("invalid command")
  );
}

async function probeCliRuntime<
  Provider extends "claude" | "codex",
  Status extends string,
>(definition: RuntimeDefinition<Provider, Status>) {
  const resolved = resolveCliPath(
    definition as RuntimeDefinition<"claude" | "codex", string>,
  );
  const base = { checked: true as const, provider: definition.provider };

  if (!resolved.path) {
    return {
      ...base,
      available: false,
      authenticated: false,
      active: false,
      ready: false,
      reason: definition.status.unavailable,
      cliPathPresent: false,
      cliPathSource: null,
      versionPresent: false,
      version: null,
      probes: {},
    };
  }

  const versionProbe = await runCli(
    resolved.path,
    ["--version"],
    PROBE_TIMEOUT_MS,
    resolved.searchPath,
  );
  if (!versionProbe.ok) {
    const result = {
      ...base,
      available: true,
      authenticated: false,
      active: false,
      ready: false,
      reason: versionProbe.timedOut
        ? definition.status.versionTimeout
        : definition.status.versionFailed,
      cliPathPresent: true,
      cliPathSource: resolved.source,
      versionPresent: false,
      version: null,
      probes: { version: versionProbe },
    };
    logger.warn(
      `[NativeAgentRuntime] ${definition.provider} version probe failed: ${result.reason}`,
    );
    return result;
  }

  const authProbe = await runCli(
    resolved.path,
    definition.authArgs,
    PROBE_TIMEOUT_MS,
    resolved.searchPath,
  );
  if (!authProbe.ok) {
    const reason = authProbe.timedOut
      ? definition.status.authTimeout
      : isAuthCommandUnavailable(authProbe)
        ? definition.status.authUnavailable
        : definition.status.authRequired;
    return {
      ...base,
      available: true,
      authenticated: false,
      active: false,
      ready: false,
      reason,
      cliPathPresent: true,
      cliPathSource: resolved.source,
      versionPresent: true,
      version: cleanVersion(versionProbe),
      probes: { version: versionProbe, auth: authProbe },
    };
  }

  return {
    ...base,
    available: true,
    authenticated: true,
    active: true,
    ready: true,
    reason: definition.status.ready,
    cliPathPresent: true,
    cliPathSource: resolved.source,
    versionPresent: true,
    version: cleanVersion(versionProbe),
    probes: { version: versionProbe, auth: authProbe },
  };
}

export async function probeNativeClaudeRuntime(
  options: { force?: boolean } = {},
): Promise<NativeRuntimeProbe | null> {
  if (
    !options.force &&
    claudeCache &&
    Date.now() - claudeCache.at < CACHE_TTL_MS
  ) {
    return claudeCache.value;
  }
  if (claudeInFlight) return claudeInFlight;

  const operation = probeCliRuntime({
    provider: "claude",
    binary: "claude",
    explicitCommand: process.env.CLAUDE_CODE_PATH,
    explicitSource: "CLAUDE_CODE_PATH",
    authArgs: ["auth", "status"],
    status: {
      ready: "CLAUDE_CLI_AUTHENTICATED",
      authRequired: "CLAUDE_CLI_AUTH_REQUIRED",
      authTimeout: "CLAUDE_CLI_AUTH_STATUS_TIMEOUT",
      authUnavailable: "CLAUDE_CLI_AUTH_STATUS_UNAVAILABLE",
      versionFailed: "CLAUDE_CLI_VERSION_FAILED",
      versionTimeout: "CLAUDE_CLI_VERSION_TIMEOUT",
      unavailable: "CLAUDE_CLI_UNAVAILABLE",
    },
  }).then((result) => {
    const probe: NativeRuntimeProbe = { ...result, defaultAgent: "claude" };
    claudeCache = { at: Date.now(), value: probe };
    return probe;
  });
  claudeInFlight = operation;
  try {
    return await operation;
  } finally {
    if (claudeInFlight === operation) claudeInFlight = null;
  }
}

export async function probeNativeCodexRuntime(
  options: { force?: boolean } = {},
): Promise<CodexRuntimeProbe | null> {
  if (
    !options.force &&
    codexCache &&
    Date.now() - codexCache.at < CACHE_TTL_MS
  ) {
    return codexCache.value;
  }
  if (codexInFlight) return codexInFlight;

  const operation = probeCliRuntime({
    provider: "codex",
    binary: "codex",
    explicitCommand: process.env.OPENLOOMI_AGENT_CODEX_COMMAND,
    explicitSource: "OPENLOOMI_AGENT_CODEX_COMMAND",
    authArgs: ["login", "status"],
    status: {
      ready: "CODEX_CLI_AUTHENTICATED",
      authRequired: "CODEX_CLI_AUTH_REQUIRED",
      authTimeout: "CODEX_CLI_AUTH_STATUS_TIMEOUT",
      authUnavailable: "CODEX_CLI_AUTH_STATUS_UNAVAILABLE",
      versionFailed: "CODEX_CLI_VERSION_FAILED",
      versionTimeout: "CODEX_CLI_VERSION_TIMEOUT",
      unavailable: "CODEX_CLI_UNAVAILABLE",
    },
  }).then((result) => {
    codexCache = { at: Date.now(), value: result };
    return result;
  });
  codexInFlight = operation;
  try {
    return await operation;
  } finally {
    if (codexInFlight === operation) codexInFlight = null;
  }
}

export function clearNativeClaudeRuntimeCache(): void {
  claudeCache = null;
}

export function clearNativeCodexRuntimeCache(): void {
  codexCache = null;
}

export function clearNativeRuntimeCaches(): void {
  clearNativeClaudeRuntimeCache();
  clearNativeCodexRuntimeCache();
}

export function getRuntimePlatform(): "windows" | "macos" | "linux" {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  return "linux";
}
