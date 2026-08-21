import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesUrl,
  buildOpenAiChatCompletionsUrl,
  getLlmProviderDefinition,
  LLM_PROVIDER_IDS,
  resolveEnvironmentLlmProviderConfig,
} from "@/lib/ai/llm-providers";

describe("LLM provider catalog", () => {
  it("registers all issue #218 providers", () => {
    expect(LLM_PROVIDER_IDS).toEqual([
      "openai_compatible",
      "anthropic_compatible",
      "openrouter",
      "bedrock",
      "gemini",
      "ollama",
      "deepseek",
      "xai",
    ]);
    expect(getLlmProviderDefinition("bedrock").transport).toBe("bedrock");
    for (const providerId of ["gemini", "ollama", "deepseek", "xai"] as const) {
      expect(getLlmProviderDefinition(providerId).transport).toBe(
        "openai_compatible",
      );
    }
  });

  it("treats configured base URLs as exact API roots", () => {
    expect(
      buildOpenAiChatCompletionsUrl(
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(buildAnthropicMessagesUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("resolves provider-specific environment variables", () => {
    expect(
      resolveEnvironmentLlmProviderConfig({
        LLM_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_MODEL: "deepseek-chat",
      }),
    ).toEqual({
      providerId: "deepseek",
      providerType: "openai_compatible",
      apiKey: "deepseek-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      region: undefined,
    });
  });

  it("supports keyless Ollama and Bedrock's AWS credential chain", () => {
    expect(
      resolveEnvironmentLlmProviderConfig({
        LLM_PROVIDER: "ollama",
        OLLAMA_MODEL: "llama3.2",
      }),
    ).toMatchObject({
      providerId: "ollama",
      apiKey: undefined,
      baseUrl: "http://localhost:11434/v1",
    });

    expect(
      resolveEnvironmentLlmProviderConfig({
        LLM_PROVIDER: "bedrock",
        AWS_BEDROCK_MODEL: "us.amazon.nova-lite-v1:0",
        AWS_REGION: "us-west-2",
      }),
    ).toMatchObject({
      providerId: "bedrock",
      providerType: "bedrock",
      apiKey: undefined,
      region: "us-west-2",
    });
  });
});
