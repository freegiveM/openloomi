/**
 * Cron completion → transient Loomi pet bubble notification.
 *
 * When a *user-created* scheduled job finishes, optionally POST a one-shot
 * pet-state event carrying a `monologue` string. The pet bubble
 * (`apps/web/public/loomi-bubble.html`) renders that monologue as a
 * transient message and auto-dismisses on its own timer — it is
 * explicitly NOT a decision card, so there are no Run/Dismiss buttons.
 *
 * Gated by `LoopPreferences.cronCompletionPetNotify` (default false).
 * Skipped for Loop's own handlers (`loop.tick` / `loop.brief` /
 * `loop.wrap` / `loop.action`) — those already reach the pet as decision
 * cards via the `~/.openloomi/loop/decisions.json` watcher, so notifying
 * here would double up.
 *
 * Delivery is best-effort: any failure (server down, network) is logged
 * and swallowed so the caller — `completeJobExecution` — never blocks the
 * job status update or the next scheduler tick on a slow pet POST.
 */

import { DEV_PORT, PROD_PORT } from "@openloomi/shared";
import { readPreferences } from "@/lib/loop/preferences";

export interface CronCompletionNotifyResult {
  considered: boolean;
  sent: boolean;
  skippedOptOut: boolean;
  skippedLoopJob: boolean;
  error?: string;
}

/**
 * Loop's own handler names. Cron completions from these are skipped —
 * the `decisions.json` watcher already surfaces them as decision cards.
 */
function isLoopHandler(handlerName?: string): boolean {
  return typeof handlerName === "string" && handlerName.startsWith("loop.");
}

/**
 * Resolve the local pet-state endpoint. The cron executor runs *inside*
 * the Next.js process that also serves `/api/pet/state`, so it's always
 * on the same loopback host:port. Port mirrors `@/lib/loop/runner`:
 * `PORT` env first, else the dev/prod default from `@openloomi/shared`.
 */
function resolvePetStateUrl(): string {
  const port =
    process.env.PORT ||
    (process.env.NODE_ENV === "development" ? DEV_PORT : PROD_PORT);
  return `http://127.0.0.1:${port}/api/pet/state`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * POST a transient pet bubble notification for a completed cron job.
 * No-op (returns early) when the pref is off or the handler is Loop's
 * own. Never throws.
 */
export async function notifyCronCompletion(
  jobName: string,
  status: "success" | "error",
  errorSummary?: string,
  handlerName?: string,
): Promise<CronCompletionNotifyResult> {
  const result: CronCompletionNotifyResult = {
    considered: true,
    sent: false,
    skippedOptOut: false,
    skippedLoopJob: false,
  };

  if (isLoopHandler(handlerName)) {
    result.skippedLoopJob = true;
    return result;
  }

  const prefs = readPreferences();
  if (prefs.cronCompletionPetNotify !== true) {
    result.skippedOptOut = true;
    return result;
  }

  const monologue =
    status === "success"
      ? `Cron "${jobName}" completed`
      : `Cron "${jobName}" failed — ${truncate(errorSummary ?? "unknown error", 60)}`;

  try {
    const res = await fetch(resolvePetStateUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: status === "success" ? "happy" : "needsinput",
        source: "openloomi-cli",
        monologue,
      }),
    });
    if (!res.ok) {
      result.error = `pet/state returned ${res.status}`;
      console.warn("[cron.notifications] pet notify non-2xx:", result.error);
      return result;
    }
    result.sent = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.warn("[cron.notifications] pet notify failed:", result.error);
  }
  return result;
}
