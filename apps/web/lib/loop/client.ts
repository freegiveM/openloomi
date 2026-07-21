/**
 * Loop barrel — client-safe surface.
 *
 * This file is the only `@/lib/loop/*` import path Client Components
 * should use. It re-exports only modules that have no Node.js-only
 * dependencies (no `node:fs`, no DB, no agent bridge, no composio
 * adapter) so the Next.js client bundle never ends up with a
 * `node:fs` import that the browser can't resolve.
 *
 * Anything that lives in `./store`, `./paths`, `./runner`, `./tick`,
 * `./scheduler`, `./handlers`, `./brief`, `./wrap`, `./watcher`,
 * `./activation`-state-mutating helpers, `./server`, etc. is
 * deliberately excluded — those touch the on-disk snapshot or call the
 * agent and must stay on the server.
 *
 * If you find yourself wanting to add an export here, ask first:
 *   1. Does it only read types or call pure functions?
 *   2. Does it touch `node:fs`, the agent, or any side-effecting I/O?
 * If #2 is "yes", keep it on `@/lib/loop` (server-only).
 */

export * from "./types";
export {
  isLoopMonitored,
  isDecisionCapable,
  deriveConnectorCapability,
  withConnectorCapability,
  summarizeConnectorCapability,
  filterComposioOnlyEntries,
} from "./connectors-pure";
export {
  deriveReadiness,
  deriveRelationship,
  deriveUrgency,
  derivePriority,
  readinessState,
  stateLabel,
  canExecute,
} from "./readiness";
