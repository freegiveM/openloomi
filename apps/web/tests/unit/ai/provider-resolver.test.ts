import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const getActiveUserLlmProviderConfigMock = vi.fn();

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getActiveUserLlmProviderConfig: getActiveUserLlmProviderConfigMock,
}));

const recordUsageMock = vi.fn();
vi.mock("@/lib/llm-usage/recorder", () => ({
  recordUsage: recordUsageMock,
}));

const registerProvidersMock = vi.fn();
const registerProviderMock = vi.fn();

vi.mock("@/lib/ai/native-agent/host", () => ({
  nativeAgentHost: {
    registerProvider: registerProviderMock,
    registerProviders: registerProvidersMock,
  },
}));

const resolveNativeAgentProviderRequestMock = vi.fn();

vi.mock("@/lib/ai/native-agent/provider-env", () => ({
  resolveNativeAgentProviderRequest: resolveNativeAgentProviderRequestMock,
}));

const createAgentMock = vi.fn();

vi.mock("@melandlabs/ai/agent", () => ({
  getAgentRegistry: () => ({ create: createAgentMock }),
}));

async function loadResolver() {
  // Reset module cache so each test re-evaluates the env-derivation call.
  vi.resetModules();
  const mod = await import("@/lib/ai/provider-resolver");
  return mod.resolveLlmProvider;
}

describe("resolveLlmProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveNativeAgentProviderRequestMock.mockReset();
    createAgentMock.mockReset();
    getActiveUserLlmProviderConfigMock.mockReset();
    recordUsageMock.mockReset().mockResolvedValue(true);
    process.env = { ...ORIGINAL_ENV };
    process.env.OPENLOOMI_AGENT_PROVIDER = undefined;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns the HTTP Anthropic provider when the user has an anthropic_compatible row", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce({
      providerId: "anthropic_compatible",
      providerType: "anthropic_compatible",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      model: "claude-sonnet-4-6",
    });
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "anthropic_messages",
    });
    expect(provider).toBeDefined();
    expect(provider?.flavor).toBe("anthropic_http");
    expect(provider?.model).toBe("claude-sonnet-4-6");
    expect(getActiveUserLlmProviderConfigMock).toHaveBeenCalledWith("user-1");
  });

  it("returns the HTTP OpenAI provider when the user has an openai_compatible row", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce({
      providerId: "openai_compatible",
      providerType: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "chat_completions",
    });
    expect(provider).toBeDefined();
    expect(provider?.flavor).toBe("openai_http");
    expect(provider?.model).toBe("gpt-4o");
  });

  it("falls back to the agent runtime when no HTTP provider is configured", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce(undefined);
    process.env.OPENLOOMI_AGENT_PROVIDER = "codex";
    resolveNativeAgentProviderRequestMock.mockReturnValue({
      provider: "codex",
      providerConfig: { codexPath: "codex" },
      modelConfig: { model: "gpt-5-codex" },
    });
    createAgentMock.mockReturnValue({
      async *run() {
        yield { type: "text", content: "CODEX_RUNTIME_OK" };
      },
    });
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "anthropic_messages",
    });
    expect(provider).toBeDefined();
    expect(provider?.flavor).toBe("agent_runtime");

    const result = await provider?.complete({ userContent: "run codex" });

    expect(registerProviderMock).toHaveBeenCalledOnce();
    expect(registerProviderMock).toHaveBeenCalledWith("codex");
    expect(registerProvidersMock).not.toHaveBeenCalled();
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5-codex",
        providerConfig: { codexPath: "codex" },
      }),
    );
    expect(result).toMatchObject({
      text: "CODEX_RUNTIME_OK",
      model: "gpt-5-codex",
    });
  });

  it("returns undefined when neither HTTP nor a non-claude agent runtime is configured", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce(undefined);
    process.env.OPENLOOMI_AGENT_PROVIDER = "claude";
    resolveNativeAgentProviderRequestMock.mockReturnValueOnce({
      provider: "claude",
    });
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "anthropic_messages",
    });
    expect(provider).toBeUndefined();
  });

  it("returns undefined when userId is absent and no runtime is set", async () => {
    // No HTTP path attempted (no userId) and OPENLOOMI_AGENT_PROVIDER unset.
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: undefined,
      prefer: "chat_completions",
    });
    expect(provider).toBeUndefined();
    expect(getActiveUserLlmProviderConfigMock).toHaveBeenCalledWith(undefined);
  });

  it("routes Gemini through the OpenAI-compatible transport", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce({
      providerId: "gemini",
      providerType: "openai_compatible",
      apiKey: "gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.5-flash",
    });
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "anthropic_messages",
    });

    expect(provider).toMatchObject({
      providerId: "gemini",
      flavor: "openai_http",
      model: "gemini-2.5-flash",
    });
  });

  it("records authoritative Gemini usage under the provider identity", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce({
      providerId: "gemini",
      providerType: "openai_compatible",
      apiKey: "gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.5-flash",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200 },
      ),
    );
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "chat_completions",
      endpoint: "translate",
    });
    const result = await provider?.complete({ userContent: "hi" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.any(Object),
    );
    expect(result?.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(recordUsageMock).toHaveBeenCalledWith({
      userId: "user-1",
      providerType: "gemini",
      model: "gemini-2.5-flash",
      endpoint: "translate",
      inputTokens: 11,
      outputTokens: 7,
    });
    fetchMock.mockRestore();
  });

  it("routes AWS Bedrock through the Converse adapter", async () => {
    getActiveUserLlmProviderConfigMock.mockResolvedValueOnce({
      providerId: "bedrock",
      providerType: "bedrock",
      model: "us.amazon.nova-lite-v1:0",
      region: "us-east-1",
    });
    const resolve = await loadResolver();
    const provider = await resolve({
      userId: "user-1",
      prefer: "chat_completions",
    });

    expect(provider).toMatchObject({
      providerId: "bedrock",
      flavor: "bedrock",
      model: "us.amazon.nova-lite-v1:0",
    });
  });
});
