# LoCoMo Benchmark

Benchmark suite for evaluating OpenLoomi's long-term memory retrieval system using the [LoCoMo](https://github.com/StonyBrookUniversity/LoCoMo) dataset.

## Overview

This benchmark evaluates how well the memory system answers questions from conversation history across different retrieval modes. It tests temporal reasoning, multi-hop inference, and single-hop fact retrieval capabilities.

## Dataset

The LoCoMo dataset contains conversation sessions with multiple question-answer pairs per sample. Each sample includes:

- **Conversation history** - Raw dialog between speakers
- **Observations** - Summarized observations with dialog references
- **Session summaries** - High-level summaries of each session
- **QA pairs** - Questions with ground truth answers across 4 categories

### Question Categories

| Category | Name        | Description                                |
| -------- | ----------- | ------------------------------------------ |
| 1        | single_hop  | Simple factual recall from a single memory |
| 2        | temporal    | Questions requiring date/time reasoning    |
| 3        | multi_hop   | Multi-step inference across sessions       |
| 4        | open_domain | Open-ended questions requiring synthesis   |

## Retrieval Modes

| Mode              | Description                                    |
| ----------------- | ---------------------------------------------- |
| `dialog`          | Raw conversation history                       |
| `observation`     | Summarized observations with dialog references |
| `session_summary` | Session-level summaries only                   |

## Setup

```bash
# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env
```

Edit `.env` to add your API keys:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

## Usage

```bash
# Run full benchmark with observation mode
pnpm benchmark -- --dataset dataset/locomo10.json --mode observation

# Quick mode (first 5 questions per sample)
pnpm benchmark -- --dataset dataset/locomo10.json --mode observation --quick

# Run with specific samples
pnpm benchmark -- --dataset dataset/locomo10.json --mode dialog --samples sample_001,sample_002

# Save results to file
pnpm benchmark -- --dataset dataset/locomo10.json --mode observation --output results.json
```

### CLI Options

| Flag        | Short | Description                                         | Default            |
| ----------- | ----- | --------------------------------------------------- | ------------------ |
| `--dataset` | `-d`  | Path to LoCoMo JSON dataset                         | Required           |
| `--mode`    | `-m`  | Retrieval mode (dialog/observation/session_summary) | observation        |
| `--samples` | `-s`  | Comma-separated sample IDs to run                   | All                |
| `--quick`   | `-q`  | Limit to first 5 questions per sample               | false              |
| `--output`  | `-o`  | Save results JSON to path                           | None               |
| `--port`    | `-p`  | API port for agent                                  | Auto-discover      |
| `--token`   | `-t`  | Path to auth token                                  | ~/.openloomi/token |

## Output

The benchmark outputs:

- **Overall accuracy** - LLM judge accuracy across all categories
- **Per-category metrics** - F1, BLEU-1, BLEU-4 scores by category
- **Per-sample results** - Accuracy and token usage per sample
- **Token totals** - Combined API token consumption

### Metrics

- **LLM Judge Accuracy** - Whether the LLM judge considers the answer correct
- **F1 Score** - Token-level precision/recall
- **BLEU-1/4** - N-gram overlap with brevity penalty

## Architecture

```
src/
├── index.ts           # CLI entry point
├── evaluator.ts       # LoCoMoEvaluator - loads samples, runs QA evaluation
├── memory-adapter.ts  # InMemoryStorageAdapter + agent API calls
├── dataset.ts         # LoCoMo JSON parsing
├── metrics.ts         # BLEU, F1, LLM judge evaluation
├── scorer.ts          # Category name mapping
├── prompts.ts         # LLM judge prompt template
├── contracts.ts       # MemoryStorageAdapter interface
├── types.ts           # TypeScript types
└── prompts.ts         # Evaluation prompts
```

## Requirements

- Node.js 18+
- pnpm
- OpenLoomi API running on localhost (port auto-discovery or specify with `--port`)
- OpenRouter API key (for LLM judge evaluation)
