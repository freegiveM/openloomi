/**
 * POST /api/loop/dev/scene
 *
 * Inject a demo decision (or set of decisions) for the 8 forms in the
 * aha-moment deck. Only available when `NODE_ENV !== "production"` OR
 * `OPENLOOMI_DEV=1` is set — refuses with 404 otherwise so production
 * builds can never pollute the loop's decision store via this shortcut.
 *
 * Body:
 *   { scene: SceneKey }   // see lib/loop/dev-scenes.ts
 *
 * Response:
 *   { ok, scene, decisions: LoopDecision[], hintState?: string }
 *
 * Why this exists:
 *   - The watcher polls decisions.json every 2s and emits `loop:state`
 *     + `loop:decision`. By adding a real pending decision we get the
 *     bubble + card UI on screen with zero pet-side custom code.
 *   - Forms 1–3 don't yet have pet-side custom UI; for those we just
 *     return the `hintState` for the dev panel / future UI to act on.
 */

import { NextResponse } from "next/server";
import { decisions } from "@/lib/loop";
import { DEV_SCENE_LIST, getScene } from "@/lib/loop/dev-scenes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function devModeAllowed(): boolean {
  // 1. Explicit opt-in (works in any NODE_ENV).
  if (process.env.OPENLOOMI_DEV === "1") return true;
  // 2. Default-on outside production.
  return process.env.NODE_ENV !== "production";
}

export async function GET() {
  if (!devModeAllowed()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // List the scenes so the dev panel can render its buttons without
  // having to hard-code the keys. Cheap: 8 entries, no I/O. `hintState`
  // is included so `onSceneClick` can fire `emitPetState(...)` on click —
  // the dev panel only reads it client-side and never persists it, so
  // it's safe to ship through this dev-only endpoint.
  return NextResponse.json({
    scenes: DEV_SCENE_LIST.map((s) => ({
      key: s.key,
      slide: s.slide,
      label: s.label,
      caption: s.caption,
      ...(s.hintState ? { hintState: s.hintState } : {}),
    })),
  });
}

export async function POST(req: Request) {
  if (!devModeAllowed()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: { scene?: string } = {};
  try {
    body = (await req.json()) as { scene?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const key = (body.scene ?? "").trim();
  if (!key) {
    return NextResponse.json({ error: "scene key required" }, { status: 400 });
  }
  const scene = getScene(key);
  if (!scene) {
    return NextResponse.json(
      {
        error: `unknown scene '${key}'`,
        known: Object.keys(
          DEV_SCENE_LIST.reduce(
            (acc, s) => {
              acc[s.key] = true;
              return acc;
            },
            {} as Record<string, boolean>,
          ),
        ),
      },
      { status: 400 },
    );
  }

  const payloads = scene.build();
  const persisted = [];
  for (const p of payloads) {
    // decisions.add mutates and persists; we control the payload shape
    // ourselves in dev-scenes.ts so we don't need extra mapping here.
    const added = decisions.add({
      ...p,
      // Force status pending — scene builder always wants a fresh
      // pending decision; if a caller overrides we honour the override.
      status: p.status ?? "pending",
    });
    persisted.push(added);
  }

  return NextResponse.json({
    ok: true,
    scene: scene.key,
    slide: scene.slide,
    decisions: persisted,
    ...(scene.hintState ? { hintState: scene.hintState } : {}),
  });
}
