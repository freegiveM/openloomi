/**
 * Loop domain types — the Loop is OpenLoomi's proactive execution brain.
 *
 * Decisions are typed cards that flow through a pipeline:
 *   watch (pull signals) → enrich (memory lookup) → classify (rule + classifier)
 *   → execute (POST /api/native/agent) → user approval (dry/run/dismiss/promote)
 *
 * The schema is intentionally permissive: callers (agents, CLI, web UI, pet)
 * may omit optional fields. The store layer hoists top-level `memory_refs` /
 * `insight_refs` into `context` on every read so every consumer sees one
 * consistent shape.
 */

export type DecisionType =
  | "rsvp"
  | "email_reply"
  | "review_pr"
  | "todo"
  | "im_reply"
  | "deadline_reminder"
  | "release_plan"
  | "requirement_synthesis"
  | "linear_review"
  | "contact_update"
  | "doc_update"
  | "brief"
  | "wrap"
  | "noop" // NEW — non-actionable; filtered at decisions.add()
  | "tick_summary" // NEW — explicit per-tick summary; filtered at decisions.add()
  | "quiet_digest" // NEW — filler content for empty brief/wrap days; read-only
  | "email_burst_digest" // NEW (SP-3) — burst of N emails from same sender
  | "unknown";

export type DecisionStatus = "pending" | "done" | "dismissed";

export type ActionKind =
  | "calendar_rsvp"
  | "email_reply"
  | "im_reply"
  | "github_review"
  | "deadline_notify"
  | "todo"
  | "linear_review"
  | "requirement_synthesis"
  | "release_plan"
  | "contact_update"
  | "doc_update"
  | "brief"
  | "wrap"
  | "quiet_digest" // NEW — filler content for empty brief/wrap days
  | "email_burst_digest" // NEW (SP-3) — burst digest action kind
  | string; // open form for agent-emitted kinds

export interface LoopAction {
  kind: ActionKind;
  params: Record<string, unknown>;
}

export interface LoopDecisionContext {
  why?: string[];
  memory_refs?: string[];
  insight_refs?: string[];
  person?: string | null;
  [extra: string]: unknown;
}

/**
 * #364 — pending-action lock. Persists a reference to the currently
 * scheduled (cron) action for this decision so a second click on the
 * same RSVP / Run / Dismiss can be detected and either refused or
 * superseded atomically. Without this, two opposite responses (e.g.
 * "No" then "Yes") could both fire — the bug reports both `last_status
 * = "success"` rows alongside a decision record that only retains the
 * last `sub_action`.
 *
 * Stored under `context.pending_action` so it lives in the existing
 * JSON-backed decision store (no DB migration). `action_id` is the
 * `scheduled_jobs.id` — same shape the card already fetches via
 * `/api/loop/action/by-decision/[id]` for the polling fallback.
 */
export interface DecisionPendingAction {
  action_id: string;
  /** ISO timestamp the job was scheduled. */
  scheduled_at: string;
  /** Verb stored in the job payload (`run` | `dry` | `dismiss` | …). */
  action: string;
  /**
   * Sub-action body the user passed when they clicked (e.g. RSVP
   * `{ response: "no" }`). Persisted so a subsequent schedule that
   * wants to supersede can see what was about to run.
   */
  sub_action?: Record<string, unknown>;
}

/**
 * #364 — immutable execution history. Append-only list of every
 * scheduled-action attempt that ever existed for this decision,
 * regardless of whether it ran, was cancelled, or was superseded.
 * Replaces the previous `context.sub_action` overwrite so the card
 * can show all attempts and the UI never hides a contradictory
 * earlier execution.
 */
export type DecisionSubActionStatus =
  | "completed"
  | "skipped"
  | "blocked"
  | "failed"
  | "cancelled"
  | "superseded";

export interface DecisionSubActionRecord {
  /** Scheduled-job id (== `action_id` for pending_action). */
  action_id: string;
  /** ISO timestamp the job was scheduled. */
  scheduled_at: string;
  /** ISO timestamp the action reached a terminal state (fired or was cancelled). */
  completed_at?: string;
  /** Verb that was scheduled. */
  action: string;
  /** Frozen sub-action body the user clicked (e.g. `{ response: "no" }`). */
  sub_action?: Record<string, unknown>;
  /** Terminal state of the attempt. */
  status: DecisionSubActionStatus;
  /**
   * Runner verdict when the job actually fired. Mirrors the
   * `LoopDecisionExecution.outcome` shape so the card can render a
   * per-attempt reason without re-deriving from the runner.
   */
  verdict?: "executed" | "skipped" | "blocked" | "failed";
  /** Human-readable reason (matches `LoopDecisionExecution.reason`). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Decision semantics (#359) — three separate questions, not one score
// ---------------------------------------------------------------------------
//
// A single `confidence` value used to be overloaded across three unrelated
// product questions:
//   1. How likely is the signal to belong to a decision `type`? (classification)
//   2. Is there enough information to decide/execute safely?     (readiness)
//   3. How well do we know the person/entity involved?           (relationship)
//
// These are now separated. `confidence` stays a DIAGNOSTIC classification
// probability and is NEVER used to derive urgency or priority. `readiness`
// gates execution. `relationship` is optional colour that only surfaces when
// it materially helps the user judge risk/relevance. See `readiness.ts` for
// the derivation helpers and `derivePriority` (urgency × impact, independent
// of `confidence`).

/**
 * Decision readiness — is there enough information to act safely?
 *   - "ready"          → decision-critical fields present; safe to execute.
 *   - "needs_context"  → missing fields; execution is gated until resolved.
 *   - "not_actionable" → nothing to do (e.g. an event you own with no guests).
 */
export type ReadinessStatus = "ready" | "needs_context" | "not_actionable";

export interface DecisionReadiness {
  status: ReadinessStatus;
  /** Human-readable decision-critical fields absent from the signal. */
  missing?: string[];
}

/**
 * Relationship context — how well OpenLoomi knows the counterparty. Optional
 * by design; absence means "no evidence", and it NEVER blocks a decision by
 * itself. It only sharpens the plain-language state (e.g. an unknown sender
 * asking for an external action becomes "Confirm carefully").
 */
export type RelationshipLevel = "self" | "known" | "unknown";

export interface DecisionRelationship {
  level: RelationshipLevel;
}

export interface LoopDecision {
  id: string;
  ts: string;
  status: DecisionStatus;
  signal_id?: string;
  type: DecisionType;
  title: string;
  action: LoopAction;
  context?: LoopDecisionContext;
  /**
   * Classification confidence — how likely the signal belongs to `type`.
   * DIAGNOSTIC ONLY (#359): never used to derive urgency or priority. A high
   * value means "we're confident this is an RSVP", NOT "this is urgent",
   * "safe to execute", or "the sender is trusted".
   */
  confidence?: number;
  /**
   * Decision readiness — gates execution (#359). When absent, consumers
   * derive it from the action/signal via `readiness.ts::deriveReadiness`.
   */
  readiness?: DecisionReadiness;
  /**
   * Relationship context — optional colour (#359). When absent, consumers
   * may derive it via `readiness.ts::deriveRelationship`. Never blocks a
   * decision by itself.
   */
  relationship?: DecisionRelationship;
  source_signal?: LoopSignal;
  /**
   * SP-1 — pre-computed card-display priority, set by
   * `store.ts::normalizeDecision` via `readiness.ts::derivePriority`.
   * Independent of `confidence` (per #359) and independent of
   * `readiness.status` — a `not_actionable` decision is P2 regardless
   * of how urgent its source signal looked. Persisted under
   * `context.priority` for the Rust watcher to read verbatim, and
   * mirrored at the top level for clean TS consumers. When absent
   * (legacy rows pre-SP-1) consumers should re-derive via
   * `readiness.ts::derivePriority(decision, now)`.
   *
   * Typed inline (not as `LoopPriority` from `./readiness`) to avoid
   * the `types ↔ readiness` circular import — the union is identical
   * and structurally compatible.
   */
  priority?: "P0" | "P1" | "P2";
  result?: unknown;
  completed_at?: string;
  /** Card-flavored dialogue/next step for the pet and web UI. */
  dialogue?: string;
  nextStep?: string;
  /**
   * #358 — structured execution outcome. Records what actually happened when
   * the runner executed this decision: did the agent perform an external
   * write, refuse, skip, get blocked, or fail? Persisted so the activity
   * trail, briefs, wraps, and audits don't claim an external side-effect
   * happened when nothing did. Optional for backward compatibility — legacy
   * `done` rows without this field render as `done / executed` by default.
   */
  execution?: LoopDecisionExecution;
}

// ---------------------------------------------------------------------------
// Execution outcome (#358) — what actually happened during a `run`
// ---------------------------------------------------------------------------
//
// Distinguishes "transport + model completed" from "the user-visible action
// was actually performed". A clean HTTP 200 from the agent is not enough —
// the agent may have refused, no-op'd, or hit a connector error.

/** Verdict from a single `runDecision` execution attempt. */
export type ExecutionOutcome = "executed" | "skipped" | "blocked" | "failed";

export interface LoopDecisionExecution {
  /** The structured verdict the runner parsed from the agent's response. */
  outcome: ExecutionOutcome;
  /**
   * Human-readable reason — required for skipped/blocked/failed. Optional
   * for executed (used as a short summary line in the UI).
   */
  reason?: string;
  /**
   * Connector-specific evidence of the external write. Populated whenever
   * the agent returned an id (calendar eventId, gmail messageId, slack ts,
   * github reviewId, tool call id). Open-ended for forward-compat.
   */
  evidence?: {
    eventId?: string;
    messageId?: string;
    reviewId?: string;
    toolCallId?: string;
    [k: string]: unknown;
  };
  /** ISO timestamp of when the agent returned this outcome. */
  evaluatedAt: string;
}

export interface LoopDecisionBuckets {
  pending: LoopDecision[];
  done: LoopDecision[];
  dismissed: LoopDecision[];
}

export type SignalType =
  | "email"
  | "calendar_event"
  | "github_pr"
  | "github_issue"
  | "github_notification" // #378 — passive GitHub notification; aggregated, never a Run card
  | "slack_message"
  | "linear_issue"
  | "obsidian_note_changed"
  | string;

export interface LoopSignal {
  id: string;
  ts: string;
  source: string;
  type: SignalType;
  payload: Record<string, unknown>;
  /** Optional dedupe key. Signals with the same `dedupeKey` after append
   *  are kept once. */
  _origin?: "composio" | "insights" | "obsidian" | "manual";
  _insightId?: string;
  /**
   * #360 — non-secret provenance for the connected account this signal was
   * pulled from. Multi-account toolkits (e.g. two Google Calendar accounts)
   * pull once per account and tag each signal here so decisions, briefs, and
   * dedupe stay traceable to their source account. NEVER contains OAuth
   * tokens or other credentials — only a stable connected-account id and an
   * optional human-facing label (usually the account email / handle).
   */
  sourceAccount?: ConnectorAccount;
}

import type {
  LoopPreferences,
  QuietDayFillerId,
} from "@openloomi/loop/preferences";
export type { LoopPreferences, QuietDayFillerId };

/** Mute rule scope — discriminated union keyed by signal type. */
export type MuteScope =
  | { kind: "email"; from: string }
  | { kind: "calendar_event"; organizer: string; fallback?: "eventId" }
  | { kind: "slack_message"; user?: string; channel?: string }
  | { kind: "im_message"; user?: string; channel?: string }
  | { kind: "obsidian_note_changed"; path: string }
  | { kind: "github_pr"; repo: string }
  | { kind: "github_issue"; repo: string }
  | { kind: "linear_issue"; team?: string; project?: string };

export interface MuteRule {
  /** Normalised lowercase key — the atom of O(1) lookups. */
  key: string;
  /** Discriminated scope, kept for diagnostics and a future mute UI. */
  scope: MuteScope;
  /** ISO timestamp when the rule was created. */
  createdAt: string;
  /** Provenance — which dismiss produced this rule. */
  source?: { decisionId?: string; signalType?: SignalType };
  /**
   * SP-4 — optional ISO timestamp until which the rule is treated
   * as "in cooldown" by `mutes.cooldownActive(key, now)`. Distinct
   * from the rule being absent: a rule with `cooldown_until` in
   * the future still allows the decision to land in `pending` (the
   * pet bubble surfaces it) but suppresses the OS-notification
   * fan-out for the same source. After `cooldown_until` passes the
   * rule degrades to a regular mute (still blocks per `mutes.has`).
   */
  cooldown_until?: string;
}

export interface LoopMutes {
  version: 1;
  rules: MuteRule[];
  /** Flattened keys — recomputed from `rules` on every write. */
  keys: string[];
}

/**
 * Capability states for a connector (#361). The Loop is fully agentic and
 * pulls signals from a small set of canonical toolkits (gmail, google_calendar,
 * github, slack, linear, obsidian) — but a user can authorize many more
 * integrations for chat/memory use that do NOT participate in Loop's signal
 * pull. These states let the UI tell those two situations apart without
 * conflating "authorized" with "monitored by Loop".
 *
 *   - "needs_setup"      → connected for chat/memory but not yet wired into Loop.
 *   - "connected"        → credentials healthy; canonical toolkit with a known mapping.
 *   - "loop_monitored"   → Loop actively pulls signals from this source.
 *   - "decision_capable" → payload has a supported classifier mapping; can produce decisions.
 *   - "unsupported"      → connected but no classifier mapping; signals are intentionally dropped.
 *
 * `decision_capable` implies `loop_monitored` (you can't decide from a source
 * Loop isn't pulling), and `loop_monitored` implies `connected`. The reverse
 * is not true — that's the whole point of having separate states.
 */
export type ConnectorCapability =
  | "needs_setup"
  | "connected"
  | "loop_monitored"
  | "decision_capable"
  | "unsupported";

/**
 * #360 — a single connected account within a toolkit. Multi-account
 * toolkits (Gmail, Google Calendar, Slack, …) can have several of these.
 * The shape is deliberately minimal and non-secret: a stable connected-
 * account id (Composio `connected_account_id` / `word_id`) plus an optional
 * human-facing label (usually the account's email or handle). It NEVER
 * carries OAuth tokens, refresh tokens, or other credentials, so it is safe
 * to round-trip through `/api/loop/connectors` and persist on disk.
 */
export interface ConnectorAccount {
  /** Stable, non-secret connected-account identifier. */
  id: string;
  /** Optional human-facing label — usually the account email / handle. */
  label?: string;
  /**
   * Per-account health from the last probe/tick. Absent means "assumed
   * healthy" for back-compat. `false` lets the UI flag an account whose
   * pull failed while its siblings succeeded (partial-failure isolation).
   */
  healthy?: boolean;
  /** Optional short, non-secret reason when `healthy === false`. */
  lastError?: string;
}

export interface ConnectorEntry {
  id: string;
  label: string;
  /** True when at least one account is connected and the toolkit reports healthy. */
  connected: boolean;
  accountCount: number;
  /**
   * #360 — the active connected accounts Loop monitors for this toolkit.
   * One entry per healthy account, so a multi-account toolkit (e.g. two
   * Google Calendar accounts) is transparent to the UI instead of implying
   * a single default account. Length SHOULD agree with `accountCount`; the
   * field is optional for back-compat with snapshots written before #360.
   * Entries carry only non-secret identifiers/labels — never credentials.
   */
  accounts?: ConnectorAccount[];
  lastError?: string;
  /**
   * Provenance flag. `true` means an agent probe actually emitted this
   * row; `false` (or absent for compat) means it's a "haven't asked yet"
   * sentinel from the FALLBACK list. UIs use this to distinguish "we know
   * this is offline" from "we don't know yet" — the two render with
   * different pills (red `Offline` vs. neutral `Pending first probe`).
   */
  probed?: boolean;
  fetchedAt: string;
  /**
   * Optional non-secret provenance for rows derived from an integration
   * source instead of the Loop probe. Kept advisory so older connector
   * snapshots without it remain valid.
   */
  source?: "native" | "loop" | "composio" | "mixed";
  /**
   * #361 — Loop participation flag. `true` means scheduled ticks actively
   * pull this connector for signals. `false` (or absent for compat) means
   * the connector is authorized for chat/memory but does not contribute to
   * Loop's signal pull — its presence in the connector list does NOT mean
   * Loop is monitoring it.
   */
  loopMonitored?: boolean;
  /**
   * #361 — decision-capable flag. `true` means this connector's payload
   * has a supported classifier mapping (e.g. gmail → rsvp/email_reply,
   * google_calendar → rsvp, github → review_pr). `false` means signals
   * from this source are intentionally dropped with an explicit
   * "unsupported" reason — see `unsupportedSignals` on the tick result.
   */
  decisionCapable?: boolean;
  /**
   * #361 — semantic capability state. Lets the UI render one of:
   * "needs setup" / "connected" / "loop monitored" / "decision capable"
   * without conflating authorization with Loop participation.
   */
  capability?: ConnectorCapability;
  /**
   * #361 — human-readable reason for `capability === "unsupported"`. Never
   * contains credentials, account identifiers, or message content.
   */
  capabilityReason?: string;
}

/**
 * Aggregate capability counts surfaced by the readiness API (#361). Lets a
 * UI label "5 connected, 3 monitored by Loop, 2 decision-capable" without
 * needing to enumerate every connector on the dashboard.
 */
export interface ConnectorCapabilitySummary {
  /** Total connectors visible to the user (built-ins + custom). */
  total: number;
  /** Number with `connected: true`. */
  connected: number;
  /** Number with `loopMonitored: true`. Strict subset of `connected`. */
  loopMonitored: number;
  /** Number with `decisionCapable: true`. Strict subset of `loopMonitored`. */
  decisionCapable: number;
  /** Number of `unsupported` connectors — authorized but no classifier mapping. */
  unsupported: number;
  /** Number of `needs_setup` connectors — connected but not yet wired into Loop. */
  needsSetup: number;
}

export interface LoopState {
  enabled: boolean;
  preferences: LoopPreferences;
  counts: {
    pending: number;
    done: number;
    dismissed: number;
    signals: number;
    /**
     * #361 — signals received this tick whose `source` / `type` did not
     * match any canonical Loop mapping. Surfaced so the UI can tell the
     * user "X signals arrived but no decisions were produced" instead of
     * silently dropping them.
     */
    unsupportedSignals: number;
  };
  /**
   * #516 — when the supervisor check refused the most recent tick,
   * mirror the reason here. UI surfaces this as a banner: "Loop
   * disabled — desktop app supervisor not detected". `null` while a
   * normal supervisor is present OR while no tick has run yet.
   */
  orphanSupervisor?: "stamp_missing" | "stamp_stale" | "stamp_mismatch" | null;
  lastTickAt?: string;
  connectors: ConnectorEntry[];
  /**
   * #361 — aggregate capability counts. Lets the readiness surface label
   * "5 connected, 3 monitored by Loop, 2 decision-capable" without
   * enumerating every connector on the dashboard.
   */
  connectorCapability: ConnectorCapabilitySummary;
}

export interface LoopTickResult {
  scanned: number;
  surfaced: number;
  muted: number;
  newDecisions: LoopDecision[];
  errors: string[];
  /**
   * #361 — signals received this tick whose `source` / `type` had no
   * canonical Loop mapping and were intentionally dropped. Surfaced in
   * `LoopState.counts.unsupportedSignals` and the readiness surface so
   * users aren't left wondering why an authorized integration produced
   * zero decisions.
   */
  unsupportedSignals?: number;
  /**
   * #516 — present (and tick is zero-yield) when the supervisor
   * check in `handleTick` (`lib/loop/parent-watch.ts`) refused to
   * run. Surface in `LoopState` so the UI can render a clear "Loop
   * disabled — supervisor gone" banner instead of silently pretending
   * the tick was a normal no-signal run.
   */
  orphanSupervisor?: "stamp_missing" | "stamp_stale" | "stamp_mismatch";
}

// ---------------------------------------------------------------------------
// Agentic narrative for brief / wrap
// ---------------------------------------------------------------------------
//
// The brief / wrap snapshots are otherwise plain data (items, stats). The
// `narrative` field is the agentic overlay — a short headline + body the agent
// writes, plus generation lifecycle state. Three terminal shapes:
//
//   - undefined  → user opted out (prefs.narrative === false); UI uses the
//                  templated dialogue.
//   - null       → tried but failed; UI silently falls back to template.
//   - { status: "generating", ... } → an agent call is in flight; UI shows
//                  a spinner placeholder, never hangs.
//   - { status: "ready", ... }     → headline + body available.
//
// `input_hash` is sha1(items) (or sha1(highlights) for wrap) — used to detect
// staleness so we can skip a redundant agent call when the underlying queue
// hasn't changed since the last successful generation.

export interface BriefNarrativeReady {
  status: "ready";
  /** ≤ 200 chars after slice; do not start with "Morning:". */
  headline: string;
  /** ≤ 800 chars after slice; plain prose, no markdown. */
  body: string;
  /** ISO timestamp the narrative finished generating. */
  generatedAt: string;
  /** Optional model id for debugging / admin panels. */
  model?: string;
  /** sha1(items) at the time of generation. Detects staleness. */
  input_hash?: string;
}

export interface BriefNarrativeGenerating {
  status: "generating";
  /** ISO timestamp the agent call started. */
  startedAt: string;
  /** sha1(items) the agent was invoked on. */
  input_hash: string;
}

export type BriefNarrative =
  | BriefNarrativeReady
  | BriefNarrativeGenerating
  | null;

export interface WrapNarrativeReady {
  status: "ready";
  headline: string;
  body: string;
  generatedAt: string;
  model?: string;
  input_hash?: string;
}

export interface WrapNarrativeGenerating {
  status: "generating";
  startedAt: string;
  input_hash: string;
}

export type WrapNarrative = WrapNarrativeReady | WrapNarrativeGenerating | null;

// ---------------------------------------------------------------------------
// Brief snapshot — muted bucket shape
// ---------------------------------------------------------------------------
//
// `id` is the originating `LoopDecision.id`. Two muted rows can have the same
// `kind`+`title` (e.g. two `wrap` decisions on the same date, or multiple
// `email_reply` rows for the same thread), so we need a stable identity beyond
// position for React keys and any future "un-mute from the UI" flow.

export interface BriefMuted {
  id: string;
  kind: string;
  title: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Probe error kinds (#391 #412) — moved here from `./connectors.ts` so the
// client-side per-kind callout can import them via `@/lib/loop/client`
// without dragging `node:fs` into the browser bundle. The on-disk shape is
// unchanged — `connectors.ts` just re-imports the types below.
// ---------------------------------------------------------------------------

/**
 * #391 — the kind of failure the last connector probe hit. Mirrors the
 * failure arms of `ProbeOutcome` in `composio-bridge.ts` (timeout is
 * observed here in `refreshConnectors`'s silent race, the rest come
 * from the probe itself).
 *
 * The `cli_*` kinds are emitted by the CLI-direct fast-path
 * (`composio-cli.ts`) when the user's local `composio` binary is
 * installed but can't answer the probe (auth broken, dev project not
 * initialized, output unparseable). They map 1:1 onto the agentic
 * failure arms so the UI can render one unified `lastProbeError`
 * affordance regardless of which surface attempted the probe.
 */
export type ProbeErrorKind =
  | "transport_error"
  | "agent_http_error"
  | "empty_response"
  | "malformed_response"
  | "timeout"
  | "cli_not_found"
  | "cli_unauthorized"
  | "cli_malformed";

/**
 * #391 — persisted diagnostic for the last failed probe. Lives on the
 * connector cache file alongside the (possibly stale) snapshot so the
 * next API read can return both the entries and the reason the probe
 * couldn't refresh them.
 */
export interface ProbeErrorInfo {
  kind: ProbeErrorKind;
  message: string;
  /** ISO timestamp of when the failure was recorded. */
  at: string;
}
