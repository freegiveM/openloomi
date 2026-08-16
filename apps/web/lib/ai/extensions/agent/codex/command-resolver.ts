import { existsSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import { buildAgentCliSearchPath } from "../cli-process";
import { CodexCommandNotFoundError } from "./command";

const WINDOWS_CODEX_HELPERS = [
  "codex-windows-sandbox-setup.exe",
  "codex-command-runner.exe",
] as const;

export interface ResolveCodexCommandOptions {
  /** User/provider supplied command. It always wins over automatic discovery. */
  configuredCommand?: string;
  /** PATH before OpenLoomi's standard desktop CLI locations are appended. */
  basePath?: string;
  /** Fully built search path, primarily useful to deterministic callers/tests. */
  searchPath?: string;
  /** Preserve spawn(command, { cwd }) semantics for configured relative paths. */
  workingDirectory?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppData?: string;
}

export class CodexWindowsBundleIncompleteError extends Error {
  constructor(readonly candidates: readonly string[]) {
    const summary = candidates
      .map((candidate) => `\`${candidate}\``)
      .join(", ");
    super(
      `OpenLoomi found Codex CLI executable(s), but none is a complete Windows bundle. Sandboxed Codex runs require ${WINDOWS_CODEX_HELPERS.join(
        " and ",
      )} from the same Codex installation. Incomplete installation(s): ${summary}. Repair or upgrade Codex, or set OPENLOOMI_AGENT_CODEX_COMMAND to a complete Codex executable.`,
    );
    this.name = "CodexWindowsBundleIncompleteError";
  }
}

/**
 * Resolve the executable once before Codex preflight and runtime startup.
 *
 * A configured command is authoritative. Automatic Windows discovery skips
 * native bundles that cannot launch the sandbox while preserving standard PATH
 * and OpenLoomi's documented desktop CLI locations as the only discovery roots.
 */
export function resolveCodexCommand(
  options: ResolveCodexCommandOptions = {},
): string {
  const currentPlatform = options.platform ?? platform();
  const home = options.homeDirectory ?? homedir();
  const searchPath =
    options.searchPath ??
    buildAgentCliSearchPath(options.basePath, {
      platform: currentPlatform,
      homeDirectory: home,
      localAppData: options.localAppData,
    });
  const configuredCommand = options.configuredCommand?.trim();

  if (configuredCommand) {
    const resolved = resolveConfiguredCommand(
      configuredCommand,
      searchPath,
      currentPlatform,
      options.workingDirectory,
    );
    assertUsableWindowsNativeBundle(resolved, currentPlatform);
    return canonicalizeWindowsNativeCommand(resolved, currentPlatform);
  }

  const discovered = findCommandsOnSearchPath(
    searchPath,
    commandNames("codex", currentPlatform),
  ).filter((command) => !isPrivateEditorCodexPath(command));

  if (currentPlatform !== "win32") {
    const command = discovered[0];
    if (!command) throw new CodexCommandNotFoundError("codex");
    return command;
  }

  const uniqueCommands = deduplicateWindowsPaths(
    discovered.map((command) =>
      canonicalizeWindowsNativeCommand(command, currentPlatform),
    ),
  );
  const incomplete: string[] = [];

  for (const command of uniqueCommands) {
    if (
      isWindowsNativeCodex(command) &&
      !isCompleteWindowsCodexBundle(command)
    ) {
      incomplete.push(command);
      continue;
    }
    return command;
  }

  if (incomplete.length > 0) {
    throw new CodexWindowsBundleIncompleteError(incomplete);
  }
  throw new CodexCommandNotFoundError("codex");
}

export function isCompleteWindowsCodexBundle(command: string): boolean {
  if (!isWindowsNativeCodex(command)) return true;
  const commandDirectories = [dirname(command)];

  try {
    const canonicalDirectory = dirname(realpathSync.native(command));
    if (!commandDirectories.includes(canonicalDirectory)) {
      commandDirectories.push(canonicalDirectory);
    }
  } catch {
    // The configured path may not exist yet. Startup will report that error.
  }

  const helperDirectories = commandDirectories.flatMap((directory) => [
    directory,
    join(directory, "codex-resources"),
    join(directory, "..", "codex-resources"),
  ]);

  return helperDirectories.some((directory) =>
    WINDOWS_CODEX_HELPERS.every((helper) =>
      existsSync(join(directory, helper)),
    ),
  );
}

function resolveConfiguredCommand(
  command: string,
  searchPath: string,
  currentPlatform: NodeJS.Platform,
  workingDirectory = process.cwd(),
): string {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) {
    return resolve(workingDirectory, command);
  }
  return (
    findCommandsOnSearchPath(
      searchPath,
      commandNames(command, currentPlatform),
    )[0] ?? command
  );
}

function assertUsableWindowsNativeBundle(
  command: string,
  currentPlatform: NodeJS.Platform,
): void {
  if (
    currentPlatform === "win32" &&
    existsSync(command) &&
    isWindowsNativeCodex(command) &&
    !isCompleteWindowsCodexBundle(command)
  ) {
    throw new CodexWindowsBundleIncompleteError([command]);
  }
}

function canonicalizeWindowsNativeCommand(
  command: string,
  currentPlatform: NodeJS.Platform,
): string {
  if (currentPlatform !== "win32" || !isWindowsNativeCodex(command)) {
    return command;
  }
  try {
    // The official standalone installer exposes bin through a junction. Codex
    // resolves sandbox helpers relative to its launched executable path, so it
    // must be spawned from the real release directory rather than the facade.
    return realpathSync.native(command);
  } catch {
    return command;
  }
}

function commandNames(
  command: string,
  currentPlatform: NodeJS.Platform,
): string[] {
  if (currentPlatform !== "win32" || extname(command)) return [command];
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function findCommandsOnSearchPath(
  searchPath: string,
  names: readonly string[],
): string[] {
  const commands: string[] = [];
  for (const directory of searchPath
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, "").trim())
    .filter(Boolean)) {
    for (const name of names) {
      const command = resolve(directory, name);
      if (existsSync(command)) {
        commands.push(command);
        break;
      }
    }
  }
  return commands;
}

function deduplicateWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const key = absolute.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(absolute);
  }
  return result;
}

function isPrivateEditorCodexPath(command: string): boolean {
  const segments = resolve(command)
    .toLowerCase()
    .split(/[\\/]+/);
  return segments.some(
    (segment, index) =>
      index > 0 &&
      segments[index - 1] === "extensions" &&
      segment.startsWith("openai.chatgpt-"),
  );
}

function isWindowsNativeCodex(command: string): boolean {
  return basename(command).toLowerCase() === "codex.exe";
}
