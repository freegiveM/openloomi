import { isTauriMode } from "@/lib/env/constants";
import { getConfiguredAgentProviderResolution } from "./provider-env";
import {
  SELECTABLE_AGENT_RUNTIMES,
  type AgentRuntimePublicProbe,
  type AgentRuntimeSettingsResponse,
  type SelectableAgentRuntime,
} from "./runtime-contract";
import {
  type AgentRuntimeProbe,
  getRuntimePlatform,
  probeNativeClaudeRuntime,
  probeNativeCodexRuntime,
  probeNativeHermesRuntime,
  probeNativeOpenClawRuntime,
  probeNativeOpenCodeRuntime,
} from "./runtime-probe";

export async function getAgentRuntimeSettings(
  options: {
    forceRefresh?: boolean;
    claudeApiConfigured?: boolean;
    hermesApiConfigured?: boolean;
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

  const runtimes = Object.fromEntries(
    await Promise.all(
      SELECTABLE_AGENT_RUNTIMES.map(async (provider) => [
        provider,
        await safelyProbe(
          provider,
          options.forceRefresh,
          options.claudeApiConfigured,
          options.hermesApiConfigured,
        ),
      ]),
    ),
  ) as Record<SelectableAgentRuntime, AgentRuntimePublicProbe>;

  return {
    editable: true,
    preference: resolution.preference ?? null,
    effective: {
      provider: resolution.provider,
      source: resolution.source,
    },
    platform: getRuntimePlatform(),
    runtimes,
  };
}

async function safelyProbe(
  provider: SelectableAgentRuntime,
  forceRefresh = false,
  claudeApiConfigured = false,
  hermesApiConfigured = false,
): Promise<AgentRuntimePublicProbe> {
  try {
    const probe = await probeRuntime(provider, forceRefresh);
    return toPublicProbe(provider, probe, {
      claudeApiConfigured,
      hermesApiConfigured,
    });
  } catch (error) {
    console.warn(`[AgentRuntimeSettings] ${provider} probe failed`, error);
    return unverifiedProbe(provider);
  }
}

function probeRuntime(provider: SelectableAgentRuntime, force: boolean) {
  const options = { force };
  switch (provider) {
    case "claude":
      return probeNativeClaudeRuntime(options);
    case "codex":
      return probeNativeCodexRuntime(options);
    case "opencode":
      return probeNativeOpenCodeRuntime(options);
    case "hermes":
      return probeNativeHermesRuntime(options);
    case "openclaw":
      return probeNativeOpenClawRuntime(options);
  }
}

export function toPublicProbe(
  provider: SelectableAgentRuntime,
  probe: AgentRuntimeProbe | null,
  options: {
    claudeApiConfigured?: boolean;
    hermesApiConfigured?: boolean;
  } = {},
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

  // A complete saved Anthropic-compatible configuration is passed to Claude
  // directly or injected into the Hermes ACP child process during execution.
  if (
    ((provider === "claude" && options.claudeApiConfigured) ||
      (provider === "hermes" && options.hermesApiConfigured)) &&
    probe.versionPresent &&
    !probe.reason.endsWith("_CAPABILITY_FAILED") &&
    !probe.reason.endsWith("_CAPABILITY_TIMEOUT")
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
      : probe.reason.endsWith("_CAPABILITY_TIMEOUT")
        ? "CAPABILITY_TIMEOUT"
        : probe.reason.endsWith("_CAPABILITY_FAILED")
          ? "CAPABILITY_FAILED"
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
