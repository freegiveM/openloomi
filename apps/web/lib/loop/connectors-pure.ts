/**
 * Loop connector capability — pure helpers, browser-safe.
 *
 * These functions are the surface area the connected-accounts UI and the
 * readiness card both consume (#361). They only depend on types and a
 * couple of `Set` constants, so they can run on the client without pulling
 * `node:fs` into the bundle.
 *
 * Anything that touches the on-disk cache (read/write/cooldown) lives in
 * `./connectors` and is server-only. Server callers that need the full
 * surface — pure helpers + cache I/O — keep importing the barrel
 * (`@/lib/loop`) which re-exports both files.
 */

import type {
  ConnectorCapability,
  ConnectorCapabilitySummary,
  ConnectorEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Canonical Loop toolkits (#361) — these are the sources the tick prompt
// actually pulls. Any connector NOT in this set is treated as "connected
// for chat / memory but not contributing to Loop decisions". Native chat
// integrations (Feishu, Lark, iMessage, …) and the composio skill's long
// tail of integrations live outside this set.
//
// Keep in sync with `tick-prompt.ts` §0 and `classify.ts` `signal_type →
// decision_type` mapping — this is the source of truth for "is this
// connector a Loop signal source?".
// ---------------------------------------------------------------------------
const LOOP_MONITORED_TOOLKITS = new Set([
  "gmail",
  "google_calendar",
  "github",
  "slack",
  "linear",
  "obsidian",
]);

// Decision-capable subsets of the loop-monitored toolkits. Obsidian is
// monitored (file-system scan) but its note-changed events are surfaced as
// generic "memory surfaces" — they don't currently map onto a typed
// decision, so it's loop_monitored but NOT decision_capable. The same goes
// for any toolkit we add in future until its classifier mapping lands.
const DECISION_CAPABLE_TOOLKITS = new Set([
  "gmail",
  "google_calendar",
  "github",
  "slack",
  "linear",
]);

/**
 * Decide whether a connector is one Loop actively pulls from. Pure function
 * over the connector id so it can be reused by tests, the readiness API,
 * and the connector list view without round-tripping through the agent.
 */
export function isLoopMonitored(connectorId: string): boolean {
  return LOOP_MONITORED_TOOLKITS.has(connectorId);
}

/**
 * Decide whether a connector's payload can produce typed decisions via the
 * reference classifier. Pure function over the connector id. Returns
 * `false` for toolkits that are monitored but whose signal type has no
 * decision mapping yet (e.g. obsidian) and for any non-canonical toolkit.
 */
export function isDecisionCapable(connectorId: string): boolean {
  return DECISION_CAPABLE_TOOLKITS.has(connectorId);
}

/**
 * Reduce a (possibly partial) connector entry into a single semantic
 * capability state (#361). The state machine:
 *
 *   connected=false              → "needs_setup" (or absent probe → keep undefined)
 *   connected=true  + non-loop   → "needs_setup"  (chat/memory-only integration)
 *   connected=true  + loop+dc    → "decision_capable"
 *   connected=true  + loop-no-dc → "loop_monitored"
 *   connected=true  + non-class  → "unsupported"
 *
 * Returns `null` when there isn't enough signal yet (unprobed FALLBACK
 * rows) so callers can distinguish "we don't know" from "we know this is
 * offline".
 */
export function deriveConnectorCapability(
  entry: Pick<ConnectorEntry, "id" | "connected" | "probed">,
): ConnectorCapability | null {
  if (!entry.connected) {
    // Unprobed FALLBACK sentinel — don't claim "needs_setup" yet; we
    // haven't asked the agent. Distinguishing the two is the whole point
    // of #361.
    if (!entry.probed) return null;
    return "needs_setup";
  }
  if (!isLoopMonitored(entry.id)) {
    // Connected for chat / memory but no canonical Loop mapping — the
    // exact case the issue calls out (Feishu native integration).
    return "needs_setup";
  }
  if (isDecisionCapable(entry.id)) return "decision_capable";
  // Loop monitors it (canonical toolkit) but no classifier mapping yet
  // (e.g. obsidian) → surfaced, not silently dropped.
  return "loop_monitored";
}

/**
 * Stamp the capability fields onto a connector entry. Pure helper that
 * never throws and never includes credentials — the output is safe to
 * round-trip through `/api/loop/connectors` and the readiness surface.
 */
export function withConnectorCapability(entry: ConnectorEntry): ConnectorEntry {
  const capability = deriveConnectorCapability(entry);
  const loopMonitored = entry.connected ? isLoopMonitored(entry.id) : false;
  const decisionCapable =
    entry.connected && loopMonitored ? isDecisionCapable(entry.id) : false;
  const next: ConnectorEntry = {
    ...entry,
    loopMonitored,
    decisionCapable,
  };
  if (capability) next.capability = capability;
  return next;
}

/**
 * Reduce a list of connector entries into the capability summary surfaced
 * by the readiness API (#361). Pure function over a snapshot — the caller
 * supplies the list and gets back the strict-superset counts. Never throws
 * on missing fields: missing `capability` falls back to a derived value
 * via `withConnectorCapability`'s logic so callers don't need to stamp
 * upstream.
 */
export function summarizeConnectorCapability(
  entries: ConnectorEntry[],
): ConnectorCapabilitySummary {
  const out: ConnectorCapabilitySummary = {
    total: entries.length,
    connected: 0,
    loopMonitored: 0,
    decisionCapable: 0,
    unsupported: 0,
    needsSetup: 0,
  };
  for (const raw of entries) {
    const e = raw.capability ? raw : withConnectorCapability(raw);
    if (e.connected) out.connected += 1;
    if (e.loopMonitored) out.loopMonitored += 1;
    if (e.decisionCapable) out.decisionCapable += 1;
    if (e.capability === "unsupported") out.unsupported += 1;
    if (e.capability === "needs_setup") out.needsSetup += 1;
  }
  return out;
}

/**
 * #413 — keep only Composio-managed entries that have NOT been rendered
 * elsewhere. Three exclusions, each for a distinct reason:
 *
 *   1. `connected === false` → the user never authorized this platform
 *      (or it lapsed). The "Not authorized" affordance is the
 *      "Connect more via Composio" button on the parent dialog; we
 *      deliberately do NOT render an unconnected row here, neither as
 *      a red dot nor as a neutral pill, since either would imply the
 *      user already has it.
 *   2. `probed === false` → the agent hasn't actually confirmed the
 *      connector's state yet (typical for a freshly-appended custom
 *      channel from `appendCustomChannels`). Without `probed`, a
 *      capability badge can't be derived either, so the row would only
 *      ever be a stub.
 *   3. id present in `nativePlatforms` → a native OAuth account already
 *      owns this id; rendering twice confuses users.
 *
 * Pure function over the seed list. Lives in `connectors-pure` so the
 * React component (`composio-connector-list.tsx`) and the unit test
 * (`composio-connector-list-filter.test.ts`) can import it without
 * pulling `node:fs` or the UI package into the node-test bundle.
 */
export function filterComposioOnlyEntries(
  items: ConnectorEntry[],
  nativePlatforms: ReadonlySet<string>,
): ConnectorEntry[] {
  return items.filter(
    (e) => e.connected && e.probed !== false && !nativePlatforms.has(e.id),
  );
}

// ---------------------------------------------------------------------------
// Native chat integrations (#xxx) — platforms we want surfaced on the
// Loomi online card even though they are NOT part of `LOOP_MONITORED_TOOLKITS`.
// Loop never pulls signals from these sources; they exist purely so the user
// can see at a glance which of their native OAuth chat accounts is wired up
// for chat / memory use. Gmail / Calendar / etc. intentionally live in
// `LOOP_MONITORED_TOOLKITS` instead — adding them here would collide with
// the Loop rows on id.
//
// Keep this set tight: anything new should be added only after the
// `displayName` and `accountStatus` semantics are confirmed against
// `integrationAccounts` rows. The id is the `platform` column, lowercased.
// ---------------------------------------------------------------------------
export const NATIVE_CHAT_INTEGRATIONS: ReadonlySet<string> = new Set([
  "telegram",
  "weixin",
  "whatsapp",
  "feishu",
  "lark",
  "imessage",
  "qqbot",
  "dingtalk",
  "discord",
]);

/**
 * Minimal shape required to turn a native chat account into a
 * `ConnectorEntry`. Lighter than the full `IntegrationAccount` row so the
 * route layer can pull only the non-credential columns it needs from the
 * database — see `listIntegrationAccountRecordsByUser` in
 * `apps/web/lib/db/queries.ts`.
 */
export interface NativeAccountLike {
  id: string;
  platform: string;
  displayName?: string;
  externalId?: string;
  status: string;
}

/**
 * Reduce a list of native chat accounts into `ConnectorEntry` rows. One row
 * per `platform`; multiple accounts for the same platform collapse into a
 * single row with `accountCount > 1` and a `accounts[]` list (mirroring the
 * multi-account shape used by Composio toolkits — see `types.ts:ConnectorEntry`).
 *
 * Pure / browser-safe — no fs, no DB. The route layer fetches records and
 * passes them in. Capability is stamped via `withConnectorCapability`, so
 * connected native rows surface as `"needs_setup"` (chat-only, not a Loop
 * signal source) which matches the existing capability badge vocabulary
 * used by `composio-connector-list.tsx`.
 *
 * Notes:
 *   - Records whose `platform` is not in `NATIVE_CHAT_INTEGRATIONS` are
 *     silently dropped — callers don't need to pre-filter.
 *   - `connected` is `true` when at least one account has `status === "active"`.
 *     The OR semantic lets a user who wired up two WeChat accounts keep using
 *     chat skills even if one is paused.
 *   - `probed: true` is set unconditionally because the source of truth is
 *     the database, not an agent probe — there is no "haven't asked yet"
 *     sentinel for these.
 */
export function buildNativeChatConnectorEntries(
  accounts: NativeAccountLike[],
): ConnectorEntry[] {
  const byPlatform = new Map<string, NativeAccountLike[]>();
  for (const acc of accounts) {
    if (!NATIVE_CHAT_INTEGRATIONS.has(acc.platform)) continue;
    const bucket = byPlatform.get(acc.platform) ?? [];
    bucket.push(acc);
    byPlatform.set(acc.platform, bucket);
  }

  const fetchedAt = new Date().toISOString();
  const out: ConnectorEntry[] = [];
  for (const [platform, group] of byPlatform) {
    const accountsEntries = group.map((a) => ({
      id: a.id,
      label: a.displayName || a.externalId || platform,
      healthy: a.status === "active",
    }));
    const anyActive = group.some((a) => a.status === "active");
    out.push(
      withConnectorCapability({
        id: platform,
        label: group[0].displayName || platform,
        connected: anyActive,
        accountCount: group.length,
        accounts: accountsEntries,
        probed: true,
        fetchedAt,
      }),
    );
  }
  return out;
}

/**
 * All-offline fallback used whenever the on-disk snapshot is missing or
 * stale. Re-exported so the server-side connector cache can hand the same
 * shape back without going through `node:fs`.
 */
export const FALLBACK_CONNECTORS: ConnectorEntry[] = [
  {
    id: "gmail",
    label: "Gmail",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "",
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "",
  },
  {
    id: "github",
    label: "GitHub",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "",
  },
  {
    id: "slack",
    label: "Slack",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "",
  },
  {
    id: "linear",
    label: "Linear",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "",
  },
  {
    id: "obsidian",
    label: "Obsidian",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "",
  },
];
