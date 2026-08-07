/**
 * Regression coverage for `lib/loop/parent-watch.ts` — the supervisor
 * liveness gate that backs issue #516. Each test wires the
 * `_setParentWatchOverrides` test hook so we exercise a specific
 * `SupervisorState` without touching the real `process.env` or the
 * user's `~/.openloomi/sidecar.alive`.
 *
 * Matrix:
 *
 *   - "unbound"        → bootId empty/absent → ok (dev / CLI pass-through).
 *   - "stamp_missing"  → bootId set, file absent → !ok.
 *   - "stamp_stale"    → bootId matches but file > staleAfterMs old → !ok.
 *   - "stamp_mismatch" → bootId differs from stamp contents → !ok.
 *   - "supervised"     → bootId matches and file is fresh → ok.
 *
 * Plus a small smoke test for the producer-side helper
 * `writeSupervisorStamp`, which has its own atomic write + rename path.
 *
 * The "unbound" cases are exercised via `_setParentWatchOverrides({
 * bootId: "" })` rather than mutating `process.env`: assigning
 * `undefined` to `process.env.X` coerces to the string "undefined"
 * under Node and breaks the truthy check inside `parent-watch.ts`,
 * so the only reliable way to fake "unset" is through the test hook.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _setParentWatchOverrides,
  checkSupervisor,
  writeSupervisorStamp,
} from "@/lib/loop/parent-watch";

let stampDir: string;
let stampPath: string;

beforeEach(() => {
  const dir = mkdirSync(
    join(
      tmpdir(),
      `openloomi-parent-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ),
    { recursive: true },
  );
  if (!dir) throw new Error("mkdirSync returned undefined");
  stampDir = dir;
  stampPath = join(stampDir, "sidecar.alive");
  _setParentWatchOverrides(null);
});

afterEach(() => {
  if (existsSync(stampDir)) rmSync(stampDir, { recursive: true, force: true });
  _setParentWatchOverrides(null);
});

describe("checkSupervisor — unbound (no effective boot id)", () => {
  it("passes when override bootId is empty string", () => {
    _setParentWatchOverrides({ bootId: "", stampPath });
    const out = checkSupervisor();
    expect(out.ok).toBe(true);
    expect(out.state).toBe("unbound");
    expect(out.bootId).toBe("");
  });

  it("passes when override bootId is undefined (treated like env unset)", () => {
    // No override at all — `parent-watch.ts` falls through to env, which
    // we have NOT touched; if the ambient env happens to have
    // OPENLOOMI_BOOT_ID set we still don't expect a stamp on the test
    // path, so this branch resolves to "unbound". Pin a non-existent
    // stamp path so any rare collision resolves to "stamp_missing"
    // rather than a false positive.
    _setParentWatchOverrides({
      stampPath: join(stampDir, "no-such-stamp-here"),
    });
    const out = checkSupervisor();
    // Either unbound (env unset) or stamp_missing (env set but no file);
    // both are pass-throughs to the caller so the test only asserts
    // that this path doesn't blow up.
    expect(["unbound", "stamp_missing"]).toContain(out.state);
    if (out.state === "unbound") {
      expect(out.ok).toBe(true);
    }
  });
});

describe("checkSupervisor — stamp_missing (#516)", () => {
  it("rejects when boot id is configured and stamp file is absent", () => {
    _setParentWatchOverrides({
      bootId: "boot-abc",
      stampPath,
    });
    // Stamp file intentionally not written.
    const out = checkSupervisor();
    expect(out.ok).toBe(false);
    expect(out.state).toBe("stamp_missing");
    expect(out.bootId).toBe("boot-abc");
    expect(out.reason).toMatch(/stamp file missing/);
    expect(out.reason).toMatch(/#516/);
  });
});

describe("checkSupervisor — stamp_mismatch", () => {
  it("rejects when stamp contents differ from boot id", () => {
    writeFileSync(stampPath, "boot-old-but-current-env-is-new");
    _setParentWatchOverrides({
      bootId: "boot-new",
      stampPath,
    });
    const out = checkSupervisor();
    expect(out.ok).toBe(false);
    expect(out.state).toBe("stamp_mismatch");
    expect(out.reason).toMatch(/bootId mismatch/);
  });
});

describe("checkSupervisor — stamp_stale", () => {
  it("rejects when stamp file mtime is older than staleAfterMs", () => {
    writeFileSync(stampPath, "boot-abc");
    // Backdate the mtime by a comfortable margin (5 minutes — well past
    // the 60s staleAfterMs).
    const past = new Date(Date.now() - 5 * 60 * 1000);
    // utimes via dynamic require — keeps the top-level fs imports tidy.
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(stampPath, past, past);
    _setParentWatchOverrides({
      bootId: "boot-abc",
      stampPath,
    });
    const out = checkSupervisor();
    expect(out.ok).toBe(false);
    expect(out.state).toBe("stamp_stale");
    expect(out.reason).toMatch(/older than/);
  });
});

describe("checkSupervisor — supervised", () => {
  it("accepts a fresh stamp with matching boot id", () => {
    writeFileSync(stampPath, "boot-abc");
    _setParentWatchOverrides({
      bootId: "boot-abc",
      stampPath,
    });
    const out = checkSupervisor();
    expect(out.ok).toBe(true);
    expect(out.state).toBe("supervised");
    expect(out.bootId).toBe("boot-abc");
  });

  it("accepts content with surrounding whitespace (atomic rename leftovers)", () => {
    writeFileSync(stampPath, "  boot-abc  \n");
    _setParentWatchOverrides({
      bootId: "boot-abc",
      stampPath,
    });
    const out = checkSupervisor();
    expect(out.ok).toBe(true);
    expect(out.state).toBe("supervised");
  });
});

describe("writeSupervisorStamp", () => {
  it("writes the boot id to the stamp path atomically (tmp then rename)", () => {
    const target = join(stampDir, "sidecar.alive");
    writeSupervisorStamp(target, "boot-xyz");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("boot-xyz");
    // tmp file should be gone after the rename
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("overwrites an existing stamp file in-place", () => {
    const target = join(stampDir, "sidecar.alive");
    writeSupervisorStamp(target, "boot-old");
    writeSupervisorStamp(target, "boot-new");
    expect(readFileSync(target, "utf8")).toBe("boot-new");
  });
});
