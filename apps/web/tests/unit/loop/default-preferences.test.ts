/**
 * Regression coverage for issue #417 — fresh-install Loop defaults.
 *
 * Before #417:
 *   enabled: true, briefTime: "09:00", wrapTime: "21:00"
 * After #417:
 *   enabled: false, briefTime: null, wrapTime: null
 *
 * These defaults ride the shallow-merge in `lib/loop/preferences.ts`
 * (`readPreferences = { ...DEFAULT, ...persisted }`), so existing
 * users with an explicit `enabled: true` already on disk are
 * grandfathered — only fresh installs see the OFF defaults. The test
 * pins the shape so a careless future flip cannot silently re-arm
 * Loop for new users.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_LOOP_PREFERENCES } from "@/lib/loop/types";

describe("DEFAULT_LOOP_PREFERENCES — #417 fresh-install defaults", () => {
  it("has enabled=false so fresh installs do not auto-run Loop", () => {
    expect(DEFAULT_LOOP_PREFERENCES.enabled).toBe(false);
  });

  it("has briefTime=null so the brief cron row is never auto-created", () => {
    expect(DEFAULT_LOOP_PREFERENCES.briefTime).toBeNull();
  });

  it("has wrapTime=null so the wrap cron row is never auto-created", () => {
    expect(DEFAULT_LOOP_PREFERENCES.wrapTime).toBeNull();
  });

  it("keeps a usable tick interval even though tick is gated by enabled", () => {
    expect(DEFAULT_LOOP_PREFERENCES.intervalSec).toBeTypeOf("number");
    expect(DEFAULT_LOOP_PREFERENCES.intervalSec).toBeGreaterThanOrEqual(30);
  });

  it("does not auto-enable desktopNotifications or pet cron notifications", () => {
    expect(DEFAULT_LOOP_PREFERENCES.desktopNotifications).toBe(false);
    expect(DEFAULT_LOOP_PREFERENCES.cronCompletionPetNotify).toBe(false);
  });
});
