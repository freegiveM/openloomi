/**
 * Regression coverage for `lib/loop/classify.ts` calendar_event gates.
 *
 * Issue #355: historical self-owned Google Calendar entries were being
 * misclassified as actionable RSVPs because the reference classifier
 * (a) didn't validate that the returned event's `start`/`end` timestamps
 * fell inside the prompt's `[now, now + 7d]` window, (b) treated a
 * missing `my_response` as `needsAction`, (c) emitted `calendar_rsvp`
 * actions defaulting to `response: "accepted"`, and (d) surfaced
 * self-owned no-attendee events (a Google Calendar API quirk that
 * pushes all-day private entries through the same surface as real
 * invitations). The acceptance criteria require regression tests for
 * each path: historical events, self-owned events without attendees,
 * already-confirmed events, and genuine pending invitations.
 *
 * The test uses `vi.useFakeTimers()` so all date math is deterministic
 * against `2026-07-16T12:00:00Z` regardless of the host's wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mutable tmp dir reference for the mocked paths module. Each beforeEach
// creates a fresh dir and rewrites LOOP_HOME so test runs are isolated
// from each other AND from the user's real ~/.openloomi/loop.
let LOOP_HOME = "";

vi.mock("@/lib/loop/paths", async () => {
  const { dirname, join } = await import("node:path");
  const buildPaths = () => ({
    home: LOOP_HOME,
    signals: join(LOOP_HOME, "signals.jsonl"),
    decisions: join(LOOP_HOME, "decisions.json"),
    status: join(LOOP_HOME, "status.json"),
    brief: join(LOOP_HOME, "brief.json"),
    wrap: join(LOOP_HOME, "wrap.json"),
    connectors: join(LOOP_HOME, "connectors.json"),
    config: join(LOOP_HOME, "config.json"),
    mutes: join(LOOP_HOME, "mutes.json"),
    migrated: join(LOOP_HOME, "migrated.json"),
    log: join(LOOP_HOME, "loop.log"),
    inbox: join(LOOP_HOME, "inbox"),
    syncState: join(LOOP_HOME, "sync-state.json"),
    customTypes: join(LOOP_HOME, "custom-types.json"),
    customChannels: join(LOOP_HOME, "custom-channels.json"),
    classifierRules: join(LOOP_HOME, "classifier-rules.json"),
    activationState: join(LOOP_HOME, "activation_state.json"),
  });
  const pathsProxy = new Proxy(
    {},
    {
      get: (_t, prop: string) => (buildPaths() as Record<string, string>)[prop],
    },
  );
  return {
    get LOOP_HOME() {
      return LOOP_HOME;
    },
    LOOP_PATHS: pathsProxy,
    ensureDirs: () => {
      mkdirSync(LOOP_HOME, { recursive: true });
    },
    ensureParent: (p: string) => {
      mkdirSync(dirname(p), { recursive: true });
    },
    migrate: () => null,
  };
});

const { classify, isHardSkipped, gateSignal, rules } =
  await import("@/lib/loop/classify");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomi-classify-"));
  LOOP_HOME = join(tmp, ".openloomi", "loop");
  mkdirSync(LOOP_HOME, { recursive: true });
  // Freeze "now" at 2026-07-16T12:00:00Z for deterministic time math
  // (7-day horizon = 2026-07-23T12:00:00Z).
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

const TEST_PREFS = { noReplySkip: false, promotionSkip: false };

function makeCalendarSignal(payload: Record<string, unknown>) {
  return {
    id: "sig_test",
    ts: "2026-07-16T12:00:00.000Z",
    source: "googlecalendar",
    type: "calendar_event" as const,
    payload: {
      eventId: "evt_test_1",
      title: "Test meeting",
      ...payload,
    },
  };
}

describe("classify — calendar_event gates", () => {
  it("drops historical events (start/end in the past) as 'event ended'", () => {
    const sig = makeCalendarSignal({
      start: "2014-06-01T00:00:00Z",
      end: "2014-06-02T00:00:00Z",
      my_response: "needsAction",
      organizer: "user@example.com",
      attendees: [],
    });
    const skip = isHardSkipped(sig, TEST_PREFS);
    expect(skip).not.toBeNull();
    expect(skip?.reason).toBe("event ended");
    expect(classify(sig)).toBeNull();
  });

  it("drops self-owned events with no attendees when activeUserEmail is known", () => {
    const tomorrow = new Date("2026-07-17T12:00:00Z").toISOString();
    const sig = makeCalendarSignal({
      start: tomorrow,
      end: tomorrow,
      my_response: "needsAction",
      organizer: "self@example.com",
      attendees: [],
    });
    const skip = isHardSkipped(sig, TEST_PREFS, {
      activeUserEmail: "self@example.com",
    });
    expect(skip).not.toBeNull();
    expect(skip?.reason).toBe("self-owned event, no attendees");
  });

  it("does NOT drop self-owned events with no attendees when activeUserEmail is unset (legacy permissive)", () => {
    const tomorrow = new Date("2026-07-17T12:00:00Z").toISOString();
    const sig = makeCalendarSignal({
      start: tomorrow,
      end: tomorrow,
      my_response: "needsAction",
      organizer: "self@example.com",
      attendees: [],
    });
    // Without the email, the self-owned gate is dormant — we still
    // reach the classify() branch.
    const skip = isHardSkipped(sig, TEST_PREFS);
    expect(skip).toBeNull();
  });

  it("drops events already accepted/declined/tentative", () => {
    const tomorrow = new Date("2026-07-17T12:00:00Z").toISOString();
    const sig = makeCalendarSignal({
      start: tomorrow,
      end: tomorrow,
      my_response: "accepted",
      organizer: "other@example.com",
      attendees: [{ email: "self@example.com" }],
    });
    const skip = isHardSkipped(sig, TEST_PREFS);
    expect(skip).not.toBeNull();
    expect(skip?.reason).toBe("already accepted");
  });

  it("emits a calendar_rsvp decision for genuine pending invitations with full metadata", () => {
    const start = "2026-07-17T12:00:00Z";
    const end = "2026-07-17T13:00:00Z";
    const sig = makeCalendarSignal({
      start,
      end,
      my_response: "needsAction",
      organizer: "other@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "confirmed",
    });
    const decision = classify(sig, { activeUserEmail: "self@example.com" });
    expect(decision).not.toBeNull();
    expect(decision?.type).toBe("rsvp");
    expect(decision?.action.kind).toBe("calendar_rsvp");
    const params = decision?.action.params as Record<string, unknown>;
    expect(params.eventId).toBe("evt_test_1");
    expect(params.response).toBeNull();
    expect(params.start).toBe(start);
    expect(params.end).toBe(end);
    expect(params.organizer).toBe("other@example.com");
    expect(params.organizerIsSelf).toBe(false);
    expect(params.attendeesCount).toBe(1);
    expect(params.status).toBe("confirmed");
    expect(params.my_response).toBe("needsAction");
  });

  it("drops events with missing my_response (the regression case — issue #355)", () => {
    const start = "2014-06-01T00:00:00Z";
    const end = "2014-06-02T00:00:00Z";
    // Future event so the "event ended" gate doesn't catch it first —
    // we want to assert that the missing-my_response gate alone fires.
    const sig = makeCalendarSignal({
      start,
      end,
      // my_response is intentionally absent (undefined)
      organizer: "user@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "confirmed",
    });
    // Use a future window to isolate the missing-my_response gate from
    // the "event ended" gate — but make `end` future so only the
    // missing-response gate should fire.
    const future = new Date("2026-07-17T12:00:00Z").toISOString();
    const futureSig = makeCalendarSignal({
      start: future,
      end: future,
      organizer: "user@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "confirmed",
    });
    // Sanity: with future timestamps and no my_response, the only gate
    // that should fire is "missing my_response" (organizer != self,
    // user is in attendees, status != cancelled).
    const skip = isHardSkipped(futureSig, TEST_PREFS, {
      activeUserEmail: "self@example.com",
    });
    expect(skip).not.toBeNull();
    expect(skip?.reason).toBe("missing my_response");
    expect(
      classify(futureSig, { activeUserEmail: "self@example.com" }),
    ).toBeNull();

    // Historical-shape (2014) still gets dropped, but with the
    // end-first gate kicking in (no my_response AND past end). Either
    // gate alone is sufficient to drop the signal — the test asserts
    // the classification path returns null regardless.
    const historicalSig = makeCalendarSignal({
      start,
      end,
      organizer: "user@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "confirmed",
    });
    expect(
      classify(historicalSig, { activeUserEmail: "self@example.com" }),
    ).toBeNull();
  });

  it("drops cancelled events regardless of my_response", () => {
    const tomorrow = new Date("2026-07-17T12:00:00Z").toISOString();
    const sig = makeCalendarSignal({
      start: tomorrow,
      end: tomorrow,
      my_response: "needsAction",
      organizer: "other@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "cancelled",
    });
    const skip = isHardSkipped(sig, TEST_PREFS);
    expect(skip).not.toBeNull();
    expect(skip?.reason).toBe("event cancelled");
  });

  it("drops events whose start is beyond the 7-day forward window", () => {
    const farFuture = new Date("2026-07-25T12:00:00Z").toISOString(); // +9d
    const sig = makeCalendarSignal({
      start: farFuture,
      end: farFuture,
      my_response: "needsAction",
      organizer: "other@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "confirmed",
    });
    const skip = isHardSkipped(sig, TEST_PREFS, {
      activeUserEmail: "self@example.com",
    });
    expect(skip).not.toBeNull();
    expect(skip?.reason).toBe("event beyond 7-day window");
  });

  it("still emits a rsvp for self-owned events when attendees are present (you can RSVP to your own meeting)", () => {
    const start = "2026-07-17T12:00:00Z";
    const end = "2026-07-17T13:00:00Z";
    const sig = makeCalendarSignal({
      start,
      end,
      my_response: "needsAction",
      organizer: "self@example.com",
      attendees: [
        { email: "self@example.com" },
        { email: "other@example.com" },
      ],
      status: "confirmed",
    });
    // hard-skip path: the self-owned-no-attendees gate should NOT fire
    // because attendees is non-empty.
    const skip = isHardSkipped(sig, TEST_PREFS, {
      activeUserEmail: "self@example.com",
    });
    expect(skip).toBeNull();
    // classify: user is in attendees, so the rsvp decision lands.
    const decision = classify(sig, { activeUserEmail: "self@example.com" });
    expect(decision).not.toBeNull();
    expect(decision?.type).toBe("rsvp");
    const params = decision?.action.params as Record<string, unknown>;
    expect(params.response).toBeNull();
    expect(params.attendeesCount).toBe(2);
  });

  it("sets organizerIsSelf correctly (false for other-organizer, true for self-organizer with attendees)", () => {
    const start = "2026-07-17T12:00:00Z";
    const end = "2026-07-17T13:00:00Z";

    // Case A: other-organizer → organizerIsSelf: false
    const otherOrg = makeCalendarSignal({
      start,
      end,
      my_response: "needsAction",
      organizer: "other@example.com",
      attendees: [{ email: "self@example.com" }],
      status: "confirmed",
    });
    const decA = classify(otherOrg, { activeUserEmail: "self@example.com" });
    expect(
      (decA?.action.params as Record<string, unknown>).organizerIsSelf,
    ).toBe(false);

    // Case B: self-organizer with attendees → organizerIsSelf: true
    const selfOrg = makeCalendarSignal({
      start,
      end,
      my_response: "needsAction",
      organizer: "self@example.com",
      attendees: [
        { email: "self@example.com" },
        { email: "other@example.com" },
      ],
      status: "confirmed",
    });
    const decB = classify(selfOrg, { activeUserEmail: "self@example.com" });
    expect(
      (decB?.action.params as Record<string, unknown>).organizerIsSelf,
    ).toBe(true);
  });

  it("gateSignal chains isMuted → isHardSkipped and respects opts", () => {
    const start = "2026-07-17T12:00:00Z";
    const end = "2026-07-17T13:00:00Z";
    const sig = makeCalendarSignal({
      start,
      end,
      my_response: "needsAction",
      organizer: "self@example.com",
      attendees: [],
    });
    // Without opts the self-owned gate doesn't fire → gateSignal passes
    // (no mutes match, no hard skip).
    expect(gateSignal(sig, TEST_PREFS)).toBeNull();
    // With opts the self-owned gate fires → gateSignal drops it.
    const gated = gateSignal(sig, TEST_PREFS, {
      activeUserEmail: "self@example.com",
    });
    expect(gated).not.toBeNull();
    expect(gated?.reason).toBe("self-owned event, no attendees");
  });
});

/**
 * Regression coverage for issue #367: GitHub (and other automated)
 * notification emails whose subject happens to contain RSVP-related
 * words were misclassified as sendable `draft_reply` decisions.
 *
 * The invariant: sender/origin evidence wins over subject-word matches.
 * `classify()` must drop automated/notification senders BEFORE the two
 * email draft_reply branches — unconditionally, regardless of the
 * noReplySkip preference or gateSignal() wiring — while still surfacing
 * genuine human correspondence.
 */
function makeEmailSignal(payload: Record<string, unknown>) {
  return {
    id: "sig_email_test",
    ts: "2026-07-16T12:00:00.000Z",
    source: "gmail",
    type: "email" as const,
    payload,
  };
}

describe("classify — email automated-sender gate (#367)", () => {
  it("does NOT create a draft_reply for a GitHub notification titled 'restructure RSVP cards'", () => {
    const sig = makeEmailSignal({
      from: "notifications@github.com",
      subject:
        "Re: [melandlabs/openloomi] ux(loop): restructure RSVP cards (#363)",
      snippet: "xingxingluolei commented on this issue.",
      threadId: "t1",
    });
    expect(classify(sig)).toBeNull();
  });

  it("catches a notification sender wrapped in a display name", () => {
    const sig = makeEmailSignal({
      from: "melandlabs/openloomi <notifications@github.com>",
      subject: "Please review pull request #400",
      snippet: "A new pull request needs your review.",
      threadId: "t2",
    });
    expect(rules.isAutomatedSender(sig.payload.from)).toBe(true);
    expect(classify(sig)).toBeNull();
  });

  it("does NOT create a card for closed/reopened/commented issue notifications", () => {
    for (const subject of [
      "Re: [melandlabs/openloomi] Issue closed (#363)",
      "Re: [melandlabs/openloomi] Issue reopened (#363)",
      "Re: [melandlabs/openloomi] New comment on invite flow (#358)",
    ]) {
      const sig = makeEmailSignal({
        from: "notifications@github.com",
        subject,
        snippet: "View it on GitHub.",
        threadId: "t3",
      });
      expect(classify(sig)).toBeNull();
    }
  });

  it("still surfaces a real human email asking for an RSVP", () => {
    const sig = makeEmailSignal({
      from: "mira@acme.dev",
      subject: "Can you RSVP for the launch dinner?",
      snippet: "Let me know if you can make it Thursday.",
      threadId: "t4",
    });
    const decision = classify(sig);
    expect(decision).not.toBeNull();
    expect(decision?.type).toBe("draft_reply");
    expect(decision?.action.kind).toBe("email_reply");
    expect((decision?.action.params as Record<string, unknown>).to).toBe(
      "mira@acme.dev",
    );
  });

  it("still surfaces a human email wrapped in a display name", () => {
    const sig = makeEmailSignal({
      from: "Mira Chen <mira@acme.dev>",
      subject: "Could you review the deck before Friday?",
      snippet: "Need your eyes on slides 3-5.",
      threadId: "t5",
    });
    const decision = classify(sig);
    expect(decision?.type).toBe("draft_reply");
  });

  it("drops other automated senders (noreply@, mailer-daemon@) regardless of subject", () => {
    for (const from of [
      "noreply@stripe.com",
      "no-reply@calendar.google.com",
      "mailer-daemon@googlemail.com",
    ]) {
      const sig = makeEmailSignal({
        from,
        subject: "Meeting invite — please review",
        snippet: "urgent: action needed",
        threadId: "t6",
      });
      expect(rules.isAutomatedSender(from)).toBe(true);
      expect(classify(sig)).toBeNull();
    }
  });
});
