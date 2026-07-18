/**
 * Loop evening wrap — generates a once-a-day snapshot of "what got done today"
 * and enqueues it as a `type:"wrap"` decision card.
 *
 * Output shape (persisted to ~/.openloomi/loop/wrap.json):
 *   {
 *     date: "2026-07-06",
 *     generatedAt: "<ISO>",
 *     stats: {
 *       done: number, dismissed: number, stillPending: number,
 *       // #362 — explicit scope labels so the UI can render "0 decisions
 *       // resolved today" without claiming "nothing got done".
 *       scope: "loop_decisions",
 *     },
 *     highlights: [
 *       { id, title, type, completedAt, resultKind },
 *       ...
 *     ],
 *     evidence?: {  // #362 — optional Chronicle/observed-activity counter.
 *       chronicleScreenshots: number,
 *       chronicleInsights: number,
 *       notes: string,
 *     },
 *     narrative?: WrapNarrative  // optional agentic overlay (see types.ts)
 *   }
 *
 * Narrative generation mirrors brief.ts: buildAndEnqueue writes a
 * "generating" placeholder synchronously, enqueues the card, and kicks
 * off a fire-and-forget agent call that patches both the snapshot and
 * the decision card on completion.
 *
 * #362 — Wrap's `done`/`dismissed`/`stillPending` are derived from Loop
 * decision cards. They do NOT represent "the user's total daily output".
 * The UI must therefore scope the wording — the empty state never says
 * "nothing got done today" and the headline never says "you finished N
 * tasks". See `computeWrapDialogue()` for the scope-aware copy.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LOOP_PATHS } from "./paths";
import { readPreferences } from "./preferences";
import { invokeAgentPrompt } from "./runner";
import { decisions, log } from "./store";
import { runQuietDayModule } from "./quiet-modules";
import type { LoopDecision, WrapNarrative } from "./types";

const WRAP_PATH = LOOP_PATHS.wrap;
const HIGHLIGHTS_CAP = 8;

/** 20-minute hard ceiling — mirrors brief.ts. */
const NARRATIVE_TIMEOUT_MS = 20 * 60 * 1000;

export interface WrapHighlight {
  id: string;
  title: string;
  type: string;
  completedAt: string;
  resultKind: string;
}

export interface WrapEvidence {
  /**
   * Number of Chronicle screen captures that landed today. Read from the
   * openloomi-memory insights feed so the wrap can acknowledge observed
   * activity without conflating it with verified completion.
   */
  chronicleScreenshots: number;
  /**
   * Number of memory insights recorded today (chats, screen-memory, etc.).
   * Like screenshots, these are *observed*, not *completed*. Surfaced so
   * the wrap can say "X things captured" without claiming they were done.
   */
  chronicleInsights: number;
  /**
   * Source description for diagnostics — never includes message content
   * or account identifiers. Mirrors #361's "no credentials, no message
   * content" rule for the readiness surface.
   */
  notes: string;
}

export interface WrapSnapshot {
  date: string;
  generatedAt: string;
  stats: {
    done: number;
    dismissed: number;
    stillPending: number;
    /**
     * #362 — explicit scope tag. Always `"loop_decisions"` for the stats
     * derived from `decisions.json`. Lets the UI render the counts with
     * accurate scope labels ("Loop decisions resolved today", never
     * "you finished N things today"). Forward-compat: future sources
     * (Chronicle, custom types) may add their own scope tags without
     * breaking existing readers.
     */
    scope: "loop_decisions";
  };
  highlights: WrapHighlight[];
  /**
   * #362 — optional evidence summary. Captures observed-but-not-verified
   * activity (Chronicle screen captures, memory insights). Surfaced
   * alongside the decision stats so a user with zero Loop decisions but
   * a busy day sees "0 decisions resolved · 12 things captured". Never
   * silently treated as completed work.
   */
  evidence?: WrapEvidence;
  /**
   * Optional agentic narrative. `undefined` when prefs.narrative is false;
   * `null` when generation was attempted and failed; `{status: "generating"|
   * "ready", ...}` otherwise.
   */
  narrative?: WrapNarrative;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// #362 — Chronicle evidence lookup
// ---------------------------------------------------------------------------
//
// Reads the openloomi-memory insights feed for today so the wrap can
// acknowledge observed-but-not-verified activity alongside the Loop
// decision stats. The wrapper script is the only thing that knows where
// the feed lives on disk; we shell out to it because the insights store
// is owned by the memory subsystem, not the loop. Never includes
// message content or account identifiers — only counts.
//
// Errors are swallowed: a missing / broken memory subsystem must not
// block the wrap. The wrap falls back to "no observed activity" instead
// of failing the snapshot.
async function readChronicleEvidence(date: string): Promise<WrapEvidence> {
  try {
    const { spawnSync } = await import("node:child_process");
    const memoryDir = process.env.OPENLOOMI_MEMORY_DIR;
    if (!memoryDir) return emptyEvidence("memory dir not configured");
    const script = `${memoryDir.replace(/\/+$/, "")}/scripts/openloomi-memory.cjs`;
    const res = spawnSync(
      "node",
      [script, "list-insights", "--days=1", "--limit=200", "--json"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (res.status !== 0 || !res.stdout) {
      return emptyEvidence(`memory script exited ${res.status ?? "?"}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return emptyEvidence("memory script returned non-JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      return emptyEvidence("memory script returned no data");
    }
    // openloomi-memory.cjs list-insights --json returns `{ items: [...] }`
    // (NOT `{ insights: [...] }`). Each item's timestamp is `time`
    // (ISO, e.g. "2026-07-18T17:40:39.000Z") and the chronicle-screen
    // marker is `taskLabel: "chronicle_screen"` plus a `categories`
    // array containing "chronicle" / "screen-memory" (there is no
    // `origin` field). Match all three so the existing
    // `chronicleScreenshots` counter only ticks on actual screens.
    const items = (parsed as { items?: unknown[] }).items;
    if (!Array.isArray(items)) return emptyEvidence("no insights array");
    let chronicleScreenshots = 0;
    let chronicleInsights = 0;
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const it = raw as Record<string, unknown>;
      const ts = typeof it.time === "string" ? it.time : "";
      if (!ts.startsWith(date)) continue;
      const taskLabel = typeof it.taskLabel === "string" ? it.taskLabel : "";
      const categories = Array.isArray(it.categories)
        ? (it.categories as unknown[]).filter(
            (c): c is string => typeof c === "string",
          )
        : [];
      const detailKind =
        Array.isArray(it.details) &&
        it.details[0] &&
        typeof it.details[0] === "object"
          ? ((it.details[0] as Record<string, unknown>).kind as unknown)
          : undefined;
      const isChronicleScreen =
        taskLabel === "chronicle_screen" ||
        detailKind === "chronicle_screen" ||
        categories.includes("chronicle") ||
        categories.includes("screen-memory");
      if (isChronicleScreen) {
        chronicleScreenshots += 1;
      } else {
        chronicleInsights += 1;
      }
    }
    return {
      chronicleScreenshots,
      chronicleInsights,
      notes:
        chronicleScreenshots + chronicleInsights === 0
          ? "no observed activity recorded"
          : `${chronicleScreenshots} screen captures + ${chronicleInsights} insights (observed, not verified)`,
    };
  } catch (e) {
    return emptyEvidence(
      e instanceof Error ? e.message : "memory script unavailable",
    );
  }
}

function emptyEvidence(notes: string): WrapEvidence {
  return { chronicleScreenshots: 0, chronicleInsights: 0, notes };
}

export function readWrap(): WrapSnapshot | null {
  try {
    if (!existsSync(WRAP_PATH)) return null;
    return JSON.parse(readFileSync(WRAP_PATH, "utf8")) as WrapSnapshot;
  } catch {
    return null;
  }
}

function writeWrap(s: WrapSnapshot): void {
  try {
    writeFileSync(WRAP_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    console.warn("[loop.wrap] write failed:", e);
  }
}

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function resultKind(dec: LoopDecision): string {
  const r = dec.result;
  if (!r) return "completed";
  if (typeof r === "string") {
    const t = r.trim().toLowerCase();
    if (t.includes("error")) return "error";
    if (t.includes("dry")) return "dry_run";
    if (t.length > 0) return "completed";
  }
  if (typeof r === "object" && r !== null) {
    const status = (r as { status?: string }).status;
    if (typeof status === "string") return status;
  }
  return "completed";
}

export interface BuildWrapResult {
  stats: { done: number; dismissed: number; stillPending: number };
  highlights: WrapHighlight[];
}

/**
 * Build the evening wrap for today. Idempotent within a single date.
 *
 * Like `brief.build`, this is the deterministic aggregator — narrative is
 * handled by `buildAndEnqueue` + `enrichWithNarrative`.
 *
 * #362 — async signature because we now shell out to openloomi-memory
 * to count today's Chronicle observations. The narrative-only `force`
 * path still re-reads the on-disk evidence, which is cheap.
 */
export async function build(
  opts: { force?: boolean } = {},
): Promise<WrapSnapshot> {
  const date = today();
  const existing = readWrap();
  if (
    !opts.force &&
    existing &&
    existing.date === date &&
    existing.highlights.length > 0
  ) {
    return existing;
  }

  const dayStartMs = todayStart();
  const all = decisions.list();
  const todayDone = all.filter(
    (d) =>
      d.status === "done" &&
      d.completed_at &&
      new Date(d.completed_at).getTime() >= dayStartMs,
  );
  const todayDismissed = all.filter(
    (d) =>
      d.status === "dismissed" &&
      d.completed_at &&
      new Date(d.completed_at).getTime() >= dayStartMs,
  );
  const stillPending = decisions.pending().length;

  const highlights: WrapHighlight[] = todayDone
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
    .slice(0, HIGHLIGHTS_CAP)
    .map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      completedAt: d.completed_at ?? "",
      resultKind: resultKind(d),
    }));

  const evidence = await readChronicleEvidence(date);

  const snapshot: WrapSnapshot = {
    date,
    generatedAt: new Date().toISOString(),
    stats: {
      done: todayDone.length,
      dismissed: todayDismissed.length,
      stillPending,
      scope: "loop_decisions",
    },
    highlights,
    evidence,
  };
  writeWrap(snapshot);
  log(
    `wrap ${date}: done=${snapshot.stats.done} dismissed=${snapshot.stats.dismissed} pending=${snapshot.stats.stillPending} evidence=${evidence.chronicleScreenshots + evidence.chronicleInsights}`,
  );
  return snapshot;
}

// ---------------------------------------------------------------------------
// Narrative generation (mirrors brief.ts)
// ---------------------------------------------------------------------------

/**
 * Stable 16-char hash over highlights. Same input → same hash, so the
 * next wrap on the same day can short-circuit if nothing changed.
 */
export function computeWrapNarrativeInputHash(
  highlights: WrapHighlight[],
): string {
  const sorted = [...highlights]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((h) => `${h.id}:${h.resultKind}`)
    .join("|");
  return createHash("sha1").update(sorted).digest("hex").slice(0, 16);
}

/**
 * Build the prompt sent to the native agent for the wrap narrative.
 * Mirrors brief.ts but: headline rule is "do NOT start with 'Night:'",
 * optional `carry: string[]` field for v2 (parsers ignore unknowns).
 */
export function buildWrapPrompt(
  highlights: WrapHighlight[],
  snapshot: WrapSnapshot,
): string {
  const highlightsJson = JSON.stringify(
    highlights.map((h) => ({
      title: h.title,
      type: h.type,
      completedAt: h.completedAt,
      resultKind: h.resultKind,
    })),
    null,
    2,
  );

  return `You are writing the evening wrap for the user's OpenLoomi Loop — a single, agentic narrative summary of what got resolved today and what's still open. You have tool use — use it to ground the narrative in real past context BEFORE composing.

# Inputs

Date: ${snapshot.date}
Done: ${snapshot.stats.done} decisions resolved today.
Dismissed: ${snapshot.stats.dismissed} dismissed.
Still pending: ${snapshot.stats.stillPending} carried into tomorrow.

Highlights (most recent first, capped at 8):
${highlightsJson}

# Step 1 — REQUIRED: gather focused context from memory + insights

Before writing, run these three queries IN PARALLEL using the Bash tool so the wrap names actual people, references yesterday's commitments, and ties today's work to projects you find in memory — instead of restating highlights[]:

  # 1. Any open thread on the projects touched today — what's left to do,
  #    who is blocked on what. Pull from local memory + knowledge base.
  node \$OPENLOOMI_MEMORY_DIR/scripts/openloomi-memory.cjs search-all "<2-4 keywords from highlights>"

  # 2. Today's insights — what conversations / decisions happened today
  #    that may not be in highlights[] (chats, off-record commitments,
  #    follow-ups promised but not yet due).
  node \$OPENLOOMI_MEMORY_DIR/scripts/openloomi-memory.cjs list-insights --days=1 --limit=20

  # 3. Semantic hits for the day's theme (e.g. "loomilib sprint close",
  #    "weekend coverage", "OKR check-in").
  node \$OPENLOOMI_MEMORY_DIR/scripts/openloomi-memory.cjs search-knowledge "<1 short theme>"

Rules for the queries:
- Run all three in ONE assistant turn with parallel Bash calls — do not serialise.
- Hard cap each query at ~8s.
- If a query errors or returns empty, treat it as "no extra context" and still compose. NEVER fail the wrap because memory/insights were unavailable.
- Use anything concrete you find (names, project refs, prior commitments) verbatim. If a profile names a person, write their real name.

# Step 2 — Compose the narrative

With highlights[] + your focused query results, emit a SINGLE SSE \`result\` event whose \`content\` is a JSON object with this exact shape:

{
  "headline": string,        // ≤ 80 chars; NOT "Night: …" — that is a status line
  "body": string,            // 2-4 sentences, ≤ 400 chars, plain prose, NO markdown
  "model"?: string           // optional, your model id for debugging
}

# Rules

- Plain prose only. No markdown headers, no bullet symbols, no emoji.
- Headline must NOT start with "Night:". It is the headline, not a status line.
- Lead with what was actually completed (specific titles / projects), then
  what carried over.
- Mention specific titles from highlights[] AND from your query results — generic advice ("got stuff done") is bad.
- If highlights[] is empty, return headline="Quiet day", body="Nothing got done today. Tomorrow is a fresh shot — the morning brief will re-prioritize.".
- If you cannot emit a structured \`result\` event for any reason, fall back
  to emitting a single \`\`\`json fenced block in your text reply containing
  the same object.
- Do not make external side effects (no sending mail, no creating calendar
  events). This is read-only summarization.
- v2 will add a \`carry: string[]\` field (1-3 short labels for what the
  user should look at first tomorrow). You may include it now or leave it
  out — parsers ignore extra/missing optional fields.`;
}

export interface WrapParseResult {
  ok: boolean;
  narrative?: WrapNarrative;
  error?: string;
}

export function parseWrapNarrative(
  res: {
    ok: boolean;
    result?: unknown;
    text?: string;
    error?: string;
  },
  highlights: WrapHighlight[],
): WrapParseResult {
  const hash = computeWrapNarrativeInputHash(highlights);

  const fromObj = (obj: unknown): WrapNarrative => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.headline !== "string" || typeof o.body !== "string")
      return null;
    return {
      status: "ready",
      headline: o.headline.slice(0, 200),
      body: o.body.slice(0, 800),
      generatedAt: new Date().toISOString(),
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      input_hash: hash,
    };
  };

  if (res.ok) {
    const fromResult = fromObj(res.result);
    if (fromResult) return { ok: true, narrative: fromResult };
    const m = /```json\s*([\s\S]+?)```/.exec(res.text ?? "");
    if (m) {
      try {
        const fromText = fromObj(JSON.parse(m[1]));
        if (fromText) return { ok: true, narrative: fromText };
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      error: "no parseable narrative in agent response",
    };
  }
  return { ok: false, error: res.error ?? "agent call failed" };
}

/**
 * Try to enrich a snapshot with an agentic narrative. Never throws —
 * any failure collapses to `narrative: null` so callers keep the
 * template path. Failures are logged for admin visibility only.
 */
export async function enrichWithNarrative(
  snapshot: WrapSnapshot,
  opts: { force?: boolean } = {},
): Promise<WrapSnapshot> {
  try {
    const prefs = readPreferences();
    if (prefs.narrative === false) return snapshot;

    const hash = computeWrapNarrativeInputHash(snapshot.highlights);

    if (
      !opts.force &&
      snapshot.narrative &&
      snapshot.narrative.status === "ready" &&
      snapshot.narrative.input_hash === hash
    ) {
      return snapshot;
    }

    if (snapshot.highlights.length === 0) {
      return { ...snapshot, narrative: null };
    }

    const prompt = buildWrapPrompt(snapshot.highlights, snapshot);
    const res = await invokeAgentPrompt(prompt, {
      timeoutMs: NARRATIVE_TIMEOUT_MS,
    });
    const parsed = parseWrapNarrative(res, snapshot.highlights);
    if (parsed.ok && parsed.narrative) {
      return { ...snapshot, narrative: parsed.narrative };
    }
    log(`[loop.wrap] narrative unavailable: ${parsed.error ?? "unknown"}`);
    return { ...snapshot, narrative: null };
  } catch (e) {
    log(
      `[loop.wrap] narrative enrich threw: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { ...snapshot, narrative: null };
  }
}

/**
 * Compute the card dialogue for a wrap snapshot. Mirrors
 * `computeBriefDialogue` — shared logic so the pet card's top-line
 * text reflects the headline immediately after the bg enrich lands.
 *
 * #362 — the dialogue is now scope-aware. `done` counts Loop-resolved
 * decision cards, not "the user's total daily output". The wording:
 *   - says "Loop decisions resolved", never "you finished N things"
 *   - distinguishes "0 decisions resolved" from "nothing got done"
 *   - acknowledges Chronicle observations ("X things captured") as
 *     *observed* activity, never as completed work
 */
export function computeWrapDialogue(
  snapshot: WrapSnapshot,
  highlights: WrapHighlight[],
): string {
  const n = snapshot.narrative;
  if (n?.status === "generating") {
    return "Evening wrap is generating — pull to refresh in a moment.";
  }
  if (n?.status === "ready") {
    return `${n.headline} — ${n.body.split("\n")[0] ?? ""}`.slice(0, 280);
  }
  const evidence = snapshot.evidence;
  const observed =
    evidence && evidence.chronicleScreenshots + evidence.chronicleInsights > 0
      ? ` ${evidence.chronicleScreenshots + evidence.chronicleInsights} things captured.`
      : "";
  const headline = highlights[0]?.title ?? "(none resolved)";
  if (snapshot.stats.done > 0) {
    return `Night: ${snapshot.stats.done} Loop decisions resolved today — latest was "${headline}".${observed}`.slice(
      0,
      280,
    );
  }
  if (observed) {
    // Zero decisions but Chronicle captured something. Don't claim
    // completion; surface observed activity as observed.
    return `Night: 0 Loop decisions resolved — ${observed.trim()}`.slice(
      0,
      280,
    );
  }
  // Zero decisions and no observed activity. Honest scope — we
  // measured nothing, not "you did nothing".
  return "Night: nothing surfaced from Loop today. Tomorrow is a fresh shot.";
}

export function kickOffBackgroundEnrichment(
  snapshot: WrapSnapshot,
  cardId: string,
): void {
  void (async () => {
    try {
      const enriched = await enrichWithNarrative(snapshot, { force: true });

      try {
        writeWrap(enriched);
      } catch (e) {
        log(`[loop.wrap] persist (bg) failed: ${e}`);
      }

      try {
        const card = decisions.get(cardId);
        if (!card) return;
        const ctx = { ...(card.context ?? {}) };
        const next = enriched.narrative;
        const patch: Partial<LoopDecision> = { context: ctx };
        if (next && next.status === "ready") {
          ctx.narrative = next;
          const why = Array.isArray(ctx.why) ? [...ctx.why] : [];
          why.push(`Narrative: ${next.headline}`);
          ctx.why = why;
          patch.dialogue = computeWrapDialogue(enriched, enriched.highlights);
          patch.confidence = 0.85;
        } else {
          ctx.narrative = undefined;
          patch.dialogue = computeWrapDialogue(enriched, enriched.highlights);
        }
        decisions.update(cardId, patch);
      } catch (e) {
        log(`[loop.wrap] patch card failed: ${e}`);
      }
    } catch (e) {
      log(
        `[loop.wrap] background enrich threw: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// buildAndEnqueue — orchestrator the cron / API path calls.
// ---------------------------------------------------------------------------

export interface EnqueueWrapResult {
  card: LoopDecision | null;
  snapshot: WrapSnapshot;
}

export async function buildAndEnqueue(
  opts: { force?: boolean } = {},
): Promise<EnqueueWrapResult> {
  const built = await build(opts);
  const highlights = built.highlights;
  const hash = computeWrapNarrativeInputHash(highlights);

  let initialNarrative: WrapNarrative | undefined;
  const prefs = readPreferences();
  if (prefs.narrative === false) {
    initialNarrative = undefined;
  } else if (
    !opts.force &&
    built.narrative &&
    built.narrative.status === "ready" &&
    built.narrative.input_hash === hash
  ) {
    initialNarrative = built.narrative;
  } else if (highlights.length > 0) {
    initialNarrative = {
      status: "generating",
      startedAt: new Date().toISOString(),
      input_hash: hash,
    };
  } else {
    initialNarrative = null;
  }

  const snapshot: WrapSnapshot = { ...built, narrative: initialNarrative };

  try {
    writeWrap(snapshot);
  } catch (e) {
    log(`[loop.wrap] persist failed: ${e}`);
  }

  // #316 — quiet-mode branch (mirrors brief.ts). When zero highlights
  // got captured today, the default behaviour is to skip the
  // templated "nothing got done" card entirely. The snapshot above
  // is still on disk for history.
  //
  // Sub-branches match brief.ts:
  //   1. `prefs.quietDayFiller !== "none"` → try the module; enqueue
  //      the returned `quiet_digest` decision if non-null.
  //   2. otherwise → log + return `{ card: null, snapshot }`.
  //
  // `prefs.quietWhenEmpty === false` falls through to the templated
  // card (existing code path below).
  if (highlights.length === 0 && prefs.quietWhenEmpty !== false) {
    if (prefs.quietDayFiller && prefs.quietDayFiller !== "none") {
      log(`[loop.wrap] empty wrap — running module ${prefs.quietDayFiller}`);
      const moduleDecision = await runQuietDayModule(prefs.quietDayFiller, {
        kind: "wrap",
        date: snapshot.date,
        prefs,
      });
      if (moduleDecision) {
        // Route the digest through `decisions.add` so the pet watcher
        // sees it (#316 follow-up). Without this the card lived only
        // on `wrap.json.quiet_digest` and never reached
        // `decisions.json`. See the matching comment in `brief.ts`
        // for the full rationale.
        const persisted = decisions.add(moduleDecision) ?? moduleDecision;

        const enrichedSnapshot = {
          ...snapshot,
          narrative: null as WrapNarrative,
        };
        (
          enrichedSnapshot as WrapSnapshot & { quiet_digest?: LoopDecision }
        ).quiet_digest = persisted;
        try {
          writeWrap(enrichedSnapshot);
        } catch (e) {
          log(`[loop.wrap] persist (digest) failed: ${e}`);
        }
        log(
          `[loop.wrap] digest card enqueued ${persisted.id} (module=${prefs.quietDayFiller})`,
        );
        return { card: persisted, snapshot: enrichedSnapshot };
      }
      log(
        `[loop.wrap] empty wrap — module ${prefs.quietDayFiller} returned no decision, skipping card`,
      );
      return { card: null, snapshot };
    }
    log("[loop.wrap] empty wrap — quietWhenEmpty=true, skipping card");
    return { card: null, snapshot };
  }

  const dialogue = computeWrapDialogue(snapshot, highlights);

  const card = decisions.add({
    type: "wrap",
    title: `Evening wrap · ${snapshot.date}`,
    action: {
      kind: "wrap",
      params: { date: snapshot.date },
    },
    dialogue,
    nextStep:
      snapshot.stats.stillPending > 0
        ? `${snapshot.stats.stillPending} still pending — the morning brief will re-prioritize.`
        : "Queue's clear — sleep well.",
    context: {
      why: [
        `Done today: ${snapshot.stats.done}`,
        `Dismissed: ${snapshot.stats.dismissed}`,
        `Still pending: ${snapshot.stats.stillPending}`,
        ...(snapshot.narrative?.status === "generating"
          ? ["Narrative: generating"]
          : snapshot.narrative?.status === "ready"
            ? [`Narrative: ${snapshot.narrative.headline}`]
            : []),
      ],
      memory_refs: [],
      ...(snapshot.narrative ? { narrative: snapshot.narrative } : {}),
    },
    confidence: snapshot.narrative?.status === "ready" ? 0.85 : 1,
  });

  // #288 — `card` is now `LoopDecision | null` because decisions.add() may
  // reject noop / tick_summary records. For type:"wrap" the filter never
  // matches, but the nullable contract is acknowledged here defensively.
  if (card && snapshot.narrative?.status === "generating") {
    kickOffBackgroundEnrichment(snapshot, card.id);
  }

  log(
    `wrap card enqueued ${card?.id ?? "<rejected>"}${
      snapshot.narrative?.status === "generating"
        ? " (narrative: generating)"
        : snapshot.narrative?.status === "ready"
          ? " (narrative: ready)"
          : " (templated)"
    }`,
  );
  return { card, snapshot };
}
