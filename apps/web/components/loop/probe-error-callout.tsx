"use client";

/**
 * #412 — per-kind callout for `lastProbeError`. Replaces the previous
 * generic "Last sync failed: <message>" line on `/connectors` with a
 * localized reason + an affordance tailored to each `ProbeErrorKind`:
 *
 *   - `cli_not_found`        → copyable `npm i -g @composio/cli`
 *   - `cli_unauthorized`     → "Sign in via agent" deep-link
 *   - `timeout`              → plain suggestion to lower `intervalSec`
 *   - `transport_error`      → tooltip with the upstream status parsed
 *   - `agent_http_error`       from `error.message`
 *   - `empty_response`       → no special affordance
 *   - `malformed_response`   → no special affordance
 *   - `cli_malformed`        → no special affordance
 *
 * Always rendered: a "Retry probe" button bound to `onRetry`, disabled
 * while `isRetrying`. Visual style mirrors the previous amber line so
 * the slot already on the connectors page stays coherent.
 *
 * i18n keys live under `connectors.probeKindTitle.<kind>` /
 * `connectors.probeKindDesc.<kind>`; the always-on Retry button uses
 * `connectors.probeRetry` / `connectors.probeRetrying`. See
 * `packages/i18n/src/locales/en-US.ts` and `zh-Hans.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { Button } from "@openloomi/ui";
import { RemixIcon } from "@/components/remix-icon";
import type { ProbeErrorInfo, ProbeErrorKind } from "@/lib/loop/types";

const COMPOSIO_CLI_INSTALL_CMD = "npm i -g @composio/cli";

/**
 * Try to lift a numeric HTTP status out of the diagnostic message.
 * The probe writes messages like `"HTTP 502: Bad Gateway"` or
 * `"HTTP 504"`, and surfacing the status as a tooltip is a useful
 * signal without reinventing the connector-error UI.
 */
function extractStatus(message: string): string | null {
  const m = message.match(/HTTP\s+(\d{3})/i);
  if (!m) return null;
  return m[1];
}

interface KindConfig {
  /** Title i18n key (without the `connectors.` prefix). */
  titleKey: string;
  /** Body i18n key (without the `connectors.` prefix). */
  descKey: string;
}

const KIND_CONFIG: Record<ProbeErrorKind, KindConfig> = {
  transport_error: {
    titleKey: "connectors.probeKindTitle.transport_error",
    descKey: "connectors.probeKindDesc.transport_error",
  },
  agent_http_error: {
    titleKey: "connectors.probeKindTitle.agent_http_error",
    descKey: "connectors.probeKindDesc.agent_http_error",
  },
  empty_response: {
    titleKey: "connectors.probeKindTitle.empty_response",
    descKey: "connectors.probeKindDesc.empty_response",
  },
  malformed_response: {
    titleKey: "connectors.probeKindTitle.malformed_response",
    descKey: "connectors.probeKindDesc.malformed_response",
  },
  timeout: {
    titleKey: "connectors.probeKindTitle.timeout",
    descKey: "connectors.probeKindDesc.timeout",
  },
  cli_not_found: {
    titleKey: "connectors.probeKindTitle.cli_not_found",
    descKey: "connectors.probeKindDesc.cli_not_found",
  },
  cli_unauthorized: {
    titleKey: "connectors.probeKindTitle.cli_unauthorized",
    descKey: "connectors.probeKindDesc.cli_unauthorized",
  },
  cli_malformed: {
    titleKey: "connectors.probeKindTitle.cli_malformed",
    descKey: "connectors.probeKindDesc.cli_malformed",
  },
};

export interface ProbeErrorCalloutProps {
  error: ProbeErrorInfo;
  onRetry: () => void;
  isRetrying: boolean;
}

export function ProbeErrorCallout({
  error,
  onRetry,
  isRetrying,
}: ProbeErrorCalloutProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const cfg = KIND_CONFIG[error.kind];

  // `transport_error` / `agent_http_error` get a status tooltip when the
  // probe wrote one (e.g. "HTTP 502: …"). Falls back to the raw message
  // when no status was extractable so the tooltip is still informative.
  const statusTooltip = useMemo(() => {
    if (error.kind !== "transport_error" && error.kind !== "agent_http_error") {
      return null;
    }
    const status = extractStatus(error.message);
    if (!status) return error.message;
    return t("connectors.probeKindHttpTooltip", "Upstream status: {{status}}", {
      status,
    });
  }, [error.kind, error.message, t]);

  // Sign-in-via-agent: prefer the in-process bridge (same pattern as
  // `personalization-linked-accounts.tsx::handleConnectMoreViaComposio`)
  // and fall back to the URL `?page=chat&send=` pipe when the bridge
  // hasn't mounted (e.g. very early dev-mode click).
  const handleSignInViaAgent = useCallback(() => {
    const prompt = t(
      "connectors.probeKindSignInPrompt",
      "Please run `composio login --no-wait` in the user's terminal so the Loop probe can authenticate, then retry.",
    );
    const bridge = (
      globalThis as { __petChatBridgeSend?: (text: string) => void }
    ).__petChatBridgeSend;
    if (typeof bridge === "function") {
      bridge(prompt);
      return;
    }
    router.push(`/?page=chat&send=${encodeURIComponent(prompt)}`);
  }, [router, t]);

  return (
    <div
      className="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="font-medium text-amber-800"
            title={statusTooltip ?? undefined}
          >
            {t(cfg.titleKey)}
          </p>
          <p className="mt-1 text-amber-700/90">{t(cfg.descKey)}</p>
          {error.kind === "cli_not_found" ? (
            <div className="mt-2">
              <CopyInstallCommand />
            </div>
          ) : null}
          {error.kind === "cli_unauthorized" ? (
            <div className="mt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSignInViaAgent}
                className="h-7 gap-1.5 border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
              >
                <RemixIcon name="user" size="size-3.5" />
                {t("connectors.probeKindSignIn", "Sign in via agent")}
              </Button>
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={isRetrying}
          className="h-7 shrink-0 gap-1.5 border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
        >
          <RemixIcon
            name={isRetrying ? "loader_2" : "refresh"}
            size="size-3.5"
            className={isRetrying ? "animate-spin" : undefined}
          />
          {isRetrying
            ? t("connectors.probeRetrying", "Retrying…")
            : t("connectors.probeRetry", "Retry probe")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Copy-to-clipboard affordance for the `npm i -g @composio/cli`
 * command. Localised label + "Copied" confirmation, mirroring the
 * `RemixIcon` + `Button` pattern used elsewhere in
 * `personalization-linked-accounts.tsx`.
 */
function CopyInstallCommand() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Reset the "Copied" flag after 2 s — same timing as the markdown
  // preview's copy button so the UX is consistent.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(id);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(COMPOSIO_CLI_INSTALL_CMD);
      setCopied(true);
    } catch {
      // Clipboard write rejected (insecure context, permission denied).
      // Leave `copied` false so the label falls back to "Copy …".
    }
  }, []);

  return (
    <div className="inline-flex items-center gap-2 rounded border border-amber-200 bg-white px-2 py-1 font-mono text-[11px] text-amber-900">
      <code className="select-all">{COMPOSIO_CLI_INSTALL_CMD}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className="h-5 gap-1 px-1.5 text-[11px] text-amber-800 hover:bg-amber-50"
        aria-label={t("connectors.probeKindInstall", "Copy install command")}
      >
        <RemixIcon name={copied ? "check" : "file_copy"} size="size-3" />
        {copied
          ? t("connectors.probeKindCopied", "Copied")
          : t("connectors.probeKindInstall", "Copy install command")}
      </Button>
    </div>
  );
}
