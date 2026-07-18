/**
 * Dry-run script for the agentic narrative pipeline.
 *
 * Bypasses the dev server, native agent endpoint, and the store's
 * `decisions.add` side effect. Stubs `invokeAgentPrompt` with a canned
 * response so we can show:
 *
 *   1. What items `build()` would surface today (deterministic).
 *   2. What the prompt the agent actually receives looks like.
 *   3. What the parsed `BriefNarrative` object looks like.
 *   4. What the persisted `brief.json` shape looks like.
 *   5. What the decision card's `dialogue` and `context.narrative` look
 *      like.
 *
 * Run with:
 *   node --import tsx scripts/dry-run-narrative.ts
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Reuse the canonical BriefItem from brief.ts so type identity lines up.
import {
  buildBriefPrompt,
  parseBriefNarrative,
  type BriefItem,
} from "../lib/loop/brief";

const MOCK_ITEMS: BriefItem[] = [
  {
    kind: "rsvp",
    id: "dec_rsvp_mira_standup",
    title: "RSVP · Mira's standup · 10:00",
    action: { kind: "calendar_rsvp", params: { eventId: "evt_abc" } },
    priority: 1,
    reason: "calendar event in 90 min, no response yet",
  },
  {
    kind: "review_pr",
    id: "dec_pr_loomilib_482",
    title: "Review PR · loomilib#482",
    action: { kind: "github_review", params: { repo: "loomilib", pr: 482 } },
    priority: 2,
    reason: "requested 2d ago, blocking @teammate",
  },
  {
    kind: "review_pr",
    id: "dec_pr_openloomi_77",
    title: "Review PR · openloomi#77",
    action: { kind: "github_review", params: { repo: "openloomi", pr: 77 } },
    priority: 2,
    reason: "small docs fix, ship-it candidate",
  },
  {
    kind: "email_reply",
    id: "dec_reply_sam_launch",
    title: "Reply · Sam re: launch timing",
    action: { kind: "email_reply", params: {} },
    priority: 3,
    reason: "thread flagged 'asap' in subject",
  },
  {
    kind: "im_reply",
    id: "dec_slack_quinn",
    title: "Slack · Quinn in #launch",
    action: { kind: "im_reply", params: { channel: "slack" } },
    priority: 4,
    reason: "@mention 4h ago",
  },
  {
    kind: "linear_review",
    id: "dec_linear_loop_201",
    title: "Linear · LOOP-201 feedback",
    action: { kind: "linear_review", params: {} },
    priority: 6,
    reason: "assigned to me, due Friday",
  },
];

const MOCK_MUTED = [
  {
    id: "dec_release_v08",
    kind: "release_plan",
    title: "Release plan v0.8",
    reason: "not surfaced in brief",
  },
  {
    id: "dec_doc_readme",
    kind: "doc_update",
    title: "Update README.md",
    reason: "not surfaced in brief",
  },
];

// ---------------------------------------------------------------------------
// Step 1: computeNarrativeInputHash — exercise the pure helper.
// ---------------------------------------------------------------------------

function computeNarrativeInputHash(items: BriefItem[]): string {
  const sorted = [...items]
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((i) => `${i.kind}:${i.id}`)
    .join("|");
  return createHash("sha1").update(sorted).digest("hex").slice(0, 16);
}

const hash = computeNarrativeInputHash(MOCK_ITEMS);
console.log("\n=== Step 1: computeNarrativeInputHash ===");
console.log("hash:", hash);

// ---------------------------------------------------------------------------
// Step 2: buildBriefPrompt — show the actual prompt the agent receives.
// ---------------------------------------------------------------------------

const mockSnapshot = {
  date: "2026-07-09",
  generatedAt: new Date().toISOString(),
  stats: { scanned: 8, surfaced: 6, muted: 2 },
  items: MOCK_ITEMS,
  muted: MOCK_MUTED,
  // No `narrative` field — initial state before enrichment.
} as const;

const prompt = buildBriefPrompt(MOCK_ITEMS, mockSnapshot, MOCK_MUTED);

console.log("\n=== Step 2: buildBriefPrompt ===");
console.log(`prompt length: ${prompt.length} chars`);
console.log("--- prompt start ---");
console.log(prompt.split("\n").slice(0, 6).join("\n"));
console.log("... [snip] ...");
console.log(prompt.split("\n").slice(-10).join("\n"));
console.log("--- prompt end ---");

// Persist the full prompt so the user can inspect.
const outDir = join(tmpdir(), "openloomi-narrative-dry-run");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "prompt.txt"), prompt, "utf8");
console.log(`(full prompt written to ${join(outDir, "prompt.txt")})`);

// ---------------------------------------------------------------------------
// Step 3: simulate the agent returning a `result` event.
// ---------------------------------------------------------------------------

const STUB_NARRATIVE = {
  headline: "Mira's standup blocks the morning, two PRs need to ship",
  body:
    "Mira's 10am standup still needs an RSVP — declining frees the whole morning. " +
    "Two review_pr on loomilib are blocking teammates, ship them first. " +
    "Sam's slack about the launch is FYI; ignore for now.",
  model: "stub-haiku-4.5",
};

const stubResponse = {
  ok: true,
  result: STUB_NARRATIVE,
  text: JSON.stringify(STUB_NARRATIVE),
  reasoning: "I prioritised the RSVP, then the two PRs, then the email.",
};

console.log("\n=== Step 3: stubbed agent response ===");
console.log(JSON.stringify(stubResponse, null, 2));

// ---------------------------------------------------------------------------
// Step 4: parseBriefNarrative — exercise the parser with the stub.
// ---------------------------------------------------------------------------

const parsed = parseBriefNarrative(
  {
    ok: stubResponse.ok,
    result: stubResponse.result,
    text: stubResponse.text,
  },
  MOCK_ITEMS,
);

console.log("\n=== Step 4: parseBriefNarrative ===");
console.log(JSON.stringify(parsed, null, 2));

// ---------------------------------------------------------------------------
// Step 5: assemble the snapshot that gets persisted to ~/.openloomi/loop/brief.json.
// ---------------------------------------------------------------------------

const snapshot = {
  ...mockSnapshot,
  narrative: parsed.ok && parsed.narrative ? parsed.narrative : null,
};

console.log("\n=== Step 5: persisted brief.json ===");
console.log(JSON.stringify(snapshot, null, 2));

writeFileSync(
  join(outDir, "brief.json"),
  JSON.stringify(snapshot, null, 2),
  "utf8",
);
console.log(`(written to ${join(outDir, "brief.json")})`);

// ---------------------------------------------------------------------------
// Step 6: assemble the decision card that gets enqueued.
// ---------------------------------------------------------------------------

const narrForCard =
  parsed.ok && parsed.narrative?.status === "ready" ? parsed.narrative : null;
const headline = MOCK_ITEMS[0]?.title ?? "No todos today";
const dialogue =
  snapshot.narrative?.status === "ready"
    ? `${snapshot.narrative.headline} — ${snapshot.narrative.body.split("\n")[0] ?? ""}`.slice(
        0,
        280,
      )
    : MOCK_ITEMS.length > 0
      ? `Morning: ${MOCK_ITEMS.length} priorities queued — top one is "${headline}".`
      : "Morning: the queue is clear. Go grab a coffee.";

const card = {
  id: "dec_brief_demo",
  ts: new Date().toISOString(),
  status: "pending",
  type: "brief",
  title: `Morning brief · ${snapshot.date}`,
  action: { kind: "brief", params: { date: snapshot.date } },
  dialogue,
  nextStep: `Tap to see ${MOCK_ITEMS.length} items, or say "start" to handle them one by one.`,
  context: {
    why: [
      `Scanned ${snapshot.stats.scanned} pending decisions`,
      `Surfaced ${snapshot.stats.surfaced} priorities, muted ${snapshot.stats.muted}`,
      `Narrative: ${narrForCard?.headline}`,
    ],
    memory_refs: [],
    narrative: narrForCard,
  },
  confidence: 0.85,
};

console.log("\n=== Step 6: decision card ===");
console.log(JSON.stringify(card, null, 2));

writeFileSync(join(outDir, "card.json"), JSON.stringify(card, null, 2), "utf8");
console.log(`(written to ${join(outDir, "card.json")})`);

// ---------------------------------------------------------------------------
// Step 7: also exercise the FENCED JSON fallback path.
// ---------------------------------------------------------------------------

console.log("\n=== Step 7: fenced ```json fallback path ===");

const fencedResponse = {
  ok: true,
  // No structured result — only text. parseBriefNarrative must extract
  // the JSON from the ```json ... ``` fence.
  result: undefined,
  text: [
    "Sure, here's the brief:\n",
    "```json",
    JSON.stringify(
      {
        headline: "Standup RSVP is the only urgent one",
        body: "Mira's 10am standup is the only thing that needs a decision before lunch. The two PRs and the Sam thread can all wait.",
        model: "stub-haiku-4.5",
      },
      null,
      2,
    ),
    "```",
    "\nHope that helps.",
  ].join("\n"),
};

const fencedParsed = parseBriefNarrative(
  {
    ok: fencedResponse.ok,
    result: fencedResponse.result,
    text: fencedResponse.text,
  },
  MOCK_ITEMS,
);

console.log("fenced parse result:");
console.log(JSON.stringify(fencedParsed, null, 2));

// ---------------------------------------------------------------------------
// Step 8: failure path — what the snapshot looks like when the agent errors.
// ---------------------------------------------------------------------------

console.log("\n=== Step 8: agent failure path ===");
const failedResponse = {
  ok: false,
  error: "agent call timed out after 1200000ms",
};
const failedParsed = parseBriefNarrative(
  {
    ok: failedResponse.ok,
    error: failedResponse.error,
  },
  MOCK_ITEMS,
);
console.log("failed parse result:");
console.log(JSON.stringify(failedParsed, null, 2));
const failedSnapshot = {
  ...mockSnapshot,
  narrative:
    failedParsed.ok && failedParsed.narrative ? failedParsed.narrative : null,
};
console.log("snapshot.narrative →", failedSnapshot.narrative);
console.log("(UI falls back to the templated dialogue — log line:");
console.log(
  "  [loop.brief] narrative unavailable: agent call timed out after 1200000ms)",
);

// ---------------------------------------------------------------------------
// Done.
// ---------------------------------------------------------------------------

console.log("\n=== Done. Outputs in:", outDir, "===");
console.log("  - prompt.txt   (full agent prompt)");
console.log("  - brief.json  (snapshot that gets persisted)");
console.log("  - card.json   (decision card that gets enqueued)");
