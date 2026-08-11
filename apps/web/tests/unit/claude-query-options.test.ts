import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/mcp", () => ({
  createBusinessToolsMcpServer: vi.fn(),
}));

import { createClaudeQueryOptions } from "@/lib/ai/extensions/agent/claude/query-options";

describe("Claude query recovery options", () => {
  it("resumes the exact provider session in its persisted working directory", () => {
    const options = createClaudeQueryOptions({
      sessionId: "runtime-session",
      cwd: "D:\\workspace\\persisted-session",
      settingSources: ["project"],
      allowedTools: ["Read", "Bash"],
      abortController: new AbortController(),
      env: { ANTHROPIC_API_KEY: "test-key" },
      config: { provider: "claude", model: "claude-test" },
      claudeCodePath: "claude-code",
      isDev: false,
      debugFilePath: "openloomi.log",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      spawnClaudeCodeProcess: vi.fn() as unknown as NonNullable<
        Options["spawnClaudeCodeProcess"]
      >,
      systemPrompt: "system prompt",
      permissionLogMode: "run",
      resumeProviderSessionId: "claude-provider-session",
    });

    expect(options).toMatchObject({
      cwd: "D:\\workspace\\persisted-session",
      resume: "claude-provider-session",
      model: "claude-test",
      allowedTools: ["Read", "Bash"],
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
    });
    expect(Object.hasOwn(options, "continue")).toBe(false);
    expect(Object.hasOwn(options, "sessionId")).toBe(false);
    expect(Object.hasOwn(options, "forkSession")).toBe(false);
  });
});
