import { readFile } from "node:fs/promises";
import type { GDPvalTask } from "./types";

export async function loadGDPvalDataset(path: string): Promise<GDPvalTask[]> {
  const text = await readFile(path, "utf-8");
  const tasks: GDPvalTask[] = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = JSON.parse(trimmed) as Partial<GDPvalTask>;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      throw new Error(`Invalid GDPval JSONL line ${index + 1}: missing prompt`);
    }

    tasks.push({
      task_id: parsed.task_id || `gdpval_${index.toString().padStart(4, "0")}`,
      prompt: parsed.prompt,
      metadata: parsed.metadata,
      raw: parsed.raw,
    });
  }

  return tasks;
}
