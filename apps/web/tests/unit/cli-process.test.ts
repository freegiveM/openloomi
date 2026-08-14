import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentCliSearchPath,
  buildCliEnvironment,
  findCliExecutableOnSearchPath,
  shouldDetachCliProcess,
  terminateTrackedCliProcesses,
  trackCliProcess,
} from "@/lib/ai/extensions/agent/cli-process";

const originalEnv = process.env;
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = originalEnv;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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
    const windowsHome = "windows-home";
    const localAppData = "windows-local-app-data";
    const searchPath = buildAgentCliSearchPath("custom-bin", {
      platform: "win32",
      homeDirectory: windowsHome,
      localAppData,
    }).split(delimiter);

    expect(searchPath).toContain("custom-bin");
    expect(searchPath).toContain(join(windowsHome, ".local", "bin"));
    expect(searchPath).toContain(
      join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
    );
  });

  it("resolves PATH directories before executable extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "openloomi-cli-path-"));
    temporaryDirectories.push(root);
    const earlierDirectory = join(root, "earlier");
    const laterDirectory = join(root, "later");
    mkdirSync(earlierDirectory);
    mkdirSync(laterDirectory);
    const earlierCommand = join(earlierDirectory, "codex.cmd");
    writeFileSync(earlierCommand, "");
    writeFileSync(join(laterDirectory, "codex.exe"), "");

    expect(
      findCliExecutableOnSearchPath(
        [earlierDirectory, laterDirectory].join(delimiter),
        ["codex.exe", "codex.cmd", "codex"],
      ),
    ).toBe(earlierCommand);
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

  it("installs host signal cleanup and terminates tracked processes", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: shouldDetachCliProcess(),
      stdio: "ignore",
    });
    const closed = once(child, "close");
    trackCliProcess(child);
    expect(
      process
        .listeners("SIGINT")
        .some((listener) => listener.name === "cleanupBeforeHostShutdown"),
    ).toBe(true);

    terminateTrackedCliProcesses();

    await closed;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
