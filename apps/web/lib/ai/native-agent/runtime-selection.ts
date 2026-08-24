import "server-only";

import type {
  AgentRuntimeSettingsResponse,
  SelectableAgentRuntime,
} from "./runtime-contract";
import { writeAgentRuntimePreference } from "./runtime-preference";
import { getAgentRuntimeSettings } from "./runtime-settings";
import { getUserLlmProviderConfig } from "../user-llm-api-settings";

export async function getRuntimeApiConfiguration(userId: string) {
  const anthropicApiConfigured = Boolean(
    await getUserLlmProviderConfig({
      userId,
      providerType: "anthropic_compatible",
    }),
  );
  return {
    claudeApiConfigured: anthropicApiConfigured,
    hermesApiConfigured: anthropicApiConfigured,
  };
}

export async function selectReadyAgentRuntime(
  userId: string,
  provider: SelectableAgentRuntime,
): Promise<
  | { selected: true; settings: AgentRuntimeSettingsResponse }
  | { selected: false; settings: AgentRuntimeSettingsResponse }
> {
  let apiConfiguration = await getRuntimeApiConfiguration(userId);
  let readiness = await getAgentRuntimeSettings({
    forceRefresh: true,
    ...apiConfiguration,
  });

  // The runtime probe can take several seconds. If the shared API setting
  // changes while it runs, remap Claude/Hermes against the latest value.
  if (provider === "claude" || provider === "hermes") {
    const latestApiConfiguration = await getRuntimeApiConfiguration(userId);
    if (
      latestApiConfiguration.claudeApiConfigured !==
      apiConfiguration.claudeApiConfigured
    ) {
      apiConfiguration = latestApiConfiguration;
      readiness = await getAgentRuntimeSettings(apiConfiguration);
    }
  }

  if (!readiness.runtimes?.[provider].ready) {
    return { selected: false, settings: readiness };
  }

  writeAgentRuntimePreference(provider);
  return {
    selected: true,
    settings: {
      ...readiness,
      preference: provider,
      effective: { provider, source: "preference" },
    },
  };
}
