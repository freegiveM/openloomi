# GDPval Benchmark for OpenLoomi

This package adapts the public `openai/gdpval` HuggingFace dataset for OpenLoomi agent evaluation.

GDPval is not a memory benchmark like BEAM. It contains real-world knowledge-work tasks with prompts and supporting artifacts. This runner sends each converted task prompt to OpenLoomi's local `/api/native/agent` endpoint and stores model responses for later evaluation.

## Setup

Start OpenLoomi in another terminal first:

```powershell
cd D:\openloomi\apps\web
$env:Path="$HOME\.cargo\bin;D:\node-v20.20.2-win-x64;$env:Path"
$env:IS_TAURI="true"
$env:PORT="3515"
D:\node-v20.20.2-win-x64\corepack.cmd pnpm tauri dev --config src-tauri/tauri.conf.dev.json
```

Install Python dataset dependencies if needed:

```powershell
python -m pip install -U datasets huggingface_hub pyarrow
```

## Convert Dataset

Small smoke sample:

```powershell
cd D:\openloomi
D:\node-v20.20.2-win-x64\corepack.cmd pnpm --filter @openloomi/benchmark-gdpval convert -- --output dataset/gdpval_sample3.jsonl --limit 3
```

Full public split:

```powershell
cd D:\openloomi
D:\node-v20.20.2-win-x64\corepack.cmd pnpm --filter @openloomi/benchmark-gdpval convert -- --output dataset/gdpval.jsonl
```

## Run Benchmark

Sample:

```powershell
cd D:\openloomi
D:\node-v20.20.2-win-x64\corepack.cmd pnpm --filter @openloomi/benchmark-gdpval benchmark --dataset dataset/gdpval_sample3.jsonl --output results/gdpval_sample3_result.json --no-resume
```

Full converted set:

```powershell
cd D:\openloomi
D:\node-v20.20.2-win-x64\corepack.cmd pnpm --filter @openloomi/benchmark-gdpval benchmark --dataset dataset/gdpval.jsonl --output results/gdpval_result.json --no-resume
```

## Notes

- Do not commit `.env`, raw downloaded data, or generated results unless explicitly requested.
- The first implementation stores responses and basic run status. Rubric-grade evaluation can be added after confirming the task schema and desired judging method.
