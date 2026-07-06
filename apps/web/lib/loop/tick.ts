/**
 * Loop tick — one pass through the signal → enrich → classify → enqueue
 * pipeline. Two execution modes are supported:
 *
 *   - **agentic** (default): builds the prompt in `tick-prompt.ts` and
 *     POSTs it to `/api/native/agent`. The agent does the full pipeline:
 *     signal pull (Composio MCP / Skill / CLI / openloomi-memory insights
 *     fallback), Obsidian vault scan, memory enrichment, classification,
 *     and decision persistence. Matches the original `loop-daemon.cjs`
 *     "agentic mode" 1:1 — the loop is the prompt, the agent does the work.
 *     Set `LOOP_LEGACY=1` (or pass `mode: "legacy"`) to opt out.
 *
 *   - **legacy**: in-process rules-based classifier + DB-backed enrich.
 *     Fast, deterministic, no LLM cost. Useful for offline / headless /
 *     no-MCP environments and for unit tests that need a stable pipeline.
 *
 * Either path returns a `LoopTickResult` so the caller (cron, CLI, HTTP
 * route) doesn't care which mode ran.
 */

import { classify, isHardSkipped } from "./classify";
import { LOOP_PATHS, ensureDirs, migrate } from "./paths";
import { decisions, log, signals, writeStatus } from "./store";
import { buildTickPrompt } from "./tick-prompt";
import type {
  LoopDecision,
  LoopPreferences,
  LoopSignal,
  LoopTickResult,
} from "./types";
import { DEFAULT_LOOP_PREFERENCES } from "./types";

const TICK_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2h
const TICK_BATCH = 200;

/**
 * The Loop runs as a single-user-per-process pipeline. We mirror the
 * scheduler's `setActiveUser` pattern so callers (cron handlers, the web
 * `/api/loop/tick` route, the CLI) can tell the tick which user it should
 * enrich against without threading a `userId` through every layer.
 */
let activeUserId: string | null = null;

/** Set the user the next `run()` invocation will enrich against. */
export function setActiveUser(userId: string | null): void {
  activeUserId = userId;
}

/** Read the currently-active user. Useful for diagnostics / logging. */
export function getActiveUser(): string | null {
  return activeUserId;
}

function nowMs(): number {
  return Date.now();
}

function sinceIso(ms: number): string {
  return new Date(nowMs() - ms).toISOString();
}

function dedupeKey(sig: LoopSignal): string {
  const p = sig.payload as Record<string, unknown>;
  return String(
    p.messageId ??
      p.eventId ??
      p.ts ??
      p.id ??
      p.path ??
      `${sig.source}:${sig.type}`,
  );
}

function alreadyProcessed(key: string): boolean {
  // O(N) scan — fine for the few-hundred pending decisions scale.
  for (const bucket of ["pending", "done", "dismissed"] as const) {
    for (const dec of decisions.list(bucket)) {
      if (dec.signal_id === key) return true;
      if ((dec.source_signal as { id?: string } | undefined)?.id === key)
        return true;
    }
  }
  return false;
}

export type TickMode = "agentic" | "legacy";

export interface TickOptions {
  /** Override preferences for this tick only. Defaults to DEFAULT_LOOP_PREFERENCES. */
  preferences?: Partial<LoopPreferences>;
  /** Only process signals newer than this. Defaults to 2h back. */
  sinceMs?: number;
  /** Force re-classify of all recent signals (skips dedupe). */
  force?: boolean;
  /** Optional: callers can pre-supply a list of signals (for tests). */
  inputSignals?: LoopSignal[];
  /**
   * Explicit userId for enrichment (contact / project / history lookups).
   * Falls back to the module-level `activeUserId` set via `setActiveUser`
   * (mirrored from scheduler.ts). When neither is set, enrich degrades
   * to a no-op and decisions land with the base 0.6 confidence.
   */
  userId?: string;
  /**
   * Execution mode. Defaults to `"agentic"`; falls back to `"legacy"`
   * when `LOOP_LEGACY=1` is set in the environment. `"agentic"` is
   * gated on the native-agent endpoint being reachable; if the POST
   * fails with a transport-level error we surface it (don't silently
   * fall back — the operator should know).
   */
  mode?: TickMode;
}

/**
 * Run one tick. Returns a structured result with counts and any decisions
 * that were newly enqueued. Errors per-signal are collected, not thrown.
 */
export async function run(opts: TickOptions = {}): Promise<LoopTickResult> {
  const mode: TickMode =
    opts.mode ?? (process.env.LOOP_LEGACY === "1" ? "legacy" : "agentic");
  if (mode === "agentic") return runAgentic(opts);
  return runLegacy(opts);
}

/* -------------------------------------------------------------------------- */
/* Agentic mode — full-pipeline prompt → /api/native/agent                   */
/* -------------------------------------------------------------------------- */

interface AgentTickResultPayload {
  scanned?: number;
  surfaced?: number;
  muted?: number;
  errors?: number;
  duration_ms?: number;
  surfaces_used?: string[];
}

function emptyResult(): LoopTickResult {
  return {
    scanned: 0,
    surfaced: 0,
    muted: 0,
    newDecisions: [],
    errors: [],
  };
}

async function runAgentic(opts: TickOptions): Promise<LoopTickResult> {
  ensureDirs();
  migrate();

  const t0 = Date.now();
  const prompt = buildTickPrompt({
    sinceDays: Math.max(1, Math.ceil((opts.sinceMs ?? TICK_LOOKBACK_MS) / 86_400_000)),
    // Obsidian vault scan lives in the Chronicle subsystem, not the loop —
    // the watcher already consumes its `obsidian_note_changed` signals from
    // signals.jsonl. The original skill's `obsidian-scan.cjs` reference is
    // therefore omitted from the agentic prompt by default.
    includeObsidian: false,
  });

  // Lazy import — runner transitively pulls node:http + auth-token logic
  // that the CLI doesn't need. Mirrors the pattern in tick's legacy path.
  const { invokeAgentPrompt } = await import("./runner");

  log(`tick (agentic): dispatching prompt (${prompt.length} chars) to /api/native/agent`);
  let res;
  try {
    res = await invokeAgentPrompt(prompt, {
      timeoutMs: 15 * 60 * 1000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`tick (agentic) failed: ${msg}`);
    writeStatus({
      lastTickAt: new Date().toISOString(),
      lastError: `agentic tick failed: ${msg}`,
    });
    return {
      ...emptyResult(),
      errors: [msg],
    };
  }

  if (!res.ok) {
    const msg = res.error ?? `HTTP ${res.status ?? "?"}`;
    log(`tick (agentic) native-agent error: ${msg}`);
    writeStatus({
      lastTickAt: new Date().toISOString(),
      lastError: `agentic tick: ${msg}`,
    });
    return {
      ...emptyResult(),
      errors: [msg],
    };
  }

  // The agent emits a structured `result` event at the end of the prompt;
  // pull counts from there when present. Fall back to re-reading the
  // decision store (decisions.json diff vs. before-tick snapshot) so the
  // caller still gets honest numbers even if the agent's result event
  // was missing or malformed.
  const before = snapshotCounts();
  const payload = (res.result ?? {}) as AgentTickResultPayload;
  const scanned = payload.scanned ?? 0;
  const agentSurfaced = payload.surfaced;
  const muted = payload.muted ?? 0;
  const errors = payload.errors ?? 0;
  const surfaces = payload.surfaces_used ?? [];

  let surfaced: number;
  let newDecisions: LoopDecision[] = [];
  if (typeof agentSurfaced !== "number") {
    // Re-derive from disk.
    const after = snapshotCounts();
    surfaced = Math.max(0, after.pending - before.pending);
    newDecisions = pendingAddedSince(before);
  } else {
    surfaced = agentSurfaced;
    // Even when the agent reports the count, surface the freshly-added
    // decisions so the caller can return them.
    newDecisions = pendingAddedSince(before);
  }

  const result: LoopTickResult = {
    scanned,
    surfaced,
    muted,
    newDecisions,
    errors: errors > 0 ? [`agent reported ${errors} per-signal errors`] : [],
  };

  const dur = Date.now() - t0;
  log(
    `tick (agentic) done: scanned=${result.scanned} surfaced=${result.surfaced} muted=${result.muted} errors=${result.errors.length} surfaces=${surfaces.join(",") || "?"} dur=${dur}ms`,
  );
  writeStatus({
    lastTickAt: new Date().toISOString(),
    lastSignalCount: result.scanned,
    lastDecisionCount: result.surfaced,
    ...(result.errors[0] ? { lastError: result.errors[0] } : {}),
  });
  return result;
}

interface CountsSnapshot {
  pending: number;
  done: number;
  dismissed: number;
  pendingIds: Set<string>;
}

function snapshotCounts(): CountsSnapshot {
  const pending = decisions.list("pending");
  return {
    pending: pending.length,
    done: decisions.list("done").length,
    dismissed: decisions.list("dismissed").length,
    pendingIds: new Set(pending.map((d) => d.id)),
  };
}

function pendingAddedSince(before: CountsSnapshot): LoopDecision[] {
  const after = decisions.list("pending");
  return after.filter((d) => !before.pendingIds.has(d.id));
}

/* -------------------------------------------------------------------------- */
/* Legacy mode — rules-based classify + DB enrich (LOOP_LEGACY=1)           */
/* -------------------------------------------------------------------------- */

async function runLegacy(opts: TickOptions): Promise<LoopTickResult> {
  ensureDirs();
  // Lazy migrate on first tick so legacy data shows up before any decision
  // is enqueued. Safe to call repeatedly — no-op after the first run.
  migrate();

  const prefs: LoopPreferences = {
    ...DEFAULT_LOOP_PREFERENCES,
    ...(opts.preferences ?? {}),
  };

  let recent: LoopSignal[];
  if (opts.inputSignals) {
    recent = opts.inputSignals;
  } else {
    recent = signals.list({
      since: sinceIso(opts.sinceMs ?? TICK_LOOKBACK_MS),
      limit: TICK_BATCH,
    });
  }

  const result: LoopTickResult = {
    scanned: 0,
    surfaced: 0,
    muted: 0,
    newDecisions: [],
    errors: [],
  };

  for (const sig of recent) {
    result.scanned += 1;
    try {
      const skip = isHardSkipped(sig, prefs);
      if (skip) {
        result.muted += 1;
        continue;
      }
      const key = dedupeKey(sig);
      if (!opts.force && alreadyProcessed(key)) {
        // Already surfaced — count as muted so the stats are honest.
        result.muted += 1;
        continue;
      }
      const candidate = classify(sig);
      if (!candidate) {
        result.muted += 1;
        continue;
      }
      // Enrich: ask the memory subsystem for the contact, project, and
      // related decisions that match this signal. Best-effort — if the
      // memory call fails the candidate still gets persisted with the
      // base confidence and a single "Source: …" why-line. Lazy-imported
      // because enrich transitively pulls `@/lib/insights/search`, which
      // imports `lib/env/constants` → `server-only` and breaks the CLI
      // when `--userId` is not provided.
      const enrichUserId = opts.userId ?? activeUserId;
      let context: Record<string, unknown> = {
        why: [`Source: ${sig.source}:${sig.type}`],
        memory_refs: [],
      };
      let confidence = 0.6;
      if (enrichUserId) {
        const { enrich, enrichToContext } = await import("./enrich");
        const enriched = await enrich({
          userId: enrichUserId,
          signal: sig,
          candidate,
          baseConfidence: 0.6,
        }).catch((e) => {
          log(`tick enrich error: ${sig.id}: ${(e as Error).message}`);
          return null;
        });
        if (enriched) {
          context = enrichToContext(enriched) as unknown as Record<
            string,
            unknown
          >;
          confidence = enriched.confidence;
        }
      }
      const dec: LoopDecision = decisions.add({
        signal_id: sig.id,
        type: candidate.type,
        title: candidate.title,
        action: candidate.action,
        context: context as LoopDecision["context"],
        confidence,
        source_signal: sig,
        dialogue: candidateDialogue(sig, candidate.type),
        nextStep: candidateNextStep(candidate.type),
      });
      result.newDecisions.push(dec);
      result.surfaced += 1;
      log(`tick (legacy): ${sig.source}:${sig.type} → ${dec.id} (${dec.type})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${sig.id}: ${msg}`);
      log(`tick (legacy) error: ${sig.id}: ${msg}`);
    }
  }

  writeStatus({
    lastTickAt: new Date().toISOString(),
    lastSignalCount: result.scanned,
    lastDecisionCount: result.surfaced,
    ...(result.errors[0] ? { lastError: result.errors[0] } : {}),
  });
  log(
    `tick (legacy) done: scanned=${result.scanned} surfaced=${result.surfaced} muted=${result.muted} errors=${result.errors.length}`,
  );
  return result;
}

function candidateDialogue(sig: LoopSignal, type: string): string {
  switch (type) {
    case "rsvp":
      return "This calendar invite needs a call — want me to reply 'accepted' directly?";
    case "draft_reply":
      return "This email looks like it's waiting on you — should I draft a reply?";
    case "review_pr":
      return "A PR tagged you as reviewer — take a look?";
    case "slack_reply":
      return "Someone @-mentioned you on Slack — want me to grab context first?";
    case "todo":
      return "Drop this into your todo list?";
    case "linear_review":
      return "Linear has an issue waiting for your scope check.";
    case "requirement_synthesis":
      return "This signal could become a new product-requirements draft.";
    default:
      return `New signal (${sig.source}): ${sig.type}`;
  }
}

function candidateNextStep(type: string): string {
  switch (type) {
    case "rsvp":
      return "Tap Dry Run to see the plan, or Run to accept the invite directly.";
    case "draft_reply":
      return "Tap Dry Run to draft a reply, then confirm to send.";
    case "review_pr":
      return "Tap Run to have the agent produce a review checklist.";
    case "slack_reply":
      return "Tap Dry Run to draft a reply, then confirm to send.";
    case "todo":
      return "Tap Run to add it to today's todo.";
    case "linear_review":
      return "Tap Run to have the agent do a scope check.";
    case "requirement_synthesis":
      return "Tap Run to draft a PR / FAQ.";
    default:
      return "Tap Run to let the agent handle it.";
  }
}

export { LOOP_PATHS };
