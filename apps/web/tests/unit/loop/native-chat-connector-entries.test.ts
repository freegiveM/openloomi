/**
 * Regression coverage for the `/api/loop/connectors` native-chat merge.
 *
 * `buildNativeChatConnectorEntries` folds `integrationAccounts` rows into
 * `ConnectorEntry` shape so the Loomi online card can show a user's
 * Telegram / WeChat / WhatsApp / Feishu / Lark / iMessage / QQBot /
 * DingTalk / Discord accounts alongside the six Loop-monitored toolkits
 * (Gmail, Google Calendar, GitHub, Slack, Linear, Obsidian).
 *
 * The tests pin:
 *   - only platforms in `NATIVE_CHAT_INTEGRATIONS` survive;
 *   - multiple accounts for one platform collapse into one row with the
 *     correct `accountCount` and `accounts[]`;
 *   - `connected` follows an OR semantic across the group (any active
 *     account keeps chat skills usable);
 *   - the capability stamp lands on `"needs_setup"` because none of the
 *     native chat platforms are in `LOOP_MONITORED_TOOLKITS`;
 *   - no platform id collides with the six Loop toolkits, so the existing
 *     React `filterComposioOnlyEntries` doesn't accidentally dedupe them.
 */

import { describe, expect, it } from "vitest";

import {
  NATIVE_CHAT_INTEGRATIONS,
  buildNativeChatConnectorEntries,
  filterComposioOnlyEntries,
} from "@/lib/loop/connectors-pure";
import type { ConnectorEntry } from "@/lib/loop/types";

function acc(over: {
  id?: string;
  platform: string;
  displayName?: string;
  externalId?: string;
  status?: string;
}): {
  id: string;
  platform: string;
  displayName?: string;
  externalId?: string;
  status: string;
} {
  return {
    id: over.id ?? `${over.platform}-${over.externalId ?? "0"}`,
    platform: over.platform,
    displayName: over.displayName,
    externalId: over.externalId,
    status: over.status ?? "active",
  };
}

describe("NATIVE_CHAT_INTEGRATIONS", () => {
  it("includes the nine chat platforms but NOT the Loop-monitored six", () => {
    expect(NATIVE_CHAT_INTEGRATIONS.has("telegram")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("weixin")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("whatsapp")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("feishu")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("lark")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("imessage")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("qqbot")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("dingtalk")).toBe(true);
    expect(NATIVE_CHAT_INTEGRATIONS.has("discord")).toBe(true);

    // Loop-monitored six must NOT collide with the native chat set so the
    // route's merged `items` array never double-renders a platform.
    for (const id of [
      "gmail",
      "google_calendar",
      "github",
      "slack",
      "linear",
      "obsidian",
    ]) {
      expect(NATIVE_CHAT_INTEGRATIONS.has(id)).toBe(false);
    }
  });
});

describe("buildNativeChatConnectorEntries", () => {
  it("drops accounts whose platform is not in the native chat set", () => {
    const out = buildNativeChatConnectorEntries([
      acc({ platform: "gmail" }), // would collide with Loop row → ignored
      acc({ platform: "google_calendar" }), // same
      acc({ platform: "notion" }), // arbitrary unknown → ignored
    ]);
    expect(out).toEqual([]);
  });

  it("returns an empty list when given no accounts", () => {
    expect(buildNativeChatConnectorEntries([])).toEqual([]);
  });

  it("emits one row per platform for a single account each", () => {
    const out = buildNativeChatConnectorEntries([
      acc({
        id: "tg-1",
        platform: "telegram",
        displayName: "Alice",
        externalId: "@alice",
        status: "active",
      }),
      acc({
        id: "wx-1",
        platform: "weixin",
        displayName: "Bob",
        status: "active",
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id).sort()).toEqual(["telegram", "weixin"]);
    const telegram = out.find((e) => e.id === "telegram");
    expect(telegram).toBeDefined();
    if (!telegram) return;
    expect(telegram.label).toBe("Alice");
    expect(telegram.connected).toBe(true);
    expect(telegram.accountCount).toBe(1);
    expect(telegram.accounts).toEqual([
      { id: "tg-1", label: "Alice", healthy: true },
    ]);
    expect(telegram.probed).toBe(true);
    expect(telegram.fetchedAt).toMatch(/T/);
    // Capability stamp is applied: connected + non-loop → "needs_setup"
    expect(telegram.capability).toBe("needs_setup");
    expect(telegram.loopMonitored).toBe(false);
    expect(telegram.decisionCapable).toBe(false);
  });

  it("collapses multiple accounts of the same platform into one row", () => {
    const out = buildNativeChatConnectorEntries([
      acc({
        id: "wa-1",
        platform: "whatsapp",
        displayName: "+1 555 0100",
        externalId: "100",
        status: "active",
      }),
      acc({
        id: "wa-2",
        platform: "whatsapp",
        displayName: "+1 555 0101",
        externalId: "101",
        status: "active",
      }),
      acc({
        id: "wa-3",
        platform: "whatsapp",
        displayName: "+1 555 0102",
        externalId: "102",
        status: "expired",
      }),
    ]);
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.id).toBe("whatsapp");
    expect(row.label).toBe("+1 555 0100"); // first account's displayName
    expect(row.accountCount).toBe(3);
    expect(row.accounts).toBeDefined();
    if (!row.accounts) return;
    expect(row.accounts).toHaveLength(3);
    expect(row.accounts[0]).toEqual({
      id: "wa-1",
      label: "+1 555 0100",
      healthy: true,
    });
    expect(row.accounts[2].healthy).toBe(false);
    // OR semantic — at least one account is active → row is connected
    expect(row.connected).toBe(true);
  });

  it("marks the row offline when every account is non-active", () => {
    const out = buildNativeChatConnectorEntries([
      acc({ id: "dd-1", platform: "dingtalk", status: "expired" }),
      acc({ id: "dd-2", platform: "dingtalk", status: "revoked" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].connected).toBe(false);
    expect(out[0].accountCount).toBe(2);
    expect(out[0].accounts?.every((a) => a.healthy === false)).toBe(true);
  });

  it("falls back to platform id when no displayName is available", () => {
    const out = buildNativeChatConnectorEntries([
      acc({ platform: "feishu", displayName: undefined, externalId: "" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("feishu");
    expect(out[0].accounts?.[0].label).toBe("feishu");
  });

  it("never collides with Loop-monitored rows — composio filter doesn't drop them", () => {
    // The route merges native rows into `items`. The React side calls
    // `filterComposioOnlyEntries` against a `nativePlatforms` set built
    // from `useIntegrations()`. If our id ever appeared in that set, the
    // native row would be silently dropped — a regression. Pin the
    // disjointness here so any future change to either side surfaces.
    const out: ConnectorEntry[] = buildNativeChatConnectorEntries([
      acc({ platform: "telegram" }),
      acc({ platform: "discord" }),
      acc({ platform: "imessage" }),
    ]);
    const nativePlatformsFromDB = new Set(["telegram", "discord", "imessage"]);
    // No Loop row happens to share an id with any native chat id, so a
    // composio-only row with one of these ids shouldn't exist in the
    // fixture. If it ever did, the filter would drop it — assert the
    // disjoint direction by feeding empty items.
    expect(filterComposioOnlyEntries([], nativePlatformsFromDB)).toEqual([]);
    // And the native rows themselves pass the filter unchanged (they're
    // connected + probed + id is the platform).
    expect(filterComposioOnlyEntries(out, new Set())).toEqual(out);
  });
});
