// Backup the workdirs of recovered predictions (those with no `metadata`
// in run.json) to the artifacts directory BEFORE the --retry-zero-deliverables
// run clears those workdirs. This way, even if the retry fails, we still
// have a copy of the original model output.
//
// Usage:
//   tsx scripts/backup_workdirs.ts <run.json> <workdirsRoot> <artifactsRoot>

import { copyFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const [runJsonPath, workdirsRoot, artifactsRoot] = process.argv.slice(2);
if (!runJsonPath || !workdirsRoot || !artifactsRoot) {
  console.error("Usage: tsx scripts/backup_workdirs.ts <run.json> <workdirsRoot> <artifactsRoot>");
  process.exit(2);
}

interface Prediction {
  task_id: string;
  metadata?: unknown;
  deliverables: Array<{ workdir_path: string }>;
}

const runData = JSON.parse(await readFile(runJsonPath, "utf-8")) as {
  predictions: Prediction[];
};

// Predictions to back up: either zero-deliverables OR metadata-undefined.
const toBackup = runData.predictions.filter(
  (p) => p.deliverables.length === 0 || p.metadata === undefined || p.metadata === null,
);

let copied = 0;
let skipped = 0;
let missing = 0;
for (const p of toBackup) {
  const taskWorkdir = join(workdirsRoot, p.task_id);
  const taskArtifactsDir = join(artifactsRoot, p.task_id);
  // If the artifact dir already exists and has files, skip.
  if (existsSync(taskArtifactsDir)) {
    const existing = readdirSync(taskArtifactsDir).filter((n) => !n.startsWith("."));
    if (existing.length > 0) {
      skipped++;
      continue;
    }
  }
  if (!existsSync(taskWorkdir)) {
    missing++;
    continue;
  }
  await mkdir(taskArtifactsDir, { recursive: true });

  const walk = async (srcDir: string, prefix: string) => {
    let dirents;
    try {
      dirents = readdirSync(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const srcAbs = join(srcDir, ent.name);
      const destAbs = join(taskArtifactsDir, rel);
      if (ent.isDirectory()) {
        // Skip harness dirs
        if (ent.name === ".claude" || ent.name === "node_modules" || ent.name === ".next") continue;
        await mkdir(dirname(destAbs), { recursive: true });
        await walk(srcAbs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      // Skip harness files
      if (
        ent.name === "_openloomi_sse_debug.log" ||
        ent.name === "_repro_debug.log" ||
        ent.name === "Population_v2.xlsx" ||
        ent.name === "Population%20v2.xlsx" ||
        ent.name === "Population v2.xlsx"
      ) {
        continue;
      }
      try {
        await mkdir(dirname(destAbs), { recursive: true });
        await copyFile(srcAbs, destAbs);
        copied++;
      } catch (err) {
        console.warn(`  ! ${p.task_id}/${rel}: copy failed: ${(err as Error).message}`);
      }
    }
  };
  await walk(taskWorkdir, "");
}

console.log(`backup done: copied=${copied} skipped=${skipped} missing=${missing} total=${toBackup.length}`);