import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLineBufferedDiagnosticSink,
  extractSafeClaudeSdkErrorLines,
  prepareClaudeCodeTempDirectory,
  redactClaudeRuntimeDiagnostic,
} from "../../lib/ai/extensions/agent/claude/runtime-preflight";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openloomi-claude-preflight-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude runtime preflight", () => {
  it("creates a missing configured temp directory with private permissions", async () => {
    const directory = path.join(createTemporaryDirectory(), "missing", "tmp");
    const env = { CLAUDE_CODE_TMPDIR: directory };

    const error = await prepareClaudeCodeTempDirectory(env);

    expect(error).toBeNull();
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(env.CLAUDE_CODE_TMPDIR).toBe(directory);
  });

  it("removes an unusable override so Claude can use the OS temp directory", async () => {
    const configuredPath = path.join(createTemporaryDirectory(), "not-a-dir");
    fs.writeFileSync(configuredPath, "file");
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_TMPDIR: configuredPath,
    };

    const error = await prepareClaudeCodeTempDirectory(env);

    expect(error?.message).toMatch(/EEXIST|not a real directory/);
    expect(env).not.toHaveProperty("CLAUDE_CODE_TMPDIR");
  });

  it("does not change permissions on an existing shared directory", async () => {
    if (process.platform === "win32") return;

    const directory = path.join(createTemporaryDirectory(), "shared");
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o777);
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_TMPDIR: directory,
    };

    const error = await prepareClaudeCodeTempDirectory(env);

    expect(error?.message).toMatch(/permissions are not private/);
    expect(env).not.toHaveProperty("CLAUDE_CODE_TMPDIR");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o777);
  });

  it("redacts configured and structured credentials from diagnostics", () => {
    const secret = "sk-sensitive-value";
    const diagnostic =
      'Bearer bearer-value ANTHROPIC_AUTH_TOKEN="other-value" raw=sk-sensitive-value';

    expect(redactClaudeRuntimeDiagnostic(diagnostic, [secret])).toBe(
      'Bearer [REDACTED] ANTHROPIC_AUTH_TOKEN="[REDACTED]" raw=[REDACTED]',
    );
  });

  it("reassembles stderr lines before redacting split credentials", () => {
    const secret = "sk-sensitive-value";
    const diagnostics: string[] = [];
    const sink = createLineBufferedDiagnosticSink((line) => {
      diagnostics.push(redactClaudeRuntimeDiagnostic(line, [secret]));
    });

    sink.write(Buffer.from("fatal: token=sk-sens"));
    sink.write(Buffer.from("itive-value\nremaining partial"));

    expect(diagnostics).toEqual(["fatal: token=[REDACTED]\n"]);

    sink.end();
    expect(diagnostics).toEqual([
      "fatal: token=[REDACTED]\n",
      "remaining partial",
    ]);
  });

  it("extracts startup and API failures without copying arbitrary debug content", () => {
    const startupError =
      "2026-07-23T02:39:34.123Z [ERROR] Error processing --settings: ENOENT: no such file or directory, open '/Users/example/.cache/openloomi-tmp/claude-settings.json'";
    const apiError =
      '2026-07-23T02:39:35.123Z [ERROR] API error (attempt 1/11): 401 {"type":"error"}';
    const debugTail = [
      "2026-07-23T02:39:34.100Z [DEBUG] user prompt: private content",
      startupError,
      "2026-07-23T02:39:35.000Z [ERROR] arbitrary private response content",
      apiError,
    ].join("\n");

    expect(extractSafeClaudeSdkErrorLines(debugTail)).toBe(
      `${startupError}\n${apiError}`,
    );
  });
});
