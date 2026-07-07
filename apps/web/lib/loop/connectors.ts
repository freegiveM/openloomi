/**
 * Loop connector status — surface-only.
 *
 * The Loop is fully agentic: the agent at `/api/native/agent` has the
 * Composio MCP server loaded and probes connection state itself at tick
 * time. The Loop's local module no longer hits Composio's REST API
 * directly — that would require a parallel `COMPOSIO_API_KEY` env var and
 * duplicate the agent's discovery work.
 *
 * `listConnectors()` returns the canonical 6-entry shape (gmail /
 * google_calendar / github / slack / linear / obsidian), all marked
 * `connected: false`. The agent's tick result can write an authoritative
 * snapshot to `~/.openloomi/loop/connectors.json`; if that file exists
 * (and is fresh enough), we honour it instead. The UI pill row is
 * therefore "last agent-reported" rather than "live" — fine because the
 * pill is decorative, not a control surface.
 *
 * Cache TTL is 24h: ticks run every `intervalSec` (default 600s = 10min),
 * and the agent's MCP probe is the ground truth — there's no point
 * thrashing the cache between ticks. Force-refresh is available via
 * `refreshConnectors()` and the `/api/loop/connectors?force=1` query.
 *
 * Obsidian is file-system based and has no Composio adapter — it's
 * reported as `connected: false` here; Chronicle owns its watch state.
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
    const raw = JSON.parse(
      readFileSync(LOOP_PATHS.connectors, "utf8"),
    ) as ConnectorCache;
    if (!raw?.fetchedAt || !Array.isArray(raw.connectors)) return null;
    if (Date.now() - new Date(raw.fetchedAt).getTime() > CACHE_TTL_MS)
      return null;
    return raw;
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

/** Force-refresh by clearing the cache and returning FALLBACK. */
export async function refreshConnectors(): Promise<ConnectorEntry[]> {
  return listConnectors({ force: true });
}
