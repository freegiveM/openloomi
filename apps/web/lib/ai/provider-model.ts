import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { customProvider, type LanguageModel } from "ai";
import {
  resolveEnvironmentLlmProviderConfig,
  type ResolvedLlmProviderConfig,
} from "./llm-providers";

let activeProviderConfig: ResolvedLlmProviderConfig | null = null;
let activeProviderFingerprint: string | null = null;
let cachedModel: LanguageModel | null = null;
let cachedProvider: ReturnType<typeof customProvider> | null = null;

export function setActiveLlmProviderConfig(
  config: ResolvedLlmProviderConfig | null,
): void {
  const fingerprint = config ? JSON.stringify(config) : null;
  if (fingerprint !== activeProviderFingerprint) {
    cachedModel = null;
    cachedProvider = null;
  }
  activeProviderConfig = config;
  activeProviderFingerprint = fingerprint;
}

export function clearActiveLlmProviderConfig(): void {
  setActiveLlmProviderConfig(null);
}

export function createLlmLanguageModel(
  config: ResolvedLlmProviderConfig,
  modelName = config.model,
): LanguageModel {
  if (config.providerType === "bedrock") {
    return createAmazonBedrock({
      region: config.region,
      apiKey: config.apiKey,
      credentialProvider: config.apiKey ? undefined : defaultProvider(),
    }).languageModel(modelName) as LanguageModel;
  }

  if (config.providerType === "anthropic_compatible") {
    return createAnthropic({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    }).languageModel(modelName) as LanguageModel;
  }

  if (!config.baseUrl) {
    throw new Error(`Base URL is required for ${config.providerId}`);
  }

  return createOpenAICompatible({
    name: config.providerId,
    baseURL: config.baseUrl,
    apiKey: config.apiKey ?? "ollama",
    headers:
      config.providerId === "openrouter"
        ? {
            "HTTP-Referer":
              process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3515",
            "X-Title": "OpenLoomi",
          }
        : undefined,
  }).chatModel(modelName);
}

function getActiveConfig(): ResolvedLlmProviderConfig {
  const config = activeProviderConfig ?? resolveEnvironmentLlmProviderConfig();
  if (!config) {
    throw new Error(
      "No LLM provider configured. Enable one in Preferences or set LLM_PROVIDER and its environment variables.",
    );
  }
  return config;
}

export function getActiveLlmProviderConfig():
  | ResolvedLlmProviderConfig
  | undefined {
  try {
    return getActiveConfig();
  } catch {
    return undefined;
  }
}

export function getModel(_isNativeMode: boolean): LanguageModel {
  if (!cachedModel) {
    cachedModel = createLlmLanguageModel(getActiveConfig());
  }
  return cachedModel;
}

export function getVLMModel(isNativeMode: boolean): LanguageModel {
  return getModel(isNativeMode);
}

export function createDynamicModel(
  _isNativeMode: boolean,
  modelName?: string,
): LanguageModel {
  const config = getActiveConfig();
  return createLlmLanguageModel(config, modelName?.trim() || config.model);
}

export function getModelProvider(
  isNativeMode: boolean,
): ReturnType<typeof customProvider> {
  if (cachedProvider) return cachedProvider;

  const model = getModel(isNativeMode);
  type ProviderLanguageModel = NonNullable<
    Parameters<typeof customProvider>[0]["languageModels"]
  >[string];
  const providerModel = model as unknown as ProviderLanguageModel;
  cachedProvider = customProvider({
    languageModels: {
      "chat-model": providerModel,
      "vlm-model": providerModel,
      "title-model": providerModel,
      "artifact-model": providerModel,
    },
  });
  return cachedProvider;
}
