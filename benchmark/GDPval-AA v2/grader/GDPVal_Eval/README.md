# GDPVal-AA Evaluation Framework

GDPVal-AA is Artificial Analysis' evaluation framework for OpenAI's [GDPval dataset](https://huggingface.co/datasets/openai/gdpval).  It assesses language models' capabilities on economically valuable tasks, covering **44 occupations** across key sectors contributing to GDP in the United States.

Paper: [arxiv.org/abs/2510.04374](https://arxiv.org/abs/2510.04374)  
Agent harness: [github.com/ArtificialAnalysis/Stirrup](https://github.com/ArtificialAnalysis/Stirrup)

---

## Overview

The evaluation comprises two stages:

1. **Task Submission** – Models are given a task and required to produce one or more files using an agentic harness with five tools: Web Fetch, Web Search, View Image, Run Shell, and Finish.
2. **Pairwise Grading** – Gemini 3 Pro blindly ranks two submissions for the same task, each created by a different model.

Final ELO scores are computed via a Bradley-Terry model fitted with MLE, bootstrapped confidence intervals (1,000 resamples), and anchored so that GPT-5.1 (Non-Reasoning) = 1,000.

---

## Repository Structure

```
gdpval/
├── elo/
│   ├── bradley_terry.py   # Bradley-Terry MLE ELO computation
│   └── bootstrap.py       # 95 % bootstrapped confidence intervals
├── grading/
│   ├── pairwise_grader.py # Gemini 3 Pro pairwise grader
│   └── sampling.py        # Balanced + active (ELO-informed) match sampling
├── intelligence_index/
│   └── normalize.py       # ELO → Intelligence Index normalization
└── submission/
    └── prompt.py          # Task submission prompt templates & helpers
tests/                     # pytest test suite (45 tests)
```

---

## Installation

```bash
pip install -e ".[dev]"
```

---

## Quick Start

### ELO Calculation

```python
from gdpval.elo.bradley_terry import BradleyTerry
from gdpval.elo.bootstrap import bootstrap_confidence_intervals

# Each tuple is (winner, loser) – ties are excluded per GDPVal-AA methodology.
matches = [
    ("gpt-5.1", "model_b"),
    ("gpt-5.1", "model_c"),
    ("model_b", "model_c"),
]

# Point estimates anchored at GPT-5.1 = 1000
bt = BradleyTerry(anchor_model="gpt-5.1", anchor_elo=1000)
ratings = bt.fit(matches)
print(ratings)  # {'gpt-5.1': 1000.0, 'model_b': ..., 'model_c': ...}

# 95 % bootstrapped confidence intervals (1,000 resamples)
point_estimates, confidence_intervals = bootstrap_confidence_intervals(
    matches, n_bootstrap=1000, random_seed=42
)
```

### Intelligence Index Normalization

```python
from gdpval.intelligence_index.normalize import normalize_elo, normalize_ratings

# Single score: clamp((elo - 500) / 2000, 0, 1)
print(normalize_elo(1400))  # 0.45

# Batch normalization
print(normalize_ratings({"gpt-5.1": 1000, "model_b": 800}))
# {'gpt-5.1': 0.25, 'model_b': 0.15}
```

### Pairwise Match Sampling

```python
from gdpval.grading.sampling import balanced_pairs, active_pairs

models = ["gpt-5.1", "claude-opus-4", "gemini-3-pro", "grok-4"]

# Stage 1: Balanced sampling (each pair once, diverse task coverage)
pairs = balanced_pairs(models, task_ids=["task_01", "task_02"], random_seed=0)

# Stage 2: Active sampling (ELO-informed, prioritises similar-rated models)
current_ratings = {"gpt-5.1": 1000, "claude-opus-4": 1080, "gemini-3-pro": 950, "grok-4": 1120}
pairs = active_pairs(models, current_ratings, n_pairs=50, task_ids=["task_01", "task_02"])
```

### Task Submission Prompt

```python
from gdpval.submission.prompt import build_task_prompt

prompt = build_task_prompt(
    task="Create a bar chart of US GDP by sector.",
    reference_files=["/home/user/gdp_data.csv"],
    finish_tool_name="finish",
)
```

---

## ELO Methodology

- **Model**: Bradley-Terry via MLE (L-BFGS-B) from pairwise win/loss records (ties excluded).
- **Anchor**: GPT-5.1 (Non-Reasoning) fixed at ELO 1,000.
- **Confidence Intervals**: 95 % CI via bootstrap resampling (1,000 iterations).
- **Intelligence Index**: `clamp((ELO - 500) / 2000, 0, 1)`.  ELO scores are frozen at the time of a model's addition.

### Evaluating a Sample from the Dataset

```python
from gdpval.dataset.loader import fetch_sample
from gdpval.submission.prompt import build_task_prompt

# Fetch the first task from openai/gdpval (requires internet access)
sample = fetch_sample(offset=0)
print(sample["task_id"], sample["occupation"])

# Build the task-submission prompt
prompt = build_task_prompt(
    task=sample["prompt"],
    reference_files=sample.get("reference_files") or [],
)
```

Or use the CLI entry point to evaluate one sample and write a JSON record:

```bash
python evaluate.py                        # evaluates offset 0, writes results/sample_evaluation.json
python evaluate.py --offset 5             # evaluates the 6th task
python evaluate.py --output my_result.json
```

A pre-recorded evaluation result is available at [`results/sample_evaluation.json`](results/sample_evaluation.json).

---

## Running Tests

```bash
pytest tests/ -v
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Gemini API key for the pairwise grader |
