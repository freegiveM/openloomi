/**
 * Loop runner — execute a pending decision by POSTing to the main app's
 * native agent endpoint.
 *
 * POSTs to `/api/native/agent` with `{ prompt }` and parses the SSE
 * response. Reuses the same endpoint the locomo benchmark uses — full
 * agentic tool-use, memory writes, multi-round reasoning.
 *
 * The actual SSE parsing happens inside `/api/native/agent/route.ts`. From
 * the runner's perspective we just POST a prompt, wait for the result event
 * in the SSE stream, and return the final result. The decision is moved to
 * `done` (or stays `pending` on failure) and the result is attached.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEV_PORT, PROD_PORT } from "@openloomi/shared";

import {
  decisions,
  log,
  MUTABLE_DECISION_TYPES,
  muteKeyFor,
  mutes,
} from "./store";
import { deriveReadiness } from "./readiness";
import { parseExecutionOutcome } from "./outcomes";
import type {
  ExecutionOutcome,
  LoopDecision,
  LoopDecisionExecution,
} from "./types";

/**
 * Resolve the URL of the native agent endpoint.
 *
 * The Loop runs *inside* the Next.js process that also serves
 * `/api/native/agent` — so the agent is always on the same host:port as
 * the Next.js dev/release server itself. Port comes from `@openloomi/shared`
 * (`DEV_PORT` / `PROD_PORT`) so we stay in sync with the rest of the app.
 * `LOOP_NATIVE_AGENT_URL` stays as the escape hatch for split-host setups
 * (e.g. agent behind a reverse proxy on another machine).
 */
function resolveNativeAgentUrl(): string {
  if (process.env.LOOP_NATIVE_AGENT_URL) {
    return process.env.LOOP_NATIVE_AGENT_URL.replace(/\/+$/, "");
  }
  const port =
    process.env.PORT ||
    (process.env.NODE_ENV === "development" ? DEV_PORT : PROD_PORT);
  return `http://127.0.0.1:${port}/api/native/agent`;
}

function readToken(): string | null {
  try {
    const p = join(homedir(), ".openloomi", "token");
    if (!existsSync(p)) return null;
    const encoded = readFileSync(p, "utf8").trim();
    return Buffer.from(encoded, "base64").toString("utf8") || null;
  } catch {
    return null;
  }
}

interface NativeAgentResponse {
  ok: boolean;
  status?: number;
  text?: string;
  reasoning?: string;
  result?: unknown;
  events?: unknown[];
  error?: string;
}

export interface SseEvent {
  type?: string;
  content?: unknown;
}

export interface InvokeAgentOptions {
  timeoutMs?: number;
  onEvent?: (e: SseEvent) => void;
}

/**
 * Public agent-entry point used by the loop's tick. Resolves the
 * native-agent URL (env override → default) and POSTs the prompt as
 * `{ prompt }`. Returns the parsed SSE response — caller can read
 * `result` for a structured payload (when the agent emits a `result` event)
 * or fall back to `text` / `events` for streaming output.
 */
export async function invokeAgentPrompt(
  prompt: string,
  opts: InvokeAgentOptions = {},
): Promise<NativeAgentResponse> {
  const url = resolveNativeAgentUrl();
  return postNativeAgent(url, { prompt }, opts);
}

async function postNativeAgent(
  urlStr: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; onEvent?: (e: SseEvent) => void } = {},
): Promise<NativeAgentResponse> {
  const token = readToken();
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: `bad url ${urlStr}` };
  }
  return new Promise((resolve) => {
    const req = fetch(parsed, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15 * 60 * 1000),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          resolve({
            ok: false,
            status: res.status,
            error: text || `HTTP ${res.status}`,
          });
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          resolve({ ok: false, status: res.status, error: "no response body" });
          return;
        }
        const decoder = new TextDecoder();
        let buf = "";
        const textChunks: string[] = [];
        const reasoningChunks: string[] = [];
        // #358 — capture every parsed SSE event so the runner's outcome
        // parser can ask "did any tool call happen?" after the stream
        // closes. Without this the heuristic always sees `events: []` and
        // would default to `skipped / no external action performed` even
        // when the agent did emit a tool_call event earlier.
        const events: unknown[] = [];
        let result: unknown = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (payload) {
                try {
                  const evt = JSON.parse(payload) as SseEvent;
                  events.push(evt);
                  opts.onEvent?.(evt);
                  if (evt.type === "text" && typeof evt.content === "string") {
                    textChunks.push(evt.content);
                  } else if (
                    evt.type === "reasoning" &&
                    typeof evt.content === "string"
                  ) {
                    reasoningChunks.push(evt.content);
                  } else if (evt.type === "result" && evt.content) {
                    result = evt.content;
                  }
                } catch {
                  /* skip malformed */
                }
              }
            }
            nl = buf.indexOf("\n");
          }
        }
        resolve({
          ok: true,
          status: res.status,
          text: textChunks.join(""),
          reasoning: reasoningChunks.join(""),
          result,
          events,
        });
      })
      .catch((err: Error) => resolve({ ok: false, error: err.message }));
  });
}

function buildPrompt(decision: LoopDecision, mode: "dry" | "run"): string {
  const verb = mode === "dry" ? "Simulate executing" : "Execute";
  const parts: string[] = [];
  parts.push(
    `${verb} this OpenLoomi Loop decision and produce a concrete, plain-text summary of what you did (or would do).`,
    "",
    "Decision:",
    JSON.stringify(
      {
        id: decision.id,
        type: decision.type,
        title: decision.title,
        action: decision.action,
        context: decision.context ?? null,
        signal: decision.source_signal ?? null,
      },
      null,
      2,
    ),
  );
  if (Array.isArray(decision.context?.why) && decision.context.why.length) {
    parts.push("", "Why:", ...decision.context.why.map((w) => `- ${w}`));
  }
  // #358 — final instruction. The runner uses this SSE `result` event to
  // decide whether the user-visible action actually happened. A clean HTTP
  // 200 from the agent is not enough — the verdict MUST reflect the
  // external side-effect (or explicit lack of one). `pure_reasoning`
  // decisions (brief / wrap / todo prose) still emit `executed` so the
  // `done` bucket counts them; refusing without a reason is `skipped`;
  // connector errors are `failed`.
  parts.push(
    "",
    "End with a single SSE `result` event whose `content` is JSON of this exact shape:",
    '  {"outcome":"executed"|"skipped"|"blocked"|"failed","reason":"...","evidence":{...}}',
    "- `executed` — the external side-effect happened (calendar event created, email sent, PR reviewed, etc.). Include connector-specific evidence ids in `evidence` (eventId, messageId, reviewId, toolCallId).",
    "- `skipped` — the agent deliberately chose not to act (missing consent, not actionable, you-just-wrote-prose). Provide a short `reason`.",
    "- `blocked` — execution was prevented by a precondition the agent couldn't satisfy (auth, rate limit). Provide a short `reason` so the user can fix it.",
    "- `failed` — the agent tried but hit an error (connector 401, network). Provide a short `reason`.",
    "Plain-text reasoning should still be emitted (as `text` events) — the system records it alongside the verdict.",
  );
  if (decision.action?.kind === "deadline_notify") {
    parts.push(
      "",
      'How to execute action.kind === "deadline_notify":',
      "- Default behavior: create a calendar event on the googlecalendar toolkit via composio",
      "  (skill: `Skill composio execute GOOGLECALENDAR_CREATE_EVENT on googlecalendar with {...}`",
      "   or CLI: `composio googlecalendar create_event --json {...}` — pick whichever is on $PATH).",
      '  Title: "Deadline: <params.message>". Start: `params.notifyAt`. End: `params.deadlineAt` (or all-day on `params.deadlineAt`\'s date).',
      '- If `params.channel === "slack"`, send a DM to the user instead via the slack toolkit',
      "  (skill: `Skill composio execute SLACK_SEND_MESSAGE on slack with {...}`",
      '   or CLI: `composio slack send_message --json {...}`) with text "<params.message> — due <params.deadlineAt>".',
      '- Emit a single SSE `result` event whose `content` is JSON `{"outcome":"executed","reason":"...","evidence":{"eventId":"..."}}` so the system records the calendar event id. If you cannot execute, emit `{"outcome":"skipped","reason":"..."}` instead.',
    );
  }
  // #363 — when the user has already chosen their RSVP response
  // (Attend / Decline), `action.params.response` is set and the agent
  // must honour it instead of asking again or rewriting it.
  if (
    decision.type === "rsvp" &&
    decision.action?.params &&
    typeof (decision.action.params as Record<string, unknown>).response ===
      "string"
  ) {
    const r = (decision.action.params as Record<string, unknown>).response;
    parts.push(
      "",
      "User has already chosen the RSVP response.",
      `- params.response is set by the user via Attend / Decline to "${r}". Do not change it.`,
      "- Execute the calendar_rsvp action with this response and emit a single SSE `result` event whose `content` is JSON",
      '  {"outcome":"executed","reason":"...","evidence":{"eventId":"..."}}',
      '- If you cannot execute (auth, network), emit `{"outcome":"blocked"|"failed","reason":"..."}` instead so the card can retry.',
    );
  }
  // If the user edited the draft inline (via the pet card's #dec-editor
  // + PATCH /api/loop/decision/:id) the edited subject/body lives at
  // `context.draft`. Inject it verbatim and tell the agent not to
  // re-draft. Without this block the agent would call the LLM again and
  // overwrite the user's edits before sending. Falls back to the
  // action.params.subject for the subject line so the body section
  // below can stand on its own if the editor only filled the body.
  if (decision.action?.kind === "email_reply" && decision.context?.draft) {
    const d = decision.context.draft as {
      subject?: string | null;
      body?: string;
    };
    const subject =
      typeof d.subject === "string" && d.subject.length > 0
        ? d.subject
        : (decision.action.params?.subject as string | undefined) ||
          "(no subject)";
    parts.push(
      "",
      "User-edited draft — use this subject and body verbatim, do NOT redraft:",
      `Subject: ${subject}`,
      "",
      d.body ?? "",
    );
  }
  // IM reply (Telegram / Feishu / Lark / WeChat / QQ / DingTalk) has no
  // subject line — inject only the body verbatim so the agent sends the
  // user's edited message unchanged instead of re-drafting via the LLM.
  if (decision.action?.kind === "im_reply" && decision.context?.draft) {
    const d = decision.context.draft as {
      subject?: string | null;
      body?: string;
    };
    parts.push(
      "",
      "User-edited draft — send this body verbatim, do NOT redraft:",
      "",
      d.body ?? "",
    );
  }
  if (mode === "dry") {
    parts.push(
      "",
      "Dry run — DO NOT make any external side effects (no sending emails, accepting invites, etc.). Just describe the plan and any drafts.",
    );
  }
  return parts.join("\n");
}

export interface RunOptions {
  dry?: boolean;
  onEvent?: (e: SseEvent) => void;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  status: "done" | "dismissed" | "pending";
  decision: LoopDecision | null;
  result?: unknown;
  error?: string;
  /**
   * #358 — structured execution verdict for the action API + UI. Present
   * for `run` and `dry` paths; absent for dismiss / promote because they
   * don't execute anything. Persisted on the decision via `decisions.moveTo`
   * / `decisions.update` and re-exposed to the caller so the web UI can
   * render the verdict without re-reading the decision.
   */
  execution?: LoopDecisionExecution;
}

/**
 * Execute (or dry-run) a decision.
 *  - dry=true  → agent returns a plan only; decision stays `pending`
 *  - dry=false → agent runs; on success the decision is moved to `done`,
 *                on failure it stays `pending` with an attached error
 */
export async function runDecision(
  id: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const dec = decisions.get(id);
  if (!dec)
    return { ok: false, status: "pending", decision: null, error: "not found" };
  if (dec.status !== "pending") {
    return {
      ok: false,
      status: dec.status,
      decision: dec,
      error: `not pending (${dec.status})`,
    };
  }

  // #359 — readiness is an execution gate. A `not_actionable` decision (e.g.
  // an event you own with no other guests) must never perform an external
  // write. Dry runs stay allowed so the user can still inspect the plan.
  if (!opts.dry) {
    const readiness = deriveReadiness(dec);
    if (readiness.status === "not_actionable") {
      log(`run ${dec.id} blocked: not_actionable`);
      return {
        ok: false,
        status: "pending",
        decision: dec,
        error: "not_actionable: no action needed for this decision",
      };
    }
  }

  const url = resolveNativeAgentUrl();
  const prompt = buildPrompt(dec, opts.dry ? "dry" : "run");
  log(`run ${dec.id} dry=${!!opts.dry}`);

  const res = await postNativeAgent(
    url,
    { prompt },
    { onEvent: opts.onEvent, timeoutMs: opts.timeoutMs },
  );
  if (!res.ok) {
    decisions.update(dec.id, {
      context: { ...(dec.context ?? {}), last_error: res.error },
    });
    log(`run ${dec.id} failed: ${res.error ?? "unknown"}`);
    return { ok: false, status: "pending", decision: dec, error: res.error };
  }

  if (opts.dry) {
    decisions.update(dec.id, {
      context: {
        ...(dec.context ?? {}),
        dry_run: res.text || JSON.stringify(res.result ?? null),
      },
    });
    return { ok: true, status: "pending", decision: dec, result: res.result };
  }

  // #358 — parse the agent's verdict. The transport completed, but the
  // user-visible action may not have. Switching on `execution.outcome` lets
  // us (a) keep blocked/failed decisions in `pending` so the user can
  // retry, (b) move executed/skipped into `done` with the verdict attached,
  // and (c) populate `last_error` for blocked/failed so the UI can render a
  // "Last attempt failed: <reason>" banner without re-reading the decision.
  const execution = parseExecutionOutcome(
    res.result,
    res.text ?? "",
    Array.isArray(res.events) ? res.events : [],
  );
  const outcome: ExecutionOutcome = execution.outcome;

  if (outcome === "executed" || outcome === "skipped") {
    // Persist the structured verdict onto the decision and move it to
    // `done`. `moveTo` takes a `result` payload — pass the structured
    // execution so on-disk records carry the evidence forward. The
    // execution field is also exposed via `decision.execution` for
    // downstream surfaces that want richer rendering than `result`.
    const moved = decisions.moveTo(dec.id, "done", {
      execution,
      // Keep the agent's plain-text summary as `result` so the existing
      // Result panel keeps working without a special case.
      summary: res.text ?? null,
      outcome,
      ...(res.result &&
      typeof res.result === "object" &&
      !("summary" in (res.result as Record<string, unknown>))
        ? { agentPayload: res.result }
        : {}),
    });
    // Stamp `execution` on the moved record too — `moveTo`'s `result`
    // payload is the canonical field, but `decision.execution` is what the
    // web UI keys on. The store layer merges via `{...d[src][idx], ...}`,
    // so a follow-up update is the safest way to attach a new top-level
    // field without rewriting the bucket layout.
    const withExecution = decisions.update(dec.id, { execution });
    log(`run ${dec.id} → done (${outcome})`);
    return {
      ok: true,
      status: "done",
      decision: withExecution ?? moved,
      result: res.result,
      execution,
    };
  }

  // blocked / failed — keep the decision in `pending` so the user can
  // retry. Store the verdict + `last_error` so the existing banner picks
  // up the structured reason on the next render.
  const blockedCtx = {
    ...(dec.context ?? {}),
    last_error: execution.reason ?? `Last attempt ${outcome}.`,
  };
  decisions.update(dec.id, { context: blockedCtx, execution });
  log(
    `run ${dec.id} → pending (${outcome}: ${execution.reason ?? "no reason"})`,
  );
  return {
    ok: false,
    status: "pending",
    decision: decisions.get(dec.id) ?? dec,
    error: execution.reason ?? `agent returned outcome=${outcome}`,
    execution,
  };
}

export async function dismissDecision(
  id: string,
  reason?: string,
): Promise<RunResult> {
  const dec = decisions.get(id);
  if (!dec)
    return { ok: false, status: "pending", decision: null, error: "not found" };
  const moved = decisions.moveTo(dec.id, "dismissed", reason ?? null);
  log(`dismiss ${dec.id}${reason ? `: ${reason}` : ""}`);
  // Best-effort: write a persistent mute rule so the same kind of signal
  // does not re-surface on the next tick. Failures are swallowed — the
  // dismiss has already succeeded, and a recurring mute must never roll
  // back a user action.
  recordMuteOnDismiss(dec.id);
  return { ok: true, status: "dismissed", decision: moved };
}

/**
 * Persist a mute rule from the dismissed decision's source signal. Called
 * from both `dismissDecision` (cron path via `handleAction`) and
 * `applyDecisionAction::case "dismiss"` (web dashboard path) so every
 * dismiss — pet card, web UI, programmatic — funnels through the same
 * write. Idempotent: re-dismissing the same decision is a no-op because
 * `mutes.add` checks the key.
 */
export function recordMuteOnDismiss(decisionId: string): void {
  try {
    const dec = decisions.get(decisionId);
    if (!dec) return;
    if (!MUTABLE_DECISION_TYPES.has(dec.type)) return;
    if (!dec.source_signal) return;
    const mk = muteKeyFor(dec.source_signal);
    if (!mk) return;
    mutes.add({
      key: mk.key,
      scope: mk.scope,
      source: {
        decisionId,
        ...(dec.source_signal.type
          ? { signalType: dec.source_signal.type }
          : {}),
      },
    });
  } catch (e) {
    log(
      `[runner] mute write failed for ${decisionId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export async function promoteDecision(id: string): Promise<RunResult> {
  // Re-queue a dismissed decision. Used when a user changes their mind.
  const dec = decisions.get(id);
  if (!dec)
    return { ok: false, status: "pending", decision: null, error: "not found" };
  if (dec.status !== "dismissed") {
    return {
      ok: false,
      status: dec.status,
      decision: dec,
      error: "not dismissed",
    };
  }
  const next = decisions.update(dec.id, {
    status: "pending",
    completed_at: undefined,
  });
  // moveTo back to pending: easiest path is a direct write — update() doesn't
  // move buckets, so we re-issue moveTo from dismissed → pending.
  const moved = decisions.moveTo(dec.id, "pending");
  log(`promote ${dec.id} → pending`);
  return { ok: true, status: "pending", decision: moved ?? next };
}

/**
 * #363 / #364 — RSVP-specific run path. Pre-sets `action.params.response`
 * to the user's intent (`"accepted"` / `"declined"` / `"tentative"`),
 * persists the mutation so the on-disk record carries the user's
 * choice, then delegates to `runDecision` for the agent + verdict
 * pipeline (#358). The runner refuses on non-RSVP decisions and on
 * non-pending decisions so a card in `done` / `dismissed` never silently
 * re-executes.
 *
 * `tentative` was added in the #364 follow-up so the floating pet
 * card's `rsvp_maybe` verb can route through the same RSVP-specific
 * runner. Without it the Maybe button would have to fall back to the
 * generic `runDecision` path, which leaves `action.params.response`
 * unset and lets the prompt re-ask the user mid-flow. `buildPrompt`
 * only reads `params.response` as a string (line ~254), so the new
 * variant works end-to-end without touching the prompt template.
 */
export async function runDecisionWithRsvpResponse(
  id: string,
  response: "accepted" | "declined" | "tentative",
): Promise<RunResult> {
  const dec = decisions.get(id);
  if (!dec)
    return { ok: false, status: "pending", decision: null, error: "not found" };
  if (dec.type !== "rsvp") {
    return {
      ok: false,
      status: dec.status,
      decision: dec,
      error: `rsvp action on non-rsvp decision (${dec.type})`,
    };
  }
  if (dec.status !== "pending") {
    return {
      ok: false,
      status: dec.status,
      decision: dec,
      error: `not pending (${dec.status})`,
    };
  }
  // #363 — overwrite the response param via the same immutable update
  // helper the inline editor uses, so the audit trail reflects the user's
  // exact intent at the moment they tapped Attend / Decline / Maybe.
  const existingParams =
    dec.action && typeof dec.action.params === "object" && dec.action.params
      ? dec.action.params
      : {};
  decisions.update(dec.id, {
    action: {
      ...dec.action,
      params: { ...existingParams, response },
    },
  });
  return runDecision(dec.id);
}

/**
 * #358 — re-queue a `done` decision so the user can retry after a skipped
 * or failed execution. Mirrors `promoteDecision` for dismissed rows but
 * also clears the structured `execution` field so the card re-renders as a
 * fresh pending card (no stale "Ran at <ts>" footer). Idempotent.
 */
export async function resurrectDecision(id: string): Promise<RunResult> {
  const dec = decisions.get(id);
  if (!dec)
    return { ok: false, status: "pending", decision: null, error: "not found" };
  if (dec.status !== "done") {
    return {
      ok: false,
      status: dec.status,
      decision: dec,
      error: "not done",
    };
  }
  // Clear execution + completed_at before the move so the pending card has
  // a clean shape. `decisions.update` is fine in the current bucket; the
  // moveTo below takes the cleaned record with it.
  decisions.update(dec.id, {
    completed_at: undefined,
    execution: undefined,
  });
  const moved = decisions.moveTo(dec.id, "pending");
  log(`resurrect ${dec.id} → pending`);
  return { ok: true, status: "pending", decision: moved };
}
