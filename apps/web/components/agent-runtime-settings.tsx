"use client";

import { Badge, Button, Separator } from "@openloomi/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { RemixIcon } from "@/components/remix-icon";
import { toast } from "@/components/toast";
import { AI_SETTINGS_CHANGED_EVENT } from "@/lib/ai/conversation-api-configuration";
import {
  type AgentRuntimePublicProbe,
  type AgentRuntimeSettingsResponse,
  type SelectableAgentRuntime,
  canSaveAgentRuntime,
  isSelectableAgentRuntime,
} from "@/lib/ai/native-agent/runtime-contract";
import {
  CODEX_LOGIN_COMMAND,
  getCodexInstallCommand,
} from "@/lib/ai/native-agent/runtime-installation";
import { notifyAiSettingsChanged } from "@/lib/ai/notify-ai-settings-changed";
import { isTauri, openUrl } from "@/lib/tauri";
import { cn, fetchWithAuth } from "@/lib/utils";

const runtimeOptions: Array<{
  provider: SelectableAgentRuntime;
  name: string;
  builtIn: boolean;
  descriptionKey: string;
  descriptionFallback: string;
  docsUrl: string;
  loginCommand?: string;
  setupCommand?: string;
}> = [
  {
    provider: "claude",
    name: "Claude",
    builtIn: true,
    descriptionKey: "settings.agentRuntimeClaudeDescription",
    descriptionFallback:
      "Powered by Claude Agent SDK with its runtime bundled in OpenLoomi—no separate Claude CLI installation required. Use a saved Anthropic-compatible API configuration or existing Claude authentication.",
    docsUrl: "https://openloomi.ai/docs/reference/agent-runtimes/claude",
  },
  {
    provider: "codex",
    name: "Codex CLI",
    builtIn: false,
    descriptionKey: "settings.agentRuntimeCodexDescription",
    descriptionFallback: "Use your local Codex CLI installation and account.",
    docsUrl: "https://learn.chatgpt.com/docs/codex/cli",
    loginCommand: CODEX_LOGIN_COMMAND,
  },
  {
    provider: "opencode",
    name: "OpenCode",
    builtIn: false,
    descriptionKey: "settings.agentRuntimeOpenCodeDescription",
    descriptionFallback:
      "Use your local OpenCode CLI and its configured model providers.",
    docsUrl: "https://openloomi.ai/docs/reference/agent-runtimes/opencode",
    loginCommand: "opencode auth login",
  },
  {
    provider: "hermes",
    name: "Hermes",
    builtIn: false,
    descriptionKey: "settings.agentRuntimeHermesDescription",
    descriptionFallback:
      "Use your local Hermes ACP runtime and configured model provider.",
    docsUrl: "https://openloomi.ai/docs/reference/agent-runtimes/hermes",
    setupCommand: "hermes setup",
  },
  {
    provider: "openclaw",
    name: "OpenClaw",
    builtIn: false,
    descriptionKey: "settings.agentRuntimeOpenClawDescription",
    descriptionFallback:
      "Use your local OpenClaw CLI with a reachable authenticated Gateway.",
    docsUrl: "https://openloomi.ai/docs/reference/agent-runtimes/openclaw",
    setupCommand: "openclaw onboard --install-daemon",
  },
];

export function AgentRuntimeSettings() {
  const { t } = useTranslation();
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [state, setState] = useState<AgentRuntimeSettingsResponse | null>(null);
  const [draft, setDraft] = useState<SelectableAgentRuntime | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRequestId = useRef(0);
  const loadAbortController = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const pendingReloadRef = useRef(false);

  const loadState = useCallback(
    async (refresh = false) => {
      if (savingRef.current) {
        pendingReloadRef.current = true;
        return;
      }

      const requestId = ++loadRequestId.current;
      loadAbortController.current?.abort();
      const controller = new AbortController();
      loadAbortController.current = controller;
      if (refresh) setRefreshing(true);
      else setLoading(true);
      if (refresh) setLoading(false);
      else setRefreshing(false);
      setLoadFailed(false);
      try {
        const response = await fetchWithAuth(
          `/api/preferences/agent-runtime${refresh ? "?refresh=1" : ""}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextState =
          (await response.json()) as AgentRuntimeSettingsResponse;
        if (requestId !== loadRequestId.current) return;
        setState(nextState);
        setDraft(
          (current) =>
            current ??
            (isSelectableAgentRuntime(nextState.effective.provider)
              ? nextState.effective.provider
              : null),
        );
      } catch (error) {
        if (controller.signal.aborted || requestId !== loadRequestId.current) {
          return;
        }
        console.error("[Agent Runtime Settings] Failed to load state", error);
        setLoadFailed(true);
        toast({
          type: "error",
          description: t(
            "settings.agentRuntimeLoadError",
            "Failed to check agent runtimes.",
          ),
        });
      } finally {
        if (requestId === loadRequestId.current) {
          setLoading(false);
          setRefreshing(false);
          if (loadAbortController.current === controller) {
            loadAbortController.current = null;
          }
        }
      }
    },
    [t],
  );

  useEffect(() => {
    const inDesktop = isTauri();
    setDesktop(inDesktop);
    if (inDesktop) void loadState();
  }, [loadState]);

  useEffect(() => {
    if (desktop !== true) return;
    const handleSettingsChanged = () => void loadState();
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () =>
      window.removeEventListener(
        AI_SETTINGS_CHANGED_EVENT,
        handleSettingsChanged,
      );
  }, [desktop, loadState]);

  useEffect(
    () => () => {
      ++loadRequestId.current;
      loadAbortController.current?.abort();
    },
    [],
  );

  const saveSelection = async () => {
    if (
      savingRef.current ||
      !state ||
      !draft ||
      !canSaveAgentRuntime(state, draft)
    ) {
      return;
    }
    ++loadRequestId.current;
    loadAbortController.current?.abort();
    loadAbortController.current = null;
    setLoading(false);
    setRefreshing(false);
    savingRef.current = true;
    setSaving(true);
    try {
      const response = await fetchWithAuth("/api/preferences/agent-runtime", {
        method: "PUT",
        body: JSON.stringify({ provider: draft }),
      });
      const payload = (await response.json().catch(() => null)) as
        | AgentRuntimeSettingsResponse
        | { error?: string; settings?: AgentRuntimeSettingsResponse }
        | null;
      if (!response.ok) {
        if (
          response.status === 409 &&
          payload &&
          "settings" in payload &&
          payload.settings
        ) {
          setState(payload.settings);
          toast({
            type: "error",
            description: t(
              "settings.agentRuntimeNotReadyError",
              "The selected runtime is no longer ready. Complete setup and check again.",
            ),
          });
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      if (!payload || !("editable" in payload)) {
        throw new Error("Invalid runtime settings response");
      }
      const nextState = payload;
      setState(nextState);
      setDraft(draft);
      notifyAiSettingsChanged();
      toast({
        type: "success",
        description: t(
          "settings.agentRuntimeSaved",
          "Agent runtime updated for new tasks.",
        ),
      });
    } catch (error) {
      console.error("[Agent Runtime Settings] Failed to save state", error);
      toast({
        type: "error",
        description: t(
          "settings.agentRuntimeSaveError",
          "Failed to update the agent runtime.",
        ),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false;
        void loadState();
      }
    }
  };

  const clearSelection = async () => {
    if (!state?.preference || savingRef.current) return;
    ++loadRequestId.current;
    loadAbortController.current?.abort();
    loadAbortController.current = null;
    setLoading(false);
    setRefreshing(false);
    savingRef.current = true;
    setSaving(true);
    try {
      const response = await fetchWithAuth("/api/preferences/agent-runtime", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextState = (await response.json()) as AgentRuntimeSettingsResponse;
      setState(nextState);
      setDraft(
        isSelectableAgentRuntime(nextState.effective.provider)
          ? nextState.effective.provider
          : null,
      );
      notifyAiSettingsChanged();
      toast({
        type: "success",
        description: t(
          "settings.agentRuntimePreferenceCleared",
          "Desktop runtime preference cleared.",
        ),
      });
    } catch (error) {
      console.error(
        "[Agent Runtime Settings] Failed to clear desktop preference",
        error,
      );
      toast({
        type: "error",
        description: t(
          "settings.agentRuntimeClearError",
          "Failed to restore the managed runtime setting.",
        ),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false;
        void loadState();
      }
    }
  };

  const selectedOption = draft
    ? runtimeOptions.find((option) => option.provider === draft)
    : undefined;

  if (desktop !== true) return null;

  return (
    <>
      <section className="space-y-4" aria-labelledby="agent-runtime-title">
        <div className="flex flex-col gap-2">
          <p
            id="agent-runtime-title"
            className="text-base font-semibold text-foreground-secondary"
          >
            {t("settings.agentRuntimeTitle", "Detected local agent runtimes")}
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t(
              "settings.agentRuntimeDescription",
              "Choose the local agent runtime OpenLoomi uses for new tasks. Running tasks are not interrupted.",
            )}
          </p>
        </div>

        {loading && !state ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
            <RemixIcon name="loader_2" size="size-4" className="animate-spin" />
            {t("settings.agentRuntimeChecking", "Checking local runtimes…")}
          </div>
        ) : loadFailed && !state ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "settings.agentRuntimeUnverified",
                "OpenLoomi could not verify the local runtimes.",
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadState()}
            >
              {t("settings.agentRuntimeTryAgain", "Try again")}
            </Button>
          </div>
        ) : state?.editable && state.runtimes ? (
          <>
            {state.effective.source === "environment" &&
              !isSelectableAgentRuntime(state.effective.provider) && (
                <p className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                  {t(
                    "settings.agentRuntimeManagedByEnvironment",
                    "The current runtime is managed by the environment: {{provider}}. Choose a detected runtime to create a desktop preference.",
                    { provider: state.effective.provider },
                  )}
                </p>
              )}

            {state.preference && (
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings.agentRuntimePreferenceOverrideDescription",
                    "This desktop preference overrides the environment/default runtime for new tasks.",
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving || loading || refreshing}
                  onClick={clearSelection}
                  className="shrink-0"
                >
                  {t(
                    "settings.agentRuntimeUseManagedSetting",
                    "Use environment/default",
                  )}
                </Button>
              </div>
            )}

            <div
              className="grid gap-3 sm:grid-cols-2"
              role="radiogroup"
              aria-labelledby="agent-runtime-title"
            >
              {runtimeOptions.map((option) => {
                const selected = draft === option.provider;
                const active = state.effective.provider === option.provider;
                const probe = state.runtimes?.[option.provider];
                return (
                  <label
                    key={option.provider}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                      selected
                        ? "border-primary/50 bg-primary/5 ring-1 ring-primary/15"
                        : "border-border bg-background hover:border-foreground/20 hover:bg-muted/30",
                      (saving || loading || refreshing) &&
                        "pointer-events-none opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="agent-runtime"
                      value={option.provider}
                      checked={selected}
                      disabled={saving || loading || refreshing}
                      onChange={() => setDraft(option.provider)}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg",
                        selected
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      <RemixIcon name="terminal" size="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                        {option.name}
                        {option.builtIn && (
                          <Badge
                            as="span"
                            variant="secondary"
                            className="h-5 rounded-md px-2 text-[11px] font-medium"
                          >
                            {t("settings.agentRuntimeBuiltIn", "Built in")}
                          </Badge>
                        )}
                        {active && (
                          <Badge
                            as="span"
                            className="h-5 rounded-md px-2 text-[11px] font-medium"
                          >
                            {t("settings.agentRuntimeInUse", "In use")}
                          </Badge>
                        )}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {t(option.descriptionKey, option.descriptionFallback)}
                      </span>
                      {probe && <RuntimeStatusLine probe={probe} />}
                    </span>
                  </label>
                );
              })}
            </div>

            {draft && selectedOption && (
              <RuntimeSetupPanel
                option={selectedOption}
                probe={state.runtimes[draft]}
                platform={state.platform}
                active={state.effective.provider === draft}
                busy={saving || loading || refreshing}
                refreshing={refreshing}
                canSave={canSaveAgentRuntime(state, draft)}
                onRefresh={() => loadState(true)}
                onSave={saveSelection}
              />
            )}
          </>
        ) : null}
      </section>
      <Separator />
    </>
  );
}

function RuntimeStatusLine({ probe }: { probe: AgentRuntimePublicProbe }) {
  const { t } = useTranslation();
  let label: string;
  if (probe.status === "ready") {
    label = t("settings.agentRuntimeReady", "Ready");
  } else if (probe.status === "login_required") {
    label =
      probe.provider === "claude"
        ? t(
            "settings.agentRuntimeAuthenticationRequired",
            "Authentication required",
          )
        : probe.provider === "hermes" || probe.provider === "openclaw"
          ? t("settings.agentRuntimeSetupRequired", "Setup required")
          : t("settings.agentRuntimeLoginRequired", "Sign-in required");
  } else if (probe.status === "not_installed") {
    label =
      probe.provider === "claude"
        ? t(
            "settings.agentRuntimeBuiltInUnavailable",
            "Built-in runtime unavailable",
          )
        : t("settings.agentRuntimeNotInstalled", "Not installed");
  } else {
    label = t("settings.agentRuntimeUnverifiedShort", "Could not verify");
  }
  return (
    <span
      className={cn(
        "mt-2 flex items-center gap-1.5 text-xs",
        probe.ready ? "text-emerald-600" : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          probe.ready ? "bg-emerald-500" : "bg-muted-foreground/60",
        )}
      />
      {label}
      {probe.version ? ` · v${probe.version.replace(/^v/, "")}` : ""}
    </span>
  );
}

function RuntimeSetupPanel({
  option,
  probe,
  platform,
  active,
  busy,
  refreshing,
  canSave,
  onRefresh,
  onSave,
}: {
  option: (typeof runtimeOptions)[number];
  probe: AgentRuntimePublicProbe;
  platform: AgentRuntimeSettingsResponse["platform"];
  active: boolean;
  busy: boolean;
  refreshing: boolean;
  canSave: boolean;
  onRefresh: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const showGuide =
    probe.status === "not_installed" || probe.status === "unverified";
  return (
    <div
      className="rounded-lg border border-border bg-background p-4 sm:p-5"
      aria-live="polite"
    >
      <div className="space-y-3">
        <RuntimeSetupSummary
          option={option}
          probe={probe}
          platform={platform}
        />

        <div className="flex flex-wrap justify-end gap-2">
          {showGuide && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void openUrl(option.docsUrl)}
            >
              <RemixIcon name="external_link" size="size-4" />
              {option.provider === "claude"
                ? t(
                    "settings.agentRuntimeTroubleshootingGuide",
                    "Troubleshooting guide",
                  )
                : probe.status === "not_installed"
                  ? t(
                      "settings.agentRuntimeOfficialInstructions",
                      "Official instructions",
                    )
                  : t("settings.agentRuntimeSetupGuide", "Setup guide")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRefresh}
          >
            <RemixIcon
              name={refreshing ? "loader_2" : "refresh"}
              size="size-4"
              className={refreshing ? "animate-spin" : undefined}
            />
            {t("settings.agentRuntimeCheckAgain", "Re-detect")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave || busy}
            onClick={onSave}
          >
            {active
              ? t("settings.agentRuntimeInUse", "In use")
              : t("settings.agentRuntimeUse", "Use {{runtime}}", {
                  runtime: option.name,
                })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuntimeSetupSummary({
  option,
  probe,
  platform,
}: {
  option: (typeof runtimeOptions)[number];
  probe: AgentRuntimePublicProbe;
  platform: AgentRuntimeSettingsResponse["platform"];
}) {
  const { t } = useTranslation();
  const isClaude = option.provider === "claude";

  if (probe.status === "ready") {
    if (isClaude) {
      return (
        <p className="text-sm text-muted-foreground">
          {probe.readyVia === "api"
            ? t(
                "settings.agentRuntimeClaudeApiReadyDescription",
                "The built-in Claude runtime will use your saved Anthropic-compatible configuration. Test the connection below, then confirm it with a new task.",
              )
            : t(
                "settings.agentRuntimeClaudeAuthReadyDescription",
                "The built-in Claude runtime found existing Claude authentication. This check does not start a model request.",
              )}
        </p>
      );
    }

    return (
      <p className="text-sm text-muted-foreground">
        {t(
          "settings.agentRuntimeReadyDescription",
          "{{runtime}} is installed and configured. This check does not start a model request.",
          { runtime: option.name },
        )}
      </p>
    );
  }

  if (probe.status === "login_required") {
    if (isClaude) {
      return (
        <p className="text-sm text-muted-foreground">
          {t(
            "settings.agentRuntimeClaudeAuthenticationDescription",
            "Save an Anthropic-compatible API configuration below. If this OS account already has Claude authentication, check again to reuse it.",
          )}
        </p>
      );
    }

    const setupRequired =
      option.provider === "hermes" || option.provider === "openclaw";
    const command = option.loginCommand ?? option.setupCommand;
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {setupRequired
            ? t(
                "settings.agentRuntimeSetupDescription",
                "Run this command in a terminal, complete setup, then check again.",
              )
            : t(
                "settings.agentRuntimeLoginDescription",
                "Run this command in a terminal, finish signing in, then check again.",
              )}
        </p>
        {command && <CopyCommand command={command} />}
      </div>
    );
  }

  if (probe.status === "not_installed") {
    if (option.provider === "codex") {
      return <CodexInstallSteps platform={platform} />;
    }

    return isClaude ? (
      <p className="text-sm text-muted-foreground">
        {t(
          "settings.agentRuntimeClaudeUnavailableDescription",
          "OpenLoomi could not load its built-in Claude runtime. Update or repair the desktop app, then check again.",
        )}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">
        {t(
          "settings.agentRuntimeCliUnavailableDescription",
          "{{runtime}} was not found. Open the official instructions, install it for this OS account, then check again.",
          { runtime: option.name },
        )}
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      {isClaude
        ? t(
            "settings.agentRuntimeClaudeUnverifiedDescription",
            "OpenLoomi could not verify the built-in Claude runtime. Open the troubleshooting guide, then check again.",
          )
        : t(
            "settings.agentRuntimeUnverifiedDescription",
            "OpenLoomi could not verify this CLI. Confirm it runs in your terminal, then check again.",
          )}
    </p>
  );
}

function CodexInstallSteps({
  platform,
}: {
  platform: AgentRuntimeSettingsResponse["platform"];
}) {
  const { t } = useTranslation();
  const terminal =
    platform === "windows"
      ? "PowerShell"
      : t("settings.agentRuntimeTerminal", "Terminal");
  const checkAgain = t("settings.agentRuntimeCheckAgain", "Re-detect");
  const useCodex = t("settings.agentRuntimeUse", "Use {{runtime}}", {
    runtime: "Codex CLI",
  });
  const inUse = t("settings.agentRuntimeInUse", "In use");

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">
        {t(
          "settings.agentRuntimeCodexInstallTitle",
          "Install and sign in to Codex CLI",
        )}
      </p>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
        <li>
          {t(
            "settings.agentRuntimeCodexInstallOpenTerminal",
            "Open {{terminal}}.",
            { terminal },
          )}
        </li>
        <li className="space-y-2 pl-1">
          <p>
            {t(
              "settings.agentRuntimeCodexInstallRunInstaller",
              "Copy and run the official install command.",
            )}
          </p>
          <CopyCommand command={getCodexInstallCommand(platform)} />
          <p>
            {t(
              "settings.agentRuntimeCodexInstallSkipLaunch",
              'When "Start Codex now? [y/N]" appears at the end, press Enter to keep the default N. Do not start Codex yet.',
            )}
          </p>
          <p>
            {t(
              "settings.agentRuntimeCodexInstallExitAccidentalLaunch",
              'If you already selected y and see "Hooks need review", select "3. Continue without trusting". After Codex opens, enter /exit or press Ctrl+C to close it.',
            )}
          </p>
        </li>
        <li className="space-y-2 pl-1">
          <p>
            {t(
              "settings.agentRuntimeCodexInstallSignIn",
              "After the installer returns to {{terminal}}, close that window and open a new one. Run this command and finish signing in in your browser. When sign-in succeeds, you can close the browser page and {{terminal}}.",
              { terminal },
            )}
          </p>
          <CopyCommand command={CODEX_LOGIN_COMMAND} />
        </li>
        <li>
          {t(
            "settings.agentRuntimeCodexInstallReturn",
            "Return here and select {{checkAction}}. Once Codex CLI is ready, select {{useAction}} if it does not already show {{inUse}}. You do not need to restart OpenLoomi.",
            { checkAction: checkAgain, useAction: useCodex, inUse },
          )}
        </li>
      </ol>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      console.error("[Agent Runtime Settings] Clipboard write failed", error);
    }
  };

  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-xs text-foreground">
      <code className="select-all truncate">{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
      >
        <RemixIcon name={copied ? "check" : "file_copy"} size="size-3" />
        {copied
          ? t("settings.agentRuntimeCopied", "Copied")
          : t("settings.agentRuntimeCopy", "Copy")}
      </Button>
    </div>
  );
}
