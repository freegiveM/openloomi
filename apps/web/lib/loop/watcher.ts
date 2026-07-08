/**
 * Loop watcher — kept as a public entry point for backward compatibility
 * with `handlers.ts` (which calls `runWatcher()` before each `tick.run()`).
 *
 * **The watcher is a no-op in agentic mode**: the agent at `/api/native/agent`
 * has the `composio` skill and `composio` CLI available and pulls signals
 * itself (see `tick-prompt.ts` §1–2). Legacy pullers (per-bot Gmail OAuth,
 * per-channel REST polling) were intentionally removed in the agentic
 * refactor.
 *
 * Connector-status probing (which is what the watcher used to gate its
 * pullers) now lives in `composio-bridge.getActiveIntegrations()` and is
 * exposed via `/api/loop/connectors` — see `connectors.ts`.
 */

import { log } from "./store";

export interface WatcherRunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  bySource: Record<string, never>;
  totalAppended: number;
}

export interface WatcherOptions {
  userId?: string;
}

/**
 * Run one watcher pass. No-op in agentic mode — kept as the public entry
 * so `handlers.ts::handleTick` and any future caller can keep calling it
 * without branching on mode.
 */
export async function runOnce(
  _opts: WatcherOptions = {},
): Promise<WatcherRunResult> {
  const startedAt = new Date();
  const result: WatcherRunResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    bySource: {},
    totalAppended: 0,
  };
  const finishedAt = new Date();
  result.finishedAt = finishedAt.toISOString();
  result.durationMs = finishedAt.getTime() - startedAt.getTime();
  log(
    `[watcher] agentic mode — no pulls (signals come from /api/native/agent)`,
  );
  return result;
}
