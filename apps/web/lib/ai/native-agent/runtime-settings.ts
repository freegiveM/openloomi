import { isTauriMode } from "@/lib/env/constants";
import { getConfiguredAgentProviderResolution } from "./provider-env";
import type {
  AgentRuntimePublicProbe,
  AgentRuntimeSettingsResponse,
  SelectableAgentRuntime,
} from "./runtime-contract";
import {
  type CodexRuntimeProbe,
  type NativeRuntimeProbe,
  getRuntimePlatform,
  probeNativeClaudeRuntime,
  probeNativeCodexRuntime,
} from "./runtime-probe";

type RuntimeProbe = NativeRuntimeProbe | CodexRuntimeProbe;

export async function getAgentRuntimeSettings(
  options: {
    forceRefresh?: boolean;
    claudeApiConfigured?: boolean;
  } = {},
): Promise<AgentRuntimeSettingsResponse> {
  const resolution = getConfiguredAgentProviderResolution();

  if (!isTauriMode()) {
    return {
      editable: false,
      preference: null,
      effective: {
        provider: resolution.provider,
        source: resolution.source,
      },
      platform: getRuntimePlatform(),
      runtimes: null,
    };
  }

  const [claude, codex] = await Promise.all([
    safelyProbe("claude", options.forceRefresh, options.claudeApiConfigured),
    safelyProbe("codex", options.forceRefresh),
  ]);

  return {
    editable: true,
    preference: resolution.preference ?? null,
    effective: {
      provider: resolution.provider,
      source: resolution.source,
    },
    platform: getRuntimePlatform(),
    runtimes: { claude, codex },
  };
}

async function safelyProbe(
  provider: SelectableAgentRuntime,
  forceRefresh = false,
  claudeApiConfigured = false,
): Promise<AgentRuntimePublicProbe> {
  try {
    const probe =
      provider === "claude"
        ? await probeNativeClaudeRuntime({ force: forceRefresh })
        : await probeNativeCodexRuntime({ force: forceRefresh });
    return toPublicProbe(provider, probe, { claudeApiConfigured });
  } catch (error) {
    console.warn(`[AgentRuntimeSettings] ${provider} probe failed`, error);
    return unverifiedProbe(provider);
  }
}

export function toPublicProbe(
  provider: SelectableAgentRuntime,
  probe: RuntimeProbe | null,
  options: { claudeApiConfigured?: boolean } = {},
): AgentRuntimePublicProbe {
  if (!probe) return unverifiedProbe(provider);

  if (!probe.available) {
    return {
      provider,
      installed: false,
      authenticated: null,
      ready: false,
      readyVia: null,
      status: "not_installed",
      version: null,
      reason: "CLI_UNAVAILABLE",
    };
  }

  if (probe.ready && probe.authenticated) {
    return {
      provider,
      installed: true,
      authenticated: true,
      ready: true,
      readyVia: "cli",
      status: "ready",
      version: probe.version,
      reason: "READY",
    };
  }

  // Claude still needs an installed CLI, but a complete saved Anthropic-
  // compatible configuration is a valid alternative to `claude auth login`.
  if (
    provider === "claude" &&
    options.claudeApiConfigured &&
    probe.versionPresent
  ) {
    return {
      provider,
      installed: true,
      authenticated: probe.authenticated,
      ready: true,
      readyVia: "api",
      status: "ready",
      version: probe.version,
      reason: "READY",
    };
  }

  if (probe.reason.endsWith("_AUTH_REQUIRED")) {
    return {
      provider,
      installed: true,
      authenticated: false,
      ready: false,
      readyVia: null,
      status: "login_required",
      version: probe.version,
      reason: "AUTH_REQUIRED",
    };
  }

  const reason = probe.reason.endsWith("_VERSION_TIMEOUT")
    ? "VERSION_TIMEOUT"
    : probe.reason.endsWith("_VERSION_FAILED")
      ? "VERSION_FAILED"
      : probe.reason.endsWith("_AUTH_STATUS_TIMEOUT")
        ? "AUTH_TIMEOUT"
        : probe.reason.endsWith("_AUTH_STATUS_UNAVAILABLE")
          ? "AUTH_UNAVAILABLE"
          : "PROBE_FAILED";

  return {
    provider,
    installed: true,
    authenticated: null,
    ready: false,
    readyVia: null,
    status: "unverified",
    version: probe.version,
    reason,
  };
}

function unverifiedProbe(
  provider: SelectableAgentRuntime,
): AgentRuntimePublicProbe {
  return {
    provider,
    installed: false,
    authenticated: null,
    ready: false,
    readyVia: null,
    status: "unverified",
    version: null,
    reason: "PROBE_FAILED",
  };
}
