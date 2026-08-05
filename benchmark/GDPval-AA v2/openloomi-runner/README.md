# GDPval-AA v2 Benchmark for OpenLoomi (harness mode)

This package is the **OpenLoomi-native runner** for the
[GDPval-AA v2](https://artificialanalysis.ai/evaluations/gdpval-aa)
evaluation. It uses OpenLoomi as the agent harness (in place of the
official [Stirrup](https://github.com/ArtificialAnalysis/Stirrup) harness)
to drive each task and captures the real file deliverables.

> ⚠️ The runner lives at `benchmark/GDPval-AA v2/openloomi-runner/`. It
> ships alongside the dataset, the cloned Stirrup harness, the cloned
> `GDPVal_EVal` grader, and the leaderboard — all in one place.

## How this fits the GDPval-AA v2 pipeline

| Stage               | Official                                                                                           | This package                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task submission     | Stirrup harness + 5 tools (Web Fetch / Web Search / View Image / Run Shell / Finish) + E2B sandbox | OpenLoomi `/api/native/agent` + 4 v2 tools (WebFetch / WebSearch / ViewImage / Bash) + per-task workDir. Finish / AbandonTask are emulated via a `<<<FINISH>>>` / `<<<ABANDON>>>` text protocol. |
| Deliverable capture | `finish` tool + saved output files in `/home/user/`                                                | SSE `tool_result.fileSnapshots` **plus** the v2 finish text protocol — both are merged and copied into `results/artifacts/<task_id>/`.                                                           |
| Reference files     | Auto-injected into the E2B sandbox per task                                                        | Pre-fetched into `../dataset/reference_files/<task_id>/` and forwarded to OpenLoomi via `fileAttachments` (which writes them into workDir verbatim).                                             |
| Pairwise grading    | Gemini 3 Pro                                                                                       | Reuse `../grader/GDPVal_EVal/gdpval/grading/pairwise_grader.py` (or AA's `evals.openai.com` if you have access).                                                                                 |
| Elo fit             | Bradley-Terry MLE, GPT-5.1 = 1000 (v1) / human expert = 1000 (v2)                                  | Same algorithm, see `../grader/GDPVal_EVal/gdpval/elo/`.                                                                                                                                         |

The dataset is the official `openai/gdpval` gold subset (220 tasks, 44
occupations, 9 US-GDP-contributing industries), already downloaded to
`../dataset/gdpval_gold.jsonl`.

## Layout

```
benchmark/GDPval-AA v2/
├── dataset/                                (resources)
│   ├── gdpval_gold.jsonl                   220 tasks
│   ├── reference_files/<task_id>/<file>   pre-fetched reference files
│   ├── reference_files_index.json          {task_id: [abs_path, ...]}
│   ├── download_gdpval.py                  fetch the 220 tasks from HF
│   └── fetch_reference_files.py            fetch every reference file
├── docs/                                   PDFs
├── harness/Stirrup/                        official AA submission harness
├── grader/GDPVal_EVal/                    botschen's Bradley-Terry Elo + grader
├── leaderboard/                            AA public leaderboard (185 models)
├── README.md                               this folder's overview
└── openloomi-runner/                       ← you are here
    ├── README.md                           this file
    ├── readme_gdpvalAAV2_for_openloomi.md  detailed v2-spec aligned docs
    ├── run_gdpval_aa_v2.sh                 one-shot workflow
    ├── package.json                        @openloomi/benchmark-gdpval-aa-v2
    ├── tsconfig.json
    ├── .env.example
    ├── src/
    │   ├── types.ts
    │   ├── dataset.ts
    │   ├── agent.ts                        OpenLoomi SSE client + finish protocol
    │   └── index.ts                       CLI entry point
    ├── scripts/
    │   ├── evaluate.py                     build the submission JSONL
    │   ├── smoke_finish_protocol.ts        TS smoke test
    │   └── prompts/prompt_builder.py       official v2 prompts (verbatim)
    └── results/                           (created at runtime)
        ├── gdpval_aa_v2_run.json
        ├── artifacts/<task_id>/
        ├── workdirs/<task_id>/
        └── submissions/openloomi_<…>.jsonl
```

## Setup

Start OpenLoomi in another terminal first:

```powershell
cd D:\openloomi
pnpm tauri:dev
```

Wait until the server prints the bearer token (it lives in
`~/.openloomi/token` on Windows) and the agent endpoint is reachable at
<http://127.0.0.1:3515/api/native/agent>. Probe it:

```powershell
curl http://127.0.0.1:3515/api/native/providers
```

In the desktop app: **Settings → AI / API → save baseUrl / apiKey / model.**
That's the model that gets used for every task.

Install Python dataset deps once (the script will install them too, but
this is faster):

```powershell
python -m pip install -U datasets huggingface_hub pyarrow
```

## Run

### One-shot script

```powershell
cd D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner
bash run_gdpval_aa_v2.sh --quick 3          # smoke test on 3 tasks
bash run_gdpval_aa_v2.sh                    # full 220-task run
bash run_gdpval_aa_v2.sh --provider codex --model gpt-5-codex
bash run_gdpval_aa_v2.sh --skip-run --skip-download   # just re-export submissions
bash run_gdpval_aa_v2.sh --no-resume        # start from scratch
```

The script does, in order:

1. Sanity-checks the environment (Node / pnpm / Python / curl).
2. Probes OpenLoomi (`/api/native/providers`); refuses to start if it's
   not reachable, with a clear "start `pnpm tauri:dev`" message.
3. Ensures `@openloomi/benchmark-gdpval-aa-v2` is linked into the
   workspace; falls back to `pnpm install --no-frozen-lockfile` if not.
4. Downloads `openai/gdpval` 220-task gold subset to
   `../dataset/gdpval_gold.jsonl` (idempotent).
5. Pre-fetches every reference file into
   `../dataset/reference_files/<task_id>/` (idempotent, 8 concurrent).
6. Runs the OpenLoomi runner with the v2-spec prompt + tool set + 250-turn
   cap; the runner is **resumable** — re-running skips completed tasks.
7. Converts the run summary into a submission JSONL via `scripts/evaluate.py`.

### Manual invocation

```powershell
cd D:\openloomi
pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- `
  --dataset "../dataset/gdpval_gold.jsonl" `
  --output   "results/gdpval_aa_v2_run.json" `
  --reference-index "../dataset/reference_files/reference_files_index.json" `
  --provider claude `
  --model    claude-sonnet-4-5
```

> Paths above are relative to the package root
> (`benchmark/GDPval-AA v2/openloomi-runner/`).

Useful flags:

| Flag                                                             | Effect                                         |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `--quick N`                                                      | only run the first N tasks                     |
| `--no-resume`                                                    | start from scratch (deletes prior run summary) |
| `--provider codex --model gpt-5-codex`                           | switch agent runtime + model                   |
| `--timeout-ms 3600000`                                           | raise the per-task wall-clock budget           |
| `--allowed-tools "WebFetch,WebSearch,ViewImage,Bash,Write,Read"` | override the default v2 tool set               |
| `--no-official-prompts`                                          | debug: skip the Python prompt builder          |

### Switching model / provider

`OPENLOOMI_DEFAULT_MODEL` and `OPENLOOMI_DEFAULT_PROVIDER` (in `.env`)
default to `claude-sonnet-4-5` and `claude`. Override per run with
`--model` / `--provider`, e.g.:

```powershell
pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- `
  --dataset "../dataset/gdpval_gold.jsonl" `
  --output   results/gdpval_aa_v2_gpt5.json `
  --provider codex --model gpt-5-codex
```

The `--provider` flag is the OpenLoomi agent runtime (claude / codex /
opencode / hermes / openclaw); the **actual LLM** is always the one
configured in the OpenLoomi desktop app's **Settings → AI**.

## Resume support

`--resume` is on by default: re-running reads
`results/gdpval_aa_v2_run.json`, skips the `task_id`s already present,
and only runs what's left. Interrupt, swap windows, swap networks, then
re-run — it picks up where it left off.

To start from scratch:

```bash
bash run_gdpval_aa_v2.sh --no-resume
```

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

`deliverables` are populated from two sources, **merged** with the
finish-protocol paths winning on conflict:

- `tool_result.fileSnapshots` events the OpenLoomi harness emits as the
  agent writes files.
- Absolute paths the model declared in the `<<<FINISH>>>` block (the
  v2 finish contract — this is how the agent says "I am done, here are
  my deliverables").

The runner copies each one into
`results/artifacts/<task_id>/<safe-name>` so the artefacts are
preserved even after the per-task `work_dir` is cleaned up.

## Feeding the pair-wise grader

The pair-wise grader (in `../grader/GDPVal_EVal/`) expects one
submission record per (model, task) line, pointing to the deliverable
files on disk. The `scripts/evaluate.py` helper converts the run
summary into that shape:

```powershell
cd D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner
python scripts\evaluate.py `
  --run results\gdpval_aa_v2_run.json `
  --output results\submissions\openloomi_claude-sonnet-4-5.jsonl
```

Run the same benchmark with a second model (or with `harness/Stirrup/`
itself) to produce a second JSONL, then grade:

```powershell
cd D:\openloomi3\openloomi\benchmark\GDPval-AA v2\grader\GDPVal_EVal
pip install -e ".[dev]"
$env:GEMINI_API_KEY = "..."

# Pair-wise judge (single-judge approximation; v2 uses a 3-judge panel).
python -m gdpval.grading.pairwise_grader `
  --task-set    "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\gdpval_gold.jsonl" `
  --submission-a "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\submissions\openloomi_claude-sonnet-4-5.jsonl" `
  --submission-b "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\submissions\openloomi_stirrup_claude-sonnet-4-5.jsonl" `
  --out          matches.jsonl

# Bradley-Terry Elo fit. The v2 anchor is "human expert deliverables = 1000"
# (not gpt-5.1 — that was v1).
python -m gdpval.elo.bradley_terry --matches matches.jsonl --anchor 1000
```

## Notes

- **Per-task time budget.** v2 allows up to 250 turns and 24h/task; we
  default to a 30-minute wall-clock budget per task
  (`--timeout-ms 1800000`); raise it if your tasks need more.
- **Deliverable count is the source of truth.** "Empty text response"
  does not mean "failed" — a model that writes `chart.png` and never
  speaks a word is still a successful submission.
- **Auth token.** The runner reads `~/.openloomi/token` by default. If
  the server's been restarted, refresh it; otherwise requests return 401.
- **Reference files.** The runner downloads the task's reference files
  via `fetch_reference_files.py` (8 concurrent) and stages them in
  `workDir` via `fileAttachments`. Models see them as if they were
  injected by Stirrup.
