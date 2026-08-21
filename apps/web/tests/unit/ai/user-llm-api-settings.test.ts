import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  enabled: vi.fn(),
  byProvider: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getEnabledUserLlmApiSettingWithApiKey: dbState.enabled,
  getUserLlmApiSettingWithApiKey: dbState.byProvider,
}));

const { getActiveUserLlmProviderConfig } =
  await import("@/lib/ai/user-llm-api-settings");

const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;

describe("active user LLM provider config", () => {
  beforeEach(() => {
    dbState.enabled.mockReset();
    dbState.byProvider.mockReset();
  });

  afterEach(() => {
    if (originalDeepSeekKey === undefined) {
      // biome-ignore lint/performance/noDelete: process.env must be restored, not assigned the string "undefined"
      delete process.env.DEEPSEEK_API_KEY;
    } else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
  });

  it("merges a saved provider identity with server credentials and defaults", async () => {
    process.env.DEEPSEEK_API_KEY = "server-key";
    dbState.enabled.mockResolvedValue({
      providerId: "deepseek",
      providerType: "openai_compatible",
      apiKey: null,
      baseUrl: null,
      model: null,
      region: null,
      enabled: true,
    });

    await expect(getActiveUserLlmProviderConfig("user-1")).resolves.toEqual({
      providerId: "deepseek",
      providerType: "openai_compatible",
      apiKey: "server-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      region: undefined,
    });
  });
});
