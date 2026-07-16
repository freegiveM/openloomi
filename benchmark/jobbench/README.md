# JobBench Benchmark for OpenLoomi

This package adapts JobBench Hugging Face datasets for OpenLoomi agent evaluation.

JobBench is treated as a task benchmark rather than a memory benchmark. The converter normalizes Hugging Face rows into JSONL tasks, and the runner sends each task prompt to OpenLoomi's local `/api/native/agent` endpoint.

## Setup

Start OpenLoomi in another terminal first:

```powershell
cd D:\openloomi\apps\web
$env:Path="D:\node-v22.23.1-win-x64;$HOME\.cargo\bin;$env:Path"
$env:HTTP_PROXY="http://127.0.0.1:7890"
$env:HTTPS_PROXY="http://127.0.0.1:7890"
$env:NO_PROXY="localhost,127.0.0.1,::1"
$env:IS_TAURI="true"
$env:PORT="3515"
pnpm.cmd tauri dev --config src-tauri/tauri.conf.dev.json
```

Install Python dataset dependencies if needed:

```powershell
python -m pip install -U datasets huggingface_hub pyarrow
```

## Convert Dataset

The default dataset name is read from `JOBBENCH_DATASET_NAME`, then falls back to `JobBench/job-bench`. If Hugging Face uses a more specific dataset repo name, pass it with `--dataset-name`.

Small smoke sample:

```powershell
cd D:\openloomi
$env:Path="D:\node-v22.23.1-win-x64;$env:Path"
pnpm.cmd --filter @openloomi/benchmark-jobbench convert --output dataset/jobbench_sample3.jsonl --limit 3
```

Full split:

```powershell
cd D:\openloomi
$env:Path="D:\node-v22.23.1-win-x64;$env:Path"
pnpm.cmd --filter @openloomi/benchmark-jobbench convert --output dataset/jobbench.jsonl
```

With explicit Hugging Face dataset repo:

```powershell
cd D:\openloomi
$env:Path="D:\node-v22.23.1-win-x64;$env:Path"
pnpm.cmd --filter @openloomi/benchmark-jobbench convert --dataset-name JobBench/job-bench --output dataset/jobbench.jsonl
```

## Run Benchmark

Sample:

```powershell
cd D:\openloomi
$env:Path="D:\node-v22.23.1-win-x64;$env:Path"
pnpm.cmd --filter @openloomi/benchmark-jobbench benchmark --dataset dataset/jobbench_sample3.jsonl --output results/jobbench_sample3_result.json --no-resume
```

Full converted set:

```powershell
cd D:\openloomi
$env:Path="D:\node-v22.23.1-win-x64;$env:Path"
pnpm.cmd --filter @openloomi/benchmark-jobbench benchmark --dataset dataset/jobbench.jsonl --output results/jobbench_result.json
```

## Notes

- Do not commit `.env`, raw downloaded data, generated JSONL files, or generated results unless explicitly requested.
- The runner stores responses and basic run status. Official JobBench scoring can be added after confirming the dataset schema and target metrics.
