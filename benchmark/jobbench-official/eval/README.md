# JobBench on OpenLoomi — End-to-End Guide

This directory hosts the JobBench evaluation pipeline against an OpenLoomi
runtime. The runner spawns a real OpenLoomi desktop agent for each task,
saves the deliverables to the official `model_output/` location, and lets
the upstream JobBench judge score them.

## Files

| Path | Purpose |
|---|---|
| `run_jobbench.sh` | One-shot driver. Validates prerequisites, then launches the Python runner. |
| `run_benchmark_openloomi.py` | Python runner. Spawns `openloomi-ctl` per task, copies deliverables to `model_output/<output_model>/`, writes a JSON summary. |
| `judge.py` / `run_judge.sh` | Upstream JobBench judge. Use these to score the deliverables produced here. |
| `run_benchmark_codex_cli.sh` / `run_benchmark_claude_code_cli.sh` / `run_benchmark_opencode.sh` | Upstream runners for the other agents; not used by OpenLoomi. |
| `dataset/` | JobBench dataset (not tracked in git). Populated by `./setup.sh` on Linux/macOS or `download_dataset_windows.py` on Windows. |

## Prerequisites

1. **Operating system** — Windows 10/11, macOS, or Linux.
2. **Node.js 22+** — required by `openloomi-ctl` packaged mode.
3. **Python 3.10+** — required by the runner and the judge.
4. **`uv`** — the JobBench upstream uses it for Python dependency management.
5. **OpenLoomi Desktop 0.8.8+** — install the official package and log in
   once so the auth token is created.
6. **`openloomi-ctl.exe`** — bundled with the desktop installer. Default
   path on Windows:
   `C:\Users\<you>\AppData\Local\Programs\openloomi\cli\openloomi-ctl.exe`.

## Two ways to run the OpenLoomi agent

The runner needs the agent to execute in the task directory. Either of these
is fine.

### A. Development build (recommended while iterating)

`pnpm tauri:dev` launches the Next.js dev server plus the Tauri shell. The
local agent API listens on `http://127.0.0.1:3515`.

```powershell
cd D:\openloomi3\openloomi
pnpm tauri:dev
```

Keep that terminal open. The runner will call the API directly via
`openloomi-ctl --one-shot --stdin`. Set:

```powershell
$env:OPENLOOMI_API_URL = "http://127.0.0.1:3515"
$env:OPENLOOMI_CLI_DIRECT = "0"
$env:OPENLOOMI_AUTH_TOKEN = (Get-Content "$HOME\.openloomi\token" -Raw).Trim()
```

The `OPENLOOMI_CLI_DIRECT=0` flag forces the CLI to call the HTTP API
instead of using the bundled in-process native-agent runner. This is the
path JobBench needs to hit your live dev server.

### B. Packaged build (no dev server required)

If you only need the bundled runtime, you can skip `pnpm tauri:dev` and let
`openloomi-ctl` use its own native-agent runner. In that case do **not** set
`OPENLOOMI_API_URL`. The packaged CLI needs:

- A logged-in token in `~/.openloomi/token` (or `OPENLOOMI_AUTH_TOKEN`).
- The same model provider configured inside the desktop app.

## Quick start

```bash
# 1. Make sure the JobBench repo is on disk and the dataset is present.
cd D:\openloomi3\openloomi\benchmark\jobbench-official

# 2. Start OpenLoomi (dev build).
#    In another terminal:
#      cd D:\openloomi3\openloomi
#      pnpm tauri:dev
#    Wait for "Ready on http://localhost:3515".

# 3. Run the driver.
cd D:\openloomi3\openloomi\benchmark\jobbench-official
./eval/run_jobbench.sh --split main
```

Useful flags:

```text
--split main|easy         Default: main. The `main` split is the official leaderboard split.
--output-model NAME      Sub-directory under model_output/ to write to. Default: openloomi-dev.
--run-label TEXT         Append a suffix to keep multiple model variants separate.
--provider NAME          Forwarded to openloomi-ctl (e.g. claude, codex, opencode).
--model MODEL_ID         Forwarded to openloomi-ctl.
--max-concurrent N       Defaults to 1 (serial). Increase with caution; the dev API is rate-sensitive.
--timeout SECONDS        Per-task wall-clock cap. Default: 3600.
--force                  Wipe and re-run every task, even if model_output/ already has files.
```

The script is resumable by default. Re-running picks up wherever the last
attempt left off.

## Outputs

| Path | Description |
|---|---|
| `eval/logs/openloomi_main_terminal_<timestamp>.log` | Full terminal transcript for the run. |
| `eval/logs/openloomi_main_openloomi-dev_<timestamp>.json` | Run summary, per-task status, exit codes, error messages. |
| `dataset/<split>/<profession>/<task>/model_output/<output-model>/` | Final deliverables produced by the agent. |
| `dataset/<split>/<profession>/<task>/model_traj/<output-model>/attempt_*.json` | Per-attempt trajectory: full `openloomi-ctl` stdout, stderr, exit code, and duration. |

## Scoring with the official judge

After at least one task has produced `model_output/`, the official JobBench
judge can score the deliverables.

```bash
cd D:\openloomi3\openloomi\benchmark\jobbench-official

# Default Grok-4.3 judge (xAI):
SPLIT=main \
EVAL_MODEL=openloomi-dev \
JUDGE_API_KEY="<xai-key>" \
uv run ./eval/run_judge.sh

# Custom OpenAI-compatible judge:
SPLIT=main \
EVAL_MODEL=openloomi-dev \
JUDGE_API_BASE="https://api.openai.com/v1" \
JUDGE_API_KEY="sk-..." \
JUDGE_MODEL="gpt-5.4" \
uv run ./eval/run_judge.sh
```

The judge reads each task's `RUBRICS.json`, extracts text from the
deliverables, and runs an LLM agent-as-judge loop. Results land in
`dataset/<split>/<profession>/<task>/eval_result/eval_<output-model>/`.

The aggregate score in that JSON is the official pass / fail metric.

## Re-running the dataset (Windows)

The official `./setup.sh` calls `hf download`, which writes through a
`./.cache/huggingface` staging directory with very long paths. On Windows
those paths exceed the 260-character limit, so we ship a Windows-native
downloader instead.

```powershell
cd D:\openloomi3\openloomi\benchmark\jobbench-official
uv run python download_dataset_windows.py
```

The script streams every file from
[`JobBench/job-bench`](https://huggingface.co/datasets/JobBench/job-bench)
straight to its final location under `dataset/main` and `dataset/easy`. It
is idempotent: re-running it skips files that already exist on disk.

## Common issues

### `service_unavailable: could not connect to ... :3515`

The dev server is not running, or it died during a long run. Check
`pnpm tauri:dev`. If the port is held by a stray Node process:

```powershell
Get-NetTCPConnection -LocalPort 3515 -State Listen |
  Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

Then start `pnpm tauri:dev` again.

### `failed to load saved auth token`

The packaged `openloomi-ctl 0.8.8` tries to Base64-decode the saved token,
but `~/.openloomi/token` is a plain JWT. Set `OPENLOOMI_AUTH_TOKEN` to the
file contents to bypass the broken decoder.

### Tasks succeed but content is wrong

The agent is running but misinterpreting the brief. Inspect the trajectory
JSON for the task. Common causes:

- Wrong population filter (e.g. applying an extra inclusion criterion).
- Wrong statistical timepoint (e.g. computing conditional power at the
  final visit instead of the interim visit).
- Incomplete imputation documentation.

To re-run that one task, delete its `model_output/<output-model>/` and call
the driver again — only the empty task is re-executed.

### Dev server died mid-run

Long JobBench tasks can take 8-20 hours. If `pnpm tauri:dev` dies, the
remaining tasks all fail with `service_unavailable`. Restart the dev
server and re-run the driver; only the failed tasks are picked up.

## Validation results from the first run

The first end-to-end run on the dev server produced:

- 17 successful tasks with real deliverables
- 3 tasks with deliverables plus a CLI warning
- 45 tasks that failed with `service_unavailable` because the dev server
  was killed mid-run

After restarting the dev server and re-running, the runner only re-executes
the 45 empty tasks. Successfully completed tasks are skipped automatically.
