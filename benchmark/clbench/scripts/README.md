# CL-bench Resume Scripts

The `scripts/` directory provides two equivalent "clean up failed checkpoints + resume" scripts:

| Script                                                                                               | Platform                       | Interpreter                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------- |
| [`resume_clbench.sh`](file:///d:/openloomi3/openloomi/benchmark/clbench/scripts/resume_clbench.sh)   | Linux / macOS / WSL / Git Bash | bash + python (already detected) |
| [`resume_clbench.ps1`](file:///d:/openloomi3/openloomi/benchmark/clbench/scripts/resume_clbench.ps1) | Windows PowerShell             | PowerShell 5+                    |

Both scripts behave identically:

1. Scan every `.json` checkpoint under `$CHECKPOINT_DIR` (default `D:\openloomi_val_results\clbench\checkpoints\clbench`).
2. Parse each checkpoint and check whether its `response` field starts with `Error:` or `ERROR:` (covering agent API failures, timeouts, terminated exits, and other force-majeure failures).
3. **Move** those failed checkpoints into a timestamped backup directory `<parent>/_trash_resumed_<YYYYMMDD_HHMMSS>/` (the files are kept, not deleted).
4. Invoke `pnpm benchmark -- ...` to resume — the already-checkpointed valid tasks are reused, and the remaining 994 entries are re-evaluated.

## Usage

### Windows PowerShell

```powershell
cd D:\openloomi3\openloomi\benchmark\clbench
powershell -ExecutionPolicy Bypass -File scripts\resume_clbench.ps1
```

### Git Bash / WSL

```bash
cd /d/openloomi3/openloomi/benchmark/clbench
bash scripts/resume_clbench.sh
```

## Environment Variable Overrides

All paths can be overridden by environment variables. The defaults are:

| Variable         | Default (clbench)                                                      | Meaning                       |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------- |
| `CHECKPOINT_DIR` | `D:\openloomi_val_results\clbench\checkpoints\clbench`                 | Checkpoint directory          |
| `DATASET`        | `<package>/dataset/clbench.jsonl`                                      | JSONL dataset path            |
| `BENCHMARK_TYPE` | `clbench`                                                              | Benchmark type                |
| `OUTPUT`         | `D:\openloomi_val_results\clbench\results\clbench_result_resumed.json` | Aggregated result output path |

> **clbench-life usage**: change the four variables above to the life paths and run the same script. The script itself does not distinguish clbench from clbench-life; it only looks at the paths.

Equivalent environment variables for the clbench-life variant:

```bash
# Git Bash / WSL
export CHECKPOINT_DIR=D:/openloomi_val_results/clbench_life/checkpoints/clbench-life
export DATASET=/d/openloomi3/openloomi/benchmark/clbench_life/dataset/clbench-life.jsonl
export BENCHMARK_TYPE=clbench-life
export OUTPUT=D:/openloomi_val_results/clbench_life/results/clbench_life_result_resumed.json
bash scripts/resume_clbench.sh
```

```powershell
# PowerShell
$env:CHECKPOINT_DIR = "D:\openloomi_val_results\clbench_life\checkpoints\clbench-life"
$env:DATASET        = "D:\openloomi3\openloomi\benchmark\clbench_life\dataset\clbench-life.jsonl"
$env:BENCHMARK_TYPE = "clbench-life"
$env:OUTPUT         = "D:\openloomi_val_results\clbench_life\results\clbench_life_result_resumed.json"
powershell -ExecutionPolicy Bypass -File scripts\resume_clbench.ps1
```

## Failed-Checkpoint Detection Rule

The script's notion of "failed" matches [`evaluator.ts#L36-42`](file:///d:/openloomi3/openloomi/benchmark/clbench/src/evaluator.ts#L36-L42) exactly:

```ts
function isErrorResponse(response: string): boolean {
  return (
    response.startsWith("Error:") ||
    response.includes("Failed to authenticate") ||
    response.includes("API Error")
  );
}
```

Only checkpoints whose `response` field matches one of the following prefixes or substrings are moved:

- `Error:` (including `Error: fetch failed`, `Error: timeout`, `Error: terminated`, etc.)
- `Failed to authenticate` (kept as a defensive fallback — should not normally appear)
- `API Error`

**Normal responses that happen to mention the word "Error" are not falsely flagged** — the match is anchored to the field value.

## Backup Directory

Each run creates a fresh backup directory:

```
<checkpoint_dir>/../_trash_resumed_<YYYYMMDD_HHMMSS>/
```

It contains every failed checkpoint that was moved. **Do not delete it manually** — if anything is still wrong after the resume, you can copy the corresponding `task_id` file back from the backup directory and re-run.

## Troubleshooting

### "pnpm not found in PATH"

Install pnpm first:

```bash
npm install -g pnpm
```

### "checkpoint dir not found"

Confirm that OpenLoomi has run at least once; checkpoints should be at `D:\openloomi_val_results\clbench\checkpoints\clbench` (or `clbench_life/checkpoints/clbench-life`). If your path differs, override the `CHECKPOINT_DIR` environment variable.

### `pnpm benchmark` exits immediately after the script runs

Usually the OpenLoomi server is not running or is not on port 3515. The script does not start the server itself; verify in advance:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 3515
```

### New `Error: fetch failed` entries appear after the resume

This is an OpenLoomi-side issue (the port died, the provider is rate-limited, the auth token expired, etc.) and is unrelated to the script. Check the server logs, or restart the server and re-run the script.

## Recommended Full Batch Flow

First run:

```powershell
$env:CLBENCH_CHECKPOINT_DIR = "D:\openloomi_val_results\clbench\checkpoints\clbench"
cd D:\openloomi3\openloomi\benchmark\clbench
pnpm benchmark -- --dataset dataset\clbench.jsonl --benchmark clbench --output results\clbench_result.json
```

After an interruption or failure, simply re-run the `pnpm benchmark` invocation above — `--resume` (enabled by default) automatically skips already-checkpointed entries.

If you want to "clear failed checkpoints first, then resume", use the `resume_clbench.ps1` / `resume_clbench.sh` scripts in this directory.

## Requirements

- Node.js 18+
- pnpm
- Python 3 (only required by the `.sh` script)
- An OpenLoomi server running on port 3515
- An OpenRouter API key (rubric scoring requires it)
