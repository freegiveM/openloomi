import { readFile } from "node:fs/promises";
import type { GDPvalAATask } from "./types";

/**
 * Load the GDPval-AA v2 task set (one JSONL record per task).
 *
 * The shipped `dataset/gdpval_gold.jsonl` already follows the OpenLoomi
 * task schema (`{task_id, prompt, metadata, raw}`); see
 * `../dataset/download_gdpval.py` for the converter.
 */
export async function loadGDPvalAADataset(
  path: string,
): Promise<GDPvalAATask[]> {
  const text = await readFile(path, "utf-8");
  const tasks: GDPvalAATask[] = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as Partial<GDPvalAATask>;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      throw new Error(
        `Invalid GDPval-AA v2 JSONL line ${index + 1}: missing prompt`,
      );
    }
    tasks.push({
      task_id:
        parsed.task_id || `gdpval_aa_${index.toString().padStart(4, "0")}`,
      prompt: parsed.prompt,
      metadata: parsed.metadata,
      raw: parsed.raw,
    });
  }

  return tasks;
}
