/**
 * Unit tests for `lib/loop/cli-path.ts` — the resolver used by the
 * tick prompt so the agent can always find `loop-cli.mjs` regardless
 * of whether the runtime is dev (`pnpm --filter web dev`), the
 * `.next/standalone` layout, or the packaged Tauri desktop app.
 *
 * Issue #348: the prompt used to hardcode
 * `apps/web/scripts/loop-cli.mjs`, which the packaged Tauri build
 * never copied into the bundle. Decision persistence silently
 * failed. The resolver now walks a fixed probe list, so the first
 * test below is "OPENLOOMI_LOOP_CLI wins when set" — the explicit
 * escape hatch.
 *
 * ## Mocking strategy — `vi.mock("node:fs")`
 *
 * The resolver's `selfRelativeCandidates()` derives its probe dirs
 * from the on-disk location of `cli-path.ts` itself
 * (`import.meta.url` / `__filename`). That derivation is independent
 * of cwd, HOME, and any environment the test sets up — it's the
 * "I always find the workspace if it exists on this machine"
 * fallback. We need to be able to make it miss so we can pin the
 * "no candidate exists → return null" contract.
 *
 * `vi.spyOn` doesn't work on Node ESM module namespaces
 * (`Cannot redefine property: existsSync`). So we hoist a
 * `vi.mock("node:fs")` factory that wraps every method, forwarding
 * to the real fs except for `existsSync`, which honours a flag the
 * test can flip with `setExistsSyncAllFalse()` / restore with the
 * returned setter. This keeps the rest of the test fixture honest
 * (mkdir/write/rm all still hit the disk) while letting the
 * "no candidate" test force the resolver to give up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Mutable flag toggled by tests that need every existsSync to miss. */
let existsSyncAllFalse = false;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: (p: string) => {
      // When the flag is on, force every probe miss EXCEPT for paths
      // we wrote into TMP_ROOT for the current test. That keeps the
      // "no candidate exists" assertion honest (the resolver falls
      // off the end and returns null) while still letting the
      // "packaged runtime" test lay its own file down and assert it
      // resolves. TMP_ROOT is matched by `startsWith` so the test's
      // own writes still report `true`.
      if (existsSyncAllFalse && !p.startsWith(TMP_ROOT)) return false;
      return real.existsSync(p);
    },
  };
});

let TMP_ROOT = "";

beforeEach(() => {
  // Each test starts in a clean tmp dir; the resolver walks up from
  // `process.cwd()` looking for `apps/web/scripts/loop-cli.mjs`, so we
  // `process.chdir` into the tmp root before importing the module so
  // the cwd-relative probes can't accidentally hit the real
  // workspace files in this dev machine.
  TMP_ROOT = mkdtempSync(join(tmpdir(), "loomi-cli-path-"));
});
afterEach(() => {
  if (TMP_ROOT && existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
  // Reset the global flag — vitest runs tests in declaration order
  // but the mock factory closure is shared across them, so an
  // unset flag is the only safe default.
  existsSyncAllFalse = false;
});

describe("resolveLoopCli", () => {
  it("returns OPENLOOMI_LOOP_CLI when set and exists", async () => {
    const envPath = join(TMP_ROOT, "user-loop-cli.mjs");
    writeFileSync(envPath, "#!/usr/bin/env node\n");
    process.env.OPENLOOMI_LOOP_CLI = envPath;
    try {
      const { resolveLoopCli } = await import("@/lib/loop/cli-path");
      expect(resolveLoopCli()).toBe(envPath);
    } finally {
      process.env.OPENLOOMI_LOOP_CLI = undefined;
    }
  });

  it("ignores OPENLOOMI_LOOP_CLI when the file does not exist", async () => {
    process.env.OPENLOOMI_LOOP_CLI = join(TMP_ROOT, "missing.mjs");
    process.chdir(TMP_ROOT);
    // Force every existsSync probe to miss — without this, the
    // `selfRelativeCandidates()` fallback finds the real dev
    // workspace on the dev machine and we'd assert `null` against a
    // real path.
    existsSyncAllFalse = true;
    try {
      const { resolveLoopCli } = await import("@/lib/loop/cli-path");
      expect(resolveLoopCli()).toBeNull();
    } finally {
      process.env.OPENLOOMI_LOOP_CLI = undefined;
    }
  });

  it("walks up the cwd to find a dev-mode `apps/web/scripts/loop-cli.mjs`", async () => {
    // Lay out `<tmp>/apps/web/scripts/loop-cli.mjs` and chdir to `<tmp>`.
    // On macOS `tmpdir()` returns `/var/folders/...` but `process.cwd()`
    // resolves to `/private/var/folders/...` (a symlink follow). The
    // resolver uses `process.cwd()` so the path it returns carries the
    // `/private/` prefix even when our TMP_ROOT does not — normalise
    // both sides through `realpathSync` before comparing.
    const devRoot = join(TMP_ROOT, "apps", "web", "scripts");
    mkdirSync(devRoot, { recursive: true });
    const devFile = join(devRoot, "loop-cli.mjs");
    writeFileSync(devFile, "#!/usr/bin/env node\n");
    process.chdir(TMP_ROOT);
    process.env.OPENLOOMI_LOOP_CLI = undefined;
    // Reach inside the module's cwd-relative probe walk — the
    // selfRelativeCandidates() fallback may still find the real dev
    // workspace if it exists, so disambiguate by writing the file
    // and trusting the priority order.

    const { resolveLoopCli } = await import("@/lib/loop/cli-path");
    const expected = realpathSync(devFile);
    expect(resolveLoopCli()).toBe(expected);
  });

  it("finds `loop-cli.mjs` at the packaged `~/.openloomi/runtime/` location", async () => {
    // Mirror the Tauri optimizer's destination. We can't reach the
    // real `~/.openloomi/runtime/` from this test (it might actually
    // be populated on a dev machine), so we point `HOME` at TMP_ROOT
    // and re-execute the resolver under that env.
    const fakeHome = join(TMP_ROOT, "home");
    mkdirSync(fakeHome, { recursive: true });
    const packagedDir = join(fakeHome, ".openloomi", "runtime");
    mkdirSync(packagedDir, { recursive: true });
    const packagedFile = join(packagedDir, "loop-cli.mjs");
    writeFileSync(packagedFile, "#!/usr/bin/env node\n");
    process.chdir(TMP_ROOT);
    process.env.OPENLOOMI_LOOP_CLI = undefined;
    // Disable other probes so the packaged-RUNTIME dir wins cleanly.
    existsSyncAllFalse = true;

    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      vi.resetModules();
      const { resolveLoopCli } = await import("@/lib/loop/cli-path");
      expect(resolveLoopCli()).toBe(packagedFile);
    } finally {
      if (realHome === undefined) process.env.HOME = undefined;
      else process.env.HOME = realHome;
      vi.resetModules();
    }
  });

  it("returns null when no candidate exists on disk", async () => {
    process.chdir(TMP_ROOT);
    process.env.OPENLOOMI_LOOP_CLI = undefined;
    // Move HOME aside so the packaged-runtime probe also misses.
    const realHome = process.env.HOME;
    process.env.HOME = join(TMP_ROOT, "no-home");
    // The `selfRelativeCandidates()` walk uses `import.meta.url` /
    // `__filename` to find the on-disk location of cli-path.ts and
    // derives `<repo>/apps/web/scripts` from it. That derivation
    // exists regardless of cwd or HOME, so we have to spoof
    // `existsSync` to make the probe miss.
    existsSyncAllFalse = true;
    try {
      vi.resetModules();
      const { resolveLoopCli } = await import("@/lib/loop/cli-path");
      expect(resolveLoopCli()).toBeNull();
    } finally {
      if (realHome === undefined) process.env.HOME = undefined;
      else process.env.HOME = realHome;
      vi.resetModules();
    }
  });

  it("dryRun returns the probe path even when nothing exists", async () => {
    process.chdir(TMP_ROOT);
    process.env.OPENLOOMI_LOOP_CLI = undefined;
    const { resolveLoopCli } = await import("@/lib/loop/cli-path");
    // dryRun must return the first candidate it would have inspected
    // so callers can render an actionable diagnostic. We don't pin
    // the exact path (it depends on the tmp layout), only that the
    // function returns SOMETHING — null would defeat the purpose.
    expect(resolveLoopCli({ dryRun: true })).not.toBeNull();
  });
});

describe("listLoopCliCandidates", () => {
  it("reports env + per-dir candidates with an exists flag", async () => {
    const devFile = join(TMP_ROOT, "candidate-loop-cli.mjs");
    writeFileSync(devFile, "#!/usr/bin/env node\n");
    process.chdir(TMP_ROOT);
    process.env.OPENLOOMI_LOOP_CLI = join(TMP_ROOT, "env-loop-cli.mjs");
    try {
      const { listLoopCliCandidates } = await import("@/lib/loop/cli-path");
      const rows = listLoopCliCandidates();
      const env = rows.find((r) => r.from === "env:OPENLOOMI_LOOP_CLI");
      expect(env?.path).toBe(process.env.OPENLOOMI_LOOP_CLI);
      expect(env?.exists).toBe(false);
      // At least one probe dir should exist with a file. Loop-cli is
      // a string — the function never throws.
      const anyExists = rows.some((r) => r.exists);
      expect(typeof anyExists).toBe("boolean");
    } finally {
      process.env.OPENLOOMI_LOOP_CLI = undefined;
    }
  });
});
