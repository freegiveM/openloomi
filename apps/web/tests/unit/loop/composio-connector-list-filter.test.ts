/**
 * Regression coverage for #413 — `composio-connector-list.tsx` must
 * NOT render three different shapes of "not actually wired in":
 *
 *   1. Unconnected entries (`connected === false`) — the user never
 *      authorized this platform. The "Not authorized" affordance is the
 *      "Connect more via Composio" button on the parent dialog; we
 *      deliberately do not draw a row for it here, neither as a red dot
 *      nor as a neutral pill.
 *
 *   2. Unprobed entries (`probed === false`) — typical for a freshly-
 *      appended custom channel from `appendCustomChannels`. Until the
 *      watcher actually exercises one, we have no truth about its
 *      connection state, and `withConnectorCapability` returns
 *      `capability: null`, so the row would be a stub.
 *
 *   3. Native-platform entries — if `useIntegrations()` already owns the
 *      id (the user did a native OAuth), we suppress the Composio row to
 *      avoid two rows for the same platform.
 *
 * Only entries that pass all three exclusions reach the rendering path,
 * where the `ConnectorCapabilityBadge` (#413's headline fix) shows the
 * user whether Loop monitors the source (green/blue), is chat-only
 * (amber), or has no classifier mapping (muted).
 */
import { describe, expect, it } from "vitest";

import { filterComposioOnlyEntries } from "@/lib/loop/connectors-pure";
import type { ConnectorEntry } from "@/lib/loop/types";

function entry(over: Partial<ConnectorEntry>): ConnectorEntry {
  return {
    id: "gmail",
    label: "Gmail",
    connected: false,
    accountCount: 0,
    probed: false,
    fetchedAt: "2026-07-21T00:00:00.000Z",
    ...over,
  };
}

const NATIVE_LINUX: ReadonlySet<string> = new Set(["slack"]);

describe("filterComposioOnlyEntries — #413 state separation", () => {
  it("renders the connected-and-probed row", () => {
    const items: ConnectorEntry[] = [
      entry({
        id: "linear",
        connected: true,
        probed: true,
        capability: "decision_capable",
      }),
    ];
    expect(filterComposioOnlyEntries(items, NATIVE_LINUX)).toEqual(items);
  });

  it("drops unconnected rows — never renders them as a red dot (#413)", () => {
    // Reproduces issue 413's headline case: a FALLBACK entry the user
    // never authorized (gmail / github / slack) appears in the seed
    // list as `connected: false`. After a successful probe it's
    // `probed: true` but still `connected: false`. The downstream
    // component must filter it out — not render it as a "Not
    // authorized" pill either, per the issue's expected behavior.
    const items: ConnectorEntry[] = [
      entry({
        id: "gmail",
        connected: false,
        probed: true,
        capability: "needs_setup",
      }),
    ];
    expect(filterComposioOnlyEntries(items, NATIVE_LINUX)).toEqual([]);
  });

  it("drops freshly-appended custom channels — `probed: false` (#413)", () => {
    // Custom channels from `appendCustomChannels` are stamped
    // `{ connected: false, probed: false }`. Even if the seed list
    // ever leaked them past `connected === false`, `probed === false`
    // would still keep them out of the rendered list.
    const items: ConnectorEntry[] = [
      entry({
        id: "stripe_charges",
        connected: false,
        probed: false,
      }),
    ];
    expect(filterComposioOnlyEntries(items, NATIVE_LINUX)).toEqual([]);
  });

  it("drops rows whose id overlaps with a native OAuth account", () => {
    // User did a native Slack OAuth AND the agent also has a Slack
    // connector in the cache. The native row wins — the Composio row
    // is suppressed.
    const items: ConnectorEntry[] = [
      entry({
        id: "slack",
        connected: true,
        probed: true,
        capability: "decision_capable",
      }),
    ];
    expect(filterComposioOnlyEntries(items, NATIVE_LINUX)).toEqual([]);
  });

  it("renders every connected-and-probed row that does not collide with a native platform", () => {
    // The bug's scenario: only Linear is connected via Composio.
    // Gmail / GitHub / Slack (all `connected: false, probed: true`)
    // are dropped; Linear passes.
    const items: ConnectorEntry[] = [
      entry({ id: "gmail", connected: false, probed: true }),
      entry({ id: "github", connected: false, probed: true }),
      entry({ id: "slack", connected: false, probed: true }),
      entry({
        id: "linear",
        connected: true,
        probed: true,
        capability: "decision_capable",
      }),
    ];
    expect(filterComposioOnlyEntries(items, NATIVE_LINUX)).toEqual([items[3]]);
  });

  it("does not leak the custom-channel 'unauthorized' stamp into the rendered list", () => {
    // Defence-in-depth: even if `connected: true` were ever stamped on
    // a custom channel before the watcher probes it (a hypothetical —
    // not how `appendCustomChannels` works today), `probed: false`
    // must still keep the row out so a red dot never appears for an
    // unauthorized channel.
    const items: ConnectorEntry[] = [
      entry({
        id: "stripe_charges",
        connected: true,
        probed: false,
      }),
    ];
    expect(filterComposioOnlyEntries(items, NATIVE_LINUX)).toEqual([]);
  });
});
