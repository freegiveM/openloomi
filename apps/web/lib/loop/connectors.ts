/**
 * Loop connector status — surface-only.
 *
 * The Loop is fully agentic: the agent at `/api/native/agent` has the
 * `composio` skill and `composio` CLI available and probes connection
 * state itself. The Loop's local module does not hit Composio's REST
 * API directly — that would require a parallel `COMPOSIO_API_KEY` env
 * var and duplicate the agent's discovery work.
 *
 * Two ways a connector snapshot reaches the cache:
 *
 *   1. **Tick pass** (`runAgentic` in `tick.ts`) — the full-pipeline
 *      prompt ends with a `result` event whose `connectors` block
 *      captures the agent's probed reality. The tick handler forwards
 *      it to `writeConnectorSnapshot` here.
 *
 *   2. **Explicit refresh** (`refreshConnectors` below) — the dev
 *      panel's "check connections" button or the
 *      `/api/loop/connectors?refresh=1` route fires a small
 *      "probe only" prompt at the agent (see `composio-bridge.ts`)
 *      which returns the same `connectors` block without going through
 *      the full pull/classify/persist pipeline.
 *
 * `listConnectors()` returns the canonical 6-entry shape (gmail /
 * google_calendar / github / slack / linear / obsidian) backed by the
 * most recent snapshot the agent produced, or by a sentinel all-false
 * fallback when no snapshot has ever been written.
 *
 * Cache TTL is 24h: ticks run every `intervalSec` (default 600s = 10min)
 * and the agent's probe is the ground truth — there's no point
 * thrashing the cache between ticks. Use `refreshConnectors()` (or
 * `/api/loop/connectors` with `{ refresh: true }`) when the UI genuinely
 * needs a fresh probe.
 *
 * Obsidian is file-system based and has no Composio adapter — it's
 * reported as `connected: false` with `lastError: "local-only"`; the
 * bridge backfills it automatically. Chronicle owns its watch state.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDirs, LOOP_PATHS } from "./paths";
import { customChannels } from "./custom-channels";
import type {
  ConnectorCapability,
  ConnectorCapabilitySummary,
  ConnectorEntry,
} from "./types";

const CACHE_TTL_MS = 1 * 60 * 60 * 1000;

interface ConnectorCache {
  fetchedAt: string;
  connectors: ConnectorEntry[];
}

// ---------------------------------------------------------------------------
// Connector capability (#361)
// ---------------------------------------------------------------------------
//
// Canonical Loop toolkits — these are the sources the tick prompt actually
// pulls. Any connector NOT in this set is treated as "connected for chat /
// memory but not contributing to Loop decisions". Native chat integrations
// (Feishu, Lark, iMessage, …) and the composio skill's long tail of
// integrations live outside this set.
//
// Keep in sync with `tick-prompt.ts` §0 and `classify.ts` `signal_type →
// decision_type` mapping — this is the source of truth for "is this
// connector a Loop signal source?".
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
export function withConnectorCapability(
  entry: ConnectorEntry,
): ConnectorEntry {
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

const FALLBACK_CONNECTORS: ConnectorEntry[] = [
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

function readCache(): ConnectorCache | null {
  try {
    if (!existsSync(LOOP_PATHS.connectors)) return null;
    // The on-disk shape can carry the top-level stamp under either
    // `fetchedAt` (current `writeConnectorSnapshot`) or `updatedAt`
    // (older writes / external writers). Read both as a permissive
    // structural type so the cache survives shape drift.
    const raw = JSON.parse(
      readFileSync(LOOP_PATHS.connectors, "utf8"),
    ) as Partial<ConnectorCache> & {
      updatedAt?: unknown;
      connectors?: unknown;
    };
    if (!Array.isArray(raw?.connectors)) return null;
    // Resolve a stamp from any of: top-level `fetchedAt` (current
    // writer), top-level `updatedAt` (older writes / external writers),
    // or the max `fetchedAt` carried by the connector entries
    // themselves. Without this tolerance the UI falls back to the all-
    // offline FALLBACK_CONNECTORS sentinel whenever the on-disk shape
    // shifts — see issue: "LOOMI ONLINE card shows all channels
    // offline" — because the `if (!raw.fetchedAt)` guard above discards
    // a perfectly valid snapshot.
    const topLevel =
      typeof raw.fetchedAt === "string"
        ? raw.fetchedAt
        : typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : null;
    const entryMax = (raw.connectors as Array<{ fetchedAt?: unknown }>).reduce<
      string | null
    >((acc, c) => {
      const ts = c.fetchedAt;
      if (typeof ts !== "string" || !ts) return acc;
      if (!acc) return ts;
      return new Date(ts).getTime() > new Date(acc).getTime() ? ts : acc;
    }, null);
    const stamp = topLevel ?? entryMax;
    if (!stamp) return null;
    if (Date.now() - new Date(stamp).getTime() > CACHE_TTL_MS) return null;
    // Defensively treat any cache entry that lacks `probed` as
    // probed: true. Cron-executor and other external writers may have
    // written the snapshot before the field existed; if it's in the
    // cache, an agent did the work — just normalize the shape so the
    // UI doesn't render it as "Pending first probe".
    //
    // #361 — also stamp capability fields when missing so older cache
    // entries (written before the field existed) still render with the
    // semantic state on the next read.
    const connectors = (raw.connectors as ConnectorEntry[]).map((c) => {
      const probed =
        typeof (c as { probed?: unknown }).probed === "boolean"
          ? c
          : { ...c, probed: true };
      return withConnectorCapability(probed as ConnectorEntry);
    });
    return {
      fetchedAt: stamp,
      connectors,
    };
  } catch {
    return null;
  }
}

/**
 * Public API — write the agent-reported connector snapshot. Called by the
 * tick handler when the agent's `result` event carries a `connectors`
 * block (see `tick-prompt.ts` §0 hook).
 *
 * Stamps #361 capability fields on each entry before persisting so the
 * readiness API can return a semantic state without re-deriving it on
 * every request.
 */
export function writeConnectorSnapshot(connectors: ConnectorEntry[]): void {
  ensureDirs();
  try {
    const stamped = connectors.map(withConnectorCapability);
    writeFileSync(
      LOOP_PATHS.connectors,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          connectors: stamped,
        } satisfies ConnectorCache,
        null,
        2,
      ),
    );
  } catch (e) {
    console.warn("[loop.connectors] cache write failed:", e);
  }
}

/**
 * Returns the agent-reported (or cached) connector status. When no
 * snapshot has been written yet, returns the FALLBACK list with all
 * entries marked `connected: false` so the UI can still render the pill
 * row.
 *
 * `opts.force = true` bypasses the cache and returns the FALLBACK
 * list — useful for tests that want a deterministic "no data" baseline.
 * Live refresh goes through `refreshConnectors()` which dispatches an
 * agent probe via the bridge.
 *
 * On cache miss, this delegates to `refreshConnectors({ silent: true })`
 * so the user never sees "all OFF" right after install — the first
 * open of the Loomi Online card auto-probes and the pill row repaints
 * to truth once the agent returns or the `PROBE_TIMEOUT_MS` ceiling
 * fires. The cache is
 * the fast path; the probe is the recovery.
 */
export async function listConnectors(
  opts: { force?: boolean } = {},
): Promise<ConnectorEntry[]> {
  if (!opts.force) {
    const cached = readCache();
    if (cached) return appendCustomChannels(cached.connectors);
  }
  // Cache miss (or force=true) → delegate to refresh. When called from
  // the regular UI path, this fires a short-timeout silent probe
  // asynchronously and returns the FALLBACK sentinel — the UI renders
  // "Pending first probe" pills immediately and the probe lands in the
  // background. Without this delegation, every fresh install sees the
  // lying "all offline" state for the entire first session.
  return refreshConnectors({ silent: true });
}

// `silent` probe budget. The agent's full probe (see `composio-bridge.ts`'s
// `invokeAgentPrompt({ timeoutMs: 10 * 60 * 1000 })`) can legitimately
// take several minutes for a cold first probe on a fresh install — it
// has to spin up the agent runtime, load the `composio` skill, run the
// CLI, and enumerate all 5 toolkits. The previous 6 s budget was so
// tight that the race almost always lost, so every card open would fall
// back to the FALLBACK sentinel and show "Awaiting first probe".
//
// 10 minutes mirrors the upper bound of the underlying agent probe, so
// the `silent` race and the underlying SSE timeout align — whichever
// hits first is the effective ceiling. In practice the silent path
// usually resolves much sooner; the long ceiling just makes sure a slow
// first probe doesn't get short-circuited into the cooldown fallback.
const PROBE_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_COOLDOWN_MS = 30 * 1000;

interface ConnectorCacheWithCooldown {
  fetchedAt?: unknown;
  connectors?: unknown;
  /**
   * Set when `refreshConnectors({silent:true})` hits its
   * `PROBE_TIMEOUT_MS` ceiling and no agent probe result was
   * available. Subsequent calls within
   * `PROBE_COOLDOWN_MS` will skip the probe entirely and short-circuit
   * to the FALLBACK sentinel — so a user double-clicking the card
   * after opening it twice in a row doesn't burn another agent round
   * trip on a hung or slowly-loading prompt.
   */
  probeCooldownUntil?: unknown;
}

function readProbeCooldown(): number {
  try {
    if (!existsSync(LOOP_PATHS.connectors)) return 0;
    const raw = JSON.parse(
      readFileSync(LOOP_PATHS.connectors, "utf8"),
    ) as ConnectorCacheWithCooldown;
    const v = raw.probeCooldownUntil;
    if (typeof v !== "string") return 0;
    const t = new Date(v).getTime();
    if (Number.isNaN(t)) return 0;
    return t;
  } catch {
    return 0;
  }
}

/**
 * Append per-user custom channels to a connector list. The user-defined
 * entries are sourced from `~/.openloomi/loop/custom-channels.json` and
 * are always shown alongside the built-in `FALLBACK_CONNECTORS` (in
 * that order — built-ins first, custom last so the UI's stable layout
 * doesn't reshuffle when a channel is added or removed). The probe
 * never tries to confirm them: their connection state lives in the
 * user's Composio account, and the watcher's pass will surface a real
 * error if the toolkit isn't reachable.
 *
 * #361 — stamps capability fields so a custom channel with a known
 * `kind` (e.g. one that maps to a canonical toolkit via `kind`) gets a
 * real capability state, not just `connected: false`. A user-defined
 * custom channel is `needs_setup` until the watcher confirms it.
 */
function appendCustomChannels(seed: ConnectorEntry[]): ConnectorEntry[] {
  const extras = customChannels.list();
  if (extras.length === 0) return seed;
  const now = new Date().toISOString();
  const out = seed.slice();
  for (const c of extras) {
    const entry: ConnectorEntry = {
      id: c.id,
      label: c.label,
      // Conservatively report as not-yet-probed; the watcher's pass
      // surfaces real failures when the toolkit isn't reachable.
      connected: false,
      accountCount: 0,
      probed: false,
      fetchedAt: now,
    };
    out.push(withConnectorCapability(entry));
  }
  return out;
}

function writeProbeCooldownMarker(): void {
  // Stamp a cooldown marker on the existing cache file (or write a
  // barebones one if the file doesn't exist yet) so a second cold
  // open within PROBE_COOLDOWN_MS skips the probe. We *don't* clobber
  // a previously-persisted snapshot — the goal is "don't hammer the
  // agent when it's slow", not "forget what we last learned".
  try {
    let existing: ConnectorCacheWithCooldown = {};
    if (existsSync(LOOP_PATHS.connectors)) {
      try {
        existing = JSON.parse(
          readFileSync(LOOP_PATHS.connectors, "utf8"),
        ) as ConnectorCacheWithCooldown;
      } catch {
        existing = {};
      }
    }
    ensureDirs();
    writeFileSync(
      LOOP_PATHS.connectors,
      JSON.stringify(
        {
          ...existing,
          probeCooldownUntil: new Date(
            Date.now() + PROBE_COOLDOWN_MS,
          ).toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* swallow — cooldown is an optimization, not a correctness lever */
  }
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
 * Clear any pending `probeCooldownUntil` marker on the on-disk cache.
 *
 * Intended for callers that have just kicked off a *real* (non-silent)
 * probe in the background and want the next card-open `silent` probe
 * to fall through to the cache (which the background probe is
 * populating) rather than be short-circuited by the stale marker left
 * over from a prior timeout. Mirrors `writeProbeCooldownMarker`'s
 * "preserve existing snapshot" policy — we only drop the marker
 * field, the connector rows stay.
 *
 * Swallows all errors (cooldown is an optimization, not correctness).
 */
export function clearProbeCooldown(): void {
  try {
    if (!existsSync(LOOP_PATHS.connectors)) return;
    const raw = JSON.parse(
      readFileSync(LOOP_PATHS.connectors, "utf8"),
    ) as ConnectorCacheWithCooldown;
    if (typeof raw.probeCooldownUntil !== "string") return;
    raw.probeCooldownUntil = undefined;
    ensureDirs();
    writeFileSync(LOOP_PATHS.connectors, JSON.stringify(raw, null, 2));
  } catch {
    /* swallow — cooldown is an optimization, not a correctness lever */
  }
}

/**
 * Force-refresh by dispatching a small "connector probe" prompt to the
 * agent via `composio-bridge.ts`. The agent inspects the active
 * composio surfaces (skill / CLI / insights) and returns a fresh
 * snapshot, which we persist via `writeConnectorSnapshot` and return.
 *
 * `opts.silent = true` wraps the probe in a `PROBE_TIMEOUT_MS`
 * (10 min) ceiling and falls back to the cache / FALLBACK on timeout,
 * including writing a `probeCooldownUntil` marker so a rapid re-open
 * within `PROBE_COOLDOWN_MS` skips the probe entirely. Used by
 * `listConnectors()`'s cache-miss path so the user's first card open
 * gets the room it needs for a cold first probe without immediately
 * falling back to "Pending first probe" pills.
 *
 * Failure modes (in order of preference):
 *
 *   1. Probe succeeded → return + persist the entries.
 *   2. Probe failed (transport / timeout / malformed result) but the
 *      cache is fresh (within CACHE_TTL_MS) → return the cache. The
 *      pill row stays accurate to the last good agent report; we just
 *      can't give the user a live update.
 *   3. Probe failed AND cache is stale / missing → return FALLBACK so
 *      the UI can still render the row. Caller should surface a
 *      "stale" hint to the user.
 */
export async function refreshConnectors(
  opts: { silent?: boolean } = {},
): Promise<ConnectorEntry[]> {
  // `silent` mode additionally consults the cooldown marker — if we're
  // still inside the post-timeout window, skip the probe entirely and
  // return whatever the cache (or FALLBACK) has. This prevents a stuck
  // or slow agent from being hammered on rapid card re-opens.
  if (opts.silent && Date.now() < readProbeCooldown()) {
    const cached = readCache();
    if (cached) return appendCustomChannels(cached.connectors);
    return appendCustomChannels(FALLBACK_CONNECTORS);
  }

  const probe: Promise<ConnectorEntry[] | null> = (async () => {
    const { probeConnectorState } = await import("./composio-bridge");
    return probeConnectorState();
  })();

  // `silent` mode wraps the probe in a short timeout so the first card
  // open is bounded — we don't want to keep the user waiting on a hung
  // agent. On timeout, write the cooldown marker and fall back to
  // whatever's on disk (or FALLBACK).
  let probed: ConnectorEntry[] | null;
  if (opts.silent) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      probed = await Promise.race<ConnectorEntry[] | null>([
        probe,
        new Promise<ConnectorEntry[] | null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!probed || probed.length === 0) {
      writeProbeCooldownMarker();
      const cached = readCache();
      if (cached) return appendCustomChannels(cached.connectors);
      return appendCustomChannels(FALLBACK_CONNECTORS);
    }
    return appendCustomChannels(probed);
  }

  probed = await probe;
  if (probed && probed.length > 0) {
    return appendCustomChannels(probed);
  }
  // Probe failed — degrade gracefully.
  const cached = readCache();
  if (cached) {
    return appendCustomChannels(cached.connectors);
  }
  return appendCustomChannels(FALLBACK_CONNECTORS);
}
