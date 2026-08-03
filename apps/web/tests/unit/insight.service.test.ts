import type { InsightSettings } from "@/lib/db/schema";
import {
  type ActivityTier,
  clampActivityTier,
  deriveActivityTier,
  filterDueInsightSettings,
  getCacheTtlMs,
  getEffectiveRefreshIntervalMinutes,
  resolveTierPriority,
  resolveTierRefreshMinutes,
} from "@/lib/insights/tier";
import { expect, test } from "vitest";

test("clampActivityTier keeps known tiers and defaults to low", () => {
  expect(clampActivityTier("high")).eq("high");
  expect(clampActivityTier("medium")).eq("medium");
  expect(clampActivityTier("unknown")).eq("low");
});

test("deriveActivityTier categorises recency correctly", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  expect(deriveActivityTier(now, new Date("2024-01-01T11:30:00Z"))).eq("high");
  expect(deriveActivityTier(now, new Date("2024-01-01T08:00:00Z"))).eq(
    "medium",
  );
  expect(deriveActivityTier(now, new Date("2023-12-31T18:00:00Z"))).eq("low");
  expect(deriveActivityTier(now, new Date("2023-12-20T12:00:00Z"))).eq(
    "dormant",
  );
});

test("deriveActivityTier treats boundary values as higher tiers", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  expect(deriveActivityTier(now, new Date(now.getTime() - 60 * 60 * 1000))).eq(
    "high",
  );

  expect(
    deriveActivityTier(now, new Date(now.getTime() - 6 * 60 * 60 * 1000)),
  ).eq("medium");

  expect(
    deriveActivityTier(now, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
  ).eq("low");
});

test("getEffectiveRefreshIntervalMinutes respects tier minimums", () => {
  const base: InsightSettings = {
    userId: "u1",
    focusPeople: [],
    focusTopics: [],
    language: "",
    refreshIntervalMinutes: 10,
    lastMessageProcessedAt: null,
    lastActiveAt: null,
    activityTier: "medium",
    aiSoulPrompt: null,
    identityIndustries: null,
    identityWorkDescription: null,
    lastUpdated: new Date(),
  };
  expect(getEffectiveRefreshIntervalMinutes(base)).eq(60);

  const relaxed = {
    ...base,
    activityTier: "low" as ActivityTier,
    refreshIntervalMinutes: 240,
  };
  expect(getEffectiveRefreshIntervalMinutes(relaxed)).eq(240);
});

test("getCacheTtlMs returns minute-based TTL", () => {
  const settings: InsightSettings = {
    userId: "u1",
    focusPeople: [],
    focusTopics: [],
    language: "",
    refreshIntervalMinutes: 20,
    lastMessageProcessedAt: null,
    lastActiveAt: null,
    activityTier: "high",
    aiSoulPrompt: null,
    identityIndustries: null,
    identityWorkDescription: null,
    lastUpdated: new Date(),
  };
  expect(getCacheTtlMs(settings)).eq(20 * 60 * 1000);
});

test("getCacheTtlMs falls back to tier minimum when tier is unknown", () => {
  const settings: InsightSettings = {
    userId: "u1",
    focusPeople: [],
    focusTopics: [],
    language: "",
    refreshIntervalMinutes: 30,
    lastMessageProcessedAt: null,
    lastActiveAt: null,
    activityTier: "mystery" as unknown as ActivityTier,
    aiSoulPrompt: null,
    identityIndustries: null,
    identityWorkDescription: null,
    lastUpdated: new Date(),
  };
  expect(getCacheTtlMs(settings)).eq(180 * 60 * 1000);
});

test("filterDueSummarySettings orders by tier and recency", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  const mkSetting = (
    tier: ActivityTier,
    minutesAgo: number,
  ): InsightSettings => ({
    userId: tier,
    focusPeople: [],
    focusTopics: [],
    language: "",
    refreshIntervalMinutes: 30,
    lastMessageProcessedAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    lastActiveAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    activityTier: tier,
    aiSoulPrompt: null,
    identityIndustries: null,
    identityWorkDescription: null,
    lastUpdated: now,
  });

  const candidates = [
    mkSetting("low", 200),
    mkSetting("high", 20),
    mkSetting("medium", 90),
    mkSetting("dormant", 1500),
  ];

  const due = filterDueInsightSettings({
    settings: candidates,
    now,
    ttlHours: 24,
    limit: 10,
  });

  expect(due.length).eq(4);
  expect(due.map((s) => s.activityTier)).toEqual([
    "high",
    "medium",
    "low",
    "dormant",
  ]);
});

test("filterDueSummarySettings respects limit and tie-breaking", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  const mkSetting = (
    tier: ActivityTier,
    minutesAgo: number,
  ): InsightSettings => ({
    userId: `${tier}-${minutesAgo}`,
    focusPeople: [],
    focusTopics: [],
    language: "",
    refreshIntervalMinutes: 30,
    lastMessageProcessedAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    lastActiveAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    activityTier: tier,
    aiSoulPrompt: null,
    identityIndustries: null,
    identityWorkDescription: null,
    lastUpdated: now,
  });

  const due = filterDueInsightSettings({
    settings: [
      mkSetting("high", 120),
      mkSetting("medium", 400),
      mkSetting("medium", 500),
      mkSetting("low", 600),
    ],
    now,
    ttlHours: 24,
    limit: 2,
  });

  expect(due.length).eq(2);
  expect(due.map((s) => s.userId)).toEqual(["high-120", "medium-500"]);
});

test("filterDueSummarySettings uses ttlHours as safety net", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  const recentMedium: InsightSettings = {
    userId: "medium",
    focusPeople: [],
    focusTopics: [],
    language: "",
    refreshIntervalMinutes: 30,
    lastMessageProcessedAt: new Date(now.getTime() - 40 * 60 * 1000),
    lastActiveAt: new Date(now.getTime() - 40 * 60 * 1000),
    activityTier: "medium",
    aiSoulPrompt: null,
    identityIndustries: null,
    identityWorkDescription: null,
    lastUpdated: now,
  };

  const due = filterDueInsightSettings({
    settings: [recentMedium],
    now,
    ttlHours: 0.5,
    limit: 10,
  });

  expect(due.length).eq(1);
  expect(due[0]?.userId).eq("medium");
});

test("resolve tier helpers expose deterministic priorities", () => {
  expect(resolveTierRefreshMinutes("high")).eq(15);
  expect(resolveTierRefreshMinutes("unknown")).eq(180);
  expect(resolveTierPriority("medium")).eq(1);
  expect(resolveTierPriority("mystery")).eq(2);
});
