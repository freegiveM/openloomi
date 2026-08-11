// Reproduce the 0-deliverable bug: invoke runFsPollingFallback on a
// known workdir where the model wrote files to the top-level, and
// observe the final collected deliverables.
import { runFsPollingFallback } from "../src/agent";
import { join } from "node:path";
import { existsSync } from "node:fs";

const workDir = process.argv[2];
if (!workDir) {
  console.error("Usage: tsx scripts/repro_fs_polling.ts <workDir>");
  process.exit(2);
}
if (!existsSync(workDir)) {
  console.error("workDir does not exist:", workDir);
  process.exit(2);
}

const handle: any = {
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

// Use a very short idle window so the repro finishes in seconds, not
// 120s; we want to *see* what the polling loop is observing.
await runFsPollingFallback({
  workDir,
  handle,
  timeoutMs: 60_000,
  fsIdleDoneMs: 3_000,
  debugPath: join(workDir, "_repro_debug.log"),
  debugSse: true,
});

console.log("collected deliverables:", handle.deliverables.length);
for (const d of handle.deliverables) {
  console.log("  ", d.workdir_path, d.size_bytes);
}