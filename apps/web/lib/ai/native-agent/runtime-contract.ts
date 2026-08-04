export const SELECTABLE_AGENT_RUNTIMES = ["claude", "codex"] as const;

export type SelectableAgentRuntime = (typeof SELECTABLE_AGENT_RUNTIMES)[number];

export type AgentRuntimeSetupStatus =
  | "ready"
  | "login_required"
  | "not_installed"
  | "unverified";

export type AgentRuntimePublicProbe = {
  provider: SelectableAgentRuntime;
  installed: boolean;
  authenticated: boolean | null;
  ready: boolean;
  status: AgentRuntimeSetupStatus;
  version: string | null;
  reason:
    | "READY"
    | "CLI_UNAVAILABLE"
    | "VERSION_FAILED"
    | "VERSION_TIMEOUT"
    | "AUTH_REQUIRED"
    | "AUTH_UNAVAILABLE"
    | "AUTH_TIMEOUT"
    | "PROBE_FAILED";
};

export type AgentRuntimeSettingsResponse = {
  editable: boolean;
  preference: SelectableAgentRuntime | null;
  effective: {
    provider: string;
    source: "preference" | "environment" | "default";
  };
  platform: "windows" | "macos" | "linux";
  runtimes: Record<SelectableAgentRuntime, AgentRuntimePublicProbe> | null;
};
