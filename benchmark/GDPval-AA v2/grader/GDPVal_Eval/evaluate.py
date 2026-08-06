"""Evaluate one sample from the openai/gdpval dataset and record the results.

Usage
-----
    python evaluate.py                     # evaluate the first sample (offset 0)
    python evaluate.py --offset <N>        # evaluate sample at row N (0-indexed)
    python evaluate.py --output results/sample_evaluation.json

The script fetches one task row from the HuggingFace openai/gdpval dataset,
builds the formatted task-submission prompt using the GDPVal-AA framework,
and writes a JSON record to the output file.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from gdpval.dataset.loader import fetch_sample
from gdpval.submission.prompt import build_task_prompt

_DEFAULT_OUTPUT = Path(__file__).parent / "results" / "sample_evaluation.json"


def evaluate_sample(offset: int = 0) -> Dict[str, Any]:
    """Load one GDPVal task and build the evaluation record.

    Parameters
    ----------
    offset:
        Zero-based row index in the dataset.

    Returns
    -------
    Dict[str, Any]
        Evaluation record with sample metadata and the formatted task prompt.
    """
    sample = fetch_sample(offset=offset)

    task_prompt = build_task_prompt(
        task=sample.get("prompt", ""),
        reference_files=sample.get("reference_files") or [],
    )

    return {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "dataset": "openai/gdpval",
        "offset": offset,
        "task_id": sample.get("task_id"),
        "sector": sample.get("sector"),
        "occupation": sample.get("occupation"),
        "prompt": sample.get("prompt"),
        "reference_files": sample.get("reference_files") or [],
        "rubric_pretty": sample.get("rubric_pretty"),
        "task_prompt": task_prompt,
    }


def main(argv: list[str] | None = None) -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Zero-based row index of the sample to evaluate (default: 0).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_DEFAULT_OUTPUT,
        help="Path to write the JSON results file (default: results/sample_evaluation.json).",
    )
    args = parser.parse_args(argv)

    result = evaluate_sample(offset=args.offset)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, ensure_ascii=False)

    print(f"Task ID  : {result['task_id']}")
    print(f"Sector   : {result['sector']}")
    print(f"Occupation: {result['occupation']}")
    print(f"Results saved to: {args.output}")


if __name__ == "__main__":
    main()
