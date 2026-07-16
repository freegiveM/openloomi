/**
 * Loop signal → decision classification.
 *
 * Port of loop-lib.cjs → rules (hardSkipped + classify) into TypeScript with
 * identical behavior. Adds `LoopPreferences` so the hard-skip toggles can be
 * driven by the user's saved preferences (defaults preserve legacy behavior).
 *
 * The classifier is intentionally lightweight: pattern matching on subject /
 * snippet, labels, and signal type. Richer semantic decisions happen later
 * when the user "runs" a decision and the agent picks it up with full
 * openloomi-memory context.
 */

import type {
  ActionKind,
  DecisionType,
  LoopAction,
  LoopDecision,
  LoopPreferences,
  LoopSignal,
} from "./types";
import { muteKeyFor, mutes } from "./store";

const NORELY_RE =
  /^(no-?reply|noreply|donotreply|notifications?@|mailer-daemon@|postmaster@)/i;
const PROMO_LABELS = ["promotions", "social", "forums", "updates", "spam"];

/**
 * Extract the bare email address from a From-header value. Handles both
 * `Display Name <addr@host>` and raw `addr@host` forms and lowercases the
 * result. GitHub notifications arrive as e.g.
 * `melandlabs/openloomi <notifications@github.com>`, so matching the
 * anchored `NORELY_RE` requires pulling the angle-bracket address out
 * first. Returns "" when no address is present.
 */
function extractEmailAddress(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).toLowerCase().trim();
}

/**
 * True when the sender is an automated / no-reply / notification address
 * (e.g. `notifications@github.com`, `noreply@…`, `mailer-daemon@…`).
 *
 * Such senders must NEVER produce a sendable `email_reply` decision, no
 * matter what the subject contains: a lexical match on RSVP / invite /
 * review in a notification subject is not evidence the user needs to
 * reply, and replying to a reply-by-email address can have external
 * consequences (a GitHub reply-by-email posts a public issue comment).
 * See issue #367.
 */
export function isAutomatedSender(from: unknown): boolean {
  const email = extractEmailAddress(from);
  return email !== "" && NORELY_RE.test(email);
}

export interface SkipReason {
  reason: string;
}

/**
 * Optional context for the reference classifier. Tests pass a frozen
 * `now`; callers with an authenticated session also pass the active
 * user's email so we can apply the self-owned-event gate without
 * leaking personal all-day events as urgent RSVPs.
 *
 * Mirrored in `tick-prompt.ts` §5 so the agentic prompt applies the
 * same gates at decision time.
 */
export interface ClassifyOptions {
  /** Override "now" for deterministic tests; defaults to `new Date()`. */
  now?: Date;
  /**
   * Current user's email (lowercase, trimmed). When supplied, the
   * classifier drops self-owned events with no attendees — a Google
   * Calendar API quirk that surfaces all-day private events as urgent
   * RSVP candidates otherwise. Optional so the function still works
   * without an auth context (CLI dry runs, tests).
   */
  activeUserEmail?: string | null;
}

/**
 * Resolve "now" for time-based gates. Centralised so callers can
 * override it via `ClassifyOptions.now` (tests, deterministic replays).
 */
function resolveNow(opts?: ClassifyOptions): Date {
  return opts?.now ?? new Date();
}

/**
 * Parse a Google Calendar-style timestamp (ISO 8601 string OR epoch ms)
 * into a `Date`, returning null when the input is missing or unparseable.
 */
function parseCalendarTimestamp(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return null;
    return new Date(ms);
  }
  return null;
}

/**
 * Returns a SkipReason if the signal should be dropped before classification,
 * or null if it should proceed.
 */
export function isHardSkipped(
  signal: LoopSignal,
  prefs: Pick<LoopPreferences, "noReplySkip" | "promotionSkip">,
  opts?: ClassifyOptions,
): SkipReason | null {
  const p = signal.payload as Record<string, unknown>;
  if (prefs.noReplySkip) {
    const from = extractEmailAddress(p.from ?? p.sender ?? p.organizer);
    if (from && NORELY_RE.test(from)) {
      return { reason: `no-reply sender: ${from}` };
    }
  }
  if (prefs.promotionSkip) {
    const labels = Array.isArray(p.labels)
      ? (p.labels as unknown[]).map((l) => String(l).toLowerCase())
      : [];
    if (labels.some((l) => PROMO_LABELS.includes(l))) {
      return { reason: `promo label: ${labels.join(",")}` };
    }
  }
  if (signal.type === "calendar_event") {
    // 1) Cancelled events — the meeting is dead; no RSVP needed.
    if (String(p.status ?? "").toLowerCase() === "cancelled") {
      return { reason: "event cancelled" };
    }
    // 2) Missing my_response — do NOT infer "needsAction". Historical
    //    self-owned events arrive with no my_response at all; falling
    //    through to the classifier branch that treated absent as
    //    needsAction caused the 2014-event regression (issue #355).
    const rRaw = p.my_response;
    const r =
      rRaw == null || (typeof rRaw === "string" && rRaw.trim() === "")
        ? ""
        : String(rRaw).toLowerCase();
    if (r === "") {
      return { reason: "missing my_response" };
    }
    // 3) Already responded.
    if (["accepted", "declined", "tentative"].includes(r)) {
      return { reason: `already ${r}` };
    }
    // 4) Event already ended — historical entries (e.g. 2014 all-day
    //    events from the user's own calendar) leak through when the
    //    upstream query window is narrower than the persisted window.
    const end = parseCalendarTimestamp(p.end);
    if (end) {
      const now = resolveNow(opts);
      if (end.getTime() <= now.getTime()) {
        return { reason: "event ended" };
      }
    }
    // 5) Event outside the forward window — Google Calendar events.list
    //    was called with `timeMax: now + 7d`, but a robust classifier
    //    enforces the same bound again so a stray future event doesn't
    //    surface as a current-work RSVP card.
    const start = parseCalendarTimestamp(p.start);
    if (start) {
      const horizon = resolveNow(opts).getTime() + 7 * 24 * 60 * 60 * 1000;
      if (start.getTime() > horizon) {
        return { reason: "event beyond 7-day window" };
      }
    }
    // 6) Self-owned event with no attendees — personal all-day entries
    //    (reminders, out-of-office, focus blocks) that the user owns
    //    and isn't sharing with anyone. Surfacing these as actionable
    //    RSVPs with a default "accepted" was the trust-and-external-
    //    action bug the issue names.
    if (opts?.activeUserEmail) {
      const selfEmail = opts.activeUserEmail.toLowerCase().trim();
      const organizer = String(p.organizer ?? "")
        .toLowerCase()
        .trim();
      const attendees = Array.isArray(p.attendees) ? p.attendees : [];
      if (organizer === selfEmail && attendees.length === 0) {
        return { reason: "self-owned event, no attendees" };
      }
    }
  }
  if (signal.type === "email" && p.replied) {
    return { reason: "already replied" };
  }
  return null;
}

/**
 * Returns a SkipReason when the signal's normalised key is in the user's
 * persistent mute list. The mute list is written by every dismiss — see
 * `mutes.add` in store.ts — so a signal that matches the same scope as one
 * the user previously dismissed will be dropped here, before classification.
 */
export function isMuted(signal: LoopSignal): SkipReason | null {
  const mk = muteKeyFor(signal);
  if (!mk) return null;
  if (mutes.has(mk.key)) return { reason: `user-muted: ${mk.key}` };
  return null;
}

/**
 * Run the full pre-classify gate: user muting first (so a user explicitly
 * muted key wins even after they later turn off a related hard-skip toggle),
 * then the hard-skip rules.
 */
export function gateSignal(
  signal: LoopSignal,
  prefs: Pick<LoopPreferences, "noReplySkip" | "promotionSkip">,
  opts?: ClassifyOptions,
): SkipReason | null {
  return isMuted(signal) ?? isHardSkipped(signal, prefs, opts);
}

export interface DecisionCandidate {
  type: DecisionType;
  title: string;
  action: LoopAction;
  confidence?: number;
}

/**
 * Lightweight classifier: produces a decision candidate from a signal.
 * Returns null when no typed action is warranted — the signal is then
 * silently dropped from the queue but stays in signals.jsonl for debugging.
 *
 * The optional `opts` carries context the classifier needs to make
 * better routing decisions — most importantly `activeUserEmail` for the
 * self-owned-event gate. Without it the classifier is conservatively
 * permissive (legacy behaviour); with it, ambiguous personal events
 * are dropped rather than emitted as default-accepted RSVPs.
 */
export function classify(
  signal: LoopSignal,
  opts?: ClassifyOptions,
): DecisionCandidate | null {
  const p = signal.payload as Record<string, unknown>;
  const text =
    `${String(p.subject ?? "")} ${String(p.snippet ?? p.body ?? "")}`.toLowerCase();

  if (signal.type === "calendar_event") {
    // Defence-in-depth — `isHardSkipped` already drops missing / non-
    // needsAction responses, but a direct caller of `classify()` could
    // reach here with any value. Re-check before emitting. We replay the
    // full hard-skip set so the reference impl mirrors both the prompt's
    // §5 rules and `isHardSkipped` — anything that would be skipped
    // upstream is also skipped here. `classify()` doesn't take prefs
    // today (callers go through `gateSignal` first); pass an empty
    // object so the no-reply / promo gates stay dormant (the gates we
    // actually need here are the calendar ones, which ignore prefs).
    const upstream = isHardSkipped(
      signal,
      { noReplySkip: false, promotionSkip: false },
      opts,
    );
    if (upstream) return null;
    // Self-owned personal events shouldn't surface as RSVPs even if the
    // my_response shape looks actionable. The hard-skip path drops
    // self-owned + no-attendees; here we additionally require the user
    // to appear in the attendees list when their email is known.
    if (opts?.activeUserEmail) {
      const selfEmail = opts.activeUserEmail.toLowerCase().trim();
      const attendees = Array.isArray(p.attendees) ? p.attendees : [];
      const userInAttendees = attendees.some((a) => {
        if (!a || typeof a !== "object") return false;
        const rec = a as Record<string, unknown>;
        if (rec.self === true) return true;
        const email = String(rec.email ?? "")
          .toLowerCase()
          .trim();
        return email !== "" && email === selfEmail;
      });
      if (!userInAttendees) return null;
    }
    if (p.my_response !== "needsAction") return null;
    const organizer = p.organizer == null ? null : String(p.organizer);
    const organizerIsSelf =
      !!opts?.activeUserEmail &&
      organizer != null &&
      organizer.toLowerCase().trim() ===
        opts.activeUserEmail.toLowerCase().trim();
    const attendeesCount = Array.isArray(p.attendees) ? p.attendees.length : 0;
    return {
      type: "rsvp",
      title: `RSVP — ${String(p.title ?? p.summary ?? "Meeting")}`,
      action: {
        kind: "calendar_rsvp",
        // `response: null` is intentional — the user picks Yes / No /
        // Maybe at run time. Defaulting to "accepted" silently performs
        // an external write on the user's behalf, which is the exact
        // failure mode issue #355 names. The surrounding metadata lets
        // the UI render the card with full context (organizer, time,
        // status, attendee count) instead of guessing.
        params: {
          eventId: p.eventId ?? p.id,
          response: null,
          start: p.start,
          end: p.end,
          organizer,
          organizerIsSelf,
          attendeesCount,
          status: p.status,
          my_response: p.my_response,
        },
      },
    };
  }

  if (signal.type === "github_pr" && p.state === "open") {
    const requested = Array.isArray(p.requested_reviewers)
      ? p.requested_reviewers.length
      : 0;
    if (p.user_is_reviewer || requested === 0) {
      return {
        type: "review_pr",
        title: `Review PR #${String(p.number)} — ${String(p.title)}`,
        action: {
          kind: "github_review",
          params: { repo: p.repo, number: p.number },
        },
      };
    }
  }

  if (
    signal.type === "github_issue" &&
    p.assignee_login &&
    p.state === "open"
  ) {
    return {
      type: "todo",
      title: `Pick up issue #${String(p.number)} — ${String(p.title)}`,
      action: {
        kind: "todo",
        params: { title: p.title, repo: p.repo, number: p.number },
      },
    };
  }

  // ---- deadline_reminder rule (co-equal with rsvp / draft_reply / etc.) ----
  const deadlineHint = p._deadlineHint as
    | {
        deadlineAt: string;
        message: string;
        notifyAt?: string;
        confidence?: number;
      }
    | undefined;
  if (
    deadlineHint &&
    typeof deadlineHint.deadlineAt === "string" &&
    typeof deadlineHint.message === "string" &&
    (deadlineHint.confidence ?? 1) >= 0.7 &&
    (signal.type === "email" ||
      signal.type === "calendar_event" ||
      signal.type === "obsidian_note_changed" ||
      signal.type === "insight")
  ) {
    const sourceMap: Record<
      string,
      "email" | "calendar" | "obsidian" | "insight"
    > = {
      email: "email",
      calendar_event: "calendar",
      obsidian_note_changed: "obsidian",
      insight: "insight",
    };
    const source = sourceMap[signal.type];
    if (source) {
      // Mutual exclusion with draft_reply: when the signal is an email, let
      // the email branch below emit draft_reply (draft_reply wins when both
      // rules match — replying is more actionable than a separate reminder).
      // For calendar_event / obsidian_note_changed / insight there is no
      // competing branch, so the deadline_reminder fires here.
      if (signal.type !== "email") {
        const deadlineAt = deadlineHint.deadlineAt;
        const notifyAt =
          deadlineHint.notifyAt ||
          new Date(
            new Date(deadlineAt).getTime() - 60 * 60 * 1000,
          ).toISOString();
        const sourceRef: Record<string, unknown> = {};
        if (p.messageId) sourceRef.messageId = p.messageId;
        if (p.eventId) sourceRef.eventId = p.eventId;
        if (p.path) sourceRef.path = p.path;
        const when = new Date(deadlineAt).toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        const subject = String(p.subject ?? p.title ?? p.path ?? "Deadline");
        return {
          type: "deadline_reminder",
          title: `Deadline ${when}: ${subject}`.slice(0, 120),
          action: {
            kind: "deadline_notify",
            params: {
              source,
              sourceRef,
              deadlineAt,
              message: deadlineHint.message,
              notifyAt,
              channel: "calendar",
            },
          },
          confidence: deadlineHint.confidence,
        };
      }
    }
  }

  if (signal.type === "email") {
    // Sender/origin evidence wins over subject-word matches. An automated
    // or notification sender (e.g. notifications@github.com) must never
    // yield a sendable email_reply, even when the subject happens to
    // contain "RSVP", "invite", "review", etc. This runs unconditionally
    // inside classify() — independent of the noReplySkip preference and
    // the gateSignal() wiring — so the invariant holds on every path,
    // including the agentic tick that reconstructs these rules. #367.
    if (isAutomatedSender(p.from)) {
      return null;
    }
    if (/(rsvp|invit|meeting|join.*call|calendar)/.test(text)) {
      return {
        type: "draft_reply",
        title: `Reply: ${String(p.subject ?? "(no subject)")}`,
        action: {
          kind: "email_reply",
          params: {
            to: p.from,
            subject: p.subject ? `Re: ${p.subject}` : "",
            threadId: p.threadId,
          },
        },
      };
    }
    if (
      p.from &&
      !String(p.from).includes("noreply") &&
      /(please|could you|can you|need|asap|urgent|deadline|review)/.test(text)
    ) {
      return {
        type: "draft_reply",
        title: `Reply: ${String(p.subject ?? "(no subject)")}`,
        action: {
          kind: "email_reply",
          params: {
            to: p.from,
            subject: p.subject ? `Re: ${p.subject}` : "",
            threadId: p.threadId,
          },
        },
      };
    }
  }

  if (signal.type === "slack_message" && p.mentions_me) {
    return {
      type: "slack_reply",
      title: `Reply in #${String(p.channel ?? "channel")}`,
      action: {
        kind: "slack_reply",
        params: { channel: p.channel, ts: p.ts },
      },
    };
  }

  if (signal.type === "linear_issue" && p.identifier) {
    const labelNames = Array.isArray(p.labels)
      ? (p.labels as unknown[]).join(" ").toLowerCase()
      : "";
    const lText =
      `${String(p.title ?? "")} ${String(p.description ?? "")}`.toLowerCase();
    if (
      /(upload|upload-large|churn|onboard|invit)/.test(labelNames) ||
      /(upload|churn|onboard|invite).*(fail|broken|loss|drop)/.test(lText)
    ) {
      return {
        type: "requirement_synthesis",
        title: `Synthesize requirement: ${String(p.title ?? p.identifier)}`,
        action: {
          kind: "requirement_synthesis",
          params: {
            draft_target: "linear:new",
            title: `[REQ] ${String(p.title ?? p.identifier)}`,
            body_template: "PR/FAQ",
            evidence_count: 1,
            source_issue_id: p.identifier,
          },
        },
      };
    }
    return {
      type: "linear_review",
      title: `Review ${String(p.identifier)}: ${String(p.title ?? "")}`.trim(),
      action: {
        kind: "linear_review",
        params: { issue_id: p.identifier, scope_check: true },
      },
    };
  }

  if (signal.type === "obsidian_note_changed" && p.path) {
    const path = String(p.path);
    const folder = path.split("/").slice(0, -1).pop()?.toLowerCase() ?? "";

    if (folder === "projects" || folder === "plans") {
      return {
        type: "release_plan",
        title: `Update release plan: ${path}`,
        action: {
          kind: "release_plan",
          params: { source_path: path, mtime_ms: p.mtime_ms },
        },
      };
    }
    if (folder === "people") {
      return {
        type: "todo",
        title: `Update contact: ${path}`,
        action: {
          kind: "contact_update",
          params: { source_path: path, mtime_ms: p.mtime_ms },
        },
      };
    }
    if (folder === "customers") {
      return {
        type: "requirement_synthesis",
        title: `Customer note changed — re-review requirements: ${path}`,
        action: {
          kind: "requirement_synthesis",
          params: {
            draft_target: "linear:new",
            source_path: path,
            evidence_count: 1,
          },
        },
      };
    }
    return {
      type: "doc_update",
      title: `Regenerate document: ${path}`,
      action: {
        kind: "doc_update",
        params: { target_path: path, source_path: path, mtime_ms: p.mtime_ms },
      },
    };
  }

  return null;
}

/**
 * Helper for the brief/wrap generators: returns a card-shaped decision (with
 * `dialogue` + `nextStep`) instead of the leaner signal-derived shape. Both
 * forms live in the same `decisions.json` bucket — `type` discriminates.
 */
export function buildCardDecision(input: {
  type: DecisionType;
  title: string;
  action: LoopAction;
  dialogue: string;
  nextStep: string;
  context?: LoopDecision["context"];
}): LoopDecision {
  return {
    id: "", // assigned by store.add
    ts: "",
    status: "pending",
    type: input.type,
    title: input.title,
    action: input.action,
    dialogue: input.dialogue,
    nextStep: input.nextStep,
    ...(input.context ? { context: input.context } : {}),
  };
}

export const rules = {
  isHardSkipped,
  isMuted,
  gateSignal,
  classify,
  isAutomatedSender,
  NORELY_RE,
  PROMO_LABELS,
};
export type { ActionKind };
