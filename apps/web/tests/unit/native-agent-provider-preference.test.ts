import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getConfiguredAgentProviderResolution,
  getConfiguredDefaultAgentProvider,
  resolveNativeAgentProviderRequest,
} from "@/lib/ai/native-agent/provider-env";
import { writeAgentRuntimePreference } from "@/lib/ai/native-agent/runtime-preference";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("desktop agent runtime selection", () => {
  let directory: string;
  let preferencePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openloomi-provider-selection-"));
    preferencePath = join(directory, "agent-runtime.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses the saved Codex selection instead of the desktop environment", () => {
    writeAgentRuntimePreference("codex", preferencePath);

    const request = resolveNativeAgentProviderRequest(
      {
        prompt: "hello",
        provider: "claude",
        modelConfig: { model: "request-model" },
        providerConfig: { codexPath: "request-command" },
      },
      {
        TAURI_MODE: "1",
        OPENLOOMI_AGENT_PROVIDER: "unsupported-runtime",
        OPENLOOMI_AGENT_CODEX_COMMAND: "codex-custom",
        OPENLOOMI_AGENT_CODEX_MODEL: "gpt-5.4",
      },
      { preferencePath },
    );

    expect(request).toMatchObject({
      provider: "codex",
      modelConfig: { model: "gpt-5.4" },
      providerConfig: { codexPath: "codex-custom" },
    });
    expect(
      getConfiguredAgentProviderResolution(
        {
          TAURI_MODE: "1",
          OPENLOOMI_AGENT_PROVIDER: "claude",
        },
        { preferencePath },
      ),
    ).toEqual({
      provider: "codex",
      preference: "codex",
      source: "preference",
    });
  });

  it("uses the saved Claude selection and clears request provider config", () => {
    writeAgentRuntimePreference("claude", preferencePath);

    const request = resolveNativeAgentProviderRequest(
      {
        prompt: "hello",
        provider: "codex",
        modelConfig: { model: "claude-model" },
        providerConfig: { codexPath: "request-command" },
      },
      {
        IS_TAURI: "true",
        OPENLOOMI_AGENT_PROVIDER: "codex",
      },
      { preferencePath },
    );

    expect(request.provider).toBe("claude");
    expect(request.modelConfig).toEqual({ model: "claude-model" });
    expect(request.providerConfig).toBeUndefined();
  });

  it("keeps server deployments environment-controlled", () => {
    writeAgentRuntimePreference("codex", preferencePath);

    expect(
      getConfiguredDefaultAgentProvider(
        { OPENLOOMI_AGENT_PROVIDER: "claude" },
        { preferencePath },
      ),
    ).toBe("claude");
    expect(
      getConfiguredAgentProviderResolution(
        { OPENLOOMI_AGENT_PROVIDER: "claude" },
        { preferencePath },
      ),
    ).toEqual({ provider: "claude", source: "environment" });
  });
});
