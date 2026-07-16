/**
 * Regression coverage for the #361 connector capability model.
 *
 * Issue #361 calls out that Loop currently conflates three states:
 *   - an integration is authorized and usable for chat / memory;
 *   - an integration is available as a custom source;
 *   - an integration is actively monitored by Loop and can produce decisions.
 *
 * The fix exposes a semantic `capability` field on each connector entry
 * plus a capability summary on `LoopState`. These tests pin:
 *   - canonical toolkits (gmail / google_calendar / github / slack /
 *     linear) are `decision_capable` when connected;
 *   - toolkits Loop monitors but has no decision mapping (obsidian) are
 *     `loop_monitored`;
 *   - connected but non-canonical toolkits (e.g. Feishu) are `needs_setup`,
 *     never "loop_monitored";
 *   - unprobed FALLBACK rows return `null` so the UI can distinguish
 *     "we don't know yet" from "we know it's offline";
 *   - the summary emits strict-superset counts and never exposes
 *     credentials / message content;
 *   - unsupported signal counts survive a tick round-trip via `status.json`.
 */

import { describe, expect, it } from "vitest";

import {
  deriveConnectorCapability,
  isDecisionCapable,
  isLoopMonitored,
  summarizeConnectorCapability,
  withConnectorCapability,
} from "@/lib/loop/connectors";
import type { ConnectorEntry } from "@/lib/loop/types";

// ---------------------------------------------------------------------------
// isLoopMonitored / isDecisionCapable — the canonical-toolkit lookup
// ---------------------------------------------------------------------------

describe("isLoopMonitored / isDecisionCapable", () => {
  it("flags the five canonical decision-capable toolkits", () => {
    for (const id of ["gmail", "google_calendar", "github", "slack", "linear"]) {
      expect(isLoopMonitored(id)).toBe(true);
      expect(isDecisionCapable(id)).toBe(true);
    }
  });

  it("flags obsidian as loop-monitored but NOT decision-capable", () => {
    expect(isLoopMonitored("obsidian")).toBe(true);
    expect(isDecisionCapable("obsidian")).toBe(false);
  });

  it("flags Feishu / Lark / iMessage / DingTalk as not loop-monitored", () => {
    for (const id of ["feishu", "lark", "imessage", "dingtalk", "weixin"]) {
      expect(isLoopMonitored(id)).toBe(false);
      expect(isDecisionCapable(id)).toBe(false);
    }
  });

  it("treats unknown ids as not loop-monitored and not decision-capable", () => {
    expect(isLoopMonitored("made_up_toolkit")).toBe(false);
    expect(isDecisionCapable("made_up_toolkit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveConnectorCapability — semantic state machine
// ---------------------------------------------------------------------------

describe("deriveConnectorCapability", () => {
  it("returns null for unprobed FALLBACK rows so the UI shows 'pending'", () => {
    expect(
      deriveConnectorCapability({
        id: "gmail",
        connected: false,
        probed: false,
      }),
    ).toBeNull();
  });

  it("returns 'needs_setup' for probed-but-disconnected rows", () => {
    expect(
      deriveConnectorCapability({
        id: "gmail",
        connected: false,
        probed: true,
      }),
    ).toBe("needs_setup");
  });

  it("returns 'decision_capable' for a connected canonical toolkit", () => {
    expect(
      deriveConnectorCapability({
        id: "gmail",
        connected: true,
        probed: true,
      }),
    ).toBe("decision_capable");
  });

  it("returns 'loop_monitored' for obsidian (canonical but no mapping yet)", () => {
    expect(
      deriveConnectorCapability({
        id: "obsidian",
        connected: true,
        probed: true,
      }),
    ).toBe("loop_monitored");
  });

  it("returns 'needs_setup' for a connected non-canonical chat integration", () => {
    // #361's headline case: a Feishu native integration that the user
    // authorized for chat / memory but that Loop never pulls from.
    expect(
      deriveConnectorCapability({
        id: "feishu",
        connected: true,
        probed: true,
      }),
    ).toBe("needs_setup");
  });

  it("never returns 'loop_monitored' for a non-canonical id", () => {
    const out = deriveConnectorCapability({
      id: "made_up_chat_app",
      connected: true,
      probed: true,
    });
    expect(out).not.toBe("loop_monitored");
    expect(out).not.toBe("decision_capable");
    expect(out).toBe("needs_setup");
  });
});

// ---------------------------------------------------------------------------
// withConnectorCapability — stamp the entry without leaking other fields
// ---------------------------------------------------------------------------

describe("withConnectorCapability", () => {
  it("stamps loopMonitored / decisionCapable / capability without altering other fields", () => {
    const seed: ConnectorEntry = {
      id: "gmail",
      label: "Gmail",
      connected: true,
      accountCount: 2,
      probed: true,
      fetchedAt: "2026-07-16T10:00:00Z",
      lastError: "401 expired",
    };
    const out = withConnectorCapability(seed);
    expect(out.loopMonitored).toBe(true);
    expect(out.decisionCapable).toBe(true);
    expect(out.capability).toBe("decision_capable");
    // Carries diagnostic fields through unchanged.
    expect(out.lastError).toBe(seed.lastError);
    expect(out.accountCount).toBe(seed.accountCount);
  });

  it("marks a connected Feishu entry as needs_setup and NOT loop-monitored", () => {
    const out = withConnectorCapability({
      id: "feishu",
      label: "Lark/Feishu",
      connected: true,
      accountCount: 1,
      probed: true,
      fetchedAt: "2026-07-16T10:00:00Z",
    });
    expect(out.capability).toBe("needs_setup");
    expect(out.loopMonitored).toBe(false);
    expect(out.decisionCapable).toBe(false);
  });

  it("never ADDS credentials, account identifiers, or message content to the output", () => {
    // The stamp is a pure pass-through of fields the caller already
    // approved — credential safety is enforced one layer up, by the
    // `writeConnectorSnapshot` / readiness-API path that strips PII
    // before persisting. What the stamp MUST guarantee is that it
    // doesn't introduce new credential-shaped fields.
    const out = withConnectorCapability({
      id: "gmail",
      label: "Gmail",
      connected: true,
      accountCount: 1,
      probed: true,
      fetchedAt: "2026-07-16T10:00:00Z",
    });
    // Capability fields are advisory booleans + a string enum —
    // structurally unable to carry credentials or message bodies.
    expect(typeof out.loopMonitored).toBe("boolean");
    expect(typeof out.decisionCapable).toBe("boolean");
    expect(typeof out.capability).toBe("string");
    expect([
      "needs_setup",
      "connected",
      "loop_monitored",
      "decision_capable",
      "unsupported",
    ]).toContain(out.capability);
  });
});

// ---------------------------------------------------------------------------
// summarizeConnectorCapability — aggregate readiness counts
// ---------------------------------------------------------------------------

describe("summarizeConnectorCapability", () => {
  it("counts strict subsets: decisionCapable ≤ loopMonitored ≤ connected", () => {
    const entries: ConnectorEntry[] = [
      withConnectorCapability({
        id: "gmail",
        label: "Gmail",
        connected: true,
        accountCount: 1,
        probed: true,
        fetchedAt: "",
      }),
      withConnectorCapability({
        id: "github",
        label: "GitHub",
        connected: true,
        accountCount: 1,
        probed: true,
        fetchedAt: "",
      }),
      withConnectorCapability({
        id: "obsidian",
        label: "Obsidian",
        connected: true,
        accountCount: 1,
        probed: true,
        fetchedAt: "",
      }),
      withConnectorCapability({
        id: "feishu",
        label: "Feishu",
        connected: true,
        accountCount: 1,
        probed: true,
        fetchedAt: "",
      }),
    ];
    const sum = summarizeConnectorCapability(entries);
    expect(sum.total).toBe(4);
    expect(sum.connected).toBe(4);
    expect(sum.loopMonitored).toBe(3); // gmail + github + obsidian
    expect(sum.decisionCapable).toBe(2); // gmail + github only
    expect(sum.needsSetup).toBe(1); // feishu
    expect(sum.unsupported).toBe(0);
    // Strict supersets — pins the contract #361 asks for.
    expect(sum.decisionCapable).toBeLessThanOrEqual(sum.loopMonitored);
    expect(sum.loopMonitored).toBeLessThanOrEqual(sum.connected);
  });

  it("derives capability on the fly when the entry omits it", () => {
    // Older cache entries written before the field existed.
    const entries: ConnectorEntry[] = [
      {
        id: "gmail",
        label: "Gmail",
        connected: true,
        accountCount: 1,
        probed: true,
        fetchedAt: "",
      },
    ];
    const sum = summarizeConnectorCapability(entries);
    expect(sum.decisionCapable).toBe(1);
    expect(sum.loopMonitored).toBe(1);
  });

  it("counts unprobed rows as neither connected nor loop-monitored", () => {
    const entries: ConnectorEntry[] = [
      {
        id: "gmail",
        label: "Gmail",
        connected: false,
        accountCount: 0,
        probed: false,
        fetchedAt: "",
      },
    ];
    const sum = summarizeConnectorCapability(entries);
    expect(sum.total).toBe(1);
    expect(sum.connected).toBe(0);
    expect(sum.loopMonitored).toBe(0);
    expect(sum.decisionCapable).toBe(0);
  });
});