# SWE-Bench-CL 复现说明（本地版）

> 仓库来源：https://github.com/thomasjoshi/agents-never-forget  
> 论文：arXiv:2507.00014（SWE-Bench-CL: Continual Learning for Coding Agents, 2025）  
> 本目录路径：`D:\openloomi3\openloomi\benchmark\SWE-bench-CL\`

## 1. 目录结构

```
SWE-bench-CL/
├── data/                           # 数据集 & 派生分析结果
│   ├── SWE-Bench-CL-Curriculum.json         ★ 主数据集（5.6 MB，273 task）
│   ├── SWE-Bench-CL-Task-Stream.json        # 任务流版本（13 MB）
│   ├── prompt_pairs.jsonl                   # Prompt-poisoning 实验输入
│   ├── overlap_results.json                 # §4.1 patch 相似度结果
│   ├── difficulty_overlap_results.json
│   ├── difficulty_correlation_results.json
│   ├── drift_results_by_difficulty.csv      # §4.2 prompt poisoning 结果
│   └── swe-bench-cl-croissant.json          # 数据 Croissant 元数据
├── eval_v1/                        # 一代评测：直接调用 SWE-Bench 官方 Docker harness
│   └── eval_procedure.py
├── eval_v2_agent/                  # 二代评测：LangGraph agent + FAISS 语义记忆
│   └── eval_procedure.py
├── eval_v3_swe-agent/              # 三代评测：仿 SWE-Agent 终端接口 + CL
│   ├── eval_procedure.py
│   ├── eval_procedure.ipynb
│   └── SWE-Bench-CL-Curriculum_dummy.json
├── scripts/                        # 数据集构造 & 各种分析脚本
│   ├── SWE-Bench-CL_dataset_construction.py      ★ 从原始 SWE-Bench 构造数据集
│   ├── generate_cl_splits.py
│   ├── preprocess_task_stream.py
│   ├── drift_by_difficulty_prompt_poisoning.py   # §4.2 prompt poisoning
│   ├── detect_structural_overlap.py              # §4.1 patch 相似度
│   ├── analyze_difficulty_correlation.py
│   ├── warm_docker_cache.py
│   ├── finetune_and_evaluate.py                  # 微调+评测（LoRA）
│   └── …
├── Makefile                        # GCP/训练/评测的胶水脚本
├── requirements.txt                # 主依赖
├── test-requirements.txt
├── SWE_Bench_CL_NeurIPS_Submission.pdf  ★ 论文 PDF
├── README.md                       # 原 GitHub 仓库 README
└── LICENSE                         # MIT
```

## 2. 数据格式速览

打开 `data/SWE-Bench-CL-Curriculum.json`，每个任务的标准字段：

```json
{
  "instance_id": "django__django-12345",
  "repo": "django/django",
  "base_commit": "abcdef...",
  "problem_statement": "……",
  "gold_patch": "diff --git a/...",
  "test_patch": "diff --git a/...",
  "FAIL_TO_PASS": ["tests/...::test_xxx"],
  "PASS_TO_PASS": ["tests/...::test_yyy"],
  "created_at": "2020-...",
  "difficulty": "<15 min",
  "modified_files": ["django/..."],
  "sequence_position": 12,
  "dependencies": [...]
}
```

8 条 repository 序列（共 273 task）见 README 表格。

## 3. 三种评测 Harness 的区别

| Harness | 输入 | 是否带 agent | 记忆 | 推荐度 |
|---|---|---|---|---|
| **eval_v1** | LLM 直接生成 unified diff patch | ❌ 仅调用模型 | ❌ | ❌ 论文 §5 已证伪：pass-rate < 8.5%、drift 7.7%~25% |
| **eval_v2_agent** | LangGraph 多 agent（Planner/Executor/Reflector/Solver） | ✅ | ✅ FAISS | ✅ 论文主结果之一 |
| **eval_v3_swe-agent** | 仿 SWE-Agent 终端 + LangGraph | ✅ | ✅ FAISS | ✅ 论文最终 baseline 之一 |

## 4. 最小复现路径

### 4.1 仅用数据（不跑评测）

```powershell
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL\data
Get-Content SWE-Bench-CL-Curriculum.json | Select-Object -First 100
```

```python
import json
with open('SWE-Bench-CL-Curriculum.json') as f:
    d = json.load(f)
print(d['metadata'])
print(d['sequences'][0]['id'], d['sequences'][0]['tasks'][:2])
```

### 4.2 重跑 §4.1 / §4.2 数据集分析

```bash
python scripts/detect_structural_overlap.py            # §4.1 任务间相似度
python scripts/drift_by_difficulty_prompt_poisoning.py # §4.2 prompt 投毒
python scripts/analyze_difficulty_correlation.py
```

输入数据已包含在 `data/`，跑完输出新的 `*_results.json/csv`。

### 4.3 跑 eval_v1（SWE-Bench 官方 harness）

> ⚠️ 先把官方的 SWE-bench harness 装好：

```bash
git clone https://github.com/SWE-bench/SWE-bench.git
cd SWE-bench && pip install -e .
```

确保 Docker 可用。然后跑：

```bash
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL
python eval_v1/eval_procedure.py --help
```

> 论文结论：在 SWE-Bench-CL 序列数据上 `pass-rate < 8.5%`，结果**不可信**。

### 4.4 跑 eval_v2_agent（LangGraph + FAISS）— 论文主推

依赖比较多，建议用 conda 环境：

```bash
conda create -n swe-bench-cl python=3.11 -y
conda activate swe-bench-cl

pip install -r requirements.txt

# LangGraph / LangChain 家族：
pip install langchain langchain_core langchain_community
pip install langchain_openai langchain_anthropic langchain_google_genai langchain-ollama
pip install faiss-cpu tiktoken langgraph

# 可选：bitsandbytes（4-bit 量化）
pip install bitsandbytes
```

API keys（写入 `.env` 或环境变量）：

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
```

跑：

```bash
cd eval_v2_agent
jupyter notebook eval_procedure.ipynb
```

或在 VS Code 里以交互方式逐 cell 跑（脚本本身是 notebook 文件）。

### 4.5 跑 eval_v3_swe-agent

```bash
cd eval_v3_swe-agent
jupyter notebook eval_procedure.ipynb
```

依赖同 v2 + flake8（用于 lint 工具）。

## 5. 关键发现复述

| 发现 | 来源 | 数据文件 |
|---|---|---|
| patch 跨任务平均 Jaccard 0.1114，cosine 0.1792（**极低相似度**） | §4.1 | `overlap_results.json` |
| 即使不相关上下文也会改变 solution；难→易任务受影响最大 | §4.2 | `drift_results_by_difficulty.csv` |
| v1（SWE-Bench 官方 harness）pass-rate < 8.5%、drift 7.7-25% | §5 | — |
| Memory-on vs Memory-off：记忆对**中难任务**帮助最大，对 CL-Stability 始终提升 | §8 | — |

## 6. 重新构造数据集

如果你想从原始 SWE-Bench 数据重建：

```bash
# 1) 下载 SWE-Bench Verified
huggingface-cli download princeton-nlp/SWE-bench_Verified

# 2) 跑构造脚本
python scripts/SWE-Bench-CL_dataset_construction.py
```

输出会覆盖 `data/SWE-Bench-CL-Curriculum.json`。

## 7. 复现路线 → 论文表 1 数字

论文 Table 1（每序列的难度分布、有依赖 task 数）直接对应 `data/SWE-Bench-CL-Curriculum.json` 中的 `metadata + sequences[].statistics`。无需再跑脚本，对照 README 表格：

| Repo | Easy | Medium | Hard | Very Hard | w/ Deps |
|---|---|---|---|---|---|
| django/django | 50 | 0 | 0 | 0 | 50% |
| sympy/sympy | 25 | 25 | 0 | 0 | 24% |
| sphinx-doc/sphinx | 22 | 17 | 4 | 1 | 52% |
| matplotlib/matplotlib | 15 | 19 | 0 | 0 | 38% |
| scikit-learn/scikit-learn | 13 | 18 | 1 | 0 | 13% |
| astropy/astropy | 4 | 15 | 3 | 0 | 14% |
| pydata/xarray | 5 | 15 | 1 | 1 | 59% |
| pytest-dev/pytest | 8 | 8 | 3 | 0 | 37% |

## 8. 与上游差异说明（已校对）

- README 中 `eval_v3_agent/eval_procedure.py`，仓库实际是 `eval_v3_swe-agent/eval_procedure.py`（README 笔误，以仓库代码为准）。
- README 中 `SWE-Bench-CL.json`（仓库根），仓库实际在 `data/SWE-Bench-CL-Curriculum.json`；v2/v3 脚本里仍引用旧路径 `../SWE-Bench-CL.json`，需要按下面方式建符号 / 软连接：

```powershell
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL
New-Item -ItemType SymbolicLink -Path SWE-Bench-CL.json -Target data\SWE-Bench-CL-Curriculum.json
```

或直接在脚本里把 `../SWE-Bench-CL.json` 改为 `../data/SWE-Bench-CL-Curriculum.json`。
