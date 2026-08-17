/**
 * Server-side readiness probes for OpenLoomi's supported local agent runtimes.
 *
 * Probes are deliberately read-only: they check the executable version and
 * the CLI's own authentication status without starting a model request. Raw
 * probe output stays server-side; UI routes must translate these structures
 * into the safe summary exported by `runtime-settings.ts`.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, parse } from "node:path";
import spawn from "cross-spawn";

import { getClaudeBundleDirectories } from "@/lib/ai/extensions/agent/claude/cli-locations";
import {
  appendCapturedCliOutput,
  buildAgentCliSearchPath,
  buildCliEnvironment,
  findCliExecutableOnSearchPath,
  shouldDetachCliProcess,
  terminateCliProcessTree,
} from "@/lib/ai/extensions/agent/cli-process";
import {
  resolveCodexCommand,
  type ResolveCodexCommandOptions,
} from "@/lib/ai/extensions/agent/codex/command-resolver";
import { createLogger } from "@/lib/utils/logger";
import { APP_DIR_NAME } from "@/lib/env/config/constants";
import type { SelectableAgentRuntime } from "./runtime-contract";

const PROBE_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30_000;

const logger = createLogger("NativeAgentRuntime");

const PROBE_CREDENTIAL_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
]);
const PROBE_RUNTIME_PREFIXES = ["OPENCODE_", "HERMES_", "OPENCLAW_", "CODEX_"];

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
  | "CODEX_CLI_CAPABILITY_FAILED"
  | "CODEX_CLI_CAPABILITY_TIMEOUT"
  | "CODEX_CLI_VERSION_FAILED"
  | "CODEX_CLI_VERSION_TIMEOUT"
  | "CODEX_CLI_UNAVAILABLE";

export type OpenCodeRuntimeStatus =
  | "OPENCODE_CLI_AUTHENTICATED"
  | "OPENCODE_CLI_AUTH_REQUIRED"
  | "OPENCODE_CLI_AUTH_STATUS_TIMEOUT"
  | "OPENCODE_CLI_AUTH_STATUS_UNAVAILABLE"
  | "OPENCODE_CLI_CAPABILITY_FAILED"
  | "OPENCODE_CLI_CAPABILITY_TIMEOUT"
  | "OPENCODE_CLI_VERSION_FAILED"
  | "OPENCODE_CLI_VERSION_TIMEOUT"
  | "OPENCODE_CLI_UNAVAILABLE";

export type HermesRuntimeStatus =
  | "HERMES_CLI_AUTHENTICATED"
  | "HERMES_CLI_AUTH_REQUIRED"
  | "HERMES_CLI_AUTH_STATUS_TIMEOUT"
  | "HERMES_CLI_AUTH_STATUS_UNAVAILABLE"
  | "HERMES_CLI_CAPABILITY_FAILED"
  | "HERMES_CLI_CAPABILITY_TIMEOUT"
  | "HERMES_CLI_VERSION_FAILED"
  | "HERMES_CLI_VERSION_TIMEOUT"
  | "HERMES_CLI_UNAVAILABLE";

export type OpenClawRuntimeStatus =
  | "OPENCLAW_CLI_AUTHENTICATED"
  | "OPENCLAW_CLI_AUTH_REQUIRED"
  | "OPENCLAW_CLI_AUTH_STATUS_TIMEOUT"
  | "OPENCLAW_CLI_AUTH_STATUS_UNAVAILABLE"
  | "OPENCLAW_CLI_VERSION_FAILED"
  | "OPENCLAW_CLI_VERSION_TIMEOUT"
  | "OPENCLAW_CLI_UNAVAILABLE";

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
  | "OPENLOOMI_AGENT_OPENCODE_COMMAND"
  | "OPENLOOMI_AGENT_HERMES_COMMAND"
  | "OPENLOOMI_AGENT_OPENCLAW_COMMAND"
  | "FALLBACK"
  | null;

type BaseRuntimeProbe<
  Provider extends SelectableAgentRuntime,
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
    capability?: ProbeResult;
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

export type OpenCodeRuntimeProbe = BaseRuntimeProbe<
  "opencode",
  OpenCodeRuntimeStatus
>;

export type HermesRuntimeProbe = BaseRuntimeProbe<
  "hermes",
  HermesRuntimeStatus
>;

export type OpenClawRuntimeProbe = BaseRuntimeProbe<
  "openclaw",
  OpenClawRuntimeStatus
>;

export type AgentRuntimeProbe =
  | NativeRuntimeProbe
  | CodexRuntimeProbe
  | OpenCodeRuntimeProbe
  | HermesRuntimeProbe
  | OpenClawRuntimeProbe;

type RuntimeDefinition<
  Provider extends SelectableAgentRuntime,
  Status extends string,
> = {
  provider: Provider;
  binary: string;
  explicitCommand: string | undefined;
  explicitSource: Exclude<CliPathSource, null>;
  authArgs: readonly string[];
  authResultReady?: (result: ProbeResult) => boolean;
  authFailureIsRequired?: (result: ProbeResult) => boolean;
  capability?: {
    args: readonly string[];
    resultReady: (result: ProbeResult) => boolean;
  };
  status: {
    ready: Status;
    authRequired: Status;
    authTimeout: Status;
    authUnavailable: Status;
    capabilityFailed?: Status;
    capabilityTimeout?: Status;
    versionFailed: Status;
    versionTimeout: Status;
    unavailable: Status;
  };
};

type ResolvedCliPath = {
  path: string | null;
  source: CliPathSource;
  searchPath: string;
  argsPrefix: string[];
};

const runtimeCaches = new Map<
  SelectableAgentRuntime,
  { at: number; value: AgentRuntimeProbe }
>();
const runtimeInFlight = new Map<
  SelectableAgentRuntime,
  Promise<AgentRuntimeProbe>
>();

function candidateBinaries(binary: string): string[] {
  if (platform() === "win32") {
    return [`${binary}.exe`, `${binary}.cmd`, binary];
  }
  return [binary];
}

/** Resolve both current native bundles and legacy cli.js bundles. */
function resolveBundledClaudeCommand(): {
  path: string;
  argsPrefix: string[];
} | null {
  const executable = platform() === "win32" ? "claude.exe" : "claude";

  for (const directory of getClaudeBundleDirectories()) {
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return { path: candidate, argsPrefix: [] };

    const cliPath = join(directory, "cli.js");
    const vendorDirectory = join(directory, "vendor");
    if (!(existsSync(cliPath) && existsSync(vendorDirectory))) continue;

    const bundledNode = join(
      directory,
      platform() === "win32" ? "node.exe" : "node",
    );
    const openLoomiNode = join(homedir(), APP_DIR_NAME, "node", "node.exe");
    const nodePath = existsSync(bundledNode)
      ? bundledNode
      : platform() === "win32" && existsSync(openLoomiNode)
        ? openLoomiNode
        : "node";
    return {
      path: nodePath,
      argsPrefix: ["--max-old-space-size=8192", cliPath],
    };
  }
  return null;
}

function isBareCommand(command: string): boolean {
  const parsed = parse(command);
  return parsed.dir.length === 0 && parsed.base === command;
}

function resolveCliPath(
  definition: RuntimeDefinition<SelectableAgentRuntime, string>,
): ResolvedCliPath {
  const searchPath = buildAgentCliSearchPath();

  if (definition.provider === "claude") {
    const bundled = resolveBundledClaudeCommand();
    if (bundled) {
      return { ...bundled, source: "BUNDLED", searchPath };
    }
  }

  const explicit = definition.explicitCommand?.trim();
  if (explicit) {
    if (existsSync(explicit) || isBareCommand(explicit)) {
      return {
        path: explicit,
        source: definition.explicitSource,
        searchPath,
        argsPrefix: [],
      };
    }
  }

  const pathCommand = findCliExecutableOnSearchPath(
    searchPath,
    candidateBinaries(definition.binary),
  );
  if (pathCommand) {
    return {
      path: pathCommand,
      source: "PATH",
      searchPath,
      argsPrefix: [],
    };
  }

  return { path: null, source: null, searchPath, argsPrefix: [] };
}

function runCli(
  provider: SelectableAgentRuntime,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  searchPath: string,
  argsPrefix: readonly string[] = [],
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
      processHandle = spawn(command, [...argsPrefix, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: shouldDetachCliProcess(),
        env: buildRuntimeProbeEnvironment(provider, {
          PATH: searchPath,
          CLAUDECODE: "",
        }),
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

function buildRuntimeProbeEnvironment(
  provider: SelectableAgentRuntime,
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const providerOverrides: Record<string, string> = {};
  if (provider === "claude") {
    for (const key of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      const value = process.env[key];
      if (value !== undefined) providerOverrides[key] = value;
    }
  }

  const env = buildCliEnvironment({ ...providerOverrides, ...overrides });
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    const isRuntimeCredential =
      PROBE_CREDENTIAL_KEYS.has(normalized) ||
      PROBE_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    if (!isRuntimeCredential) continue;

    const isCommonModelCredential =
      normalized === "OPENAI_API_KEY" ||
      normalized === "ANTHROPIC_API_KEY" ||
      normalized === "OPENROUTER_API_KEY" ||
      normalized === "GEMINI_API_KEY" ||
      normalized === "GOOGLE_GENERATIVE_AI_API_KEY";
    const isProviderCredential =
      provider === "claude"
        ? normalized.startsWith("ANTHROPIC_") ||
          normalized === "CLAUDE_CONFIG_DIR" ||
          normalized === "CLAUDE_CODE_OAUTH_TOKEN"
        : provider === "codex"
          ? normalized === "OPENAI_API_KEY" || normalized.startsWith("CODEX_")
          : provider === "opencode"
            ? isCommonModelCredential || normalized.startsWith("OPENCODE_")
            : provider === "hermes"
              ? isCommonModelCredential || normalized.startsWith("HERMES_")
              : normalized.startsWith("OPENCLAW_");
    if (!isProviderCredential) {
      delete env[key];
    }
  }
  return env;
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
  Provider extends SelectableAgentRuntime,
  Status extends string,
>(
  definition: RuntimeDefinition<Provider, Status>,
  resolvedOverride?: ResolvedCliPath,
): Promise<BaseRuntimeProbe<Provider, Status>> {
  const resolved =
    resolvedOverride ??
    resolveCliPath(
      definition as RuntimeDefinition<SelectableAgentRuntime, string>,
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

  // Keep the whole provider probe within one timeout window by running its
  // independent read-only checks together. A broken CLI must not make the
  // settings page wait 5 seconds for every subcommand in sequence.
  const [versionProbe, authProbe, capabilityProbe] = await Promise.all([
    runCli(
      definition.provider,
      resolved.path,
      ["--version"],
      PROBE_TIMEOUT_MS,
      resolved.searchPath,
      resolved.argsPrefix,
    ),
    runCli(
      definition.provider,
      resolved.path,
      definition.authArgs,
      PROBE_TIMEOUT_MS,
      resolved.searchPath,
      resolved.argsPrefix,
    ),
    definition.capability
      ? runCli(
          definition.provider,
          resolved.path,
          definition.capability.args,
          PROBE_TIMEOUT_MS,
          resolved.searchPath,
          resolved.argsPrefix,
        )
      : Promise.resolve(undefined),
  ]);
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

  if (
    capabilityProbe &&
    (!capabilityProbe.ok ||
      !definition.capability?.resultReady(capabilityProbe))
  ) {
    const reason = capabilityProbe.timedOut
      ? definition.status.capabilityTimeout
      : definition.status.capabilityFailed;
    if (!reason) {
      throw new Error(
        `Missing capability failure status for ${definition.provider}`,
      );
    }
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
      probes: {
        version: versionProbe,
        auth: authProbe,
        capability: capabilityProbe,
      },
    };
  }

  const authReady =
    authProbe.ok && (definition.authResultReady?.(authProbe) ?? true);
  if (!authReady) {
    const reason = authProbe.timedOut
      ? definition.status.authTimeout
      : !authProbe.ok && isAuthCommandUnavailable(authProbe)
        ? definition.status.authUnavailable
        : authProbe.ok ||
            (definition.authFailureIsRequired?.(authProbe) ?? true)
          ? definition.status.authRequired
          : definition.status.authUnavailable;
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
      probes: {
        version: versionProbe,
        auth: authProbe,
        capability: capabilityProbe,
      },
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
    probes: {
      version: versionProbe,
      auth: authProbe,
      capability: capabilityProbe,
    },
  };
}

function outputContains(result: ProbeResult, ...values: string[]): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return values.every((value) => output.includes(value.toLowerCase()));
}

function hasListedCredentials(result: ProbeResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!output) return false;
  return !/(?:no|0)\s+(?:stored\s+)?(?:credentials?|authenticated providers?)|not (?:logged in|authenticated)/i.test(
    output,
  );
}

function isHermesStatusReady(result: ProbeResult): boolean {
  const ansiEscape = String.fromCharCode(27);
  const ansiPattern = new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g");
  const output = `${result.stdout}\n${result.stderr}`.replace(ansiPattern, "");
  const model = output.match(/^\s*Model:\s*(.+?)\s*$/im)?.[1];
  if (!model || model.toLowerCase() === "(not set)") return false;

  // `hermes status` exits successfully even on a fresh install. Only mark it
  // ready when the configured model also has a model credential or login.
  return (
    /^\s*(?:OpenRouter|OpenAI|Anthropic|Google \/ Gemini|DeepSeek|xAI \/ Grok|NVIDIA NIM|Z\.AI \/ GLM|Kimi(?: \/ Moonshot)?|StepFun Step Plan|MiniMax(?:-CN| \(China\))?)\s+✓/im.test(
      output,
    ) ||
    /^\s*(?:Nous Portal|OpenAI Codex|Qwen OAuth|MiniMax OAuth|xAI OAuth)\s+✓/im.test(
      output,
    ) ||
    /Nous inference key configured/i.test(output) ||
    /^\s*LM Studio\s+✓\s+reachable/im.test(output)
  );
}

function outputMatches(result: ProbeResult, pattern: RegExp): boolean {
  return pattern.test(`${result.stdout}\n${result.stderr}`);
}

async function withRuntimeCache<Probe extends AgentRuntimeProbe>(
  provider: Probe["provider"],
  force: boolean,
  operation: () => Promise<Probe>,
): Promise<Probe> {
  const cached = runtimeCaches.get(provider);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value as Probe;
  }

  const current = runtimeInFlight.get(provider);
  if (current) return current as Promise<Probe>;

  const pending = operation().then((value) => {
    runtimeCaches.set(provider, { at: Date.now(), value });
    return value;
  });
  runtimeInFlight.set(provider, pending);
  try {
    return await pending;
  } finally {
    if (runtimeInFlight.get(provider) === pending) {
      runtimeInFlight.delete(provider);
    }
  }
}

export async function probeNativeClaudeRuntime(
  options: { force?: boolean } = {},
): Promise<NativeRuntimeProbe | null> {
  return withRuntimeCache("claude", options.force ?? false, async () => {
    const result = await probeCliRuntime({
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
    });
    return { ...result, defaultAgent: "claude" };
  });
}

export async function probeNativeCodexRuntime(
  options: {
    force?: boolean;
    resolverOptions?: Omit<ResolveCodexCommandOptions, "configuredCommand">;
  } = {},
): Promise<CodexRuntimeProbe | null> {
  const definition: RuntimeDefinition<"codex", CodexRuntimeStatus> = {
    provider: "codex",
    binary: "codex",
    explicitCommand: process.env.OPENLOOMI_AGENT_CODEX_COMMAND,
    explicitSource: "OPENLOOMI_AGENT_CODEX_COMMAND",
    authArgs: ["login", "status"],
    capability: {
      args: ["exec", "--help"],
      resultReady: (result) => outputContains(result, "--json"),
    },
    status: {
      ready: "CODEX_CLI_AUTHENTICATED",
      authRequired: "CODEX_CLI_AUTH_REQUIRED",
      authTimeout: "CODEX_CLI_AUTH_STATUS_TIMEOUT",
      authUnavailable: "CODEX_CLI_AUTH_STATUS_UNAVAILABLE",
      capabilityFailed: "CODEX_CLI_CAPABILITY_FAILED",
      capabilityTimeout: "CODEX_CLI_CAPABILITY_TIMEOUT",
      versionFailed: "CODEX_CLI_VERSION_FAILED",
      versionTimeout: "CODEX_CLI_VERSION_TIMEOUT",
      unavailable: "CODEX_CLI_UNAVAILABLE",
    },
  };
  return withRuntimeCache("codex", options.force ?? false, async () => {
    try {
      return await probeCliRuntime(
        definition,
        resolveCodexProbePath(options.resolverOptions),
      );
    } catch (error) {
      logger.warn(
        `[NativeAgentRuntime] Codex command resolution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return probeCliRuntime(definition, {
        path: null,
        source: null,
        searchPath: "",
        argsPrefix: [],
      });
    }
  });
}

export async function probeNativeOpenCodeRuntime(
  options: { force?: boolean } = {},
): Promise<OpenCodeRuntimeProbe | null> {
  return withRuntimeCache("opencode", options.force ?? false, () =>
    probeCliRuntime({
      provider: "opencode",
      binary: "opencode",
      explicitCommand: process.env.OPENLOOMI_AGENT_OPENCODE_COMMAND,
      explicitSource: "OPENLOOMI_AGENT_OPENCODE_COMMAND",
      authArgs: ["auth", "list"],
      authResultReady: hasListedCredentials,
      capability: {
        args: ["run", "--help"],
        resultReady: (result) => outputContains(result, "--format", "json"),
      },
      status: {
        ready: "OPENCODE_CLI_AUTHENTICATED",
        authRequired: "OPENCODE_CLI_AUTH_REQUIRED",
        authTimeout: "OPENCODE_CLI_AUTH_STATUS_TIMEOUT",
        authUnavailable: "OPENCODE_CLI_AUTH_STATUS_UNAVAILABLE",
        capabilityFailed: "OPENCODE_CLI_CAPABILITY_FAILED",
        capabilityTimeout: "OPENCODE_CLI_CAPABILITY_TIMEOUT",
        versionFailed: "OPENCODE_CLI_VERSION_FAILED",
        versionTimeout: "OPENCODE_CLI_VERSION_TIMEOUT",
        unavailable: "OPENCODE_CLI_UNAVAILABLE",
      },
    }),
  );
}

export async function probeNativeHermesRuntime(
  options: { force?: boolean } = {},
): Promise<HermesRuntimeProbe | null> {
  const profile = process.env.OPENLOOMI_AGENT_HERMES_PROFILE?.trim();
  return withRuntimeCache("hermes", options.force ?? false, () =>
    probeCliRuntime({
      provider: "hermes",
      binary: "hermes",
      explicitCommand: process.env.OPENLOOMI_AGENT_HERMES_COMMAND,
      explicitSource: "OPENLOOMI_AGENT_HERMES_COMMAND",
      authArgs: profile ? ["--profile", profile, "status"] : ["status"],
      authResultReady: isHermesStatusReady,
      authFailureIsRequired: (result) =>
        outputMatches(
          result,
          /(?:setup|required|not configured|missing).*(?:auth|credential|model|provider)|(?:auth|credential|model|provider).*(?:required|not configured|missing)/i,
        ),
      capability: {
        args: ["--help"],
        resultReady: (result) => outputContains(result, "acp"),
      },
      status: {
        ready: "HERMES_CLI_AUTHENTICATED",
        authRequired: "HERMES_CLI_AUTH_REQUIRED",
        authTimeout: "HERMES_CLI_AUTH_STATUS_TIMEOUT",
        authUnavailable: "HERMES_CLI_AUTH_STATUS_UNAVAILABLE",
        capabilityFailed: "HERMES_CLI_CAPABILITY_FAILED",
        capabilityTimeout: "HERMES_CLI_CAPABILITY_TIMEOUT",
        versionFailed: "HERMES_CLI_VERSION_FAILED",
        versionTimeout: "HERMES_CLI_VERSION_TIMEOUT",
        unavailable: "HERMES_CLI_UNAVAILABLE",
      },
    }),
  );
}

export async function probeNativeOpenClawRuntime(
  options: { force?: boolean } = {},
): Promise<OpenClawRuntimeProbe | null> {
  return withRuntimeCache("openclaw", options.force ?? false, () =>
    probeCliRuntime({
      provider: "openclaw",
      binary: "openclaw",
      explicitCommand: process.env.OPENLOOMI_AGENT_OPENCLAW_COMMAND,
      explicitSource: "OPENLOOMI_AGENT_OPENCLAW_COMMAND",
      authArgs: [
        "gateway",
        "status",
        "--require-rpc",
        "--json",
        "--timeout",
        "4000",
      ],
      authFailureIsRequired: (result) =>
        outputMatches(
          result,
          /(?:unauthorized|authentication|required|missing|invalid).*(?:token|password|credential)|(?:token|password|credential).*(?:required|missing|invalid)/i,
        ),
      status: {
        ready: "OPENCLAW_CLI_AUTHENTICATED",
        authRequired: "OPENCLAW_CLI_AUTH_REQUIRED",
        authTimeout: "OPENCLAW_CLI_AUTH_STATUS_TIMEOUT",
        authUnavailable: "OPENCLAW_CLI_AUTH_STATUS_UNAVAILABLE",
        versionFailed: "OPENCLAW_CLI_VERSION_FAILED",
        versionTimeout: "OPENCLAW_CLI_VERSION_TIMEOUT",
        unavailable: "OPENCLAW_CLI_UNAVAILABLE",
      },
    }),
  );
}

function resolveCodexProbePath(
  options: Omit<ResolveCodexCommandOptions, "configuredCommand"> = {},
): ResolvedCliPath {
  const searchPath =
    options.searchPath ??
    buildAgentCliSearchPath(options.basePath, {
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      localAppData: options.localAppData,
    });
  const explicit = process.env.OPENLOOMI_AGENT_CODEX_COMMAND?.trim();
  return {
    path: resolveCodexCommand({
      ...options,
      configuredCommand: explicit,
      searchPath,
    }),
    source: explicit ? "OPENLOOMI_AGENT_CODEX_COMMAND" : "PATH",
    searchPath,
    argsPrefix: [],
  };
}

export function clearNativeClaudeRuntimeCache(): void {
  runtimeCaches.delete("claude");
}

export function clearNativeCodexRuntimeCache(): void {
  runtimeCaches.delete("codex");
}

export function clearNativeRuntimeCaches(): void {
  runtimeCaches.clear();
}

export function getRuntimePlatform(): "windows" | "macos" | "linux" {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  return "linux";
}
