import "server-only";

import { buildCliEnvironment } from "@/lib/ai/extensions/agent/cli-process";

const CODEX_PROCESS_EXTRA_ENV_KEYS = [
  "ALL_PROXY",
  "BROWSER",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
] as const;
const CODEX_PROCESS_ENV_KEYS = new Set<string>([
  "CODEX_CA_CERTIFICATE",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  ...CODEX_PROCESS_EXTRA_ENV_KEYS,
]);
const SECRET_ENV_NAME =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|SECRET|PASSWORD)$|^DATABASE_URL$/i;

export function buildCodexProcessEnvironment(
  searchPath: string,
  options: {
    omit?: readonly string[];
    overrides?: Record<string, string>;
  } = {},
): NodeJS.ProcessEnv {
  const environment = buildCliEnvironment({ PATH: searchPath });

  for (const key of CODEX_PROCESS_EXTRA_ENV_KEYS) {
    const value = readProcessEnvironmentValue(key);
    if (value) setEnvironmentValue(environment, key, value);
  }
  for (const key of Object.keys(environment)) {
    if (
      !CODEX_PROCESS_ENV_KEYS.has(key.toUpperCase()) ||
      SECRET_ENV_NAME.test(key)
    ) {
      delete environment[key];
    }
  }
  for (const key of options.omit ?? []) {
    deleteEnvironmentValue(environment, key);
  }
  setEnvironmentValue(environment, "PATH", searchPath);
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    setEnvironmentValue(environment, key, value);
  }

  return environment;
}

export function readProcessEnvironmentValue(name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === normalizedName) return value;
  }
  return undefined;
}

function setEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  value: string,
): void {
  deleteEnvironmentValue(environment, name);
  environment[name] = value;
}

function deleteEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): void {
  const normalizedName = name.toUpperCase();
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === normalizedName) delete environment[key];
  }
}
