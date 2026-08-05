#!/usr/bin/env python3
"""Download the openai/gdpval HuggingFace dataset (gold 220-task subset).

This script downloads the official GDPval gold public split used by
GDPval-AA v2 evaluations (220 tasks across 44 occupations, 9 industries).

Each row in the dataset contains task prompts plus reference files for
real-world knowledge work tasks.

Usage:
    python download_gdpval.py [--output gdpval_gold.jsonl] [--limit N]

Requires:
    pip install datasets huggingface_hub pyarrow
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from datasets import get_dataset_split_names, load_dataset

DATASET_NAME = "openai/gdpval"


def make_jsonable(value):
    """Convert HF dataset objects to JSON-serializable Python primitives."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [make_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(k): make_jsonable(v) for k, v in value.items()}
    if hasattr(value, "path"):
        return str(value.path)
    if hasattr(value, "filename"):
        return str(value.filename)
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download openai/gdpval dataset (gold subset) for GDPval-AA v2"
    )
    parser.add_argument(
        "--output",
        default="gdpval_gold.jsonl",
        help="Output JSONL file path (default: gdpval_gold.jsonl)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of tasks (default: all 220)",
    )
    parser.add_argument(
        "--streaming",
        action="store_true",
        help="Use streaming mode (lower memory)",
    )
    args = parser.parse_args()

    print(f"Resolving splits for {DATASET_NAME} ...")
    splits = get_dataset_split_names(DATASET_NAME)
    print(f"Available splits: {splits}")

    # The gold public split is the official 220-task subset used by GDPval-AA v2.
    split = "train" if "train" in splits else splits[0]
    print(f"Loading split '{split}' ...")

    dataset = load_dataset(DATASET_NAME, split=split, streaming=args.streaming)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    with output_path.open("w", encoding="utf-8") as handle:
        for index, row in enumerate(dataset):
            if args.limit is not None and count >= args.limit:
                break

            row_dict = dict(row)
            # Build the OpenLoomi-friendly task object.
            prompt_keys = ("prompt", "task_prompt", "instruction", "question")
            prompt = next(
                (
                    row_dict.get(k)
                    for k in prompt_keys
                    if isinstance(row_dict.get(k), str) and row_dict.get(k).strip()
                ),
                json.dumps(
                    {k: make_jsonable(v) for k, v in row_dict.items()},
                    ensure_ascii=False,
                ),
            )

            id_keys = ("task_id", "id", "example_id")
            task_id = next(
                (
                    row_dict.get(k)
                    for k in id_keys
                    if isinstance(row_dict.get(k), str) and row_dict.get(k).strip()
                ),
                f"gdpval_{index:04d}",
            )

            metadata_keys = (
                "occupation",
                "industry",
                "domain",
                "category",
                "task_type",
                "source",
            )
            metadata = {
                k: row_dict.get(k)
                for k in metadata_keys
                if k in row_dict
            }

            item = {
                "task_id": task_id,
                "prompt": prompt,
                "metadata": metadata,
                "raw": make_jsonable(row_dict),
            }
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")
            count += 1

            if (count % 20 == 0) or (args.limit is not None and count == args.limit):
                print(f"  ... wrote {count} tasks")

    print(f"Done. Wrote {count} GDPval gold tasks to {output_path}")


if __name__ == "__main__":
    main()