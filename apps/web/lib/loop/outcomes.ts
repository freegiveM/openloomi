/**
 * Loop execution outcomes (#358) — pure helpers that parse the agent's
 * SSE response into a structured verdict.
 *
 * The bug we're fixing: the loop runner used to move a decision to `done`
 * whenever the HTTP call to `/api/native/agent` returned 200, regardless of
 * whether the agent actually performed an external action. That conflated
 * "transport + model completed" with "the user-visible action happened".
 * A user who picked "accept this RSVP" got a card labelled "Ran at <ts>"
 * even when the agent's text said "I didn't execute" and no Calendar
 * mutation happened.
 *
 * The agent is asked (via `buildPrompt`) to end its response with a single
 * SSE `result` event whose `content` is JSON of the shape
 *   { outcome: "executed"|"skipped"|"blocked"|"failed",
 *     reason: "...",
 *     evidence: { eventId, messageId, ... } }
 *
 * `parseExecutionOutcome` consumes that payload (when present) and falls
 * back to heuristics over the streamed text + event list when it isn't.
 * Pure functions so the dry-run path and the tests can both reuse them.
 */

import type { ExecutionOutcome, LoopDecisionExecution } from "./types";

// ---------------------------------------------------------------------------
// Tool-call event detection (#358)
// ---------------------------------------------------------------------------
//
// Multiple runtime event types mean "a tool was invoked" — Anthropic emits
// `tool_use`, OpenAI emits `tool_calls`, the OpenLoomi SSE bridge emits
// `tool_call`. Tally them all so a refusal heuristic that needs "no external
// tool happened" sees the right answer regardless of upstream.

const TOOL_EVENT_TYPES = new Set([
  "tool_call",
  "tool_use",
  "tool_calls",
  "function_call",
]);

/**
 * True if the SSE event stream contains any event whose `type` is one of the
 * recognised "an external tool was invoked" markers. Exported for tests so
 * they can assert the heuristic without re-implementing the type list.
 */
export function hasToolCallEvents(events: unknown[]): boolean {
  if (!Array.isArray(events)) return false;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const t = (e as { type?: unknown }).type;
    if (typeof t === "string" && TOOL_EVENT_TYPES.has(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Refusal heuristic (#358)
// ---------------------------------------------------------------------------
//
// Used as a fallback when the structured `result` payload doesn't carry an
// `outcome`. We deliberately use a wide net — false positives lean
// `skipped`, not `executed`, because that's the safer direction: claiming an
// external write that didn't happen is the bug we're fixing.

const REFUSAL_PATTERNS: RegExp[] = [
  /\bi\s+(can'?t|cannot|won'?t|will\s+not|am\s+unable\s+to)\b/i,
  /\bnot\s+able\s+to\b/i,
  /\bunable\s+to\s+(execute|perform|complete|do)\b/i,
  /\bi'?m\s+skipping\b/i,
  /\bskipping\s+(this|that|the)\b/i,
  /\bnot\s+actionable\b/i,
  /\bno\s+action\s+(needed|required|possible)\b/i,
  /\brequires?\s+(user|your)\s+(consent|approval|confirmation)\b/i,
  /\bwithout\s+(user|your)\s+(consent|approval|confirmation)\b/i,
  /\bwould\s+need\s+(user|your)\s+(consent|approval|confirmation)\b/i,
  /\bcan'?t\s+proceed\s+without\b/i,
  /\bi\s+didn'?t\s+(execute|perform|do|send|accept|complete)\b/i,
  /\bnot\s+executed\b/i,
  /\bno\s+external\s+(action|side[\s-]effect)\b/i,
];

export function isRefusalText(text: string): boolean {
  if (!text) return false;
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Failure-pattern heuristic (#358)
// ---------------------------------------------------------------------------
//
// Counterpart to `isRefusalText`. When the agent's narrative reports a
// connector error (401, network failure, OAuth expiry, …) we want to
// surface it as `failed` (stays in pending so the user can retry) instead
// of falling through to the `skipped / no external action performed`
// default. Kept narrow so it doesn't false-positive on benign phrases
// like "the plan failed to mention…".

const FAILURE_PATTERNS: RegExp[] = [
  /\b(?:http|api)\s*[-_]?\s*(?:401|403|404|429|500|502|503|504)\b/i,
  /\b401\s+unauthorized\b/i,
  /\b403\s+forbidden\b/i,
  /\bunauthorized\b.*\breconnect\b/i,
  /\breconnect\s+(?:google|slack|github|gmail|notion|calendar)\b/i,
  /\b(?:oauth|token)\s+(?:expired|invalid|missing)\b/i,
  /\b(?:rate[\s-]?limit(ed)?\b|too\s+many\s+requests)\b/i,
  /\bnetwork\s+(?:error|failure)\b/i,
  /\bconnection\s+(?:refused|reset|timeout)\b/i,
  /^\s*failed\s*:/i,
  /\bfailed\s+to\s+(?:send|create|update|execute|complete|connect)\b/i,
  /\bcould\s+not\s+(?:send|create|update|execute|complete|connect)\b/i,
  /\bexception\s+(?:thrown|caught)\b/i,
];

export function isFailureText(text: string): boolean {
  if (!text) return false;
  for (const re of FAILURE_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Outcome parser
// ---------------------------------------------------------------------------

/**
 * Coerce an unknown `result` payload into a partial execution. Returns
 * `null` when nothing recognisable is present — callers fall through to
 * the heuristic + final-default branches.
 */
function readStructuredOutcome(result: unknown): {
  outcome: ExecutionOutcome;
  reason?: string;
  evidence?: LoopDecisionExecution["evidence"];
} | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const raw = r.outcome ?? r.status ?? r.verdict;
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (
    lower !== "executed" &&
    lower !== "skipped" &&
    lower !== "blocked" &&
    lower !== "failed"
  ) {
    return null;
  }
  const reason = typeof r.reason === "string" ? r.reason : undefined;
  const evidence =
    r.evidence && typeof r.evidence === "object"
      ? (r.evidence as LoopDecisionExecution["evidence"])
      : undefined;
  return {
    outcome: lower as ExecutionOutcome,
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

/** ISO timestamp used for `evaluatedAt`. Exposed for test injection. */
function evaluatedAt(): string {
  return new Date().toISOString();
}

/**
 * Parse the agent's SSE response into a structured execution outcome.
 *
 * Order of precedence:
 *   1. Structured `{outcome, reason?, evidence?}` in the `result` payload.
 *   2. Refusal heuristic over the streamed text → `skipped`.
 *   3. Failure heuristic over the streamed text → `failed` (e.g. 401,
 *      OAuth expired, connector down). Comes BEFORE the no-events
 *      fallback so an error narrative always wins over "no tools fired".
 *   4. No tool events AND positive text → `skipped` ("no external action
 *      performed"). An agent that produced prose but no tool calls
 *      effectively did nothing — but text exists so we can describe why.
 *   5. Final fallback (no text, no events) → `failed` ("agent returned no
 *      verifiable outcome"). All-empty input means we cannot conclude
 *      anything went right; the safer default is "failed" so the user
 *      sees a retryable pending decision instead of a false success.
 *
 * Pure function — same inputs always produce the same verdict, which is
 * what the regression test in `execution-outcomes.test.ts` asserts.
 */
export function parseExecutionOutcome(
  result: unknown,
  text: string,
  events: unknown[],
): LoopDecisionExecution {
  const structured = readStructuredOutcome(result);
  if (structured) {
    return {
      ...structured,
      evaluatedAt: evaluatedAt(),
    };
  }
  if (isRefusalText(text)) {
    return {
      outcome: "skipped",
      reason: (text || "").trim().slice(0, 280) || "agent declined to execute",
      evaluatedAt: evaluatedAt(),
    };
  }
  if (isFailureText(text)) {
    return {
      outcome: "failed",
      reason: (text || "").trim().slice(0, 280) || "agent reported a failure",
      evaluatedAt: evaluatedAt(),
    };
  }
  if (!hasToolCallEvents(events) && text && text.trim().length > 0) {
    return {
      outcome: "skipped",
      reason: "no external action performed",
      evaluatedAt: evaluatedAt(),
    };
  }
  return {
    outcome: "failed",
    reason: "agent returned no verifiable outcome",
    evaluatedAt: evaluatedAt(),
  };
}
