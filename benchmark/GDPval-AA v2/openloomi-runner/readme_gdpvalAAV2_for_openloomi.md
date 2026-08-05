# GDPval-AA v2 on OpenLoomi — v2-spec aligned runner

This is the **submission-side runner** for the GDPval-AA v2 evaluation. It uses OpenLoomi as the task-submission harness and produces a JSON blob of file deliverables that can be fed to any v2-compatible pair-wise grader (including Artificial Analysis' own `evals.openai.com`, given access).

> **Important scope boundary.** Artificial Analysis only published the submission side of the v2 stack (Stirrup, the official task prompt, and the dataset). The pair-wise grading service (`evals.openai.com`) and the 3-judge panel are **not** open-source. This runner produces v2-shaped submissions; you must run your own grader (or use AA's web service) to compute Elo.

## How the runner aligns with the v2 spec

| v2 spec element                                                           | How this runner covers it                                                                                               | Status                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Dataset (`openai/gdpval` gold, 220 tasks)                                 | `../dataset/gdpval_gold.jsonl` (pre-downloaded)                                                                         | Supported                               |
| Reference files (up to ~17 per task)                                      | Pre-fetched into `../dataset/reference_files/<task_id>/`, injected via `fileAttachments`                                | Supported                               |
| System prompt ("AI agent … 250 steps … finish … abandon_task_finish")     | `scripts/prompts/prompt_builder.py` (verbatim)                                                                          | Supported                               |
| Task prompt (runtime, env, reference-files block, finish instructions)    | Same builder, verbatim                                                                                                  | Supported                               |
| Tool set (WebFetch / WebSearch / ViewImage / CodeExec / Finish / Abandon) | OpenLoomi has no native Finish/Abandon tools — emulated via a text protocol. Tools are restricted to the four v2 tools. | Supported (with emulation)              |
| Turn cap = 250                                                            | Enforced client-side; auto-aborts at the 251st `tool_use` event                                                         | Supported                               |
| 70% context summarization                                                 | Provided by the agent runtime; not explicitly enforced                                                                  | Runtime-level                           |
| Temperature 0 / 0.6                                                       | Not set here; controlled by the agent runtime (configurable in OpenLoomi Settings → AI)                                 | Runtime-level                           |
| Max output tokens                                                         | Same as above — runtime-controlled                                                                                      | Runtime-level                           |
| Sandbox (E2B)                                                             | Real local filesystem (workDir per task)                                                                                | Behaviour may differ from the E2B image |
| Finish protocol ("absolute paths in finish call")                         | Text protocol: `<<<FINISH>>>` + summary + paths                                                                         | Supported                               |
| Abandon protocol                                                          | Text protocol: `<<<ABANDON>>>` + reason                                                                                 | Supported                               |
| Pair-wise judging + Elo (anchor = human experts 1000)                     | Out of scope here — use `../grader/GDPVal_EVal` or `evals.openai.com`                                                   | Out of scope                            |

## Layout

```
benchmark/GDPval-AA v2/
├── dataset/                                (resources)
│   ├── gdpval_gold.jsonl                   220 tasks
│   ├── reference_files/<task_id>/<file>    pre-fetched reference files
│   ├── reference_files_index.json          {task_id: [abs_path, ...]}
│   ├── download_gdpval.py                  fetch the 220 tasks from HF
│   └── fetch_reference_files.py            fetch every reference file
├── docs/                                   PDFs
├── harness/Stirrup/                        official AA submission harness
├── grader/GDPVal_EVal/                     botschen's Bradley-Terry Elo + grader
├── leaderboard/                            AA public leaderboard
└── openloomi-runner/                       ← you are here
    ├── README.md
    ├── readme_gdpvalAAV2_for_openloomi.md  this file
    ├── run_gdpval_aa_v2.sh                 one-shot workflow
    ├── package.json                        @openloomi/benchmark-gdpval-aa-v2
    ├── tsconfig.json
    ├── .env.example
    ├── src/
    │   ├── types.ts
    │   ├── dataset.ts
    │   ├── agent.ts                        OpenLoomi SSE client + finish protocol
    │   └── index.ts                        CLI entry point
    ├── scripts/
    │   ├── prompts/prompt_builder.py       official v2 prompts (verbatim)
    │   ├── evaluate.py                     convert run summary -> submission JSONL
    │   └── smoke_finish_protocol.ts        TS smoke test
    └── results/                            (created at runtime)
        ├── gdpval_aa_v2_run.json
        ├── artifacts/<task_id>/
        ├── workdirs/<task_id>/
        └── submissions/openloomi_<…>.jsonl
```

## Setup

Start the OpenLoomi desktop app in one terminal:

```powershell
cd D:\openloomi
pnpm tauri:dev
```

Inside the desktop app: **Settings → AI / API → save baseUrl / apiKey / model.** That model is the one that actually runs every GDPval task.

Verify the API is reachable:

```powershell
curl http://127.0.0.1:3515/api/native/providers
```

## Run the benchmark

### One-shot script

The bundled `run_gdpval_aa_v2.sh` does everything end-to-end:

```bash
cd "/d/openloomi3/openloomi/benchmark/GDPval-AA v2/openloomi-runner"
bash run_gdpval_aa_v2.sh --quick 3          # smoke test on 3 tasks
bash run_gdpval_aa_v2.sh                    # full 220-task run
bash run_gdpval_aa_v2.sh --provider codex --model gpt-5-codex
bash run_gdpval_aa_v2.sh --skip-run --skip-download   # just re-export submissions
bash run_gdpval_aa_v2.sh --no-resume        # start from scratch
```

The script also runs `fetch_reference_files.py` (parallel, 8 concurrent) to make sure every task's reference files are on disk before kicking off the agent.

### Manual invocation

```powershell
cd D:\openloomi
pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- `
  --dataset "../GDPval-AA v2/dataset/gdpval_gold.jsonl" `
  --output   "results/gdpval_aa_v2_run.json" `
  --reference-index "../GDPval-AA v2/dataset/reference_files/reference_files_index.json" `
  --provider claude `
  --model    claude-sonnet-4-5
```

Useful flags:

| Flag                                                             | Effect                                              |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| `--quick N`                                                      | Only run the first N tasks.                         |
| `--no-resume`                                                    | Start from scratch (deletes the prior run summary). |
| `--provider codex --model gpt-5-codex`                           | Switch the agent runtime and model.                 |
| `--timeout-ms 3600000`                                           | Raise the per-task wall-clock budget.               |
| `--allowed-tools "WebFetch,WebSearch,ViewImage,Bash,Write,Read"` | Override the default v2 tool set.                   |
| `--no-official-prompts`                                          | Debug: skip the Python prompt builder.              |

## The v2 finish text protocol

Because OpenLoomi has no first-class `finish` / `abandon_task_finish` tool, the runner instructs the agent (in both the system and task prompts) to end its run with one of:

```
<<<FINISH>>>
<one-line summary>
<abs path 1>
<abs path 2>
...
```

or

```
<<<ABANDON>>>
<one-line reason>
```

The runner's SSE drainer captures the model's full text, then `parseFinishProtocol` (in [src/agent.ts](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/agent.ts)) extracts the path list. The first non-empty line after `<<<FINISH>>>` is treated as the summary; subsequent lines that look like absolute paths (`/foo`, `\foo`, `C:\foo`, `D:/foo`) become the submitted file list.

These paths are then resolved against the task's workDir, hashed, and copied into `results/artifacts/<task_id>/`.

## What the runner captures per task

In `results/gdpval_aa_v2_run.json`:

```jsonc
{
  "task_id": "83d10b06-26d1-4636-a32c-23f92c57f30b",
  "prompt": "...",
  "response": "...final assistant text (incl. <<<FINISH>>> block)...",
  "metadata": { "occupation": "...", "sector": "..." },
  "work_dir": "D:\\...\\openloomi-runner\\results\\workdirs\\83d10b06-...",
  "deliverables": [
    {
      "workdir_path": "report.pdf",
      "archive_path": "artifacts/83d10b06-.../report.pdf",
      "size_bytes": 218443,
      "sha256": "...",
      "mime_type": "application/pdf"
    }
  ],
  "tool_calls": ["WebFetch", "Bash", ...],
  "turn_count": 24,
  "session_id": "...",
  "duration_ms": 432109,
  "usage": { "input_tokens": 1234, "output_tokens": 567 }
}
```

## Exporting the submission JSONL

```powershell
cd D:\openloomi\benchmark\GDPval-AA v2\openloomi-runner
python scripts\evaluate.py `
  --run results\gdpval_aa_v2_run.json `
  --output results\submissions\openloomi_claude-sonnet-4-5.jsonl
```

Run the same benchmark with a second model (or with Stirrup itself) to produce a second JSONL, then grade:

```powershell
cd "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\grader\GDPVal_EVal"
pip install -e ".[dev]"
$env:GEMINI_API_KEY = "..."

# Pair-wise judge (single-judge approximation; v2 uses a 3-judge panel).
# Replace this with the AA grader if you have access.
python -m gdpval.grading.pairwise_grader `
  --task-set    "../dataset/gdpval_gold.jsonl" `
  --submission-a "../openloomi-runner/results/submissions/openloomi_claude-sonnet-4-5.jsonl" `
  --submission-b "../openloomi-runner/results/submissions/openloomi_stirrup_claude-sonnet-4-5.jsonl" `
  --out          matches.jsonl

# Bradley-Terry Elo fit. The v2 anchor is "human expert deliverables = 1000"
# (not gpt-5.1 — that was v1).
python -m gdpval.elo.bradley_terry --matches matches.jsonl --anchor 1000
```

## Smoke test (no OpenLoomi needed)

```bash
cd /d/openloomi3/openloomi
npx tsx "benchmark/GDPval-AA v2/openloomi-runner/scripts/smoke_finish_protocol.ts"
```

This verifies (1) that the official v2 prompt builder is callable, (2) that its output contains every required section, and (3) that the finish / abandon text protocol parser recovers absolute paths correctly. The smoke test does not contact OpenLoomi.

## Caveats / what still deviates

1. **Sandbox.** v2 runs each task in an E2B sandbox; this runner uses your local filesystem. If a task depends on packages that are not installed on your machine (LaTeX, CADquery, RDKit, …), the agent will fail.
2. **No native `finish` tool.** OpenLoomi does not expose one. We emulate it via a text protocol. Models that strictly refuse to follow the text protocol will produce zero deliverables; rerun with `--no-official-prompts` to debug.
3. **Panel judging.** v2 uses a 3-judge panel anchored to human expert deliverables at 1000. The `GDPVal_EVal` grader ships a single-judge version; your Elo will be **correlated** with the AA leaderboard but will not match it exactly.
4. **Office metadata fixes.** AA manually fixed some malformed Office files in the dataset so LibreOffice can open them. The runner ships the unfixed HF version; you may need to apply the same patches if a task fails to open a `.docx` / `.xlsx`.

## Files in this package

- `src/agent.ts` — OpenLoomi SSE client, official prompt assembly, finish/abandon text-protocol parser, 250-turn cap, reference-file injection, v2 tool set, SHA-256 + mime-type helpers.
- `src/index.ts` — reads the reference index, forwards attachments via `fileAttachments`, builds the v2 prompt, parses the finish protocol, and merges `fileSnapshots` with the finish-declared files.
- `scripts/prompts/prompt_builder.py` — verbatim copy of the AA methodology-page system and task prompts.
- `scripts/smoke_finish_protocol.ts` — TS smoke test (no OpenLoomi).
- `dataset/fetch_reference_files.py` — parallel downloader for every task's reference files.
