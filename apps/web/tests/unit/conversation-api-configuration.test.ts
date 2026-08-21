import { describe, expect, it } from "vitest";

import {
  hasUsableConversationApiConfiguration,
  type ConversationApiSettingsResponse,
} from "@/lib/ai/conversation-api-configuration";

function createResponse(
  overrides: {
    enabled?: boolean;
    hasApiKey?: boolean;
    baseUrl?: string | null;
    model?: string | null;
    systemHasApiKey?: boolean;
    defaultAgent?: string;
    nativeRuntimeAuthenticated?: boolean;
  } = {},
): ConversationApiSettingsResponse {
  return {
    settings: [
      {
        providerType: "anthropic_compatible",
        enabled: overrides.enabled ?? false,
        hasApiKey: overrides.hasApiKey ?? false,
        baseUrl: overrides.baseUrl ?? null,
        model: overrides.model ?? null,
      },
    ],
    systemDefaults: {
      anthropic_compatible: {
        hasApiKey: overrides.systemHasApiKey ?? false,
      },
    },
    defaultAgent: overrides.defaultAgent,
    nativeRuntime: overrides.nativeRuntimeAuthenticated
      ? { ready: true, authenticated: true }
      : null,
  };
}

describe("conversation API configuration", () => {
  it("accepts a complete enabled user provider", () => {
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({
          enabled: true,
          hasApiKey: true,
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-4-6",
        }),
      ),
    ).toBe(true);
  });

  it("rejects incomplete or disabled user providers", () => {
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({
          enabled: false,
          hasApiKey: true,
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-4-6",
        }),
      ),
    ).toBe(false);
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({
          enabled: true,
          hasApiKey: true,
          baseUrl: " ",
          model: "claude-sonnet-4-6",
        }),
      ),
    ).toBe(false);
  });

  it("accepts an OpenAI-compatible provider as chat configuration", () => {
    const response = createResponse();
    response.settings = [
      {
        providerType: "openai_compatible",
        enabled: true,
        hasApiKey: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
      },
    ];

    expect(hasUsableConversationApiConfiguration(response)).toBe(true);
  });

  it("accepts keyless Ollama and AWS Bedrock configurations", () => {
    const response = createResponse();
    response.settings = [
      {
        providerId: "ollama",
        providerType: "openai_compatible",
        enabled: true,
        hasApiKey: false,
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.2",
      },
    ];
    expect(hasUsableConversationApiConfiguration(response)).toBe(true);

    response.settings = [
      {
        providerId: "bedrock",
        providerType: "bedrock",
        enabled: true,
        hasApiKey: false,
        baseUrl: null,
        model: "us.amazon.nova-lite-v1:0",
        region: "us-east-1",
      },
    ];
    expect(hasUsableConversationApiConfiguration(response)).toBe(true);
  });

  it("accepts an authenticated native Claude CLI runtime", () => {
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ nativeRuntimeAuthenticated: true }),
      ),
    ).toBe(true);
  });

  it("ignores the stale system Anthropic API key mirror", () => {
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ systemHasApiKey: true }),
      ),
    ).toBe(false);
  });

  it("treats a non-claude defaultAgent as configured even without an API key", () => {
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ defaultAgent: "codex" }),
      ),
    ).toBe(true);
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ defaultAgent: "opencode" }),
      ),
    ).toBe(true);
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ defaultAgent: "hermes" }),
      ),
    ).toBe(true);
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ defaultAgent: "openclaw" }),
      ),
    ).toBe(true);
  });

  it("still requires a configured provider when defaultAgent is claude", () => {
    expect(
      hasUsableConversationApiConfiguration(
        createResponse({ defaultAgent: "claude" }),
      ),
    ).toBe(false);
  });
});
