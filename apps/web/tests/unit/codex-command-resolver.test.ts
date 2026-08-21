import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import {
  CodexWindowsBundleIncompleteError,
  isCompleteWindowsCodexBundle,
  resolveCodexCommand,
} from "@/lib/ai/extensions/agent/codex/command-resolver";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex command resolver", () => {
  it("keeps an explicit complete Codex executable authoritative", () => {
    const root = temporaryDirectory();
    const configured = createCompleteBundle(
      join(
        root,
        ".vscode",
        "extensions",
        "openai.chatgpt-explicit",
        "bin",
        "windows-x86_64",
      ),
    );
    const automatic = createCompleteBundle(join(root, "automatic"));

    expect(
      resolveCodexCommand({
        configuredCommand: configured,
        platform: "win32",
        homeDirectory: root,
        searchPath: [dirname(configured), dirname(automatic)].join(delimiter),
      }),
    ).toBe(realpathSync.native(configured));
  });

  it("skips an incomplete PATH bundle and keeps first-complete PATH order", () => {
    const root = temporaryDirectory();
    const incompleteDirectory = join(root, "incomplete");
    createExecutable(incompleteDirectory);
    const older = createCompleteBundle(join(root, "older"));
    const newer = createCompleteBundle(join(root, "newer"));
    expect(
      resolveCodexCommand({
        platform: "win32",
        searchPath: [incompleteDirectory, dirname(older), dirname(newer)].join(
          delimiter,
        ),
      }),
    ).toBe(realpathSync.native(older));
  });

  it("does not automatically select a private VS Code bundle inherited through PATH", () => {
    const home = temporaryDirectory();
    const incompleteDirectory = join(home, "official-codex");
    createExecutable(incompleteDirectory);
    const privateBundle = createCompleteBundle(
      join(
        home,
        ".vscode",
        "extensions",
        "openai.chatgpt-26.810.50856-win32-x64",
        "bin",
        "windows-x86_64",
      ),
    );

    expect(() =>
      resolveCodexCommand({
        platform: "win32",
        homeDirectory: home,
        searchPath: [incompleteDirectory, dirname(privateBundle)].join(
          delimiter,
        ),
      }),
    ).toThrow(CodexWindowsBundleIncompleteError);
  });

  it("accepts helpers from the Codex resources directory", () => {
    const root = temporaryDirectory();
    const command = createCompleteBundle(
      join(root, "bundle"),
      "child-resources",
    );

    expect(isCompleteWindowsCodexBundle(command)).toBe(true);
    expect(
      resolveCodexCommand({
        platform: "win32",
        searchPath: dirnameSearchPath(command),
      }),
    ).toBe(realpathSync.native(command));
  });

  it("accepts the official standalone junction and parent resources layout", () => {
    const root = temporaryDirectory();
    const releaseDirectory = join(
      root,
      "packages",
      "standalone",
      "releases",
      "0.147.0",
    );
    createCompleteBundle(join(releaseDirectory, "bin"), "parent-resources");

    const visibleDirectory = join(root, "Programs", "OpenAI", "Codex", "bin");
    mkdirSync(dirname(visibleDirectory), { recursive: true });
    symlinkSync(
      join(releaseDirectory, "bin"),
      visibleDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const command = join(visibleDirectory, "codex.exe");

    expect(isCompleteWindowsCodexBundle(command)).toBe(true);
    expect(
      resolveCodexCommand({
        platform: "win32",
        searchPath: dirnameSearchPath(command),
      }),
    ).toBe(realpathSync.native(command));
  });

  it("keeps an npm command shim for the shared cross-spawn launcher", () => {
    const root = temporaryDirectory();
    const command = join(root, "codex.cmd");
    writeFileSync(command, "@node codex.js %*");

    expect(resolveCodexCommand({ platform: "win32", searchPath: root })).toBe(
      resolve(command),
    );
  });

  it("fails before startup with the incomplete Windows installations", () => {
    const root = temporaryDirectory();
    const firstDirectory = join(root, "first");
    const secondDirectory = join(root, "second");
    const first = createExecutable(firstDirectory);
    const second = createExecutable(secondDirectory);

    let error: unknown;
    try {
      resolveCodexCommand({
        platform: "win32",
        searchPath: [firstDirectory, secondDirectory].join(delimiter),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CodexWindowsBundleIncompleteError);
    expect((error as Error).message).toContain(first);
    expect((error as Error).message).toContain(second);
  });

  it("does not replace an explicit incomplete native bundle with an automatic candidate", () => {
    const root = temporaryDirectory();
    const configured = createExecutable(join(root, "configured"));
    const automatic = createCompleteBundle(join(root, "automatic"));

    expect(() =>
      resolveCodexCommand({
        configuredCommand: configured,
        platform: "win32",
        searchPath: [dirname(configured), dirname(automatic)].join(delimiter),
      }),
    ).toThrow(CodexWindowsBundleIncompleteError);
  });

  it("resolves a configured relative path from the runtime working directory", () => {
    const root = temporaryDirectory();
    const command = createCompleteBundle(join(root, "tools"));

    expect(
      resolveCodexCommand({
        configuredCommand: join("tools", "codex.exe"),
        platform: "win32",
        workingDirectory: root,
        searchPath: "",
      }),
    ).toBe(realpathSync.native(command));
  });

  it("returns an absolute default command on non-Windows platforms", () => {
    const root = temporaryDirectory();
    const privateCommand = join(
      root,
      "portable-editor",
      "extensions",
      "openai.chatgpt-private",
      "bin",
      "codex",
    );
    const command = join(root, "bin", "codex");
    mkdirSync(dirname(privateCommand), { recursive: true });
    writeFileSync(privateCommand, "");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(command, "");

    expect(
      resolveCodexCommand({
        platform: "linux",
        searchPath: [dirname(privateCommand), join(root, "bin")].join(
          delimiter,
        ),
      }),
    ).toBe(resolve(command));
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openloomi-codex-resolver-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createCompleteBundle(
  directory: string,
  helperPlacement:
    | "sibling"
    | "child-resources"
    | "parent-resources" = "sibling",
): string {
  const command = createExecutable(directory);
  const helperDirectory =
    helperPlacement === "child-resources"
      ? join(directory, "codex-resources")
      : helperPlacement === "parent-resources"
        ? join(directory, "..", "codex-resources")
        : directory;
  mkdirSync(helperDirectory, { recursive: true });
  writeFileSync(join(helperDirectory, "codex-windows-sandbox-setup.exe"), "");
  writeFileSync(join(helperDirectory, "codex-command-runner.exe"), "");
  return command;
}

function createExecutable(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const command = join(directory, "codex.exe");
  writeFileSync(command, "");
  return command;
}

function dirnameSearchPath(command: string): string {
  return dirname(command);
}
