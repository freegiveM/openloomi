import { createHash } from "node:crypto";

import { CodexAppServerClient } from "./app-server";
import { runCodexCli, type CodexProviderConfig } from "./command";
import { resolveCodexCommand } from "./command-resolver";

const PREFLIGHT_TIMEOUT_MS = 5_000;
const PREFLIGHT_CACHE_TTL_MS = 60_000;
const MAX_MODEL_PAGES = 20;
const MAX_MODELS_IN_ERROR = 8;

interface ModelListEntry {
  id?: string;
  model?: string;
}

interface ModelListResult {
  data: ModelListEntry[];
  nextCursor?: string | null;
}

export interface CodexRuntimePreflightOptions {
  command: string;
  cwd: string;
  model?: string;
  providerConfig: CodexProviderConfig;
  signal?: AbortSignal;
}

export interface CodexRuntimePreflightResult {
  command: string;
  version: string;
  availableModels?: string[];
  modelCatalogChecked: boolean;
}

export class CodexRuntimePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRuntimePreflightError";
  }
}

export class CodexModelCompatibilityError extends Error {
  constructor(
    readonly model: string,
    readonly installedVersion: string,
    readonly availableModels: string[],
  ) {
    const availableSummary = availableModels
      .slice(0, MAX_MODELS_IN_ERROR)
      .join(", ");
    const availableSuffix =
      availableModels.length > MAX_MODELS_IN_ERROR ? ", …" : "";
    const availableHint = availableSummary
      ? ` Models available from this installation include: ${availableSummary}${availableSuffix}.`
      : "";

    super(
      `The selected model "${model}" is not available in Codex CLI ${installedVersion}. It may require a newer Codex CLI or may not be available to this account. Upgrade Codex with \`codex update\` (or install the latest \`@openai/codex\`), restart OpenLoomi, or choose a compatible model.${availableHint}`,
    );
    this.name = "CodexModelCompatibilityError";
  }
}

interface CachedPreflight {
  expiresAt: number;
  result: Promise<CodexRuntimePreflightResult>;
}

const preflightCache = new Map<string, CachedPreflight>();

/**
 * Validate the installed Codex binary before starting a generation request.
 *
 * The version probe is mandatory because a missing or broken executable cannot
 * service the request. Model compatibility uses Codex's official app-server
 * `model/list` capability discovery instead of an OpenLoomi-maintained version
 * matrix that would become stale. Catalog discovery deliberately fails open:
 * older CLIs and temporary app-server/auth failures still get a chance to run
 * `codex exec`, whose original stderr is preserved for the user.
 */
export async function preflightCodexRuntime(
  options: CodexRuntimePreflightOptions,
): Promise<CodexRuntimePreflightResult> {
  throwIfAborted(options.signal);

  const resolvedOptions = {
    ...options,
    command: resolveCodexCommand({
      configuredCommand:
        options.providerConfig.codexPath ??
        (options.command === "codex" ? undefined : options.command),
      basePath: options.providerConfig.env?.PATH,
      workingDirectory: options.cwd,
    }),
  };

  const cacheKey = createPreflightCacheKey(resolvedOptions);
  const now = Date.now();
  let cached = preflightCache.get(cacheKey);
  if (cached && cached.expiresAt <= now) {
    preflightCache.delete(cacheKey);
    cached = undefined;
  }

  if (!cached) {
    const result = runPreflight(resolvedOptions).catch((error) => {
      if (!(error instanceof CodexModelCompatibilityError)) {
        preflightCache.delete(cacheKey);
      }
      throw error;
    });
    cached = {
      expiresAt: now + PREFLIGHT_CACHE_TTL_MS,
      result,
    };
    preflightCache.set(cacheKey, cached);
  }

  const result = await awaitWithAbort(cached.result, options.signal);
  throwIfAborted(options.signal);
  return result;
}

export function clearCodexRuntimePreflightCache(): void {
  preflightCache.clear();
}

export function parseCodexVersion(output: string): string | undefined {
  const match = output.match(
    /(?:^|\s)(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/i,
  );
  return match?.[1];
}

async function runPreflight(
  options: CodexRuntimePreflightOptions,
): Promise<CodexRuntimePreflightResult> {
  const version = await probeCodexVersion(options);
  if (!options.model) {
    return {
      command: options.command,
      version,
      modelCatalogChecked: false,
    };
  }

  let availableModels: string[];
  try {
    availableModels = await probeCodexModels(options);
  } catch (probeError) {
    console.error("[DIAG] probeCodexModels failed:", probeError);
    return {
      command: options.command,
      version,
      modelCatalogChecked: false,
    };
  }

  if (availableModels.length === 0) {
    return {
      command: options.command,
      version,
      modelCatalogChecked: false,
    };
  }

  if (!availableModels.includes(options.model)) {
    throw new CodexModelCompatibilityError(
      options.model,
      version,
      availableModels,
    );
  }

  return {
    command: options.command,
    version,
    availableModels,
    modelCatalogChecked: true,
  };
}

async function probeCodexVersion(
  options: CodexRuntimePreflightOptions,
): Promise<string> {
  let closeEvent:
    | {
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut?: boolean;
      }
    | undefined;

  for await (const event of runCodexCli(options.command, ["--version"], {
    cwd: options.cwd,
    stdin: "",
    env: options.providerConfig.env,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  })) {
    if (event.type === "close") {
      closeEvent = event;
    }
  }

  if (!closeEvent) {
    throw new CodexRuntimePreflightError(
      "Codex CLI preflight ended before reporting its version. Run `codex --version` to verify the installation.",
    );
  }

  const output = [closeEvent.stdout, closeEvent.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");

  if (closeEvent.timedOut) {
    throw new CodexRuntimePreflightError(
      `Codex CLI version check timed out after ${PREFLIGHT_TIMEOUT_MS}ms. Run \`${options.command} --version\` and repair or upgrade the Codex installation.`,
    );
  }

  if (closeEvent.exitCode !== 0) {
    const outputSuffix = output ? `: ${output}` : "";
    throw new CodexRuntimePreflightError(
      `Codex CLI version check failed with code ${closeEvent.exitCode}${outputSuffix}. Run \`${options.command} --version\` and repair or upgrade the Codex installation.`,
    );
  }

  const version = parseCodexVersion(output);
  if (!version) {
    throw new CodexRuntimePreflightError(
      `OpenLoomi could not determine the installed Codex CLI version from \`${options.command} --version\`. Output: ${output || "(empty)"}. Upgrade Codex or verify providerConfig.codexPath.`,
    );
  }

  return version;
}

async function probeCodexModels(
  options: CodexRuntimePreflightOptions,
): Promise<string[]> {
  const client = new CodexAppServerClient({
    command: options.command,
    cwd: options.cwd,
    profile: options.providerConfig.profile,
    env: options.providerConfig.env,
  });
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(
      new Error(
        `Codex app-server preflight timed out after ${PREFLIGHT_TIMEOUT_MS}ms`,
      ),
    );
  }, PREFLIGHT_TIMEOUT_MS);
  timeout.unref?.();

  try {
    await client.initialize({ signal: timeoutController.signal });

    const models = new Set<string>();
    let cursor: string | undefined;
    let catalogComplete = false;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const result = parseModelListResult(
        await client.requestRaw(
          "model/list",
          {
            limit: 100,
            includeHidden: true,
            ...(cursor ? { cursor } : {}),
          },
          { signal: timeoutController.signal },
        ),
      );
      for (const entry of result.data) {
        if (entry.id?.trim()) {
          models.add(entry.id.trim());
        }
        if (entry.model?.trim()) {
          models.add(entry.model.trim());
        }
      }

      const nextCursor = result.nextCursor?.trim();
      if (!nextCursor || nextCursor === cursor) {
        catalogComplete = true;
        break;
      }
      cursor = nextCursor;
    }

    if (!catalogComplete) {
      throw new Error(
        `Codex app-server model/list exceeded ${MAX_MODEL_PAGES} pages`,
      );
    }

    return [...models].sort();
  } finally {
    clearTimeout(timeout);
    await client.shutdown();
  }
}

function parseModelListResult(value: unknown): ModelListResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex app-server returned an invalid model/list result");
  }

  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Codex app-server model/list result is missing data");
  }

  const entries = data.filter(
    (entry): entry is ModelListEntry =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
  const nextCursor = (value as { nextCursor?: unknown }).nextCursor;

  return {
    data: entries,
    nextCursor:
      typeof nextCursor === "string" || nextCursor === null
        ? nextCursor
        : undefined,
  };
}

function createPreflightCacheKey(
  options: CodexRuntimePreflightOptions,
): string {
  const envFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(options.providerConfig.env ?? {}).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      ),
    )
    .digest("hex");

  return JSON.stringify([
    options.command,
    options.cwd,
    options.providerConfig.profile ?? "",
    options.model ?? "",
    envFingerprint,
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The Codex request was aborted", "AbortError");
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The Codex request was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
