import {
  getEnabledUserLlmApiSettingWithApiKey,
  getUserLlmApiSettingWithApiKey,
  type LlmApiProviderId,
  type UserLlmApiSettingWithApiKey,
} from "@/lib/db/queries";
import {
  getLlmProviderDefinition,
  resolveEnvironmentLlmProviderConfig,
  type ResolvedLlmProviderConfig,
} from "./llm-providers";

export type UserLlmProviderConfig = ResolvedLlmProviderConfig;
export type LegacyHttpLlmProviderConfig = UserLlmProviderConfig & {
  apiKey: string;
  baseUrl: string;
};

function resolveStoredSetting(
  setting: UserLlmApiSettingWithApiKey | null,
): UserLlmProviderConfig | undefined {
  if (!setting?.enabled) return undefined;

  const definition = getLlmProviderDefinition(setting.providerId);
  const apiKey =
    setting.apiKey?.trim() ||
    (definition.apiKeyEnv
      ? process.env[definition.apiKeyEnv]?.trim()
      : undefined) ||
    undefined;
  const baseUrl =
    setting.baseUrl?.trim() ||
    (definition.baseUrlEnv
      ? process.env[definition.baseUrlEnv]?.trim()
      : undefined) ||
    definition.defaultBaseUrl ||
    undefined;
  const model =
    setting.model?.trim() ||
    process.env[definition.modelEnv]?.trim() ||
    definition.defaultModel;
  const region =
    setting.region?.trim() ||
    (definition.regionEnv
      ? process.env[definition.regionEnv]?.trim()
      : undefined) ||
    (setting.providerId === "bedrock"
      ? process.env.AWS_DEFAULT_REGION?.trim()
      : undefined) ||
    definition.defaultRegion ||
    undefined;

  if (definition.apiKeyRequired && !apiKey) return undefined;
  if (definition.transport !== "bedrock" && !baseUrl) return undefined;
  if (!model) return undefined;

  return {
    providerId: setting.providerId,
    providerType: definition.transport,
    apiKey,
    baseUrl,
    model,
    region,
  };
}

export function getUserLlmProviderConfig(input: {
  userId: string;
  providerType: LlmApiProviderId;
  providerId?: never;
}): Promise<LegacyHttpLlmProviderConfig | undefined>;
export function getUserLlmProviderConfig(input: {
  userId: string;
  providerId: LlmApiProviderId;
  providerType?: never;
}): Promise<UserLlmProviderConfig | undefined>;
export async function getUserLlmProviderConfig({
  userId,
  providerId: requestedProviderId,
  providerType,
}: {
  userId: string;
  providerId?: LlmApiProviderId;
  /** @deprecated Use providerId. Retained for existing internal callers. */
  providerType?: LlmApiProviderId;
}): Promise<UserLlmProviderConfig | undefined> {
  const providerId = requestedProviderId ?? providerType;
  if (!providerId) return undefined;
  try {
    const setting = await getUserLlmApiSettingWithApiKey({
      userId,
      providerId,
    });
    return resolveStoredSetting(setting);
  } catch (error) {
    console.warn(`[AI Settings] Failed to load ${providerId} override`, error);
    return undefined;
  }
}

export async function getActiveUserLlmProviderConfig(
  userId?: string,
): Promise<UserLlmProviderConfig | undefined> {
  if (userId) {
    try {
      const setting = await getEnabledUserLlmApiSettingWithApiKey(userId);
      const resolved = resolveStoredSetting(setting);
      if (resolved) return resolved;
    } catch (error) {
      console.warn("[AI Settings] Failed to load enabled provider", error);
    }
  }

  try {
    return resolveEnvironmentLlmProviderConfig();
  } catch (error) {
    console.warn("[AI Settings] Invalid environment provider config", error);
    return undefined;
  }
}
