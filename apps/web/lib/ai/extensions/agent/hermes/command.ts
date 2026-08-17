export interface HermesProviderConfig {
  hermesPath?: string;
  profile?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface HermesAcpCommand {
  command: string;
  args: string[];
}

export function normalizeHermesProviderConfig(
  value: Record<string, unknown> | undefined,
): HermesProviderConfig {
  const env =
    value?.env && typeof value.env === "object" && !Array.isArray(value.env)
      ? Object.fromEntries(
          Object.entries(value.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;

  return {
    hermesPath:
      typeof value?.hermesPath === "string" && value.hermesPath.trim()
        ? value.hermesPath.trim()
        : undefined,
    profile:
      typeof value?.profile === "string" && value.profile.trim()
        ? value.profile.trim()
        : undefined,
    timeoutMs:
      typeof value?.timeoutMs === "number" &&
      Number.isInteger(value.timeoutMs) &&
      value.timeoutMs > 0
        ? value.timeoutMs
        : undefined,
    env,
  };
}

export function buildHermesAcpCommand(
  providerConfig?: Record<string, unknown>,
): HermesAcpCommand {
  const config = normalizeHermesProviderConfig(providerConfig);
  const args: string[] = [];

  if (config.profile) {
    args.push("--profile", config.profile);
  }

  args.push("acp");

  return {
    command: config.hermesPath || "hermes",
    args,
  };
}
