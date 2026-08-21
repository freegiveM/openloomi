export const AI_SETTINGS_CHANGED_EVENT = "openloomi:ai-settings-changed";
export const MISSING_API_KEY_REASON = "missing-api-key";

type ConversationProviderSetting = {
  providerId?: string;
  providerType: string;
  baseUrl: string | null;
  model: string | null;
  region?: string | null;
  enabled: boolean;
  hasApiKey: boolean;
};

type ConversationSystemDefault = {
  hasApiKey: boolean;
  configured?: boolean;
};

export type ConversationApiSettingsResponse = {
  settings: ConversationProviderSetting[];
  systemDefaults: Record<string, ConversationSystemDefault>;
  /**
   * The agent runtime selected via `OPENLOOMI_AGENT_PROVIDER`. Defaults
   * to `claude`. Non-claude runtimes (codex / opencode / hermes /
   * openclaw) bring their own CLI auth, so the UI must skip the
   * anthropic-key gate entirely when this is set to anything else.
   */
  defaultAgent?: string;
  /**
   * Probe of the Claude runtime bundled with OpenLoomi Desktop, surfaced by
   * `/api/preferences/ai`. `authenticated: true` means it found supported
   * Claude authentication for the same OS account, so no per-user API setting
   * is required.
   */
  nativeRuntime?: { ready?: boolean; authenticated?: boolean } | null;
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

  // Built-in Claude agent: if the bundled runtime finds supported existing
  // authentication (probed server-side), no per-user key is needed.
  // `systemDefaults.anthropic_compatible.hasApiKey` is intentionally
  // NOT consulted here — it was a stale env-var mirror and would
  // falsely mark the user as configured in Tauri builds launched
  // with an Anthropic key in their env.
  if (response.nativeRuntime?.authenticated) {
    return true;
  }

  const hasUserConfiguration = response.settings.some((setting) => {
    if (!setting.enabled || !hasText(setting.model)) return false;
    if (setting.providerType === "bedrock") {
      return hasText(setting.region ?? null);
    }
    const keyOptional = setting.providerId === "ollama";
    return hasText(setting.baseUrl) && (keyOptional || setting.hasApiKey);
  });

  return (
    hasUserConfiguration ||
    Object.values(response.systemDefaults).some(
      (defaults) => defaults.configured,
    )
  );
}
