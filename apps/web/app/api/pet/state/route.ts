// Copyright 2026 openloomi Team. All rights reserved.
//
// Use of this source code is governed by a license that can be
// found in the LICENSE file in the root of this source tree.

/**
 * POST /api/pet/state — external pet state driver.
 *
 * Accepts a runtime state request from local Codex / Claude Code bridge
 * scripts and persists it to `~/.openloomi/pet/runtime_state.json`. The
 * Tauri `pet::watcher` polls that file and forwards each change into
 * `pet::handle_runtime_state_event`, which updates the live pet sprite
 * and bubble. This is the same plumbing the chat UI uses for short-lived
 * activity states (`thinking`, `working`, `juggling`, `happy`).
 *
 * Why a file and not a direct Tauri invoke? The Next.js server runs in
 * the same Tauri process as Rust in production, but we want the same
 * code path to work in dev mode where `next dev` is a separate process
 * from the desktop binary. A file in `~/.openloomi/` is the only shared
 * channel that works in both modes without a new IPC bridge.
 *
 * Body:
 *   { "state": <key>, "source": <string>, "monologue"?: <string> }
 *
 * Valid states (must match `is_supported_runtime_state` in
 * apps/web/src-tauri/src/pet/state.rs):
 *   idle | thinking | working | juggling | happy | presenting | needsinput
 *
 * Note: `sleeping` and `sweeping` are capybara-theme vocabulary and are
 * NOT accepted here — they are managed by the Loop baseline watcher.
 *
 * Response:
 *   200 — { ok: true, state, persisted_at, path }
 *   400 — { error: "missing_state" | "invalid_state" | "unsupported_source" }
 *   500 — { error: "persist_failed", message }
 *
 * Safety:
 *   - Loopback-only: OpenLoomi binds 127.0.0.1, so we trust the local
 *     socket as the auth boundary. The Codex / Claude bridges already
 *     present a bearer token to /api/remote-auth/user before they hit
 *     this endpoint.
 *   - Refuses `source` strings outside the allowlist so a misconfigured
 *     client can't impersonate the chat runtime.
 *   - Writes atomically via tmp+rename so the Tauri watcher never sees
 *     a half-written file.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_STATES = new Set([
  "idle",
  "thinking",
  "working",
  "juggling",
  "happy",
  "presenting",
  "needsinput",
]);

const ALLOWED_SOURCES = new Set([
  "codex-plugin",
  "claude-code-plugin",
  "openloomi-cli",
]);

function resolveRuntimeStatePath(): string {
  const home = os.homedir();
  return path.join(home, ".openloomi", "pet", "runtime_state.json");
}

async function persistRuntimeState(
  state: string,
  source: string,
  monologue: string | null,
): Promise<{ path: string; persistedAt: string }> {
  const targetPath = resolveRuntimeStatePath();
  const targetDir = path.dirname(targetPath);
  await fs.mkdir(targetDir, { recursive: true });

  const payload = {
    state,
    source,
    monologue,
    persisted_at: new Date().toISOString(),
  };

  // Write atomically: tmp file under the same directory + rename. The
  // Tauri watcher uses mtime to detect changes, so a torn write would
  // either be silently dropped or read with a stale payload. Renames
  // within the same filesystem are atomic on POSIX + NTFS.
  //
  // The tmp filename MUST be unique per request — not just per process.
  // The Next.js server is a single Node process that handles every
  // request, so `process.pid` alone collides across concurrent POSTs and
  // the rename below ENOENTs when another request wins the race. Append
  // a UUID to make each in-flight write land on its own file.
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, targetPath);

  return { path: targetPath, persistedAt: payload.persisted_at };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body must be JSON." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { state, source, monologue } = body as {
    state?: unknown;
    source?: unknown;
    monologue?: unknown;
  };

  if (typeof state !== "string" || state.length === 0) {
    return NextResponse.json(
      { error: "missing_state", validStates: [...ALLOWED_STATES] },
      { status: 400 },
    );
  }
  if (!ALLOWED_STATES.has(state)) {
    return NextResponse.json(
      {
        error: "invalid_state",
        received: state,
        validStates: [...ALLOWED_STATES],
      },
      { status: 400 },
    );
  }
  if (typeof source !== "string" || !ALLOWED_SOURCES.has(source)) {
    return NextResponse.json(
      {
        error: "unsupported_source",
        received: source ?? null,
        allowedSources: [...ALLOWED_SOURCES],
      },
      { status: 400 },
    );
  }

  const monologueStr =
    typeof monologue === "string" && monologue.length > 0 ? monologue : null;

  try {
    const { path: persistedPath, persistedAt } = await persistRuntimeState(
      state,
      source,
      monologueStr,
    );
    return NextResponse.json({
      ok: true,
      state,
      source,
      persisted_at: persistedAt,
      path: persistedPath,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "persist_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  // Convenience read endpoint so debugging tools / Codex can introspect
  // the last persisted state without digging through the filesystem.
  const targetPath = resolveRuntimeStatePath();
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    return NextResponse.json({ ok: true, ...parsed, path: targetPath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json(
        { ok: false, error: "not_persisted", path: targetPath },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "read_failed", message: String(error) },
      { status: 500 },
    );
  }
}
