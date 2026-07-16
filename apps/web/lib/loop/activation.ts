/**
 * Loop activation state — the shared, resumable state machine that lets
 * every OpenLoomi surface (Desktop web, Tauri pet, Codex / Claude bridges)
 * know where the user is stuck on the road to their first reviewed decision
 * card, and what to nudge next. See issue #351.
 *
 * `ready: true` (from the bridges' setup-status) only means `coreReady` —
 * runtime up + AI provider configured + native CLI logged in. Activation is
 * a SEPARATE axis: even a "ready" install shows nothing useful until the
 * user connects a data source, runs a first check, and reviews the first
 * decision that surfaces. This module makes that axis explicit and durable.
 *
 * Single source of truth on disk: `~/.openloomi/loop/activation_state.json`,
 * written atomically (tmp + rename) mirroring
 * `apps/web/app/api/pet/state/route.ts`.
 *
 * The two "progress" flags (`firstTickCompleted`, `firstDecisionSeen`) are
 * STICKY — once true they stay true (OR-ed with any freshly-derived signal)
 * so a transient empty tick / decision store never regresses the user's
 * stage. The two "live" flags (`coreReady`, `dataSourceReady`) are
 * recomputed on every `computeActivationState()` so the machine tracks
 * reality as the user configures things.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ensureDirs, ensureParent, LOOP_PATHS } from "./paths";
import { customChannels } from "./custom-channels";

export const ACTIVATION_SCHEMA_VERSION = 1 as const;

export type ActivationStage =
  | "uninitialized"
  | "setup_pending"
  | "runtime_ready"
  | "source_pending"
  | "check_pending"
  | "decision_pending"
  | "activated";

export type RecommendedNextAction =
  | "finish_setup"
  | "configure_ai_provider"
  | "connect_source"
  | "run_first_check"
  | "review_first_decision"
  | null;

export interface ActivationState {
  schemaVersion: typeof ACTIVATION_SCHEMA_VERSION;
  /** runtime + AI provider configured (i.e. today's `ready: true`). */
  coreReady: boolean;
  /** ≥1 connected Loop connector or IntegrationAccount / custom channel. */
  dataSourceReady: boolean;
  /** A `loop:tick` has completed (signals present / event recorded). */
  firstTickCompleted: boolean;
  /** The user has acted on a decision (done or dismissed). */
  firstDecisionSeen: boolean;
  activationStage: ActivationStage;
  recommendedNextAction: RecommendedNextAction;
  /** OpenLoomi-owned URL — never points at the plugin side. */
  setupUrl: string | null;
  /**
   * The top pending decision id, when one exists — lets surfaces deep-link
   * straight to the card the user should review (`/loop/<id>`). Null once
   * activated or when nothing is pending.
   */
  topPendingDecisionId: string | null;
  updatedAt: string;
}

export interface ComputeActivationOptions {
  /**
   * runtime + AI provider readiness. Callers that can resolve this (the
   * route via auth + AI settings) pass it in; defaults to `false` so a
   * bare compute on a fresh install reports `setup_pending` /
   * `uninitialized`.
   */
  coreReady?: boolean;
  /**
   * Extra data-source signal the filesystem can't see — e.g. a connected
   * `IntegrationAccount` row in the DB. OR-ed with the on-disk connector
   * check.
   */
  dataSourceReady?: boolean;
  /**
   * Base URL used to build `setupUrl`. When omitted, a same-origin
   * relative `/connectors` path is used (fine for the web UI).
   */
  baseUrl?: string | null;
}

/* ------------------------------------------------------------------ */
/* Filesystem-derived signals                                          */
/* ------------------------------------------------------------------ */

function readJsonSafe<T>(p: string, fallback: T): T {
  try {
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Any connected connector in the cached snapshot? (TTL-agnostic — a
 *  connection doesn't expire just because the probe cache did.) */
function fsHasConnectedConnector(): boolean {
  const raw = readJsonSafe<{ connectors?: Array<{ connected?: unknown }> }>(
    LOOP_PATHS.connectors,
    {},
  );
  if (!Array.isArray(raw.connectors)) return false;
  return raw.connectors.some((c) => c?.connected === true);
}

/** Any user-defined custom signal channel counts as a wired data source. */
function fsHasCustomChannel(): boolean {
  try {
    return customChannels.list().length > 0;
  } catch {
    return false;
  }
}

/** Signals log has at least one line → a tick has pulled something. */
function fsHasSignals(): boolean {
  try {
    if (!existsSync(LOOP_PATHS.signals)) return false;
    return readFileSync(LOOP_PATHS.signals, "utf8").split("\n").some(Boolean);
  } catch {
    return false;
  }
}

interface DecisionBuckets {
  pending?: Array<{ id?: unknown }>;
  done?: unknown[];
  dismissed?: unknown[];
}

function readDecisionBuckets(): DecisionBuckets {
  return readJsonSafe<DecisionBuckets>(LOOP_PATHS.decisions, {});
}

/** A decision has been acted on (done or dismissed). */
function bucketsHaveSeenDecision(d: DecisionBuckets): boolean {
  const done = Array.isArray(d.done) ? d.done.length : 0;
  const dismissed = Array.isArray(d.dismissed) ? d.dismissed.length : 0;
  return done > 0 || dismissed > 0;
}

function topPendingId(d: DecisionBuckets): string | null {
  if (!Array.isArray(d.pending)) return null;
  for (const dec of d.pending) {
    if (dec && typeof dec.id === "string" && dec.id) return dec.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Stage / action reduction                                            */
/* ------------------------------------------------------------------ */

const STAGE_TO_ACTION: Record<ActivationStage, RecommendedNextAction> = {
  uninitialized: "finish_setup",
  setup_pending: "finish_setup",
  runtime_ready: "connect_source",
  source_pending: "run_first_check",
  check_pending: "run_first_check",
  decision_pending: "review_first_decision",
  activated: null,
};

interface ReduceInput {
  coreReady: boolean;
  dataSourceReady: boolean;
  firstTickCompleted: boolean;
  firstDecisionSeen: boolean;
  hasPendingDecision: boolean;
}

function reduceStage(s: ReduceInput): ActivationStage {
  if (!s.coreReady) {
    const anyProgress =
      s.dataSourceReady ||
      s.firstTickCompleted ||
      s.firstDecisionSeen ||
      s.hasPendingDecision;
    return anyProgress ? "setup_pending" : "uninitialized";
  }
  if (s.firstDecisionSeen) return "activated";
  if (!s.dataSourceReady) return "runtime_ready";
  if (!s.firstTickCompleted) return "source_pending";
  if (s.hasPendingDecision) return "decision_pending";
  return "check_pending";
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read the persisted activation state. Returns null when the file is
 * missing or corrupt (the caller then falls back to a fresh compute).
 */
export function readActivationState(): ActivationState | null {
  try {
    if (!existsSync(LOOP_PATHS.activationState)) return null;
    const raw = JSON.parse(
      readFileSync(LOOP_PATHS.activationState, "utf8"),
    ) as Partial<ActivationState>;
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion !== ACTIVATION_SCHEMA_VERSION) return null;
    return raw as ActivationState;
  } catch {
    return null;
  }
}

/**
 * Recompute the activation state from all products on disk (plus any
 * caller-supplied `coreReady` / `dataSourceReady`). The two progress flags
 * are OR-ed with the last persisted state so they never regress.
 */
export function computeActivationState(
  opts: ComputeActivationOptions = {},
): ActivationState {
  const prior = readActivationState();

  const coreReady = opts.coreReady ?? false;

  const dataSourceReady = Boolean(
    opts.dataSourceReady || fsHasConnectedConnector() || fsHasCustomChannel(),
  );

  const buckets = readDecisionBuckets();
  const hasPendingDecision =
    Array.isArray(buckets.pending) && buckets.pending.length > 0;

  // Sticky progress flags: once true, stay true.
  const firstTickCompleted = Boolean(
    prior?.firstTickCompleted || fsHasSignals(),
  );
  const firstDecisionSeen = Boolean(
    prior?.firstDecisionSeen || bucketsHaveSeenDecision(buckets),
  );

  const stage = reduceStage({
    coreReady,
    dataSourceReady,
    firstTickCompleted,
    firstDecisionSeen,
    hasPendingDecision,
  });

  const setupUrl =
    typeof opts.baseUrl === "string" && opts.baseUrl
      ? `${opts.baseUrl.replace(/\/+$/, "")}/connectors`
      : "/connectors";

  return {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    coreReady,
    dataSourceReady,
    firstTickCompleted,
    firstDecisionSeen,
    activationStage: stage,
    recommendedNextAction: STAGE_TO_ACTION[stage],
    setupUrl,
    topPendingDecisionId: stage === "activated" ? null : topPendingId(buckets),
    updatedAt: new Date().toISOString(),
  };
}

/** Atomically persist the activation state (tmp + rename). */
export function writeActivationState(state: ActivationState): void {
  ensureDirs();
  ensureParent(LOOP_PATHS.activationState);
  const tmp = `${LOOP_PATHS.activationState}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, LOOP_PATHS.activationState);
  } catch {
    // Best-effort fallback — a torn write is worse than a direct write on
    // the platforms where rename isn't atomic.
    try {
      writeFileSync(LOOP_PATHS.activationState, JSON.stringify(state, null, 2));
    } catch {
      /* swallow — activation state is advisory, not correctness-critical */
    }
  }
}

/**
 * Record a lifecycle event that flips one of the sticky progress flags,
 * recompute the rest, and persist. Called by the tick handler
 * (`recordEvent("tick")`) and the decision action path
 * (`recordEvent("decision_seen")`).
 */
export function recordEvent(
  kind: "tick" | "decision_seen",
  opts: ComputeActivationOptions = {},
): ActivationState {
  const base = computeActivationState(opts);

  const firstTickCompleted = base.firstTickCompleted || kind === "tick";
  const firstDecisionSeen = base.firstDecisionSeen || kind === "decision_seen";

  const buckets = readDecisionBuckets();
  const hasPendingDecision =
    Array.isArray(buckets.pending) && buckets.pending.length > 0;

  const stage = reduceStage({
    coreReady: base.coreReady,
    dataSourceReady: base.dataSourceReady,
    firstTickCompleted,
    firstDecisionSeen,
    hasPendingDecision,
  });

  const next: ActivationState = {
    ...base,
    firstTickCompleted,
    firstDecisionSeen,
    activationStage: stage,
    recommendedNextAction: STAGE_TO_ACTION[stage],
    topPendingDecisionId: stage === "activated" ? null : topPendingId(buckets),
    updatedAt: new Date().toISOString(),
  };
  writeActivationState(next);
  return next;
}
