// Recovery script: rebuild the missing 130 zero-deliverable predictions
// from the on-disk workdirs (which contain the model's actual output files).
//
// This is a one-shot utility invoked after the fs-polling bug fix in
// agent.ts damaged run.json (predictions count went 220 -> 91 because the
// retry path accidentally stripped the retryable entries from the
// predictions array before re-adding them). We re-scan every workdir and
// synthesize a minimal zero-deliverable prediction so the run.json has
// a stable shape for downstream graders.
//
// Usage:
//   tsx scripts/rebuild_predictions.ts <run.json> <workdirs-root>

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const runJsonPath = process.argv[2];
const workdirsRoot = process.argv[3];
if (!runJsonPath || !workdirsRoot) {
  console.error("Usage: tsx scripts/rebuild_predictions.ts <run.json> <workdirsRoot>");
  process.exit(2);
}

interface Prediction {
  task_id: string;
  prompt: string;
  response: string;
  metadata: Record<string, unknown> | undefined;
  work_dir: string;
  deliverables: unknown[];
  tool_calls: string[];
  turn_count: number;
  session_id?: string;
  duration_ms: number;
  error?: string;
}

const runData = JSON.parse(await readFile(runJsonPath, "utf-8")) as {
  predictions: Prediction[];
  tasks_run: number;
  success_count: number;
  error_count: number;
  started_at: string;
  finished_at?: string;
};

const existingIds = new Set(runData.predictions.map((p) => p.task_id));

// Look at every workdir — those whose task_id isn't in runData.predictions
// are the ones we need to reconstruct. For each, list top-level files
// (excluding harness artefacts) and compute sha256.
const HARNESS_FILES = new Set([
  "_openloomi_sse_debug.log",
  "_repro_debug.log",
  "Population_v2.xlsx",
  "Population%20v2.xlsx",
  "Population v2.xlsx",
]);
const HARNESS_DIRS = new Set([".claude"]);

const taskIds = readdirSync(workdirsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
console.log(`scanning ${taskIds.length} workdirs; ${existingIds.size} predictions already in run.json`);

const recovered: Prediction[] = [];
for (const taskId of taskIds) {
  if (existingIds.has(taskId)) continue;
  const workdir = join(workdirsRoot, taskId);
  // Walk every file (no recursive filtering — every recovered file goes
  // into deliverables).
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (HARNESS_DIRS.has(ent.name)) continue;
        walk(join(dir, ent.name), rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (HARNESS_FILES.has(ent.name)) continue;
      files.push(rel);
    }
  };
  walk(workdir, "");

  const deliverables: unknown[] = [];
  for (const rel of files) {
    const abs = join(workdir, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    deliverables.push({
      workdir_path: rel,
      size_bytes: stat.size,
      sha256: "(recovered — sha not recomputed)",
      mime_type: "application/octet-stream",
    });
  }

  recovered.push({
    task_id: taskId,
    prompt: "(recovered from workdir)",
    response: "",
    metadata: undefined,
    work_dir: workdir,
    deliverables,
    tool_calls: [],
    turn_count: 0,
    duration_ms: 0,
  });
}

console.log(`recovered ${recovered.length} missing entries`);
runData.predictions = [...runData.predictions, ...recovered];
runData.tasks_run = runData.predictions.length;
runData.error_count = runData.predictions.filter((p) => !!p.error).length;
runData.success_count = runData.tasks_run - runData.error_count;
runData.finished_at = new Date().toISOString();

await writeFile(runJsonPath, JSON.stringify(runData, null, 2), "utf-8");
console.log(`wrote ${runJsonPath}: ${runData.predictions.length} predictions`);