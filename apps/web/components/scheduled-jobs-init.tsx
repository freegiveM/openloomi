"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { getAuthToken } from "@/lib/auth/token-manager";

/**
 * Scheduled Jobs Auto-Initialization Component
 *
 * Mounts in the (chat) layout (inside `SessionProvider`) and is responsible
 * for two things:
 *
 *   1. Starting the local scheduler in Tauri mode (existing behavior).
 *   2. Ensuring the three loop ScheduledJob rows (tick / brief / wrap)
 *      exist for the active user. The server-side
 *      `syncLoopJobsForUser(userId)` step in
 *      `apps/web/app/(chat)/api/scheduled-jobs/internal/scheduler/route.ts`
 *      is what actually creates the rows — it has to wait for a real
 *      `User.id` because of the FK on `scheduled_jobs.userId`.
 *
 * The previous version fired once after a 3s `setTimeout`, which raced
 * against guest login: on a fresh install the cookie hadn't been
 * minted yet, the endpoint returned 401, and nothing re-triggered the
 * sync. The user then had to either restart the app or navigate to
 * the scheduler settings page to nudge it. We now drive the call off
 * `useSession()` so the sync fires once `status === "authenticated"`
 * and re-fires whenever the active user id changes (e.g. sign-out +
 * sign-in as a different account).
 *
 * Tauri-only: returns silently in web mode.
 */
export function ScheduledJobsInit() {
  const { data: session, status } = useSession();
  const lastSyncedFor = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) return; // Non-Tauri environment, skip initialization

    if (status !== "authenticated") return; // wait for the session

    const userId = session?.user?.id;
    if (!userId) return;
    // Re-trigger only when the active user actually changes. The endpoint
    // is idempotent so calling it twice for the same user is harmless,
    // but skipping the second call avoids an unnecessary round-trip on
    // every re-render.
    if (lastSyncedFor.current === userId) return;
    lastSyncedFor.current = userId;

    void (async () => {
      try {
        const cloudAuthToken = getAuthToken();
        const response = await fetch(
          `/api/scheduled-jobs/internal/scheduler${
            cloudAuthToken
              ? `?cloudAuthToken=${encodeURIComponent(cloudAuthToken)}`
              : ""
          }`,
        );

        if (!response.ok) {
          // The endpoint catches `syncLoopJobsForUser` failures
          // internally and still returns 200, so reaching this branch
          // usually means auth wasn't ready yet. Clear the guard so
          // the next auth state change can re-attempt.
          lastSyncedFor.current = null;
          console.warn(
            "[Scheduled Jobs Init] API returned non-OK status:",
            response.status,
          );
          return;
        }

        const contentType = response.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
          console.warn(
            "[Scheduled Jobs Init] Unexpected response content-type:",
            contentType,
          );
          return;
        }

        const data = await response.json();
        if (data?.success && data?.scheduler?.isRunning) {
          console.log(
            "[Scheduled Jobs] ✅ Local scheduler is running (checks every",
            data.scheduler.checkInterval / 1000,
            "seconds)",
          );
        }
      } catch (error) {
        // On network failure keep the guard so we don't spam retries on
        // every render — next session change will reset it via the
        // `lastSyncedFor.current === null` reset above.
        lastSyncedFor.current = null;
        console.error("[Scheduled Jobs Init] Failed to initialize:", error);
      }
    })();
  }, [status, session?.user?.id]);

  return null;
}
