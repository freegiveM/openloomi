/**
 * Decision context helper (#363) — extracts the user-facing facts a person
 * needs to decide on a card, separate from the classifier/provenance metadata
 * the rest of the card surface already renders.
 *
 * The renderer (`components/loop/decision-context-block.tsx`) is a typed
 * dispatcher: each registered decision type produces its own `DecisionContext`
 * shape and the block renders the rows. The helper here is intentionally
 * narrow:
 *
 *   - it returns `null` for types without a registered variant, so the
 *     renderer can safely no-op and the rest of the card stays untouched;
 *   - it is pure (no I/O, no locale fetch) — locale is plumbed through so
 *     tests can pin `now` and `locale` deterministically;
 *   - the field shape is intentionally flat: `icon` / `label` / `value` /
 *     optional `href`. Translation happens in the renderer, not here.
 *
 * Follow-up PRs can add a `case "email_reply"` / `case "review_pr"` branch
 * without touching the renderer contract.
 */

export interface DecisionContextField {
  /** Remix icon id used by the renderer. */
  icon: string;
  /** i18n key for the field label (e.g. `loop.rsvp.fieldTime`). */
  label: string;
  /**
   * Pre-rendered, locale-formatted value. The helper formats timestamps /
   * counts so the renderer does not have to think about dates.
   */
  value: string;
  /**
   * Optional link target for fields like "Location" / "Meeting link" /
   * "View original". When present, the renderer wraps the value in an
   * `<a target="_blank" rel="noreferrer">` instead of plain text.
   */
  href?: string;
}

export interface DecisionContext {
  /**
   * Mirrors `DecisionType` so the renderer can dispatch on a single
   * key. Using `string` (not the enum) keeps the helper open for
   * user-defined types — `null` is the explicit "no context block"
   * signal.
   */
  type: string;
  fields: DecisionContextField[];
}

/**
 * Minimal input shape. The full `LoopDecision` is wider than this helper
 * needs (memory_refs, person, project_ref, etc. are rendered elsewhere),
 * so we accept only what we read.
 */
interface DecisionLike {
  type: string;
  action?: { params?: Record<string, unknown> } | null;
}

export interface DeriveDecisionContextOptions {
  /**
   * Reference "now" for relative time labels (e.g. "Tomorrow, 09:30").
   * Defaults to `new Date()`. Tests pass a fixed Date to keep assertions
   * stable across runs.
   */
  now?: Date;
  /**
   * BCP-47 locale tag for date/number formatting. Defaults to `en-US`.
   * The server-side `defaultDialogue` fallback uses English so non-ASCII
   * callers don't crash if no locale is plumbed.
   */
  locale?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function params(d: DecisionLike): Record<string, unknown> {
  const p = d.action?.params;
  return p && typeof p === "object" ? p : {};
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseTimestamp(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw.trim());
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

/**
 * Format a Date as a calendar day label (e.g. "Today, 09:30" / "Tomorrow,
 * 14:00" / "Wed, Jul 22, 09:30"). Anchored on `now` so the day-relative
 * prefix is deterministic in tests.
 */
function formatDayLabel(date: Date, now: Date, locale: string): string {
  const prefix = relativeDayLabel(date, now);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (!prefix) {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return `${prefix}, ${time}`;
}

function relativeDayLabel(date: Date, now: Date): string | null {
  // Compare UTC calendar days — the timestamps come in as ISO-8601 in
  // UTC (`Z` suffix), so the natural interpretation of "same day as
  // `now`" is "same UTC date". Without this, a CI box running in a
  // non-UTC timezone would label an 18:00Z event as "Tomorrow" because
  // it's already the next day locally.
  const a = startOfUtcDay(now).getTime();
  const b = startOfUtcDay(date).getTime();
  const dayDelta = Math.round((b - a) / 86_400_000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Tomorrow";
  if (dayDelta === -1) return "Yesterday";
  return null;
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/**
 * Format an attendee count as `"N invited"` (or `"N invited · M accepted"`
 * when the accepted count is present). Returns `null` when the count is
 * unknown so the renderer can drop the row instead of printing "0 invited".
 */
function formatAttendance(
  raw: Record<string, unknown>,
): { value: string } | null {
  const invitedRaw = raw.attendeesCount;
  const acceptedRaw = raw.attendeesAcceptedCount;
  const invited =
    typeof invitedRaw === "number" && Number.isFinite(invitedRaw)
      ? invitedRaw
      : null;
  const accepted =
    typeof acceptedRaw === "number" && Number.isFinite(acceptedRaw)
      ? acceptedRaw
      : null;
  if (invited == null && accepted == null) return null;
  const invitedLabel =
    invited == null ? "" : `${invited} invited${accepted != null ? " · " : ""}`;
  const acceptedLabel = accepted == null ? "" : `${accepted} accepted`;
  const value = `${invitedLabel}${acceptedLabel}`.trim();
  return value ? { value } : null;
}

/**
 * Decide whether an `htmlLink` value should be promoted to a clickable
 * location field. Only treat it as a meeting link when it looks like an
 * HTTPS URL — `mailto:` / `tel:` / `geo:` are intentionally excluded so a
 * stray calendar response doesn't hijack the Location row.
 */
function isVideoUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

// ---------------------------------------------------------------------------
// Per-type context builders
// ---------------------------------------------------------------------------

function deriveRsvpContext(
  decision: DecisionLike,
  opts: Required<DeriveDecisionContextOptions>,
): DecisionContext | null {
  const p = params(decision);
  const fields: DecisionContextField[] = [];

  // ── Time ────────────────────────────────────────────────────────────
  const start = parseTimestamp(p.start);
  const end = parseTimestamp(p.end);
  if (start) {
    const startLabel = formatDayLabel(start, opts.now, opts.locale);
    let value = startLabel;
    if (end && end.getTime() !== start.getTime()) {
      // Same-day end → append the end time. Cross-day end → already labelled
      // by `formatDayLabel`, so render the end date separately for clarity.
      const sameDay =
        startOfUtcDay(start).getTime() === startOfUtcDay(end).getTime();
      const endTime = new Intl.DateTimeFormat(opts.locale, {
        hour: "numeric",
        minute: "2-digit",
      }).format(end);
      if (sameDay) {
        value = `${startLabel}–${endTime}`;
      } else {
        value = `${startLabel} → ${formatDayLabel(end, opts.now, opts.locale)}`;
      }
    }
    fields.push({ icon: "ri-time-line", label: "loop.rsvp.fieldTime", value });
  }

  // ── Organizer ───────────────────────────────────────────────────────
  const organizer = nonEmptyString(p.organizer) ? p.organizer.trim() : null;
  if (organizer) {
    const displayName = organizerName(organizer);
    fields.push({
      icon: "ri-user-line",
      label: "loop.rsvp.fieldOrganizer",
      value: displayName,
    });
  }

  // ── Attendance ─────────────────────────────────────────────────────
  const attendance = formatAttendance(p);
  if (attendance) {
    fields.push({
      icon: "ri-team-line",
      label: "loop.rsvp.fieldAttendance",
      value: attendance.value,
    });
  }

  // ── Location / meeting link ────────────────────────────────────────
  // Prefer a free-text location; fall back to `htmlLink` when it looks
  // like a video URL (Google Meet / Zoom / Teams). The link is the
  // href target either way so the user can always jump to the source.
  const location = nonEmptyString(p.location) ? p.location.trim() : null;
  const htmlLink = nonEmptyString(p.htmlLink) ? p.htmlLink.trim() : null;
  if (location || htmlLink) {
    const value = location ?? htmlLink ?? "";
    const href =
      htmlLink && isVideoUrl(htmlLink)
        ? htmlLink
        : location && isVideoUrl(location)
          ? location
          : undefined;
    fields.push({
      icon: "ri-map-pin-line",
      label: "loop.rsvp.fieldLocation",
      value,
      ...(href ? { href } : {}),
    });
  }

  // ── Conflict (#363 explicit placeholder) ───────────────────────────
  // Real freebusy detection is out of scope for this PR. The row stays
  // so the structure is in place when a follow-up wires up the lookup.
  fields.push({
    icon: "ri-calendar-line",
    label: "loop.rsvp.fieldConflict",
    value: "loop.rsvp.conflictNone",
  });

  // If every row collapsed (no time, no organizer, no attendance, no
  // location) we still want to render the conflict placeholder, so we
  // don't return null here. The renderer can short-circuit on an empty
  // `fields` array if it wants to.
  return { type: "rsvp", fields };
}

/**
 * Pick a display name out of an organizer string. Accepts:
 *   - "Sam Lee <sam@example.com>"  → "Sam Lee"
 *   - "sam@example.com"            → "sam@example.com" (no name part to strip)
 *   - "Sam"                        → "Sam"
 *
 * The calendar payload already strips the angle brackets — we only split
 * on the LAST occurrence of `<` so values like `Foo <bar>` work and bare
 * emails round-trip unchanged.
 */
function organizerName(raw: string): string {
  const lt = raw.lastIndexOf("<");
  if (lt < 0) return raw;
  const name = raw.slice(0, lt).trim();
  return name || raw;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the decision context for a card, or `null` when the type has no
 * registered variant. The renderer treats `null` as "don't render a context
 * block" — non-RSVP cards currently fall through to that branch.
 */
export function deriveDecisionContext(
  decision: DecisionLike,
  options: DeriveDecisionContextOptions = {},
): DecisionContext | null {
  const opts: Required<DeriveDecisionContextOptions> = {
    now: options.now ?? new Date(),
    locale: options.locale ?? "en-US",
  };
  switch (decision.type) {
    case "rsvp":
      return deriveRsvpContext(decision, opts);
    // Other types fall through and return null until a follow-up PR adds
    // a builder (email_reply / review_pr / deadline_reminder / …). The
    // architecture is type-extensible on purpose.
    default:
      return null;
  }
}
