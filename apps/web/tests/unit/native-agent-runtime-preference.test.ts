import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearAgentRuntimePreference,
  readAgentRuntimePreference,
  writeAgentRuntimePreference,
} from "@/lib/ai/native-agent/runtime-preference";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agent runtime preference", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openloomi-agent-runtime-"));
    filePath = join(directory, "agent-runtime.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns no preference when the file does not exist", () => {
    expect(readAgentRuntimePreference(filePath)).toBeUndefined();
  });

  it("writes and replaces a Claude or Codex preference", () => {
    writeAgentRuntimePreference("claude", filePath);
    expect(readAgentRuntimePreference(filePath)).toBe("claude");

    writeAgentRuntimePreference("codex", filePath);
    expect(readAgentRuntimePreference(filePath)).toBe("codex");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      provider: "codex",
    });
    expect(readdirSync(directory)).toEqual(["agent-runtime.json"]);
  });

  it("clears a desktop preference without failing when it is already absent", () => {
    writeAgentRuntimePreference("codex", filePath);

    clearAgentRuntimePreference(filePath);
    expect(readAgentRuntimePreference(filePath)).toBeUndefined();

    expect(() => clearAgentRuntimePreference(filePath)).not.toThrow();
  });

  it("ignores malformed or unsupported preferences", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeFileSync(filePath, "not-json", "utf8");
    expect(readAgentRuntimePreference(filePath)).toBeUndefined();

    writeFileSync(filePath, JSON.stringify({ provider: "opencode" }), "utf8");
    expect(readAgentRuntimePreference(filePath)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
