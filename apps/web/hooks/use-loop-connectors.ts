"use client";

/**
 * SWR hook for the Loop's connector snapshot — the read path used by
 * `/connectors` to surface Composio-managed OAuth connections (GitHub,
 * Linear, Notion, HubSpot, …) that don't live on the local
 * `platform_accounts` table.
 *
 * Why this exists:
 *   - `useIntegrations()` (apps/web/hooks/use-integrations.ts) reads the
 *     native OAuth DB and only sees accounts the local OAuth callback
 *     wrote.
 *   - Users who connect accounts via the chat agent's `composio` skill
 *     land in Composio's `connected_accounts`, which the Loop's
 *     background tick surfaces into `~/.openloomi/loop/connectors.json`.
 *   - `/api/loop/connectors` exposes that cache (`get` reads, `post`
 *     forces a fresh 120s probe).
 *
 * Design choices:
 *   - Initial mount reads the cached snapshot (no `?refresh=1`). A cold
 *     cache returns the all-`connected:false` `FALLBACK_CONNECTORS`
 *     sentinel; the consumer filters those out so the empty state stays
 *     clean until a real probe lands.
 *   - `dedupingInterval: 60_000` keeps a tab re-open from hammering the
 *     agent while it's busy.
 *   - `sync()` POSTs `{refresh:true}` and `mutate()`s the cache. The
 *     probe itself takes up to 120s — callers should disable any
 *     "syncing" UI affordance via `isValidating` while the request is
 *     in flight.
 */

import useSWR from "swr";
import { getAuthToken } from "@/lib/auth/token-manager";
import type {
  ConnectorEntry,
  ProbeErrorInfo,
  ProbeErrorKind,
} from "@/lib/loop/types";

const KEY = "/api/loop/connectors";

// Allow-list mirroring `connectors.ts`'s `PROBE_ERROR_KINDS`. Duplicated
// here on purpose: the set is small (one line) and keeping the client
// from re-importing `connectors.ts` (which pulls `node:fs`) is the whole
// reason `ProbeErrorKind` now lives in `./types`.
const CLIENT_PROBE_ERROR_KINDS: ReadonlySet<ProbeErrorKind> = new Set([
  "transport_error",
  "agent_http_error",
  "empty_response",
  "malformed_response",
  "timeout",
  "cli_not_found",
  "cli_unauthorized",
  "cli_malformed",
]);

export type ConnectorSnapshot = {
  items: ConnectorEntry[];
  /**
   * Persisted by `/api/loop/connectors` only when the most recent probe
   * failed (#391 #412). `null` on the happy path so consumers can branch
   * on its presence without a separate `lastProbeError` flag. Carries
   * the full `{kind, message, at}` shape so the UI can render a per-
   * kind affordance instead of a generic message string.
   */
  lastProbeError: ProbeErrorInfo | null;
};

const fetcher = async (url: string): Promise<ConnectorSnapshot> => {
  const headers: HeadersInit = {};
  if (typeof window !== "undefined") {
    const token = getAuthToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  const res = await fetch(url, {
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status}`);
  }
  const raw = (await res.json()) as {
    items?: ConnectorEntry[];
    lastProbeError?: { kind?: unknown; message?: unknown; at?: unknown };
  };
  // Validate the full {kind, message, at} shape rather than dropping
  // `kind` on the floor (the previous behaviour before #412). Anything
  // unrecognised is treated as no error so a malformed server payload
  // can't surface as a broken callout.
  let lastProbeError: ProbeErrorInfo | null = null;
  const blob = raw.lastProbeError;
  if (blob && typeof blob === "object") {
    const kind = blob.kind;
    const message = blob.message;
    const at = blob.at;
    if (
      typeof kind === "string" &&
      CLIENT_PROBE_ERROR_KINDS.has(kind as ProbeErrorKind) &&
      typeof message === "string" &&
      typeof at === "string"
    ) {
      lastProbeError = {
        kind: kind as ProbeErrorKind,
        message,
        at,
      };
    }
  }
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    lastProbeError,
  };
};

export function useLoopConnectors() {
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<ConnectorSnapshot>(KEY, fetcher, {
      fallbackData: { items: [], lastProbeError: null },
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
    });

  const sync = async (): Promise<void> => {
    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (typeof window !== "undefined") {
      const token = getAuthToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    try {
      await fetch(KEY, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ refresh: true }),
      });
    } finally {
      await mutate();
    }
  };

  return {
    items: data?.items ?? [],
    lastProbeError: data?.lastProbeError ?? null,
    isLoading,
    isValidating,
    error,
    sync,
  };
}
