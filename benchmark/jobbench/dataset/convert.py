#!/usr/bin/env python3
"""Convert a JobBench Hugging Face dataset to OpenLoomi JSONL.

The JobBench organization may expose multiple dataset repos. Keep the source
repo configurable so this benchmark wrapper can follow the exact public dataset
without changing code.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from datasets import get_dataset_split_names, load_dataset

DEFAULT_DATASET_NAME = os.environ.get("JOBBENCH_DATASET_NAME", "JobBench/job-bench")

PROMPT_KEYS = (
    "prompt",
    "task_prompt",
    "instruction",
    "question",
    "input",
    "query",
    "description",
    "task",
)

ID_KEYS = (
    "task_id",
    "id",
    "example_id",
    "record_id",
    "uuid",
)

METADATA_KEYS = (
    "category",
    "domain",
    "job",
    "role",
    "occupation",
    "industry",
    "task_type",
    "source",
    "difficulty",
)


def make_jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [make_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [make_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): make_jsonable(item) for key, item in value.items()}
    if hasattr(value, "path"):
        return str(value.path)
    if hasattr(value, "filename"):
        return str(value.filename)
    return str(value)


def pick_first_string(row: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def build_prompt(row: dict[str, Any]) -> str:
    prompt = pick_first_string(row, PROMPT_KEYS)
    if prompt:
        return prompt

    compact = {
        key: make_jsonable(value)
        for key, value in row.items()
        if key.lower() not in {"raw", "metadata"}
    }
    return json.dumps(compact, ensure_ascii=False, indent=2)


def convert_row(row: dict[str, Any], index: int) -> dict[str, Any]:
    raw = make_jsonable(row)
    task_id = pick_first_string(raw, ID_KEYS) or f"jobbench_{index:04d}"
    metadata = {key: raw.get(key) for key in METADATA_KEYS if key in raw}

    return {
        "task_id": task_id,
        "prompt": build_prompt(raw),
        "metadata": metadata,
        "raw": raw,
    }


def resolve_split(dataset_name: str, requested_split: str | None) -> str:
    if requested_split:
        return requested_split
    splits = get_dataset_split_names(dataset_name)
    if not splits:
        raise RuntimeError(f"No splits found for {dataset_name}")
    return splits[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert JobBench Hugging Face dataset to JSONL")
    parser.add_argument("--dataset-name", default=DEFAULT_DATASET_NAME)
    parser.add_argument("--output", default="dataset/jobbench.jsonl")
    parser.add_argument("--split", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--streaming", action="store_true")
    args = parser.parse_args()

    split = resolve_split(args.dataset_name, args.split)
    dataset = load_dataset(args.dataset_name, split=split, streaming=args.streaming)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    with output_path.open("w", encoding="utf-8") as handle:
        for index, row in enumerate(dataset):
            if args.limit is not None and count >= args.limit:
                break
            item = convert_row(dict(row), index)
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")
            count += 1

    print(f"Wrote {count} JobBench tasks from {args.dataset_name}/{split} to {output_path}")


if __name__ == "__main__":
    main()

