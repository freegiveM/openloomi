import { readFile } from "node:fs/promises";
import type { JobBenchTask } from "./types";

export async function loadJobBenchDataset(
  path: string,
): Promise<JobBenchTask[]> {
  const text = await readFile(path, "utf-8");
  const tasks: JobBenchTask[] = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = JSON.parse(trimmed) as Partial<JobBenchTask>;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      throw new Error(
        `Invalid JobBench JSONL line ${index + 1}: missing prompt`,
      );
    }

    tasks.push({
      task_id:
        parsed.task_id || `jobbench_${index.toString().padStart(4, "0")}`,
      prompt: parsed.prompt,
      metadata: parsed.metadata,
      raw: parsed.raw,
    });
  }

  return tasks;
}
