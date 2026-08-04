import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentCliSearchPath,
  buildCliEnvironment,
} from "@/lib/ai/extensions/agent/cli-process";

const originalEnv = process.env;

afterEach(() => {
  process.env = originalEnv;
});

describe("CLI process environment", () => {
  it("does not expose unrelated server secrets to agent runtimes", () => {
    process.env = {
      NODE_ENV: "test",
      PATH: "test-path",
      DATABASE_URL: "postgres://secret",
      AUTH_SECRET: "auth-secret",
      OPENAI_API_KEY: "model-secret",
      ANTHROPIC_AUTH_TOKEN: "claude-token",
      CLAUDE_CONFIG_DIR: "/tmp/claude-config",
      CLAUDE_UNRELATED_SECRET: "hidden-claude-secret",
      OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
      CODEX_API_KEY: "codex-secret",
      CODEX_HOME: "/tmp/codex-home",
    };

    expect(buildCliEnvironment()).toMatchObject({
      NODE_ENV: "test",
      PATH: "test-path",
      OPENAI_API_KEY: "model-secret",
      OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
      CODEX_API_KEY: "codex-secret",
      CODEX_HOME: "/tmp/codex-home",
    });
    expect(buildCliEnvironment()).not.toHaveProperty("DATABASE_URL");
    expect(buildCliEnvironment()).not.toHaveProperty("AUTH_SECRET");
    expect(buildCliEnvironment()).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(buildCliEnvironment()).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(buildCliEnvironment()).not.toHaveProperty("CLAUDE_UNRELATED_SECRET");
  });

  it("adds native installer locations to the shared desktop CLI path", () => {
    const searchPath = buildAgentCliSearchPath("custom-bin").split(delimiter);

    expect(searchPath).toContain("custom-bin");
    expect(searchPath).toContain(join(homedir(), ".local", "bin"));
  });

  it("supports an explicit server-controlled allowlist and trusted overrides", () => {
    process.env = {
      NODE_ENV: "test",
      OPENLOOMI_AGENT_ENV_ALLOWLIST: "HTTPS_PROXY, CORPORATE_CA",
      HTTPS_PROXY: "http://proxy.example.test",
      CORPORATE_CA: "/certs/ca.pem",
      UNRELATED_SECRET: "hidden",
    };

    expect(buildCliEnvironment({ RUN_MODE: "test" })).toEqual({
      NODE_ENV: "test",
      HTTPS_PROXY: "http://proxy.example.test",
      CORPORATE_CA: "/certs/ca.pem",
      RUN_MODE: "test",
    });
  });
});
