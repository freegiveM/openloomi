"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Separator } from "@openloomi/ui";
import { useTranslation } from "react-i18next";

import { RemixIcon } from "@/components/remix-icon";
import { toast } from "@/components/toast";
import { notifyAiSettingsChanged } from "@/lib/ai/notify-ai-settings-changed";
import {
  canSaveAgentRuntime,
  type AgentRuntimePublicProbe,
  type AgentRuntimeSettingsResponse,
  type SelectableAgentRuntime,
} from "@/lib/ai/native-agent/runtime-contract";
import { isTauri, openUrl } from "@/lib/tauri";
import { cn, fetchWithAuth } from "@/lib/utils";

const runtimeOptions: Array<{
  provider: SelectableAgentRuntime;
  name: string;
  descriptionKey: string;
  descriptionFallback: string;
  docsUrl: string;
  loginCommand: string;
}> = [
  {
    provider: "claude",
    name: "Claude Code",
    descriptionKey: "settings.agentRuntimeClaudeDescription",
    descriptionFallback: "Use your local Claude Code installation and account.",
    docsUrl: "https://code.claude.com/docs/en/installation",
    loginCommand: "claude auth login",
  },
  {
    provider: "codex",
    name: "Codex CLI",
    descriptionKey: "settings.agentRuntimeCodexDescription",
    descriptionFallback: "Use your local Codex CLI installation and account.",
    docsUrl: "https://developers.openai.com/codex/cli/",
    loginCommand: "codex login",
  },
];

function isSelectableRuntime(value: string): value is SelectableAgentRuntime {
  return value === "claude" || value === "codex";
}

export function AgentRuntimeSettings() {
  const { t } = useTranslation();
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [state, setState] = useState<AgentRuntimeSettingsResponse | null>(null);
  const [draft, setDraft] = useState<SelectableAgentRuntime | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadState = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setLoadFailed(false);
      try {
        const response = await fetchWithAuth(
          `/api/preferences/agent-runtime${refresh ? "?refresh=1" : ""}`,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextState =
          (await response.json()) as AgentRuntimeSettingsResponse;
        setState(nextState);
        setDraft(
          (current) =>
            current ??
            (isSelectableRuntime(nextState.effective.provider)
              ? nextState.effective.provider
              : null),
        );
      } catch (error) {
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
        setLoading(false);
        setRefreshing(false);
      }
    },
    [t],
  );

  useEffect(() => {
    const inDesktop = isTauri();
    setDesktop(inDesktop);
    if (inDesktop) void loadState();
  }, [loadState]);

  const saveSelection = async () => {
    if (!state || !draft || !canSaveAgentRuntime(state, draft)) return;
    setSaving(true);
    try {
      const response = await fetchWithAuth("/api/preferences/agent-runtime", {
        method: "PUT",
        body: JSON.stringify({ provider: draft }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextState = (await response.json()) as AgentRuntimeSettingsResponse;
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
      setSaving(false);
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
            {t("settings.agentRuntimeTitle", "Agent runtime")}
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t(
              "settings.agentRuntimeDescription",
              "Choose the local CLI OpenLoomi uses for new agent tasks. Running tasks are not interrupted.",
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
              !isSelectableRuntime(state.effective.provider) && (
                <p className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                  {t(
                    "settings.agentRuntimeManagedByEnvironment",
                    "The current runtime is managed by the environment: {{provider}}. Choose Claude or Codex to create a desktop preference.",
                    { provider: state.effective.provider },
                  )}
                </p>
              )}

            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
              {runtimeOptions.map((option) => {
                const selected = draft === option.provider;
                const active = state.effective.provider === option.provider;
                const probe = state.runtimes?.[option.provider];
                return (
                  <label
                    key={option.provider}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-4 text-left transition-colors",
                      selected
                        ? "border-primary/50 bg-primary/5 ring-1 ring-primary/15"
                        : "border-border bg-background hover:border-foreground/20 hover:bg-muted/30",
                      (saving || refreshing) &&
                        "pointer-events-none opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="agent-runtime"
                      value={option.provider}
                      checked={selected}
                      disabled={saving || refreshing}
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
                        {active && (
                          <Badge className="h-5 rounded-md px-2 text-[11px] font-medium">
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
                active={state.effective.provider === draft}
                busy={saving || refreshing}
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
  const labels = {
    ready: t("settings.agentRuntimeReady", "Ready"),
    login_required: t("settings.agentRuntimeLoginRequired", "Sign-in required"),
    not_installed: t("settings.agentRuntimeNotInstalled", "Not installed"),
    unverified: t("settings.agentRuntimeUnverifiedShort", "Could not verify"),
  };
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
      {labels[probe.status]}
      {probe.version ? ` · v${probe.version.replace(/^v/, "")}` : ""}
    </span>
  );
}

function RuntimeSetupPanel({
  option,
  probe,
  active,
  busy,
  refreshing,
  canSave,
  onRefresh,
  onSave,
}: {
  option: (typeof runtimeOptions)[number];
  probe: AgentRuntimePublicProbe;
  active: boolean;
  busy: boolean;
  refreshing: boolean;
  canSave: boolean;
  onRefresh: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-lg border border-border bg-background p-4 sm:p-5"
      aria-live="polite"
    >
      <div className="space-y-3">
        {probe.status === "ready" ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "settings.agentRuntimeReadyDescription",
              "{{runtime}} is installed and signed in. It is ready for new tasks.",
              { runtime: option.name },
            )}
          </p>
        ) : probe.status === "login_required" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t(
                "settings.agentRuntimeLoginDescription",
                "Run this command in a terminal, finish signing in, then check again.",
              )}
            </p>
            <CopyCommand command={option.loginCommand} />
          </div>
        ) : probe.status === "not_installed" ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "settings.agentRuntimeInstallDescription",
              "Install {{runtime}} from its official guide, sign in, then check again.",
              { runtime: option.name },
            )}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              "settings.agentRuntimeUnverifiedDescription",
              "OpenLoomi could not verify this CLI. Confirm it runs in your terminal, then check again.",
            )}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {probe.status !== "ready" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void openUrl(option.docsUrl)}
            >
              <RemixIcon name="external_link" size="size-4" />
              {t("settings.agentRuntimeInstallGuide", "Installation guide")}
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
            {t("settings.agentRuntimeCheckAgain", "Check again")}
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
