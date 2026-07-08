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
import type { ConnectorEntry } from "./types";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ConnectorCache {
  fetchedAt: string;
  connectors: ConnectorEntry[];
}

const FALLBACK_CONNECTORS: ConnectorEntry[] = [
  {
    id: "gmail",
    label: "Gmail",
    connected: false,
    accountCount: 0,
    fetchedAt: "",
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    connected: false,
    accountCount: 0,
    fetchedAt: "",
  },
  {
    id: "github",
    label: "GitHub",
    connected: false,
    accountCount: 0,
    fetchedAt: "",
  },
  {
    id: "slack",
    label: "Slack",
    connected: false,
    accountCount: 0,
    fetchedAt: "",
  },
  {
    id: "linear",
    label: "Linear",
    connected: false,
    accountCount: 0,
    fetchedAt: "",
  },
  {
    id: "obsidian",
    label: "Obsidian",
    connected: false,
    accountCount: 0,
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
    return {
      fetchedAt: stamp,
      connectors: raw.connectors as ConnectorCache["connectors"],
    };
  } catch {
    return null;
  }
}

/**
 * Public API — write the agent-reported connector snapshot. Called by the
 * tick handler when the agent's `result` event carries a `connectors`
 * block (see `tick-prompt.ts` §0 hook).
 */
export function writeConnectorSnapshot(connectors: ConnectorEntry[]): void {
  ensureDirs();
  try {
    writeFileSync(
      LOOP_PATHS.connectors,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          connectors,
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
 */
export async function listConnectors(
  opts: { force?: boolean } = {},
): Promise<ConnectorEntry[]> {
  if (!opts.force) {
    const cached = readCache();
    if (cached) return cached.connectors;
  }
  const stamp = new Date().toISOString();
  return FALLBACK_CONNECTORS.map((c) => ({ ...c, fetchedAt: stamp }));
}

/**
 * Force-refresh by dispatching a small "connector probe" prompt to the
 * agent via `composio-bridge.ts`. The agent inspects the active
 * composio surfaces (skill / CLI / insights) and returns a fresh
 * snapshot, which we persist via `writeConnectorSnapshot` and return.
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
export async function refreshConnectors(): Promise<ConnectorEntry[]> {
  const { probeConnectorState } = await import("./composio-bridge");
  const probed = await probeConnectorState();
  if (probed && probed.length > 0) {
    return probed;
  }
  // Probe failed — degrade gracefully.
  const cached = readCache();
  if (cached) {
    return cached.connectors;
  }
  const stamp = new Date().toISOString();
  return FALLBACK_CONNECTORS.map((c) => ({ ...c, fetchedAt: stamp }));
}
