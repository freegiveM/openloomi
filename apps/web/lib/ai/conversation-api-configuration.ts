export const AI_SETTINGS_CHANGED_EVENT = "openloomi:ai-settings-changed";
export const MISSING_API_KEY_REASON = "missing-api-key";

type ConversationProviderSetting = {
  providerType: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  hasApiKey: boolean;
};

type ConversationSystemDefault = {
  hasApiKey: boolean;
};

export type ConversationApiSettingsResponse = {
  settings: ConversationProviderSetting[];
  systemDefaults: {
    anthropic_compatible: ConversationSystemDefault;
  };
  /**
   * The agent runtime selected via `OPENLOOMI_AGENT_PROVIDER`. Defaults
   * to `claude`. Non-claude runtimes (codex / opencode / hermes /
   * openclaw) bring their own CLI auth, so the UI must skip the
   * anthropic-key gate entirely when this is set to anything else.
   */
  defaultAgent?: string;
};

function hasText(value: string | null) {
  return Boolean(value?.trim());
}

/**
 * The built-in Claude runtime is the only agent that needs an
 * Anthropic-compatible API key. Every other supported runtime
 * (codex/opencode/hermes/openclaw) shells out to its own CLI binary
 * with its own auth and therefore should not be blocked by this UI
 * check. Keep this set in sync with
 * `apps/web/lib/ai/native-agent/provider-env.ts`'s `SUPPORTED_ENV_PROVIDERS`.
 */
const CONVERSATION_API_REQUIRED_AGENTS = new Set(["claude"]);

export function hasUsableConversationApiConfiguration(
  response: ConversationApiSettingsResponse,
) {
  // If the server tells us the runtime is anything other than the
  // built-in Claude agent, the missing-anthropic-key CTA is irrelevant.
  if (
    response.defaultAgent &&
    !CONVERSATION_API_REQUIRED_AGENTS.has(response.defaultAgent)
  ) {
    return true;
  }

  const userSetting = response.settings.find(
    (setting) => setting.providerType === "anthropic_compatible",
  );
  const hasUserConfiguration = Boolean(
    userSetting?.enabled &&
    userSetting.hasApiKey &&
    hasText(userSetting.baseUrl) &&
    hasText(userSetting.model),
  );

  return (
    hasUserConfiguration ||
    response.systemDefaults.anthropic_compatible.hasApiKey
  );
}
