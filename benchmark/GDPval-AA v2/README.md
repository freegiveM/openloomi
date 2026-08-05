# GDPval-AA v2 on OpenLoomi

This directory bundles every local resource required to reproduce **GDPval-AA v2** (the Elo-based evaluation framework that Artificial Analysis built on top of OpenAI's GDPval) on OpenLoomi, exposed through a single entry point.

## Directory Layout

```
GDPval-AA v2/
├── README.md                                This document
├── dataset/                                 Dataset and download scripts
│   ├── download_gdpval.py                   Downloads the official openai/gdpval gold subset (220 tasks)
│   ├── fetch_reference_files.py             Bulk-downloads the reference files for every task
│   ├── gdpval_gold.jsonl                    The 220 tasks already downloaded
│   └── reference_files/                     Pre-fetched reference files, one sub-directory per task
│       └── reference_files_index.json
├── harness/
│   └── Stirrup/                             The official AA agent harness (git clone)
├── grader/
│   └── GDPVal_EVal/                         botschen's reproduction of Bradley-Terry Elo + the pairwise grader
├── leaderboard/                             Snapshot of the AA public leaderboard (185 models)
├── docs/                                    Paper PDFs
└── openloomi-runner/                        ← Run v2 evaluations with OpenLoomi as the harness
    ├── README.md                            Runner reference
    ├── readme_gdpvalAAV2_for_openloomi.md   End-to-end usage guide
    ├── run_gdpval_aa_v2.sh                  One-shot workflow
    ├── package.json                         @openloomi/benchmark-gdpval-aa-v2
    ├── src/                                 TypeScript source
    ├── scripts/                             evaluate.py / prompt_builder.py / smoke test
    └── results/                             Outputs produced at runtime (per-task run JSON, artifacts, submissions)
```

## Three Run Modes (Pick One)

### Option A — OpenLoomi Runner (recommended; the only mode aligned with the v2 spec)

`openloomi-runner/` strictly follows the v2 specification: the official system and task prompts, reference files injected via `fileAttachments`, the six-tool set trimmed to the four v2 tools, the 250-turn cap, and a `<<<FINISH>>>` / `<<<ABANDON>>>` text protocol that stands in for OpenLoomi's absent `finish` / `abandon_task_finish` tools.

```powershell
cd D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner
bash run_gdpval_aa_v2.sh --quick 3
```

For full details see [openloomi-runner/README.md](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/README.md) and [readme_gdpvalAAV2_for_openloomi.md](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/readme_gdpvalAAV2_for_openloomi.md).

### Option B — Existing OpenLoomi `benchmark/gdpval/` (sanity check only)

Captures response text only; **not** counted as an official score.

```powershell
cd D:\openloomi
pnpm --filter @openloomi/benchmark-gdpval benchmark `
  --dataset "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\gdpval_gold.jsonl" `
  --output results/gdpval_aa_v2_result.json --no-resume
```

### Option C — Official Stirrup Harness (closest to the original AA methodology)

```powershell
cd "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\harness\Stirrup"
pip install -e ".[all]"
```

## Elo Scoring (After Any Run Completes)

```powershell
cd "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\grader\GDPVal_EVal"
pip install -e ".[dev]"
$env:GEMINI_API_KEY = "..."

python -m gdpval.grading.pairwise_grader `
  --task-set "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\gdpval_gold.jsonl" `
  --submission-a "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\submissions\openloomi_claude-sonnet-4-5.jsonl" `
  --submission-b "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\submissions\openloomi_stirrup_claude-sonnet-4-5.jsonl" `
  --out matches.jsonl

# v2 anchor: human expert deliverables = 1000 (only v1 anchored on gpt-5.1 = 1000)
python -m gdpval.elo.bradley_terry --matches matches.jsonl --anchor 1000
```

## Leaderboard Snapshot (as of 2026-08-04)

| Rank | Model                                             | Elo  |
| ---- | ------------------------------------------------- | ---- |
| 1    | Claude Opus 5 (Adaptive Reasoning, Max Effort)    | 1852 |
| 2    | Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)  | 1819 |
| 3    | Claude Fable 5                                    | 1743 |
| 4    | Claude Opus 5 (Adaptive Reasoning, High Effort)   | 1735 |
| 5    | GPT-5.6 Sol (max)                                 | 1730 |
| 6    | Kimi K3 (max)                                     | 1685 |
| 7    | GPT-5.6 Sol (xhigh)                               | 1683 |
| 8    | Claude Opus 5 (Adaptive Reasoning, Medium Effort) | 1628 |
| 9    | GPT-5.6 Sol (high)                                | 1623 |
| 10   | Claude Sonnet 5 (Adaptive Reasoning, Max Effort)  | 1600 |

`MiniMax-M3` currently sits at rank 33 (1389 Elo, CI ±15).

The full 185-row table is available at `leaderboard/gdpval_aa_v2_leaderboard.csv` / `.json`.

## References

- Paper: <https://arxiv.org/abs/2510.04374> (Patwardhan et al., 2025)
- Dataset: <https://huggingface.co/datasets/openai/gdpval>
- Agent harness: <https://github.com/ArtificialAnalysis/Stirrup>
- Grading framework reference: <https://github.com/botschen/GDPVal_EVal>
- Public leaderboard: <https://artificialanalysis.ai/evaluations/gdpval-aa#gdpval-aa-leaderboard-table>
- Methodology: <https://artificialanalysis.ai/methodology/intelligence-benchmarking#gdpval-aa>

## Caveats

- A sizable fraction of the 220 tasks require real deliverables such as PDF, Word, Excel, or PowerPoint files. Reporting a "pass rate" from plain-text responses alone has limited statistical meaning.
- The official headline metric is **head-to-head expert comparison / Elo**, not simple pass@k.
- Preserve the original file paths and filenames in every submission so the pairwise grader can inspect images and charts via the `view_image` tool.
- The v2 pairwise scoring uses a 3-judge panel anchored to human expert deliverables at 1000 (v1 used a single judge with GPT-5.1 = 1000). `GDPVal_EVal` only reproduces the v1 path, so the Elo code needs to be adjusted to match the v2 anchor.
