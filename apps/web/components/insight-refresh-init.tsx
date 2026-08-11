/**
 * Global Insight Refresh Initialization Component
 *
 * Starts a periodic refresh timer when the app boots so the user's insights
 * stay warm even when no page that calls into `/api/insights/...` is currently
 * mounted. Mirrors the behaviour of alloomi's `InsightRefreshInit` — adapted
 * to openloomi's conventions:
 *
 * - Tauri gating via `isTauri()` from `@/lib/tauri` (no `window.__TAURI__`
 *   poking with `@ts-ignore`).
 * - The all-bots refresh endpoint is `GET /api/insights/all`. The handler
 *   lives in `apps/web/app/(chat)/api/insights/[id]/route.ts` and treats
 *   `id === "all"` as a short-circuit that refreshes every non-default bot
 *   for the active user (see the `if (id === "all")` branch around line 143).
 * - Cloud auth travels via `Authorization: Bearer <cloudAuthToken>`; this is
 *   read by `extractCloudAuthToken` in `apps/web/lib/ai/request-context.ts`
 *   and forwarded into the per-bot refresh call.
 *
 * Behaviour:
 *  - No-op outside Tauri (web preview).
 *  - Waits for an authenticated `next-auth` session, then fires one immediate
 *    refresh and schedules a 30-minute interval thereafter.
 *  - Skips scheduled ticks if the user signs out mid-cycle (the `isAuthenticated`
 *    ref gates each tick).
 *  - Cleans up the interval on unmount and flips the module-level
 *    `globalRefreshEnabled` flag back off so other modules can stop trusting
 *    the global cadence.
 */

"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { isTauri } from "@/lib/tauri";
import { getAuthToken } from "@/lib/auth/token-manager";

// 30 minutes — matches `useInsightRefresh` defaults in alloomi and gives the
// expensive `/api/insights/all` handler (which fans out to every bot) plenty
// of breathing room.
const REFRESH_INTERVAL = 30 * 60 * 1000;

// Module-level so non-React callers can ask whether the global cadence is
// active (the same accessor alloomi exposes).
let globalRefreshEnabled = false;

export function isGlobalInsightRefreshEnabled(): boolean {
  return globalRefreshEnabled;
}

async function triggerGlobalRefresh(): Promise<void> {
  try {
    const headers: HeadersInit = {};
    try {
      const cloudAuthToken = getAuthToken();
      if (cloudAuthToken) {
        headers.Authorization = `Bearer ${cloudAuthToken}`;
      }
    } catch (error) {
      console.error(
        "[InsightRefreshInit] Failed to read cloud_auth_token:",
        error,
      );
    }

    const response = await fetch("/api/insights/all", {
      method: "GET",
      headers,
      credentials: "include",
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });

    if (!response.ok) {
      console.warn(
        `[InsightRefreshInit] Refresh failed with status: ${response.status}`,
      );
      return;
    }

    // Drain the body so the socket can be reused; the payload itself isn't
    // surfaced because mounted consumers fetch the list on their own SWR keys
    // and the global call's job is purely to warm the cache / trigger the
    // refresh pipeline server-side.
    await response.json().catch(() => undefined);

    console.log(
      `[InsightRefreshInit] Global refresh completed at ${new Date().toISOString()}`,
    );
  } catch (error) {
    console.error("[InsightRefreshInit] Global refresh error:", error);
  }
}

export function InsightRefreshInit() {
  const { data: session, status } = useSession();
  const userId = session?.user?.id;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isAuthenticatedRef = useRef(false);
  const hasStartedRef = useRef(false);

  // Watch session transitions: kick off once when auth becomes available,
  // never again for the same session.
  useEffect(() => {
    isAuthenticatedRef.current = status === "authenticated" && !!userId;

    if (!isAuthenticatedRef.current || hasStartedRef.current) {
      return;
    }

    if (!isTauri()) {
      // Web preview — the embedded Next.js dev server can't reach the
      // production refresh pipeline reliably, and we don't want background
      // hits while the user is poking at the UI in a browser tab.
      return;
    }

    hasStartedRef.current = true;
    globalRefreshEnabled = true;
    console.log(
      `[InsightRefreshInit] Starting global refresh timer (interval: ${REFRESH_INTERVAL / 1000 / 60} minutes)`,
    );

    // Kick one immediate refresh so a freshly signed-in user doesn't have to
    // wait 30 minutes for the first scheduled tick.
    void triggerGlobalRefresh();

    intervalRef.current = setInterval(() => {
      if (!isAuthenticatedRef.current) {
        // Signed out (or session evicted) between ticks — skip rather than
        // hammering a stale auth header.
        return;
      }
      console.log(
        `[InsightRefreshInit] Triggering scheduled refresh at ${new Date().toISOString()}`,
      );
      void triggerGlobalRefresh();
    }, REFRESH_INTERVAL);
  }, [status, userId]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        console.log("[InsightRefreshInit] Global refresh timer stopped");
      }
      globalRefreshEnabled = false;
      hasStartedRef.current = false;
    };
  }, []);

  return null;
}
