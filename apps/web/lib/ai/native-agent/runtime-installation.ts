import type { AgentRuntimeSettingsResponse } from "./runtime-contract";

type AgentRuntimePlatform = AgentRuntimeSettingsResponse["platform"];

const CODEX_INSTALL_COMMANDS: Record<AgentRuntimePlatform, string> = {
  windows:
    'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  macos: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  linux: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
};

export const CODEX_LOGIN_COMMAND = "codex login";

export function getCodexInstallCommand(platform: AgentRuntimePlatform): string {
  return CODEX_INSTALL_COMMANDS[platform];
}
