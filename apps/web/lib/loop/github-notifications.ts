/**
 * GitHub notification normalizer / aggregator (#378).
 *
 * Direct `github_notification` signals are PASSIVE — they carry no
 * executable action (unlike a `review_pr` where the user can post a
 * review). Left to the generic custom-signal fallback, each notification
 * used to become its own `unknown` decision card with a `Run` control,
 * producing a burst of modal cards for what is really just "GitHub has N
 * updates".
 *
 * This module turns that burst into ONE read-only `quiet_digest` card:
 *   - recognizes `github_notification` signals arriving via either the
 *     built-in `github` pull or a custom `github_notifications` channel;
 *   - derives a source-independent canonical key so the same thread seen
 *     on two surfaces collapses to one row;
 *   - derives a safe HTTPS web URL from GitHub API subject URLs;
 *   - builds a bounded `quiet_digest` decision grouped by repository;
 *   - excludes keys already represented by a typed (non-unknown) decision
 *     or a prior GitHub digest, so repeated ticks do not re-pester;
 *   - merges freshly-unseen items into an existing pending digest instead
 *     of creating a second summary card.
 *
 * Everything here is PURE and READ-ONLY. It never calls GitHub and never
 * mutates external resources — it only reshapes signals the tick already
 * pulled into a decision the store can persist.
 */

import type { LoopDecision, LoopSignal } from "./types";

/** `action.params.module` value that marks a GitHub-notification digest. */
export const GITHUB_NOTIFICATIONS_MODULE = "github-notifications";

/** Signal sources that can carry `github_notification` records. */
const GITHUB_NOTIFICATION_SOURCES = new Set(["github", "github_notifications"]);

/** Hard cap on how many items one digest card lists. Keeps the read-only
 *  summary bounded even if a repo firehoses notifications. Newest win. */
export const MAX_DIGEST_ITEMS = 20;

// ---------------------------------------------------------------------------
// Item shape
// ---------------------------------------------------------------------------

export interface GithubNotificationItem {
  /** Canonical, source-independent dedupe key. */
  key: string;
  /** Repository full name (`org/repo`) or "unknown". */
  repo: string;
  /** Subject title (PR / issue title). */
  title: string;
  /** Short human-readable line (derived from the notification reason). */
  summary: string;
  /** Raw GitHub notification reason, when present. */
  reason?: string;
  /** Validated HTTPS web URL to the thread, when derivable. */
  url?: string;
}

// ---------------------------------------------------------------------------
// Small payload accessors
// ---------------------------------------------------------------------------

function payloadOf(signal: LoopSignal): Record<string, unknown> {
  const p = signal.payload;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Repository full name (`org/repo`) from the many shapes GitHub / custom
 *  channels emit. Returns null when nothing usable is present. */
function repoFullName(p: Record<string, unknown>): string | null {
  const repository = p.repository;
  if (repository && typeof repository === "object") {
    const r = repository as Record<string, unknown>;
    const full = firstString(r.full_name, r.fullName);
    if (full) return full;
    const name = firstString(r.name);
    if (name) return name;
  }
  return firstString(p.repo, p.repository, p.repo_full_name);
}

/** Subject object accessor — GitHub notifications nest `{ title, url, type }`
 *  under `subject`; custom channels may flatten it. */
function subjectOf(p: Record<string, unknown>): Record<string, unknown> {
  const s = p.subject;
  return s && typeof s === "object" ? (s as Record<string, unknown>) : {};
}

function subjectTitle(p: Record<string, unknown>): string | null {
  const s = subjectOf(p);
  return firstString(s.title, p.title, p.subject_title);
}

function subjectUrl(p: Record<string, unknown>): string | null {
  const s = subjectOf(p);
  return firstString(s.url, p.subject_url, p.url);
}

// ---------------------------------------------------------------------------
// Recognition + canonicalization
// ---------------------------------------------------------------------------

/**
 * True when a signal is a passive GitHub notification arriving via the
 * built-in `github` pull or a custom `github_notifications` channel.
 */
export function isGithubNotificationSignal(
  signal: LoopSignal | null | undefined,
): boolean {
  if (!signal || typeof signal !== "object") return false;
  if (signal.type !== "github_notification") return false;
  return GITHUB_NOTIFICATION_SOURCES.has(String(signal.source));
}

/**
 * Convert a GitHub API subject URL (or an already-web URL) into a validated
 * HTTPS github.com web URL. Returns null for anything that isn't a
 * recognizable, safe GitHub URL — the renderer only shows links we trust.
 */
export function deriveGithubWebUrl(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Already a github.com web URL — pass through (path only, no creds/query
  // smuggling beyond the canonical form).
  if (url.hostname === "github.com") {
    return `https://github.com${url.pathname}`.replace(/\/+$/, "");
  }
  if (url.hostname === "api.github.com") {
    // /repos/OWNER/REPO/(issues|pulls)/NUMBER
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)/.exec(
      url.pathname,
    );
    if (m) {
      const [, owner, repo, kind, num] = m;
      const webKind = kind === "pulls" ? "pull" : "issues";
      return `https://github.com/${owner}/${repo}/${webKind}/${num}`;
    }
    // Bare repository URL /repos/OWNER/REPO
    const rm = /^\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (rm) return `https://github.com/${rm[1]}/${rm[2]}`;
    return null;
  }
  return null;
}

/**
 * Derive a source-independent canonical key for a GitHub notification.
 * Prefers the GitHub notification / thread id (stable across the `github`
 * and `github_notifications` surfaces), then falls back to a normalized
 * repository + subject number / URL, then repo + subject title.
 */
export function githubNotificationKey(
  signal: LoopSignal | null | undefined,
): string | null {
  if (!signal || typeof signal !== "object") return null;
  const p = payloadOf(signal);
  const id = firstString(p.id, p.thread_id, p.threadId, p.notification_id);
  if (id) return `gh:id:${id}`;

  const repo = repoFullName(p);
  const webUrl = deriveGithubWebUrl(subjectUrl(p));
  if (webUrl) {
    const num = /\/(?:issues|pull)\/(\d+)/.exec(webUrl);
    if (repo && num) return `gh:${repo.toLowerCase()}#${num[1]}`;
    return `gh:url:${webUrl.toLowerCase()}`;
  }
  const title = subjectTitle(p);
  if (repo && title) return `gh:${repo.toLowerCase()}:${title.toLowerCase()}`;
  return null;
}

/** Map a GitHub notification `reason` to a short human line. */
function humanizeReason(reason: string | null): string {
  switch ((reason ?? "").toLowerCase()) {
    case "review_requested":
      return "Review requested";
    case "mention":
      return "You were mentioned";
    case "assign":
      return "Assigned to you";
    case "team_mention":
      return "Your team was mentioned";
    case "author":
      return "Update on a thread you opened";
    case "comment":
      return "New comment";
    case "state_change":
      return "State changed";
    case "subscribed":
      return "Activity on a thread you follow";
    case "ci_activity":
      return "CI activity";
    case "":
      return "GitHub update";
    default:
      return reason ?? "GitHub update";
  }
}

/** Build a normalized item from a single notification signal, or null when
 *  the signal lacks a stable identity. */
function toGithubItem(signal: LoopSignal): GithubNotificationItem | null {
  const key = githubNotificationKey(signal);
  if (!key) return null;
  const p = payloadOf(signal);
  const repo = repoFullName(p) ?? "unknown";
  const title = subjectTitle(p) ?? "GitHub notification";
  const reason = firstString(p.reason) ?? undefined;
  const url =
    deriveGithubWebUrl(subjectUrl(p)) ??
    deriveGithubWebUrl(
      (() => {
        const repository = p.repository;
        if (repository && typeof repository === "object") {
          return firstString((repository as Record<string, unknown>).html_url);
        }
        return null;
      })(),
    ) ??
    undefined;
  return {
    key,
    repo,
    title: title.slice(0, 160),
    summary: humanizeReason(reason ?? null),
    ...(reason ? { reason } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * Normalize + cross-source deduplicate a batch of signals into items.
 * Signals that aren't GitHub notifications are ignored. Duplicate keys
 * collapse; when merging, an item that carries a URL wins over one that
 * doesn't.
 */
export function normalizeGithubNotifications(
  signals: LoopSignal[],
): GithubNotificationItem[] {
  const map = new Map<string, GithubNotificationItem>();
  for (const s of signals) {
    if (!isGithubNotificationSignal(s)) continue;
    const item = toGithubItem(s);
    if (!item) continue;
    const existing = map.get(item.key);
    if (!existing) {
      map.set(item.key, item);
      continue;
    }
    if (!existing.url && item.url) {
      map.set(item.key, { ...existing, ...item });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Digest recognition + covered-key collection
// ---------------------------------------------------------------------------

/** True when a decision is a GitHub-notification `quiet_digest` card. */
export function isGithubDigestDecision(dec: LoopDecision): boolean {
  if (!dec || dec.type !== "quiet_digest") return false;
  const params = dec.action?.params as Record<string, unknown> | undefined;
  const module =
    params?.module ??
    (dec.context && (dec.context as Record<string, unknown>).module);
  return module === GITHUB_NOTIFICATIONS_MODULE;
}

/** Read the persisted items array off a GitHub digest decision. */
function readDigestItems(dec: LoopDecision): GithubNotificationItem[] {
  const raw = (dec.context as Record<string, unknown> | undefined)?.items;
  if (!Array.isArray(raw)) return [];
  const out: GithubNotificationItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const key = firstString(o.key);
    if (!key) continue;
    out.push({
      key,
      repo: firstString(o.repo) ?? "unknown",
      title: firstString(o.title) ?? "GitHub notification",
      summary: firstString(o.summary) ?? "",
      ...(firstString(o.reason) ? { reason: String(o.reason) } : {}),
      ...(firstString(o.url) ? { url: String(o.url) } : {}),
    });
  }
  return out;
}

/**
 * Collect the notification keys already represented by existing decisions:
 *   - keys listed on any prior GitHub digest (`context.notification_keys`);
 *   - the canonical key of any typed, NON-unknown decision whose
 *     `source_signal` is a GitHub notification (e.g. a `review_pr` / `todo`
 *     the agent converted from a notification).
 *
 * Filtered `unknown` records are intentionally NOT treated as summarized —
 * they carry no real coverage and should not suppress the digest.
 */
export function collectCoveredNotificationKeys(
  decisions: LoopDecision[],
): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (isGithubDigestDecision(d)) {
      const keys = (d.context as Record<string, unknown> | undefined)
        ?.notification_keys;
      if (Array.isArray(keys)) {
        for (const k of keys) if (typeof k === "string") set.add(k);
      }
      continue;
    }
    if (d.type === "unknown") continue;
    const src = d.source_signal;
    if (src && isGithubNotificationSignal(src)) {
      const k = githubNotificationKey(src);
      if (k) set.add(k);
    }
  }
  return set;
}

/** Find the first pending GitHub digest, or null. */
export function findPendingGithubDigest(
  decisions: LoopDecision[],
): LoopDecision | null {
  return (
    decisions.find(
      (d) => d.status === "pending" && isGithubDigestDecision(d),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Digest builder
// ---------------------------------------------------------------------------

function uniqueRepos(items: GithubNotificationItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (seen.has(it.repo)) continue;
    seen.add(it.repo);
    out.push(it.repo);
  }
  return out;
}

function digestId(): string {
  return `gh_digest_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

interface BuildDigestOpts {
  /** Reuse an existing decision id when merging into a pending digest. */
  id?: string;
  /** Timestamp for the (re)built digest. Defaults to now. */
  ts?: string;
  /** Original creation timestamp, preserved across merges for provenance. */
  createdTs?: string;
}

/**
 * Build a bounded, read-only `quiet_digest` decision from items. The
 * decision carries NO executable action — `action.kind` is `quiet_digest`
 * and `params.module` marks it as the GitHub-notifications summary, which
 * the web card and pet card render read-only with a local "Mark as read".
 */
export function buildGithubDigestDecision(
  items: GithubNotificationItem[],
  opts: BuildDigestOpts = {},
): LoopDecision {
  const bounded = items.slice(-MAX_DIGEST_ITEMS);
  const count = bounded.length;
  const repos = uniqueRepos(bounded);
  const ts = opts.ts ?? new Date().toISOString();
  const repoSummary =
    repos.length <= 3
      ? repos.join(", ")
      : `${repos.slice(0, 3).join(", ")} +${repos.length - 3} more`;
  const title = `GitHub has ${count} update${count === 1 ? "" : "s"}`;
  const dialogue = `${count} unread GitHub notification${
    count === 1 ? "" : "s"
  } across ${repos.length} repo${repos.length === 1 ? "" : "s"}${
    repoSummary ? `: ${repoSummary}` : ""
  }.`;

  return {
    id: opts.id ?? digestId(),
    ts,
    status: "pending",
    type: "quiet_digest",
    title,
    action: {
      kind: "quiet_digest",
      params: { module: GITHUB_NOTIFICATIONS_MODULE },
    },
    dialogue,
    nextStep: "Mark as read once you've caught up.",
    context: {
      module: GITHUB_NOTIFICATIONS_MODULE,
      count,
      notification_keys: bounded.map((i) => i.key),
      repositories: repos,
      items: bounded.map((i) => ({
        key: i.key,
        repo: i.repo,
        title: i.title,
        summary: i.summary,
        ...(i.reason ? { reason: i.reason } : {}),
        ...(i.url ? { url: i.url } : {}),
      })),
      why: [
        `Grouped ${count} passive GitHub notification${
          count === 1 ? "" : "s"
        } into one read-only summary`,
      ],
      ...(opts.createdTs ? { created_ts: opts.createdTs } : {}),
    },
    confidence: 0.9,
  };
}

// ---------------------------------------------------------------------------
// Aggregation entry point
// ---------------------------------------------------------------------------

export interface GithubAggregationInput {
  /** Recent signal window (the tick already pulled these). */
  signals: LoopSignal[];
  /** All decisions across pending / done / dismissed buckets. */
  decisions: LoopDecision[];
  /** Injectable clock for deterministic tests. */
  now?: string;
}

export interface GithubAggregationResult {
  /**
   *  - "create" → no pending digest existed; `decision` is a fresh card to
   *    persist via `decisions.add()`.
   *  - "merge"  → a pending digest existed; `decision` (same id) carries the
   *    merged items and should be written via `decisions.update()`.
   *  - "noop"   → nothing new to surface; `decision` is null.
   */
  kind: "create" | "merge" | "noop";
  decision: LoopDecision | null;
  /** Keys added by this aggregation pass (empty for noop). */
  newKeys: string[];
}

/**
 * Aggregate passive GitHub notifications into a single read-only digest.
 *
 * Pure: reads signals + existing decisions, returns an instruction for the
 * caller to persist. Never touches the store, GitHub, or any external
 * resource itself.
 */
export function aggregateGithubNotifications(
  input: GithubAggregationInput,
): GithubAggregationResult {
  const items = normalizeGithubNotifications(input.signals);
  if (items.length === 0) {
    return { kind: "noop", decision: null, newKeys: [] };
  }

  const pendingDigest = findPendingGithubDigest(input.decisions);
  // Covered keys from everything EXCEPT the pending digest we merge into
  // (its own keys are preserved separately below).
  const others = input.decisions.filter((d) => d !== pendingDigest);
  const covered = collectCoveredNotificationKeys(others);

  const existingItems = pendingDigest ? readDigestItems(pendingDigest) : [];
  const existingKeys = new Set(existingItems.map((i) => i.key));

  const fresh = items.filter(
    (i) => !covered.has(i.key) && !existingKeys.has(i.key),
  );
  if (fresh.length === 0) {
    return { kind: "noop", decision: null, newKeys: [] };
  }

  const merged = pendingDigest ? [...existingItems, ...fresh] : fresh;
  const newKeys = fresh.map((i) => i.key);

  if (pendingDigest) {
    const decision = buildGithubDigestDecision(merged, {
      id: pendingDigest.id,
      ts: input.now,
      createdTs:
        ((pendingDigest.context as Record<string, unknown> | undefined)
          ?.created_ts as string | undefined) ?? pendingDigest.ts,
    });
    return { kind: "merge", decision, newKeys };
  }

  const decision = buildGithubDigestDecision(merged, { ts: input.now });
  return { kind: "create", decision, newKeys };
}
