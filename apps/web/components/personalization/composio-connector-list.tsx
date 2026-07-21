"use client";

/**
 * Composio-only connector list for the `/connectors` page.
 *
 * The native platform integrations are already rendered by
 * `<PlatformIntegrations />` (driven by `useIntegrations()` → local
 * `platform_accounts` table). This component renders ONLY the entries
 * that come from `useLoopConnectors()` and have no native counterpart —
 * i.e. the OAuth connections the user made via the chat agent's
 * `composio` skill (GitHub, Linear, Notion, HubSpot, …).
 *
 * Dedup rule: if a `ConnectorEntry.id` already exists as a native
 * platform integration, the native row wins (it has disconnect/reconnect
 * controls; the Composio row is suppressed to avoid two entries for the
 * same platform).
 *
 * State separation (#413): two orthogonal signals are rendered for each
 * row — never collapsed into a single red/green pill:
 *
 *   - **Health dot**  — is the connection itself working?
 *       red    = at least one account reports `healthy === false`
 *                (or an entry-level `lastError`);
 *       amber  = degraded (entry-level `lastError` only);
 *       green  = all healthy.
 *
 *   - **Capability badge** — what is Loop doing with this source? See
 *     `ConnectorCapabilityBadge` for the palette.
 *       decision_capable → green, "Decision capable" (canonical toolkit
 *                          with a known classifier mapping);
 *       loop_monitored   → blue,  "Loop monitored" (canonical toolkit,
 *                          signals pulled but no decision mapping yet,
 *                          e.g. obsidian);
 *       needs_setup      → amber, "Needs setup" (connected for
 *                          chat/memory but not wired into Loop);
 *       unsupported      → muted, "Unsupported mapping" (no classifier);
 *       (absent)         → the agent hasn't probed yet; render nothing
 *                          so we don't lie about monitoring coverage.
 *
 * Entries with `connected: false` are deliberately not rendered here:
 * the issue's "Not authorized — user never set it up" case is hidden,
 * since rendering it as anything (neutral, amber, or red) would imply
 * the user asked for it. Authorizing a new platform goes through the
 * "Connect more via Composio" affordance on the parent dialog, not
 * this list.
 *
 * Multi-account toolkits (e.g. two GitHub accounts) get one row per
 * account. Toolkits with `accounts` missing but `connected:true` fall
 * back to a single row labelled with the entry's `label`.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import Image from "next/image";
import { RemixIcon } from "@/components/remix-icon";
import { ComposioIcon } from "@/components/composio-icon";
import { ConnectorCapabilityBadge } from "@/components/loop/connector-capability-badge";
import { resolvePlatformLogo } from "@/components/integration-platform-card";
import { filterComposioOnlyEntries } from "@/lib/loop/connectors-pure";
import type { IntegrationAccountClient } from "@/hooks/use-integrations";
import type { IntegrationId } from "@/hooks/use-integrations";
import type { ConnectorAccount, ConnectorEntry } from "@/lib/loop/types";

type Props = {
  /** Native OAuth accounts from `useIntegrations()` — used for dedup. */
  nativeAccounts: IntegrationAccountClient[];
  /** Connector entries from `useLoopConnectors()` (already filtered). */
  items: ConnectorEntry[];
};

/**
 * The IDs in `ConnectorEntry` that overlap with the native
 * `IntegrationId` union. Custom Composio channels can have arbitrary
 * string ids; we narrow to `IntegrationId` only when the id is one we
 * know, so `resolvePlatformLogo` can be called without `as never`
 * casts.
 */
const KNOWN_INTEGRATION_IDS = new Set<string>([
  "slack",
  "telegram",
  "discord",
  "whatsapp",
  "gmail",
  "outlook",
  "imessage",
  "hubspot",
  "asana",
  "jira",
  "linear",
  "google_docs",
  "google_drive",
  "google_calendar",
  "linkedin",
  "facebook_messenger",
  "teams",
  "notion",
  "github",
  "twitter",
  "instagram",
  "outlook_calendar",
  "feishu",
  "dingtalk",
  "qqbot",
  "weixin",
]);

function toIntegrationId(id: string): IntegrationId | null {
  return KNOWN_INTEGRATION_IDS.has(id) ? (id as IntegrationId) : null;
}

type HealthState = "ok" | "degraded" | "error";

function accountHealth(account: ConnectorAccount | undefined): HealthState {
  if (!account) return "ok";
  if (account.healthy === false || account.lastError) return "error";
  return "ok";
}

function entryHealth(
  accounts: ConnectorAccount[] | undefined,
  entryError: string | undefined,
): HealthState {
  const list = accounts ?? [];
  if (list.some((a) => accountHealth(a) === "error")) return "error";
  if (entryError) return "degraded";
  return "ok";
}

function healthDotClass(state: HealthState): string {
  switch (state) {
    case "ok":
      return "bg-emerald-500";
    case "degraded":
      return "bg-amber-500";
    case "error":
      return "bg-red-500";
  }
}

function healthLabelKey(state: HealthState): string {
  switch (state) {
    case "ok":
      return "connectors.healthOk";
    case "degraded":
      return "connectors.healthDegraded";
    case "error":
      return "connectors.healthError";
  }
}

export function ComposioConnectorList({ nativeAccounts, items }: Props) {
  const { t } = useTranslation();

  /**
   * Compute the dedup set lazily. Native platforms win — any
   * `ConnectorEntry` whose id matches a native account is filtered out
   * so the same platform doesn't render twice.
   */
  const composioOnly = useMemo(() => {
    const nativePlatforms = new Set(nativeAccounts.map((a) => a.platform));
    return filterComposioOnlyEntries(items, nativePlatforms);
  }, [items, nativeAccounts]);

  if (composioOnly.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2" data-testid="composio-connector-list">
      {composioOnly.map((entry) => {
        const accounts = entry.accounts ?? [];
        // Per-row aggregation: when accounts is empty but entry is
        // connected, render a single fallback row using the entry label.
        const rows: Array<{
          key: string;
          label: string;
          health: HealthState;
          title?: string;
        }> =
          accounts.length > 0
            ? accounts.map((acc, idx) => ({
                key: acc.id ?? `${entry.id}-${idx}`,
                label: acc.label ?? entry.label,
                health: accountHealth(acc),
                title: acc.lastError,
              }))
            : [
                {
                  key: entry.id,
                  label: entry.label,
                  health: entryHealth(undefined, entry.lastError),
                  title: entry.lastError,
                },
              ];

        const overallHealth = entryHealth(
          accounts,
          accounts.length === 0 ? entry.lastError : undefined,
        );

        return (
          <li
            key={entry.id}
            className="flex flex-col gap-2 rounded-xl border border-[#e5e5e5] bg-white px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <PlatformIcon id={entry.id} label={entry.label} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-serif font-semibold text-[#37352f] truncate">
                    {entry.label}
                  </span>
                  <SourceBadge />
                  {/*
                   * #413 — render the Loop capability next to the source
                   * badge so the user can tell at a glance whether an
                   * authorized Composio integration participates in Loop
                   * (green/blue), is chat/memory only (amber), or is
                   * unsupported (muted). The health dot on the right
                   * keeps its existing "is the connection working"
                   * semantic — the two signals are deliberately orthogonal.
                   */}
                  <ConnectorCapabilityBadge capability={entry.capability} />
                </div>
                {entry.lastError && accounts.length === 0 ? (
                  <p className="text-xs text-amber-600 mt-0.5 truncate">
                    {entry.lastError}
                  </p>
                ) : null}
              </div>
              <HealthDot state={overallHealth} title={entry.lastError} t={t} />
            </div>
            {accounts.length > 1 ? (
              <ul className="flex flex-col gap-1.5 pl-12">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <HealthDot
                      state={row.health}
                      title={row.title}
                      size="size-1.5"
                      t={t}
                    />
                    <span className="truncate">{row.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PlatformIcon({ id, label }: { id: string; label: string }) {
  const known = toIntegrationId(id);
  const logo = known ? resolvePlatformLogo(known) : null;
  return (
    <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center shrink-0">
      {logo ? (
        <Image
          src={logo}
          alt={label}
          width={40}
          height={40}
          className="h-8 w-8 sm:h-10 sm:w-10"
        />
      ) : (
        <RemixIcon
          name="apps"
          size="size-5"
          className="sm:!text-[1.5rem] text-[#37352f]"
        />
      )}
    </div>
  );
}

function SourceBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[#f7f6f3] px-1.5 py-0.5 text-[10px] font-medium text-[#37352f] shrink-0"
      title={t(
        "connectors.sourceComposioHint",
        "Connected via Composio (agent-managed)",
      )}
    >
      <ComposioIcon className="h-3 w-3" />
      {t("connectors.sourceComposio", "Composio")}
    </span>
  );
}

function HealthDot({
  state,
  title,
  size = "size-2",
  t,
}: {
  state: HealthState;
  title?: string;
  size?: "size-1.5" | "size-2";
  t: (key: string, fallback: string) => string;
}) {
  const label = t(healthLabelKey(state), state);
  return (
    <span
      className={`inline-block rounded-full ${healthDotClass(state)} ${
        size === "size-1.5" ? "h-1.5 w-1.5" : "h-2 w-2"
      } shrink-0`}
      title={title ?? label}
      aria-label={label}
      role="img"
    />
  );
}
