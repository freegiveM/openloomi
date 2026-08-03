import type { InsightSettings } from "@/lib/db/schema";
import {
  ACTIVITY_TIER_PRIORITIES,
  clampActivityTier,
  deriveActivityTier,
  filterDueInsightSettings,
  getCacheTtlMs,
  getEffectiveRefreshIntervalMinutes,
  resolveTierPriority,
  resolveTierRefreshMinutes,
} from "@/lib/insights/tier";
import { describe, expect, it } from "vitest";

describe("Insights Tier", () => {
  describe("clampActivityTier", () => {
    it("should return valid tier as-is", () => {
      expect(clampActivityTier("high")).toBe("high");
      expect(clampActivityTier("medium")).toBe("medium");
      expect(clampActivityTier("low")).toBe("low");
      expect(clampActivityTier("dormant")).toBe("dormant");
    });

    it("should return 'low' for invalid tier", () => {
      expect(clampActivityTier("invalid")).toBe("low");
      expect(clampActivityTier("")).toBe("low");
      expect(clampActivityTier(null)).toBe("low");
      expect(clampActivityTier(undefined)).toBe("low");
    });
  });

  describe("deriveActivityTier", () => {
    it("should return 'low' when lastActiveAt is null", () => {
      const now = new Date();
      expect(deriveActivityTier(now, null)).toBe("low");
    });

    it("should return 'high' when active within 1 hour", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 30 * 60 * 1000); // 30 minutes ago
      expect(deriveActivityTier(now, lastActive)).toBe("high");
    });

    it("should return 'high' at exactly 1 hour boundary", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 60 * 60 * 1000); // exactly 1 hour ago
      expect(deriveActivityTier(now, lastActive)).toBe("high");
    });

    it("should return 'medium' when active within 6 hours", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours ago
      expect(deriveActivityTier(now, lastActive)).toBe("medium");
    });

    it("should return 'medium' at exactly 6 hour boundary", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 6 * 60 * 60 * 1000); // exactly 6 hours ago
      expect(deriveActivityTier(now, lastActive)).toBe("medium");
    });

    it("should return 'low' when active within 24 hours", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12 hours ago
      expect(deriveActivityTier(now, lastActive)).toBe("low");
    });

    it("should return 'low' at exactly 24 hour boundary", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 24 * 60 * 60 * 1000); // exactly 24 hours ago
      expect(deriveActivityTier(now, lastActive)).toBe("low");
    });

    it("should return 'dormant' when active more than 24 hours ago", () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago
      expect(deriveActivityTier(now, lastActive)).toBe("dormant");
    });
  });

  describe("resolveTierRefreshMinutes", () => {
    it("should return correct refresh minutes for each tier", () => {
      expect(resolveTierRefreshMinutes("high")).toBe(15);
      expect(resolveTierRefreshMinutes("medium")).toBe(60);
      expect(resolveTierRefreshMinutes("low")).toBe(180);
      expect(resolveTierRefreshMinutes("dormant")).toBe(1440);
    });

    it("should return default (low) refresh minutes for invalid tier", () => {
      expect(resolveTierRefreshMinutes("invalid")).toBe(180);
      expect(resolveTierRefreshMinutes(null)).toBe(180);
      expect(resolveTierRefreshMinutes(undefined)).toBe(180);
    });
  });

  describe("resolveTierPriority", () => {
    it("should return correct priority for each tier", () => {
      expect(resolveTierPriority("high")).toBe(0);
      expect(resolveTierPriority("medium")).toBe(1);
      expect(resolveTierPriority("low")).toBe(2);
      expect(resolveTierPriority("dormant")).toBe(3);
    });

    it("should return default (low) priority for invalid tier", () => {
      expect(resolveTierPriority("invalid")).toBe(2);
      expect(resolveTierPriority(null)).toBe(2);
    });
  });

  describe("ACTIVITY_TIER_PRIORITIES", () => {
    it("should have correct priority values", () => {
      expect(ACTIVITY_TIER_PRIORITIES.high).toBe(0);
      expect(ACTIVITY_TIER_PRIORITIES.medium).toBe(1);
      expect(ACTIVITY_TIER_PRIORITIES.low).toBe(2);
      expect(ACTIVITY_TIER_PRIORITIES.dormant).toBe(3);
    });
  });

  describe("getEffectiveRefreshIntervalMinutes", () => {
    it("should return tier minutes when greater than user setting", () => {
      const settings: InsightSettings = {
        userId: "user-1",
        focusPeople: [],
        focusTopics: [],
        language: "en",
        refreshIntervalMinutes: 30, // less than high tier (15)
        lastMessageProcessedAt: null,
        lastActiveAt: null,
        activityTier: "high",
        aiSoulPrompt: null,
        identityIndustries: null,
        identityWorkDescription: null,
        lastUpdated: new Date(),
      };
      // Should return max(30, 15) = 30
      expect(getEffectiveRefreshIntervalMinutes(settings)).toBe(30);
    });

    it("should return tier minutes when less than user setting", () => {
      const settings: InsightSettings = {
        userId: "user-1",
        focusPeople: [],
        focusTopics: [],
        language: "en",
        refreshIntervalMinutes: 10, // less than high tier (15)
        lastMessageProcessedAt: null,
        lastActiveAt: null,
        activityTier: "high",
        aiSoulPrompt: null,
        identityIndustries: null,
        identityWorkDescription: null,
        lastUpdated: new Date(),
      };
      // Should return max(10, 15) = 15
      expect(getEffectiveRefreshIntervalMinutes(settings)).toBe(15);
    });

    it("should handle dormant tier", () => {
      const settings: InsightSettings = {
        userId: "user-1",
        focusPeople: [],
        focusTopics: [],
        language: "en",
        refreshIntervalMinutes: 60,
        lastMessageProcessedAt: null,
        lastActiveAt: null,
        activityTier: "dormant",
        aiSoulPrompt: null,
        identityIndustries: null,
        identityWorkDescription: null,
        lastUpdated: new Date(),
      };
      // Should return max(60, 1440) = 1440
      expect(getEffectiveRefreshIntervalMinutes(settings)).toBe(1440);
    });
  });

  describe("getCacheTtlMs", () => {
    it("should convert effective refresh interval to milliseconds", () => {
      const settings: InsightSettings = {
        userId: "user-1",
        focusPeople: [],
        focusTopics: [],
        language: "en",
        refreshIntervalMinutes: 60,
        lastMessageProcessedAt: null,
        lastActiveAt: null,
        activityTier: "medium",
        aiSoulPrompt: null,
        identityIndustries: null,
        identityWorkDescription: null,
        lastUpdated: new Date(),
      };
      // Effective interval is max(60, 60) = 60 minutes = 3,600,000 ms
      expect(getCacheTtlMs(settings)).toBe(60 * 60 * 1000);
    });

    it("should handle high tier", () => {
      const settings: InsightSettings = {
        userId: "user-1",
        focusPeople: [],
        focusTopics: [],
        language: "en",
        refreshIntervalMinutes: 10,
        lastMessageProcessedAt: null,
        lastActiveAt: null,
        activityTier: "high",
        aiSoulPrompt: null,
        identityIndustries: null,
        identityWorkDescription: null,
        lastUpdated: new Date(),
      };
      // Effective interval is max(10, 15) = 15 minutes = 900,000 ms
      expect(getCacheTtlMs(settings)).toBe(15 * 60 * 1000);
    });
  });

  describe("filterDueInsightSettings", () => {
    const now = new Date("2024-01-10T12:00:00Z");

    it("should filter settings due by interval", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-1",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"), // 2 hours ago
          lastActiveAt: null,
          activityTier: "medium", // 60 min interval
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
        {
          userId: "user-2",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T11:30:00Z"), // 30 min ago
          lastActiveAt: null,
          activityTier: "medium", // 60 min interval
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 10,
        ttlHours: 24,
      });

      // Only user-1 should be due (2 hours > 60 min)
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe("user-1");
    });

    it("should filter settings due by TTL", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-1",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-09T11:00:00Z"), // 25 hours ago
          lastActiveAt: null,
          activityTier: "medium",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 10,
        ttlHours: 24,
      });

      // Should be due by TTL (25 hours > 24 hours)
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe("user-1");
    });

    it("should handle null lastMessageProcessedAt", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-1",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: null,
          lastActiveAt: null,
          activityTier: "medium",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 10,
        ttlHours: 24,
      });

      // Should be due (null treated as epoch 0)
      expect(result).toHaveLength(1);
    });

    it("should sort by tier priority first", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-low",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T08:00:00Z"), // 4 hours ago, exceeds low tier interval (180 min)
          lastActiveAt: null,
          activityTier: "low", // priority 2, refresh interval 180 min
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
        {
          userId: "user-high",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"),
          lastActiveAt: null,
          activityTier: "high",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(), // priority 0
        },
        {
          userId: "user-medium",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"),
          lastActiveAt: null,
          activityTier: "medium", // priority 1
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 10,
        ttlHours: 24,
      });

      // Should be sorted by tier priority: high, medium, low
      expect(result.map((s) => s.userId)).toEqual([
        "user-high",
        "user-medium",
        "user-low",
      ]);
    });

    it("should sort by lastMessageProcessedAt when tier is same", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-2",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T11:00:00Z"), // more recent
          lastActiveAt: null,
          activityTier: "medium",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
        {
          userId: "user-1",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"), // older
          lastActiveAt: null,
          activityTier: "medium",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 10,
        ttlHours: 24,
      });

      // Should be sorted by lastMessageProcessedAt (older first)
      expect(result.map((s) => s.userId)).toEqual(["user-1", "user-2"]);
    });

    it("should respect limit", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-1",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"),
          lastActiveAt: null,
          activityTier: "high",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
        {
          userId: "user-2",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"),
          lastActiveAt: null,
          activityTier: "medium",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
        {
          userId: "user-3",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T10:00:00Z"),
          lastActiveAt: null,
          activityTier: "low",
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 2,
        ttlHours: 24,
      });

      // Should return only 2 results (highest priority)
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.userId)).toEqual(["user-1", "user-2"]);
    });

    it("should return empty array when no settings are due", () => {
      const settings: InsightSettings[] = [
        {
          userId: "user-1",
          focusPeople: [],
          focusTopics: [],
          language: "en",
          refreshIntervalMinutes: 60,
          lastMessageProcessedAt: new Date("2024-01-10T11:50:00Z"), // 10 min ago
          lastActiveAt: null,
          activityTier: "medium", // 60 min interval
          aiSoulPrompt: null,
          identityIndustries: null,
          identityWorkDescription: null,
          lastUpdated: new Date(),
        },
      ];

      const result = filterDueInsightSettings({
        settings,
        now,
        limit: 10,
        ttlHours: 24,
      });

      expect(result).toHaveLength(0);
    });
  });
});
