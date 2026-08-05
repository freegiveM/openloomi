# CL-bench-Life Benchmark

CL-bench-Life is the life-context subset of the [Context Learning Benchmark](https://clbench.com/) published by Tencent. It evaluates a model's ability to learn from everyday-life contexts. The dataset contains **405 tasks / 5,348 rubrics** spanning three categories — Communication & Social Interactions, Daily Life Planning, and Task Assistance.

- Dataset: [tencent/CL-bench-Life](https://huggingface.co/datasets/tencent/CL-bench-Life) on Hugging Face.
- Paper: [CL-bench Life: Can Language Models Learn from Real-Life Context?](https://arxiv.org/html/2604.27043v1)

## Relationship to `benchmark/clbench`

This directory is a self-contained package; its source tree is copied from `benchmark/clbench/src/*`. The two share the same:

- evaluator logic (the `CLBenchLifeEvaluator` uses `reasoning_effort = "high"`);
- checkpoint / resume mechanism;
- OpenLoomi `/api/native/agent` invocation;
- OpenRouter rubric scoring pipeline.

The only differences are:

- the package name is `@openloomi/benchmark-clbench-life`;
- the default checkpoint sub-directory is `clbench-life`;
- the dataset is `clbench-life.jsonl`, which runs only the life subset.

If you only want to run the life subset and do not want to maintain two copies, you can run the following directly from `benchmark/clbench`:

```bash
pnpm benchmark -- --dataset dataset/clbench-life.jsonl --benchmark clbench-life
```

## Setup

```bash
cd benchmark/clbench_life
pnpm install
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the OpenRouter API key (required for rubric scoring):

```bash
cp .env.example .env
# then edit .env
```

## Running

```bash
# Full CL-bench-Life run (405 entries, high reasoning effort)
pnpm benchmark -- --dataset dataset/clbench-life.jsonl --benchmark clbench-life --output results/clbench_life_result.json

# Smoke test: only the first 5 entries
pnpm benchmark -- --dataset dataset/clbench-life.jsonl --benchmark clbench-life --quick 5

# Specify the OpenLoomi port (default auto-discovery on 3515)
pnpm benchmark -- --dataset dataset/clbench-life.jsonl --benchmark clbench-life --port 3515

# Resume from a previous run (enabled by default; skips already-checkpointed tasks)
pnpm benchmark -- --dataset dataset/clbench-life.jsonl --benchmark clbench-life --resume
```

## Checkpoint Location

By default, checkpoints are written to:

```
<package_root>/checkpoints/clbench-life/
```

You can override the location with the `CLBENCH_CHECKPOINT_DIR` environment variable. For example:

```powershell
# PowerShell
$env:CLBENCH_CHECKPOINT_DIR = "D:\openloomi_val_results\clbench_life\checkpoints\clbench-life"
pnpm benchmark -- --dataset dataset/clbench-life.jsonl --benchmark clbench-life
```

## CLI Options

| Option             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `--dataset <path>` | Path to the JSONL dataset (required)                     |
| `--benchmark`      | Must be set to `clbench-life`                            |
| `--quick <n>`      | Only run the first N entries                             |
| `--port <n>`       | OpenLoomi API port                                       |
| `--token <path>`   | Custom auth token path                                   |
| `--output <path>`  | Write the final aggregated result JSON to the given path |
| `--resume`         | Enable checkpoint resume (default: enabled)              |
| `--no-resume`      | Disable resume; re-run every entry from scratch          |

## Requirements

- Node.js 18+
- pnpm
- An OpenLoomi server running on port 3515 (configurable)
- An OpenRouter API key (rubric scoring requires a GPT-5.1 judge)
