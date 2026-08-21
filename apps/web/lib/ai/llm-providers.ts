export const LLM_PROVIDER_IDS = [
  "openai_compatible",
  "anthropic_compatible",
  "openrouter",
  "bedrock",
  "gemini",
  "ollama",
  "deepseek",
  "xai",
] as const;

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];
export type LlmProviderTransport =
  | "openai_compatible"
  | "anthropic_compatible"
  | "bedrock";

export type LlmProviderDefinition = {
  id: LlmProviderId;
  displayName: string;
  description: string;
  transport: LlmProviderTransport;
  defaultBaseUrl: string | null;
  defaultModel: string;
  defaultRegion: string | null;
  apiKeyRequired: boolean;
  apiKeyPlaceholder: string;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  modelEnv: string;
  regionEnv?: string;
};

export type ResolvedLlmProviderConfig = {
  providerId: LlmProviderId;
  providerType: LlmProviderTransport;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  region?: string;
};

type LlmEnvironment = Readonly<Record<string, string | undefined>>;

export const LLM_PROVIDER_CATALOG: Record<
  LlmProviderId,
  LlmProviderDefinition
> = {
  openai_compatible: {
    id: "openai_compatible",
    displayName: "OpenAI compatible",
    description: "OpenAI or another endpoint implementing Chat Completions.",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    defaultRegion: null,
    apiKeyRequired: true,
    apiKeyPlaceholder: "sk-...",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    modelEnv: "OPENAI_MODEL",
  },
  anthropic_compatible: {
    id: "anthropic_compatible",
    displayName: "Anthropic compatible",
    description: "Anthropic Claude or another endpoint implementing Messages.",
    transport: "anthropic_compatible",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    defaultRegion: null,
    apiKeyRequired: true,
    apiKeyPlaceholder: "sk-ant-...",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    modelEnv: "ANTHROPIC_MODEL",
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    description: "OpenRouter's catalog through its Chat Completions API.",
    transport: "openai_compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    defaultRegion: null,
    apiKeyRequired: true,
    apiKeyPlaceholder: "sk-or-v1-...",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    modelEnv: "OPENROUTER_MODEL",
  },
  bedrock: {
    id: "bedrock",
    displayName: "AWS Bedrock",
    description: "Claude, Nova, Llama, and DeepSeek through Bedrock Converse.",
    transport: "bedrock",
    defaultBaseUrl: null,
    defaultModel: "us.amazon.nova-lite-v1:0",
    defaultRegion: "us-east-1",
    apiKeyRequired: false,
    apiKeyPlaceholder: "Optional Bedrock API key",
    apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK",
    modelEnv: "AWS_BEDROCK_MODEL",
    regionEnv: "AWS_REGION",
  },
  gemini: {
    id: "gemini",
    displayName: "Google Gemini",
    description:
      "Gemini models through Google AI Studio's OpenAI-compatible API.",
    transport: "openai_compatible",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    defaultRegion: null,
    apiKeyRequired: true,
    apiKeyPlaceholder: "AIza...",
    apiKeyEnv: "GEMINI_API_KEY",
    baseUrlEnv: "GEMINI_BASE_URL",
    modelEnv: "GEMINI_MODEL",
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama",
    description: "Local Llama, Mistral, and other models served by Ollama.",
    transport: "openai_compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    defaultRegion: null,
    apiKeyRequired: false,
    apiKeyPlaceholder: "Not required",
    apiKeyEnv: "OLLAMA_API_KEY",
    baseUrlEnv: "OLLAMA_BASE_URL",
    modelEnv: "OLLAMA_MODEL",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    description: "DeepSeek chat and reasoning models through the DeepSeek API.",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    defaultRegion: null,
    apiKeyRequired: true,
    apiKeyPlaceholder: "sk-...",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    modelEnv: "DEEPSEEK_MODEL",
  },
  xai: {
    id: "xai",
    displayName: "xAI (Grok)",
    description: "Grok models through xAI's Chat Completions API.",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    defaultRegion: null,
    apiKeyRequired: true,
    apiKeyPlaceholder: "xai-...",
    apiKeyEnv: "XAI_API_KEY",
    baseUrlEnv: "XAI_BASE_URL",
    modelEnv: "XAI_MODEL",
  },
};

export function isLlmProviderId(value: string): value is LlmProviderId {
  return (LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getLlmProviderDefinition(
  providerId: LlmProviderId,
): LlmProviderDefinition {
  return LLM_PROVIDER_CATALOG[providerId];
}

export function buildOpenAiChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function buildAnthropicMessagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/messages`;
}

export function resolveEnvironmentLlmProviderConfig(
  environment: LlmEnvironment = process.env,
): ResolvedLlmProviderConfig | undefined {
  const explicitProviderId = environment.LLM_PROVIDER?.trim();
  let providerId: LlmProviderId | undefined;

  if (explicitProviderId) {
    if (!isLlmProviderId(explicitProviderId)) {
      throw new Error(`Unsupported LLM_PROVIDER: ${explicitProviderId}`);
    }
    providerId = explicitProviderId;
  } else {
    providerId = LLM_PROVIDER_IDS.find((id) => {
      const definition = LLM_PROVIDER_CATALOG[id];
      return Boolean(environment[definition.modelEnv]?.trim());
    });
  }

  if (!providerId) return undefined;
  const definition = LLM_PROVIDER_CATALOG[providerId];
  const model = environment[definition.modelEnv]?.trim();
  const apiKey = definition.apiKeyEnv
    ? environment[definition.apiKeyEnv]?.trim()
    : undefined;
  const baseUrl =
    (definition.baseUrlEnv
      ? environment[definition.baseUrlEnv]?.trim()
      : undefined) ??
    definition.defaultBaseUrl ??
    undefined;
  const region =
    (definition.regionEnv
      ? environment[definition.regionEnv]?.trim()
      : undefined) ??
    (providerId === "bedrock"
      ? environment.AWS_DEFAULT_REGION?.trim()
      : undefined) ??
    definition.defaultRegion ??
    undefined;

  if (!model) {
    throw new Error(`${definition.modelEnv} is required for ${providerId}`);
  }
  if (definition.transport !== "bedrock" && !baseUrl) {
    throw new Error(`Base URL is required for ${providerId}`);
  }
  if (definition.apiKeyRequired && !apiKey) {
    throw new Error(`${definition.apiKeyEnv} is required for ${providerId}`);
  }

  return {
    providerId,
    providerType: definition.transport,
    apiKey,
    baseUrl,
    model,
    region,
  };
}
