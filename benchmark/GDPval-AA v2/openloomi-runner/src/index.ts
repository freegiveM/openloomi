/**
 * GDPval-AA v2 runner (OpenLoomi harness).
 *
 * For every task in the dataset:
 *   1. Create an isolated per-task working directory.
 *   2. Resolve the task's reference files from the local cache and forward
 *      them to `/api/native/agent` as `fileAttachments` (the OpenLoomi
 *      harness writes them into the workDir — same semantic as Stirrup's
 *      E2B sandbox pre-population).
 *   3. Build the v2 system prompt + task prompt via the official Python
 *      prompt builder (`scripts/prompts/prompt_builder.py`).
 *   4. Call the agent with the v2 tool set (`WebFetch`, `WebSearch`,
 *      `ViewImage`, `Bash`). The 250-turn cap is enforced client-side.
 *   5. Parse the v2 `finish` / `abandon_task_finish` text protocol from
 *      the model's final message to recover the deliverable file paths.
 *   6. Copy the listed files (and any `tool_result.fileSnapshots`) into
 *      `results/artifacts/<task_id>/` and write a per-task archive record.
 *
 * The final run summary feeds `scripts/evaluate.py`, which emits the
 * submission JSONL expected by the pair-wise grader downstream.
 */

import "dotenv/config";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  ABANDON_TOKEN,
  FINISH_TOKEN,
  buildFinishDeliverables,
  buildOfficialPrompts,
  callOpenLoomiAgent,
  findAvailablePort,
  loadReferenceAttachments,
  readAuthToken,
  summariseHandle,
  V2_TOOL_SET,
} from "./agent";
import { loadGDPvalAADataset } from "./dataset";
import type {
  GDPvalAADeliverable,
  GDPvalAAPrediction,
  GDPvalAARunResult,
} from "./types";

interface CliArgs {
  dataset: string;
  output: string;
  artifactsDir: string;
  workdirsDir: string;
  referenceIndex?: string;
  port?: number;
  tokenPath?: string;
  provider: string;
  model: string;
  permissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  timeoutMs: number;
  quick?: number;
  resume: boolean;
  /** When set, overrides the default v2 tool set. */
  allowedTools?: string[];
  /** Skip the official v2 prompt builder; use a plain text dump instead. */
  useOfficialPrompts: boolean;
}

// Resolve from this file: src/index.ts -> ../dataset/reference_files/...
// so the runner works no matter where the repo is checked out. Falls
// through to the env override if you want to point at a different cache.
const DEFAULT_REFERENCE_INDEX = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\//, "")),
  "..",
  "dataset",
  "reference_files",
  "reference_files_index.json",
);

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string | number | boolean | undefined> = {
    resume: true,
    output: "results/gdpval_aa_v2_run.json",
    artifactsDir: "results/artifacts",
    workdirsDir: "results/workdirs",
    referenceIndex:
      process.env.GDPVAL_AA_V2_REFERENCE_INDEX ?? DEFAULT_REFERENCE_INDEX,
    provider: process.env.OPENLOOMI_DEFAULT_PROVIDER ?? "claude",
    model: process.env.OPENLOOMI_DEFAULT_MODEL ?? "claude-sonnet-4-5",
    permissionMode: "bypassPermissions",
    timeoutMs: Number.parseInt(
      process.env.GDPVAL_AA_V2_TASK_TIMEOUT_MS ?? "1800000",
      10,
    ),
    useOfficialPrompts: true,
  };
  let allowedTools: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dataset":
      case "-d":
        values.dataset = argv[++i];
        break;
      case "--output":
      case "-o":
        values.output = argv[++i];
        break;
      case "--artifacts-dir":
        values.artifactsDir = argv[++i];
        break;
      case "--workdirs-dir":
        values.workdirsDir = argv[++i];
        break;
      case "--reference-index":
      case "-r":
        values.referenceIndex = argv[++i];
        break;
      case "--port":
      case "-p":
        values.port = Number.parseInt(argv[++i], 10);
        break;
      case "--token":
      case "-t":
        values.tokenPath = argv[++i];
        break;
      case "--provider":
        values.provider = argv[++i];
        break;
      case "--model":
      case "-m":
        values.model = argv[++i];
        break;
      case "--permission-mode":
        values.permissionMode = argv[++i];
        break;
      case "--timeout-ms":
        values.timeoutMs = Number.parseInt(argv[++i], 10);
        break;
      case "--allowed-tools":
        allowedTools = argv[++i].split(",").map((s) => s.trim());
        break;
      case "--quick":
      case "-q":
        values.quick = Number.parseInt(argv[++i], 10);
        break;
      case "--resume":
        values.resume = true;
        break;
      case "--no-resume":
        values.resume = false;
        break;
      case "--official-prompts":
        values.useOfficialPrompts = true;
        break;
      case "--no-official-prompts":
        values.useOfficialPrompts = false;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }
  if (!values.dataset) {
    console.error("Error: --dataset is required (path to gdpval_gold.jsonl)");
    printUsage();
    process.exit(1);
  }
  return {
    dataset: values.dataset as string,
    output: values.output as string,
    artifactsDir: values.artifactsDir as string,
    workdirsDir: values.workdirsDir as string,
    referenceIndex: values.referenceIndex as string | undefined,
    port: values.port as number | undefined,
    tokenPath: values.tokenPath as string | undefined,
    provider: values.provider as string,
    model: values.model as string,
    permissionMode: values.permissionMode as CliArgs["permissionMode"],
    timeoutMs: values.timeoutMs as number,
    quick: values.quick as number | undefined,
    resume: values.resume as boolean,
    allowedTools,
    useOfficialPrompts: values.useOfficialPrompts as boolean,
  };
}

function printUsage() {
  console.log(`GDPval-AA v2 OpenLoomi runner (v2-spec aligned)

Usage:
  pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- \\
    --dataset ../dataset/gdpval_gold.jsonl \\
    --output results/gdpval_aa_v2_run.json \\
    --provider claude --model claude-sonnet-4-5

Required:
  --dataset, -d           Path to gdpval_gold.jsonl

Optional:
  --output, -o            Run summary output (default: results/gdpval_aa_v2_run.json)
  --artifacts-dir         Deliverable archive dir (default: results/artifacts)
  --workdirs-dir          Per-task work dir root (default: results/workdirs)
  --reference-index, -r   Path to reference_files_index.json
                          (default: ../dataset/reference_files/reference_files_index.json)
  --port, -p              OpenLoomi API port (auto-detected if omitted)
  --token, -t             Path to bearer token file
  --provider              OpenLoomi agent runtime (claude | codex | opencode | hermes | openclaw)
  --model, -m             Model identifier (forwarded to the harness)
  --permission-mode       default | acceptEdits | bypassPermissions | plan | dontAsk
  --timeout-ms            Per-task wall-clock budget (default 30 min)
  --allowed-tools         Override the v2 tool set (default: WebFetch,WebSearch,ViewImage,Bash)
  --quick, -q             Only run the first N tasks
  --resume / --no-resume  Skip tasks already in --output (default: resume)
  --no-official-prompts   Skip the Python prompt builder; pass the raw task
                          prompt to the agent with the finish text protocol
                          appended. Useful for debugging.

v2 finish text protocol:
  The model is expected to end every task with a final message that
  contains one of:

      ${FINISH_TOKEN}
      <one-line summary>
      /abs/path/to/deliverable1
      /abs/path/to/deliverable2
      ...

      ${ABANDON_TOKEN}
      <one-line reason>

  OpenLoomi has no native finish / abandon_task_finish tool, so we
  emulate the v2 contract through this text protocol.
`);
}

async function loadExistingPredictions(
  output: string,
): Promise<GDPvalAAPrediction[]> {
  try {
    // Tolerate UTF-8 BOM (PowerShell `Set-Content` writes one by default).
    const text = await readFile(output, "utf-8");
    const parsed = JSON.parse(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    ) as GDPvalAARunResult;
    return Array.isArray(parsed.predictions) ? parsed.predictions : [];
  } catch {
    return [];
  }
}

async function archiveDeliverable(
  workdir: string,
  deliverable: GDPvalAADeliverable,
  archiveDir: string,
  taskId: string,
): Promise<string> {
  const safeFileName = deliverable.workdir_path.replace(/[\\/]/g, "__");
  const target = join(archiveDir, taskId, safeFileName);
  await mkdir(dirname(target), { recursive: true });
  const source = isAbsolute(deliverable.workdir_path)
    ? deliverable.workdir_path
    : resolve(workdir, deliverable.workdir_path);
  await copyFile(source, target);
  return `artifacts/${taskId}/${safeFileName}`;
}

async function saveRunResult(
  output: string,
  base: GDPvalAARunResult,
  predictions: GDPvalAAPrediction[],
): Promise<void> {
  const errorCount = predictions.filter((p) => !!p.error).length;
  const finishedAt = new Date().toISOString();
  const result: GDPvalAARunResult = {
    ...base,
    finished_at: finishedAt,
    tasks_run: predictions.length,
    success_count: predictions.length - errorCount,
    error_count: errorCount,
    predictions,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2), "utf-8");
}

interface ReferenceIndex {
  [taskId: string]: string[];
}

async function loadReferenceIndex(path?: string): Promise<ReferenceIndex> {
  if (!path) return {};
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    ) as ReferenceIndex;
  } catch {
    console.warn(
      `[GDPval-AA v2] WARN: could not load reference index at ${path} (continuing without reference files)`,
    );
    return {};
  }
}

function plainFinishProtocol(taskPrompt: string, taskId: string): string {
  // A minimal prompt that still asks the model to emit our finish text
  // protocol at the end. Used when --no-official-prompts is set.
  return [
    "You are completing a GDPval-AA v2 task via the OpenLoomi harness.",
    `Task ID: ${taskId}`,
    "",
    "When you are done, your FINAL message must contain exactly one of:",
    "",
    `  ${FINISH_TOKEN}`,
    "  <one-line summary>",
    "  <abs path 1>",
    "  <abs path 2>",
    "",
    `  ${ABANDON_TOKEN}`,
    "  <one-line reason>",
    "",
    "Task:",
    taskPrompt,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port ?? (await findAvailablePort());
  const authToken = readAuthToken(args.tokenPath);

  console.log(`[GDPval-AA v2] OpenLoomi API port: ${port}`);
  console.log(`[GDPval-AA v2] Dataset: ${args.dataset}`);
  console.log(
    `[GDPval-AA v2] Provider=${args.provider} model=${args.model} ` +
      `permissionMode=${args.permissionMode}`,
  );
  console.log(
    `[GDPval-AA v2] Official v2 prompts: ${args.useOfficialPrompts ? "on" : "off"}`,
  );

  const tasks = await loadGDPvalAADataset(args.dataset);
  const selected = args.quick ? tasks.slice(0, args.quick) : tasks;
  console.log(
    `[GDPval-AA v2] Loaded ${tasks.length} tasks; running ${selected.length}`,
  );

  const workdirsDir = resolve(args.workdirsDir);
  const artifactsDir = resolve(args.artifactsDir);
  await mkdir(workdirsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const referenceIndex = await loadReferenceIndex(args.referenceIndex);
  const refCount = Object.keys(referenceIndex).length;
  if (refCount > 0) {
    const totalFiles = Object.values(referenceIndex).reduce(
      (acc, list) => acc + list.length,
      0,
    );
    console.log(
      `[GDPval-AA v2] Loaded reference index: ${refCount} task(s), ${totalFiles} file(s)`,
    );
  } else {
    console.log(
      "[GDPval-AA v2] No reference index available — tasks will run without reference files",
    );
  }

  const previous = args.resume
    ? await loadExistingPredictions(args.output)
    : [];
  const completed = new Set(previous.map((p) => p.task_id));
  const predictions: GDPvalAAPrediction[] = [...previous];

  const baseResult: GDPvalAARunResult = {
    dataset: args.dataset,
    started_at: new Date().toISOString(),
    model: args.model,
    provider: args.provider,
    tasks_run: 0,
    success_count: 0,
    error_count: 0,
    predictions: [],
  };

  const allowedTools = args.allowedTools ?? [...V2_TOOL_SET];

  for (const [index, task] of selected.entries()) {
    if (completed.has(task.task_id)) {
      console.log(
        `[${index + 1}/${selected.length}] Skip completed ${task.task_id}`,
      );
      continue;
    }

    const taskWorkdir = join(workdirsDir, task.task_id);
    // Fresh workdir per task — never reuse deliverables across tasks.
    await rm(taskWorkdir, { recursive: true, force: true });
    await mkdir(taskWorkdir, { recursive: true });

    const startMs = Date.now();
    console.log(
      `[${index + 1}/${selected.length}] Running ${task.task_id} -> ${taskWorkdir}`,
    );

    // 1) Resolve reference files for this task.
    const refPaths = referenceIndex[task.task_id] ?? [];
    const refAttachments = loadReferenceAttachments(refPaths);
    if (refAttachments.length > 0) {
      console.log(
        `  + ${refAttachments.length} reference file(s) staged for this task`,
      );
    }

    // 2) Build the v2 prompt (system + task). The official prompt is
    //    ~12 KB, well within OpenLoomi's request-body budget.
    let systemPrompt: string;
    let taskPrompt: string;
    if (args.useOfficialPrompts) {
      const official = buildOfficialPrompts(
        task.prompt,
        // The official prompt is rendered as if all reference files live at
        // /home/user/<name>; on OpenLoomi we land them at workDir/<name>,
        // but we list only the basenames in the prompt so the model writes
        // back using the same basenames.
        refAttachments.map((a) => a.name),
      );
      systemPrompt = official.system_prompt;
      taskPrompt = official.task_prompt;
    } else {
      systemPrompt = `You are an AI agent completing a standalone professional task. End your run by emitting one of: ${FINISH_TOKEN} (followed by summary and absolute file paths) or ${ABANDON_TOKEN} (followed by a reason).`;
      taskPrompt = plainFinishProtocol(task.prompt, task.task_id);
    }

    let prediction: GDPvalAAPrediction;
    try {
      const handle = await callOpenLoomiAgent({
        prompt: taskPrompt,
        systemPrompt,
        port,
        authToken,
        workDir: taskWorkdir,
        provider: args.provider,
        model: args.model,
        permissionMode: args.permissionMode,
        allowedTools,
        timeoutMs: args.timeoutMs,
        // Inject reference files via the v2 fileAttachments contract.
        // (The OpenLoomi agent module reads them as base64 + name and
        // writes them into workDir.)
        fileAttachments: refAttachments.map((a) => ({
          name: a.name,
          data: a.dataBase64,
          mimeType: a.mimeType,
        })),
      });

      // 3) Merge the v2 finish text protocol with the fileSnapshots
      //    already captured by the SSE drainer. Finish paths win because
      //    they're the model's explicit v2 contract.
      const finishDeliverables = buildFinishDeliverables(
        taskWorkdir,
        handle.submitted_paths,
      );
      // Order matters: keep finish deliverables first so dedupe by
      // (workdir_path, sha256) prefers them.
      const mergedDeliverables: GDPvalAADeliverable[] = [
        ...finishDeliverables,
        ...handle.deliverables,
      ];
      const deduped: GDPvalAADeliverable[] = [];
      const seen = new Set<string>();
      for (const d of mergedDeliverables) {
        const key = `${d.workdir_path}::${d.sha256}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(d);
      }

      const archive = async (rel: string): Promise<string | undefined> => {
        const deliverable = deduped.find((d) => d.workdir_path === rel);
        if (!deliverable) return undefined;
        try {
          return await archiveDeliverable(
            taskWorkdir,
            deliverable,
            artifactsDir,
            task.task_id,
          );
        } catch (err) {
          console.warn(
            `  ! failed to archive ${rel}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return undefined;
        }
      };

      const archived: GDPvalAADeliverable[] = [];
      for (const d of deduped) {
        const archivePath = await archive(d.workdir_path);
        archived.push({ ...d, archive_path: archivePath });
      }

      prediction = {
        task_id: task.task_id,
        prompt: task.prompt,
        response: handle.text,
        metadata: task.metadata,
        work_dir: taskWorkdir,
        deliverables: archived,
        tool_calls: handle.tool_calls,
        turn_count: handle.turn_count,
        session_id: handle.session_id,
        duration_ms: Date.now() - startMs,
        usage: handle.usage,
      };

      const finishNote = handle.abandoned
        ? ` ABANDONED (${handle.abandon_reason ?? "no reason"})`
        : handle.truncated
          ? " TRUNCATED (>250 turns)"
          : "";
      console.log(
        `  -> ${archived.length} deliverable(s) in ` +
          `${(prediction.duration_ms / 1000).toFixed(1)}s ` +
          `(${prediction.tool_calls.length} tool calls, ${prediction.turn_count} turns)${finishNote}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  x ${task.task_id} failed: ${message}`);
      prediction = {
        task_id: task.task_id,
        prompt: task.prompt,
        response: "",
        metadata: task.metadata,
        work_dir: taskWorkdir,
        deliverables: [],
        tool_calls: [],
        turn_count: 0,
        duration_ms: Date.now() - startMs,
        error: message,
      };
    }

    predictions.push(prediction);
    await saveRunResult(args.output, baseResult, predictions);
  }

  await saveRunResult(args.output, baseResult, predictions);

  const finalCount = predictions.length;
  const finalErrors = predictions.filter((p) => !!p.error).length;
  console.log("\n=== GDPval-AA v2 run complete ===");
  console.log(`Tasks run:    ${finalCount}`);
  console.log(`Success:      ${finalCount - finalErrors}`);
  console.log(`Errors:       ${finalErrors}`);
  console.log(`Run summary:  ${args.output}`);
  console.log(`Artifacts:    ${artifactsDir}`);
  console.log(`Per-task workdirs: ${workdirsDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
