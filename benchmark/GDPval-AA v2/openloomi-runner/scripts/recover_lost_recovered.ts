// Recover lost "recovered" deliverables for tasks that were clobbered by
// a failed retry. A retry that errored should NOT overwrite a recovered
// prediction; this script restores the recovered shape by scanning the
// task's artifact directory (which we backed up before the retry run).
//
// Usage:
//   tsx scripts/recover_lost_recovered.ts <run.json> <artifactsRoot>

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const [runJsonPath, artifactsRoot] = process.argv.slice(2);
if (!runJsonPath || !artifactsRoot) {
  console.error("Usage: tsx scripts/recover_lost_recovered.ts <run.json> <artifactsRoot>");
  process.exit(2);
}

interface Prediction {
  task_id: string;
  prompt: string;
  response: string;
  metadata: any;
  work_dir: string;
  deliverables: Array<{
    workdir_path: string;
    size_bytes: number;
      sha256: string;
      mime_type: string;
      archive_path?: string | null;
    }>;
  tool_calls: string[];
  turn_count: number;
  session_id?: string;
  duration_ms: number;
  error?: string;
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function guessMimeType(extension: string): string {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".html": "text/html",
    ".py": "text/x-python",
    ".ts": "text/typescript",
    ".js": "text/javascript",
  };
  return map[extension.toLowerCase()] ?? "application/octet-stream";
}

const runData = JSON.parse(await readFile(runJsonPath, "utf-8")) as {
  predictions: Prediction[];
};

// For each prediction: if it has 0 deliverables AND has a non-empty
// artifact directory, rebuild the recovered shape from the artifact
// backup. This catches both:
//   1. Tasks that errored (fetch failed) — original recovered were
//      clobbered with live+error+0-deliverable.
//   2. Tasks where the retry "succeeded" but produced 0 files (model
//      ran lots of turns but didn't write deliverables) — the live
//      prediction has metadata but no deliverables, which is worse than
//      the recovered placeholder we had before.
let recovered = 0;
for (const p of runData.predictions) {
  if (p.deliverables.length > 0) continue;
  const taskArtifactsDir = join(artifactsRoot, p.task_id);
  if (!existsSync(taskArtifactsDir)) continue;
  const deliverables: Prediction["deliverables"] = [];
  const walk = (dir: string, prefix: string) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      const stat = statSync(abs);
      deliverables.push({
        workdir_path: rel,
        size_bytes: stat.size,
        sha256: sha256File(abs),
        mime_type: guessMimeType(ent.name.split(".").pop() ?? ""),
        archive_path: abs,
      });
    }
  };
  walk(taskArtifactsDir, "");
  if (deliverables.length === 0) continue;
  // Restore recovered shape.
  p.metadata = null;
  p.deliverables = deliverables;
  p.tool_calls = [];
  p.turn_count = 0;
  p.duration_ms = 0;
  p.response = "";
  p.error = undefined;
  recovered += 1;
  console.log(`recovered ${p.task_id}: ${deliverables.length} deliverable(s) from artifacts backup`);
}

runData.success_count = runData.predictions.filter((p) => !p.error).length;
runData.error_count = runData.predictions.filter((p) => !!p.error).length;
runData.tasks_run = runData.predictions.length;
await writeFile(runJsonPath, JSON.stringify(runData, null, 2), "utf-8");
console.log(`recovered ${recovered} predictions; run.json updated.`);