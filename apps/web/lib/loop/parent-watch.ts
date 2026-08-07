/**
 * Parent supervision for Loop — backstop that refuses to tick when the
 * supervising app (Tauri desktop wrapper) is gone.
 *
 * #516 — orphaned Loop kept firing agentic ticks against the user's
 * Claude subscription after the .app bundle was deleted. Tauri cleans
 * up its Node sidecar on quit (process_group + kill(-pgid, …)), but the
 * moment the supervising process goes away via a path that bypasses the
 * usual exit (rm -rf .app, kernel kill, sleep-hibernate resume
 * interruption, etc.) the child server can survive — and the Loop cron
 * rows in `scheduled_jobs` are unrelated to who's running the process,
 * so they keep firing.
 *
 * This module provides a defence-in-depth check that asks: "is there a
 * live supervisor I can prove is the one that started me?" Implemented
 * via a heartbeat file the supervisor (openloomi.app) maintains:
 *
 *   - Supervisor opens the file every 5 s, writes its boot UUID, and
 *     deletes the file on its own clean shutdown.
 *   - Loop's `checkSupervisor()` reads the file at tick time. If the
 *     file is missing or its content doesn't match the boot id the
 *     current `next-server` was launched with (env `OPENLOOMI_BOOT_ID`),
 *     we're an orphan — refuse to tick, write `status.json` so the UI
 *     can surface "Loop disabled — supervisor gone", and disable Loop
 *     in preferences so subsequent ticks don't keep firing.
 *   - When the env var is unset (dev mode, bare `pnpm dev`, CLI
 *     invocations of `apps/web/scripts/loop-cli.mjs`), the check is
 *     skipped — those callers are themselves the supervisor.
 *
 * The file lives at `~/.openloomi/sidecar.alive` (NOT under `loop/`)
 * so its absence doesn't conflict with `ensureDirs` writing loop-home
 * files, and so a stuck/incompatible old build doesn't see a stale
 * loop-home-style path and misclassify as supervised.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PARENT_CHECK = {
  /** Heartbeat file the supervisor touches while it is alive. */
  stampPath: join(homedir(), ".openloomi", "sidecar.alive"),
  /** Max age (ms) before a stamp is treated as stale even if contents match. */
  staleAfterMs: 60_000,
};

/** Reason `checkSupervisor` returned false. Stable for tests + UI strings. */
export type SupervisorState =
  /** env `OPENLOOMI_BOOT_ID` unset — dev, CLI, or unit test. Caller is supervisor. */
  | "unbound"
  /** Stamp file absent — supervisor never started OR died without writing one. */
  | "stamp_missing"
  /** Stamp file older than `staleAfterMs` — supervisor looks crashed. */
  | "stamp_stale"
  /** Stamp contents do not match `OPENLOOMI_BOOT_ID`. Stale boot. */
  | "stamp_mismatch"
  /** Stamp present, fresh, and contents match — supervisor alive. */
  | "supervised";

export interface SupervisorCheck {
  ok: boolean;
  state: SupervisorState;
  /**
   * Matches `OPENLOOMI_BOOT_ID` when `state === "supervised"`. Empty
   * string otherwise. Surfaced to callers so the UI/log can echo it.
   */
  bootId: string;
  reason: string;
}

function describeState(state: SupervisorState): string {
  switch (state) {
    case "unbound":
      return "loop parent-watch skipped: OPENLOOMI_BOOT_ID unset (dev/CLI)";
    case "stamp_missing":
      return `loop parent-watch: stamp file missing at ${PARENT_CHECK.stampPath} — supervisor not running, refusing to tick (#516)`;
    case "stamp_stale":
      return `loop parent-watch: stamp file older than ${PARENT_CHECK.staleAfterMs}ms — supervisor looks crashed, refusing to tick (#516)`;
    case "stamp_mismatch":
      return `loop parent-watch: stamp bootId mismatch — supervisor restarted without us, refusing to tick (#516)`;
    case "supervised":
      return "loop parent-watch: supervisor alive";
  }
}

/**
 * Test-only override for the env var + stamp path. Lets unit tests
 * exercise every state without mutating `process.env`/disk.
 */
export interface ParentWatchOverrides {
  bootId?: string;
  stampPath?: string;
}

/** Internal — read by `checkSupervisor` and overridable in tests. */
let overrides: ParentWatchOverrides = {};

/** Inject test overrides; pass `null` to clear. */
export function _setParentWatchOverrides(o: ParentWatchOverrides | null): void {
  overrides = o ?? {};
}

function readBootId(): string | null {
  if (overrides.bootId !== undefined) {
    return overrides.bootId.length > 0 ? overrides.bootId : null;
  }
  const raw = process.env.OPENLOOMI_BOOT_ID;
  return raw && raw.length > 0 ? raw : null;
}

function readStampPath(): string {
  return overrides.stampPath ?? PARENT_CHECK.stampPath;
}

/**
 * Decide whether the current Next.js process is being supervised by a
 * live `openloomi.app`. Pure / synchronous; safe to call inside the
 * tick handler before any await.
 */
export function checkSupervisor(): SupervisorCheck {
  const bootId = readBootId();
  if (!bootId) {
    return {
      ok: true,
      state: "unbound",
      bootId: "",
      reason: describeState("unbound"),
    };
  }
  const stampPath = readStampPath();
  if (!existsSync(stampPath)) {
    return {
      ok: false,
      state: "stamp_missing",
      bootId,
      reason: describeState("stamp_missing"),
    };
  }
  let mtime: number;
  let contents: string;
  try {
    mtime = statSync(stampPath).mtimeMs;
    contents = readFileSync(stampPath, "utf8").trim();
  } catch (e) {
    // Stat / read failed (perm, race) — treat conservatively as orphan.
    const reason = `loop parent-watch: could not read stamp: ${
      e instanceof Error ? e.message : String(e)
    }`;
    return { ok: false, state: "stamp_missing", bootId, reason };
  }
  if (contents !== bootId) {
    return {
      ok: false,
      state: "stamp_mismatch",
      bootId,
      reason: describeState("stamp_mismatch"),
    };
  }
  const age = Date.now() - mtime;
  if (age > PARENT_CHECK.staleAfterMs) {
    return {
      ok: false,
      state: "stamp_stale",
      bootId,
      reason: describeState("stamp_stale"),
    };
  }
  return {
    ok: true,
    state: "supervised",
    bootId,
    reason: describeState("supervised"),
  };
}

/**
 * Optional helper used by the supervisor side (Tauri) to write the
 * stamp. Exposed here so the Rust heartbeat thread can mirror the
 * exact format the loop checker expects. Atomic via tmp + rename so a
 * mid-write tick read sees either the prior or new bootId but never a
 * half-written file.
 */
export function writeSupervisorStamp(stampPath: string, bootId: string): void {
  const tmp = `${stampPath}.tmp`;
  writeFileSync(tmp, bootId);
  // Simple fsync would be ideal, but the heartbeat cadence is 5 s and
  // a one-tick delay of "stale" check is acceptable. Rename is atomic
  // on POSIX; Windows best-effort.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").renameSync(tmp, stampPath);
  } catch {
    writeFileSync(stampPath, bootId);
  }
}
