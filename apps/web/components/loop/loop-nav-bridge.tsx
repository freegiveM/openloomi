"use client";

/**
 * Bridge between Tauri DOM events (dispatched by the Rust host on the
 * main webview) and Next.js client-side navigation. The Rust
 * `pet:open-decision` listener in main.rs emits an
 * `openloomi:navigate-decision` CustomEvent with `{ id }`; we resolve
 * that decision to the most recent loop-action ScheduledJob and route
 * the user to `/scheduled-jobs/<action_id>` — the canonical execution
 * page every other one-shot / recurring task uses. If no job exists
 * yet for the decision (the user has not clicked Run / Dismiss / Dry /
 * Promote), we fall through to the scheduled-jobs list filtered by
 * `?decision_id=<id>` so they can still drill in.
 *
 * Why this lives in the (chat) layout (and not in Home):
 *   The event can fire while the user is on /chat, /inbox, /connectors,
 *   /loop/<other-id> etc. — anywhere the pet surface might land. If the
 *   listener were only in Home, those routes would silently swallow the
 *   event and the main window would just re-open on whatever page was
 *   already there. Mounting it here covers the whole (chat) tree.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function LoopNavBridge() {
  const router = useRouter();
  useEffect(() => {
    const handler = async (e: Event) => {
      const ce = e as CustomEvent<{ id?: string }>;
      const id = ce.detail?.id;
      if (!id) return;
      try {
        const res = await fetch(
          `/api/loop/action/by-decision/${encodeURIComponent(id)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            action_id?: string | null;
          };
          if (data?.action_id) {
            router.push(
              `/scheduled-jobs/${encodeURIComponent(data.action_id)}`,
            );
            return;
          }
        }
      } catch {
        // Swallow and fall through to the list — never leave the user
        // staring at the same page with no feedback.
      }
      router.push(`/scheduled-jobs?decision_id=${encodeURIComponent(id)}`);
    };
    window.addEventListener("openloomi:navigate-decision", handler);
    return () =>
      window.removeEventListener("openloomi:navigate-decision", handler);
  }, [router]);

  // Brief / wrap cards aren't decisions — they're aggregate views stored
  // at ~/.openloomi/loop/brief.json / wrap.json. The Rust host fires
  // these events after the user clicks "Open brief" / "Open wrap" so we
  // push the dedicated pages that read the JSON directly. The pages
  // (`/brief`, `/wrap`) handle the "no snapshot yet" case with an empty
  // state pointing at the trigger endpoint.
  useEffect(() => {
    const onBrief = () => router.push("/brief");
    const onWrap = () => router.push("/wrap");
    window.addEventListener("openloomi:navigate-brief", onBrief);
    window.addEventListener("openloomi:navigate-wrap", onWrap);
    return () => {
      window.removeEventListener("openloomi:navigate-brief", onBrief);
      window.removeEventListener("openloomi:navigate-wrap", onWrap);
    };
  }, [router]);
  return null;
}
