/**
 * Standalone fs polling fallback verifier.
 *
 * The OpenLoomi dev server was holding the workdir locked with an
 * in-flight task, so we can't run the full quick1 end-to-end. Instead,
 * this script directly drives the helpers in `src/agent.ts` with mock
 * inputs and asserts the polling/idle/enrich/deliverable-collection
 * behaviours independently.
 *
 * Scenarios covered:
 *   1. `topLevelSignature` mtime change detection.
 *   2. `enrichHandleFromProbeLog` recovers turn_count from a probe log.
 *      (text/tool_calls/usage are *not* recoverable from the probe log —
 *      it only records message type + keys, not full payloads.)
 *   3. `runFsPollingFallback` recognises a written deliverable after the
 *      task "ends" (signature stops changing) and stops within
 *      `fsIdleDoneMs`.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  enrichHandleFromProbeLog,
  runFsPollingFallback,
  topLevelSignature,
  type AgentStreamHandle,
} from "../src/agent";

const REPO_ROOT = "D:/openloomi3/openloomi";
const SANDBOX = join(REPO_ROOT, "results", "fs_polling_verify");
const PROBE_LOG = join(SANDBOX, "fake_probe.log");
const WORK_DIR = join(SANDBOX, "workdir");

let failed = 0;
function log(label: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[verify] ${label}`, ...rest);
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) {
    log(`OK   ${label}: ${String(actual)}`);
  } else {
    log(`FAIL ${label}: got ${String(actual)}, want ${String(expected)}`);
    failed += 1;
  }
}

function assertTrue(label: string, cond: boolean): void {
  if (cond) {
    log(`OK   ${label}`);
  } else {
    log(`FAIL ${label}`);
    failed += 1;
  }
}

function makeHandle(): AgentStreamHandle {
  return {
    text: "",
    tool_calls: [],
    submitted_paths: [],
    abandoned: false,
    abandon_reason: null,
    deliverables: [],
    turn_count: 0,
    result_event_seen: false,
    truncated: false,
  };
}

async function main() {
  // ---- clean sandbox ----
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  // ---- Scenario 1: topLevelSignature reflects mtime changes ----
  log("Scenario 1: topLevelSignature");
  const fileA = join(WORK_DIR, "deliverable.xlsx");
  const fileB = join(WORK_DIR, "intermediate.tmp");
  writeFileSync(fileA, "x");
  const sig1 = topLevelSignature(WORK_DIR);
  assertTrue(
    "S1.1: fileA appears in initial signature",
    sig1.includes("deliverable.xlsx"),
  );

  // Wait >1s then touch fileA → mtime should advance.
  await new Promise((r) => setTimeout(r, 1100));
  utimesSync(fileA, new Date(), new Date());
  const sig2 = topLevelSignature(WORK_DIR);
  assertTrue("S1.2: signature changes after mtime bump", sig1 !== sig2);

  // Adding a new file also changes the signature.
  writeFileSync(fileB, "y");
  const sig3 = topLevelSignature(WORK_DIR);
  assertTrue("S1.3: signature changes when a new file appears", sig2 !== sig3);

  // ---- Scenario 2: enrichHandleFromProbeLog ----
  log("Scenario 2: enrichHandleFromProbeLog");
  // Synthetic probe log matching the real `apps/web/.../route.ts` format.
  // Each `for-await got message #N type=X` line carries the message type.
  // The probe does NOT record payload fields (text content, tool name,
  // usage), so we only verify turn_count.
  const fakeProbe = [
    "[2026-08-07T05:32:36.142Z] [AgentAPI_PROBE] route.ts module loaded",
    "[2026-08-07T05:32:37.132Z] SSE start(controller) entered; generatorSymbol=fn",
    "[2026-08-07T05:32:37.141Z] for-await got message #1 type=session keys=type,sessionId,messageId",
    "[2026-08-07T05:32:46.372Z] for-await got message #2 type=reasoning keys=type,content,messageId,runEpoch",
    "[2026-08-07T05:32:46.479Z] for-await got message #3 type=text keys=type,content,messageId,runEpoch",
    "[2026-08-07T05:32:50.000Z] for-await got message #4 type=tool_use keys=type,id,name,input,messageId,runEpoch",
    "[2026-08-07T05:32:50.500Z] for-await got message #5 type=tool_use keys=type,id,name,input,messageId,runEpoch",
    "[2026-08-07T05:33:00.000Z] for-await got message #6 type=result keys=type,content,usage,messageId,runEpoch",
    "[2026-08-07T05:33:00.001Z] Result message received, closing stream...",
  ].join("\n");
  writeFileSync(PROBE_LOG, fakeProbe);

  const handle2 = makeHandle();
  enrichHandleFromProbeLog(handle2, PROBE_LOG, null, false);
  assertEq(
    "S2.1: turn_count from probe (2 tool_use events)",
    handle2.turn_count,
    2,
  );

  // ---- Scenario 3: runFsPollingFallback recognises idle + collects deliverables ----
  log("Scenario 3: runFsPollingFallback");
  const handle3 = makeHandle();
  // Pre-populate workdir with a deliverable file that has an "old" mtime so
  // the run sees an immediately-stable signature.
  writeFileSync(join(WORK_DIR, "deliverable.xlsx"), "final content");
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  await runFsPollingFallback({
    workDir: WORK_DIR,
    handle: handle3,
    timeoutMs: 30_000,
    fsIdleDoneMs: 1_000, // tiny so the test is fast
    probeLogPath: PROBE_LOG,
    debugPath: null,
    debugSse: false,
  });
  const elapsed = Date.now() - t0;
  log(`Scenario 3 elapsed ${elapsed}ms`);
  assertTrue(
    "S3.1: handle.result_event_seen set so summariseHandle will write",
    handle3.result_event_seen,
  );
  assertTrue(
    "S3.2: at least one deliverable collected",
    handle3.deliverables.length >= 1,
  );
  const deliverable = handle3.deliverables[0];
  assertEq(
    "S3.3: deliverable.workdir_path = deliverable.xlsx",
    deliverable?.workdir_path,
    "deliverable.xlsx",
  );
  assertTrue(
    "S3.4: deliverable has sha256",
    typeof deliverable?.sha256 === "string" &&
      (deliverable?.sha256 ?? "").length === 64,
  );
  assertEq(
    "S3.5: probe-derived turn_count recovered into handle",
    handle3.turn_count,
    2,
  );
  assertTrue(
    "S3.6: run exits within ~10s (idle detection works)",
    elapsed < 10_000,
  );

  // ---- cleanup ----
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  if (failed > 0) {
    log(`FAILED (${failed} assertion(s))`);
    process.exit(1);
  } else {
    log("ALL SCENARIOS PASSED");
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});