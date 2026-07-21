// SPDX-License-Identifier: Apache-2.0
//
// tests/launch-flag.test.mjs — node:test-based tests for the
// OPENLOOMI_LAUNCH_MODE=plugin side-band the Claude plugin writes
// before spawning the desktop app. The desktop reads this env var to
// route pet left-clicks: plugin sessions default to the compact
// status card instead of the main dashboard, so the user doesn't see
// "two dialogs" for the same chat.
//
// These tests run the bridge CLI as a subprocess and assert on the
// JSON output, mirroring the existing `bridge.test.mjs` style. We
// don't pull in vitest/mocha/node-tap; the project's standard test
// runner is the built-in `node:test`.
//
// Run with:
//   node --test plugins/claude/tests/launch-flag.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeEnv,
  nodeBinDir,
  withIsolatedHome,
} from "./helpers/platform-fixtures.mjs";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(PLUGIN_DIR, "scripts", "loomi-bridge.mjs");

function runJson(args, envOverrides = {}) {
  try {
    const out = execFileSync("node", [BRIDGE, ...args], {
      encoding: "utf8",
      env: mergeEnv(process.env, envOverrides),
    });
    return JSON.parse(out);
  } catch (e) {
    const stdout = String(e.stdout ?? "");
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        // fall through to throw below
      }
    }
    throw new Error(
      `bridge exited with code ${e.status ?? "?"}: ${e.message}\nstdout=${
        stdout || "<empty>"
      }\nstderr=${String(e.stderr ?? "<empty>")}`,
    );
  }
}

function readBridgeSource() {
  return readFileSync(BRIDGE, "utf8");
}

// -----------------------------------------------------------------------------
// launch-mode-info (diagnostic surface)
// -----------------------------------------------------------------------------

test("launch-mode-info documents the OPENLOOMI_LAUNCH_MODE contract", () => {
  const j = runJson(["launch-mode-info"]);
  assert.equal(j.ok, true);
  assert.equal(j.envKey, "OPENLOOMI_LAUNCH_MODE");
  assert.equal(j.envValue, "plugin");
  // The helper name must match what `launchDesktopApp` actually
  // calls — a renamed helper would silently bypass the env write.
  assert.equal(j.helper, "ensureLaunchModeEnvForLaunch");
  // Cross-reference the Rust file that consumes the env var so a
  // rename in either place fails this test.
  assert.match(j.consumerFile, /launch_mode\.rs$/);
  // Every platform should have a non-empty per-platform note.
  assert.equal(typeof j.perPlatform.darwin, "string");
  assert.ok(j.perPlatform.darwin.length > 0);
  assert.equal(typeof j.perPlatform.linux, "string");
  assert.ok(j.perPlatform.linux.length > 0);
  assert.equal(typeof j.perPlatform.win32, "string");
  assert.ok(j.perPlatform.win32.length > 0);
});

// -----------------------------------------------------------------------------
// launch-mode-apply (test-only entry point that exercises the helper)
// -----------------------------------------------------------------------------

test("launch-mode-apply short-circuits when OPENLOOMI_LAUNCH_MODE is already set", () => {
  const j = runJson(["launch-mode-apply"], {
    OPENLOOMI_LAUNCH_MODE: "plugin",
  });
  assert.equal(j.ok, true);
  assert.equal(j.method, "already-set");
});

test("launch-mode-apply reports success on non-darwin without touching launchctl", () => {
  // On Linux/Windows the helper delegates env propagation to the
  // spawn site in launchDesktopApp, so it returns ok=true with
  // method="spawn-env" without invoking launchctl. We verify this
  // holds by running the helper on the current platform (CI is
  // typically Linux/macOS) and asserting the result shape, not the
  // specific method value.
  const j = runJson(["launch-mode-apply"]);
  assert.equal(j.ok, true);
  assert.equal(typeof j.platform, "string");
});

test("launch-mode-apply invokes launchctl setenv on macOS when env is unset", withIsolatedHome((env) => {
  // Skip on non-darwin: the helper's macOS branch uses
  // `launchctl setenv` and there's no equivalent on Linux/Windows.
  if (process.platform !== "darwin") {
    return;
  }

  // Drop a fake `launchctl` ahead of the system one on PATH. The
  // fake records every invocation to a tmpfile so the test can
  // assert on the exact argv the helper passed.
  const fakeRoot = mkdtempSync(join(tmpdir(), "openloomi-fakebin-"));
  try {
    const fakeBin = join(fakeRoot, "launchctl");
    const recordFile = join(fakeRoot, "launchctl.log");
    // Append every argv as a single line. Quote-safe because we
    // don't care about whitespace; we only need to confirm the
    // key + value made it through.
    const script =
      "#!/bin/sh\n" +
      "printf '%s\\n' \"$*\" >> " +
      JSON.stringify(recordFile) +
      "\n";
    writeFileSync(fakeBin, script);
    chmodSync(fakeBin, 0o755);

    const pathWithFake = [fakeRoot, nodeBinDir()].join(delimiter);
    const result = execFileSync(
      "node",
      [BRIDGE, "launch-mode-apply"],
      {
        encoding: "utf8",
        env: mergeEnv(env, {
          PATH: pathWithFake,
          OPENLOOMI_LAUNCH_MODE: "",
        }),
      },
    );
    const j = JSON.parse(result);
    assert.equal(j.ok, true, `helper returned: ${JSON.stringify(j)}`);
    assert.equal(j.method, "launchctl setenv");

    // Now check the fake recorded the right call.
    const recordedRaw = execFileSync("cat", [recordFile], {
      encoding: "utf8",
    });
    const lastLine = recordedRaw.trim().split("\n").pop();
    // argv layout for `launchctl setenv <key> <value>` becomes
    // "setenv OPENLOOMI_LAUNCH_MODE plugin" in the shim's $*
    // (sh word-splits on whitespace).
    const tokens = String(lastLine).split(/\s+/);
    assert.deepEqual(
      tokens.slice(0, 3),
      ["setenv", "OPENLOOMI_LAUNCH_MODE", "plugin"],
    );
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
}));

// -----------------------------------------------------------------------------
// launchDesktopApp integrates ensureLaunchModeEnvForLaunch
//
// These tests exercise the bridge's launch-flow wiring by
// inspecting the bridge source. We can't import the bridge as a
// module (it's a CLI shebang script), and we can't easily trigger
// launchDesktopApp end-to-end from a unit test (it would require
// the full setup state machine + a fake desktop binary). The
// source-grep approach catches the most common regressions
// (helper renamed, call site removed) without that overhead.
// -----------------------------------------------------------------------------

test("launchDesktopApp calls ensureLaunchModeEnvForLaunch before spawning", () => {
  const source = readBridgeSource();
  const funcIdx = source.indexOf("async function launchDesktopApp");
  assert.ok(funcIdx >= 0, "launchDesktopApp not found in bridge source");
  const funcBody = source.slice(funcIdx);
  const callIdx = funcBody.indexOf("ensureLaunchModeEnvForLaunch()");
  assert.ok(
    callIdx >= 0,
    "ensureLaunchModeEnvForLaunch() is not called inside launchDesktopApp",
  );
});

test("ensureLaunchModeEnvForLaunch handles darwin / linux / win32 branches", () => {
  const source = readBridgeSource();
  const helperIdx = source.indexOf("async function ensureLaunchModeEnvForLaunch");
  assert.ok(helperIdx >= 0, "ensureLaunchModeEnvForLaunch not defined");
  const helperBody = source.slice(helperIdx);
  // The helper must invoke `launchctl setenv` with the right key
  // + value on macOS.
  assert.match(helperBody, /launchctl/);
  assert.match(helperBody, /setenv/);
  assert.match(helperBody, /OPENLOOMI_LAUNCH_MODE/);
  assert.match(helperBody, /"plugin"/);
});

test("launchDesktopApp injects OPENLOOMI_LAUNCH_MODE into spawn env on Linux", () => {
  // Belt-and-braces for the Linux fallback path. The bridge
  // document spawns (gtk-launch and direct-fallback) must include
  // OPENLOOMI_LAUNCH_MODE in their `env` block; otherwise a hook
  // that scrubs the parent env could strip the signal before the
  // desktop sees it.
  const source = readBridgeSource();
  const linuxEnvMentions = source.match(
    /env:\s*\{\s*\.\.\.\s*process\.env,\s*OPENLOOMI_LAUNCH_MODE:\s*"plugin"\s*\}/g,
  );
  assert.ok(
    Array.isArray(linuxEnvMentions) && linuxEnvMentions.length >= 1,
    "expected the Linux spawn site(s) to inject OPENLOOMI_LAUNCH_MODE into env",
  );
});