import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { callAgentApi, findAvailablePort, readAuthToken } from "./agent";
import { loadGDPvalDataset } from "./dataset";
import type { GDPvalPrediction, GDPvalRunResult } from "./types";

interface CliArgs {
  dataset: string;
  output?: string;
  quick?: number;
  port?: number;
  tokenPath?: string;
  resume: boolean;
}

function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const values: Record<string, string | number | boolean | undefined> = {
    resume: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dataset" || arg === "-d") {
      values.dataset = argv[++i];
    } else if (arg === "--output" || arg === "-o") {
      values.output = argv[++i];
    } else if (arg === "--quick" || arg === "-q") {
      values.quick = Number.parseInt(argv[++i], 10);
    } else if (arg === "--port" || arg === "-p") {
      values.port = Number.parseInt(argv[++i], 10);
    } else if (arg === "--token" || arg === "-t") {
      values.tokenPath = argv[++i];
    } else if (arg === "--resume") {
      values.resume = true;
    } else if (arg === "--no-resume") {
      values.resume = false;
    }
  }

  if (!values.dataset) {
    console.error("Error: --dataset is required");
    console.error(
      "Usage: pnpm --filter @openloomi/benchmark-gdpval benchmark --dataset dataset/gdpval.jsonl --output results/gdpval_result.json",
    );
    process.exit(1);
  }

  return {
    dataset: values.dataset as string,
    output: values.output as string | undefined,
    quick: values.quick as number | undefined,
    port: values.port as number | undefined,
    tokenPath: values.tokenPath as string | undefined,
    resume: values.resume !== false,
  };
}

async function loadExistingPredictions(
  output?: string,
): Promise<GDPvalPrediction[]> {
  if (!output) return [];
  try {
    const existing = JSON.parse(
      await readFile(output, "utf-8"),
    ) as GDPvalRunResult;
    return Array.isArray(existing.predictions) ? existing.predictions : [];
  } catch {
    return [];
  }
}

function buildBenchmarkPrompt(task: {
  task_id: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}) {
  const metadataText =
    task.metadata && Object.keys(task.metadata).length > 0
      ? `\n\nTask metadata:\n${JSON.stringify(task.metadata, null, 2)}`
      : "";

  return `You are completing a GDPval real-world work task. Produce the requested deliverable directly. Do not mention that this is a benchmark unless asked.\n\nTask ID: ${task.task_id}${metadataText}\n\nTask:\n${task.prompt}`;
}

async function saveResult(output: string | undefined, result: GDPvalRunResult) {
  if (!output) return;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2), "utf-8");
}

async function main() {
  const args = parseCliArgs();
  const port = args.port ?? (await findAvailablePort());
  const authToken = readAuthToken(args.tokenPath);

  console.log(`Using OpenLoomi API port: ${port}`);
  console.log(`Loading GDPval dataset: ${args.dataset}`);

  const allTasks = await loadGDPvalDataset(args.dataset);
  const tasks = args.quick ? allTasks.slice(0, args.quick) : allTasks;
  console.log(`Loaded ${allTasks.length} tasks; running ${tasks.length}`);

  const previous = args.resume
    ? await loadExistingPredictions(args.output)
    : [];
  const predictions = [...previous];
  const completed = new Set(previous.map((item) => item.task_id));

  for (const [index, task] of tasks.entries()) {
    if (completed.has(task.task_id)) {
      console.log(
        `[${index + 1}/${tasks.length}] Skip completed ${task.task_id}`,
      );
      continue;
    }

    console.log(`[${index + 1}/${tasks.length}] Running ${task.task_id}`);
    const prompt = buildBenchmarkPrompt(task);

    try {
      const response = await callAgentApi(prompt, port, authToken);
      predictions.push({
        task_id: task.task_id,
        prompt: task.prompt,
        response,
        metadata: task.metadata,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      predictions.push({
        task_id: task.task_id,
        prompt: task.prompt,
        response: `Error: ${message}`,
        metadata: task.metadata,
        error: message,
      });
    }

    const result = summarize(args.dataset, predictions);
    await saveResult(args.output, result);
  }

  const finalResult = summarize(args.dataset, predictions);
  await saveResult(args.output, finalResult);

  console.log("GDPval run complete");
  console.log(`Tasks run: ${finalResult.tasks_run}`);
  console.log(`Success: ${finalResult.success_count}`);
  console.log(`Errors: ${finalResult.error_count}`);
  if (args.output) console.log(`Results saved to: ${args.output}`);
}

function summarize(
  dataset: string,
  predictions: GDPvalPrediction[],
): GDPvalRunResult {
  const errorCount = predictions.filter(
    (item) => item.error || item.response.startsWith("Error:"),
  ).length;
  return {
    dataset,
    tasks_run: predictions.length,
    success_count: predictions.length - errorCount,
    error_count: errorCount,
    predictions,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
