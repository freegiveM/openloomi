/**
 * POST /api/loop/dev/reset
 *
 * Clear all pending decisions so the dev panel can iterate on the 8
 * scenes without manual dismiss. Only available in dev (gated identical
 * to /api/loop/dev/scene — see that file for the rationale).
 *
 * Body: none.
 * Response: `{ ok, dropped: number }`.
 *
 * Safety:
 *   - Refuses with 404 in production builds.
 *   - Only touches the `pending` bucket — `done` and `dismissed` are
 *     preserved so nightly wrap snapshots and history don't get nuked
 *     just because you wanted to dry-run Form 6.
 */

import { NextResponse } from "next/server";

import { decisions } from "@/lib/loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function devModeAllowed(): boolean {
  if (process.env.OPENLOOMI_DEV === "1") return true;
  return process.env.NODE_ENV !== "production";
}

export async function POST() {
  if (!devModeAllowed()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Implementation note: `decisions` is a thin object store around
  // ~/.openloomi/loop/decisions.json. We move every pending → dismissed
  // with a synthetic reason rather than deleting, so the watcher still
  // sees a mtime change and pushes the pet back to idle. `moveTo` is
  // the same primitive the dashboard uses when you click "Dismiss".
  const pending = decisions.pending();
  for (const p of pending) {
    decisions.moveTo(p.id, "dismissed", "dev-scene-reset");
  }

  return NextResponse.json({ ok: true, dropped: pending.length });
}
