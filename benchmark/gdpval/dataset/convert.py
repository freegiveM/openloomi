#!/usr/bin/env python3
"""Convert the public openai/gdpval HuggingFace dataset to OpenLoomi JSONL.

This script intentionally keeps the original row under `raw` because GDPval
contains task-specific artifacts and fields that may evolve over time.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from datasets import get_dataset_split_names, load_dataset

DATASET_NAME = "openai/gdpval"

PROMPT_KEYS = (
    "prompt",
    "task_prompt",
    "instruction",
    "question",
    "input",
    "description",
)

ID_KEYS = (
    "task_id",
    "id",
    "example_id",
    "record_id",
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

    # Fallback: preserve enough task context instead of silently dropping rows.
    compact = {
        key: make_jsonable(value)
        for key, value in row.items()
        if key.lower() not in {"raw", "metadata"}
    }
    return json.dumps(compact, ensure_ascii=False, indent=2)


def convert_row(row: dict[str, Any], index: int) -> dict[str, Any]:
    raw = make_jsonable(row)
    task_id = pick_first_string(raw, ID_KEYS) or f"gdpval_{index:04d}"

    metadata_keys = (
        "occupation",
        "industry",
        "domain",
        "category",
        "task_type",
        "source",
    )
    metadata = {
        key: raw.get(key)
        for key in metadata_keys
        if isinstance(raw, dict) and key in raw
    }

    return {
        "task_id": task_id,
        "prompt": build_prompt(raw),
        "metadata": metadata,
        "raw": raw,
    }


def resolve_split(requested_split: str | None) -> str:
    if requested_split:
        return requested_split
    splits = get_dataset_split_names(DATASET_NAME)
    if not splits:
        raise RuntimeError(f"No splits found for {DATASET_NAME}")
    return splits[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert openai/gdpval to JSONL")
    parser.add_argument("--output", default="dataset/gdpval.jsonl")
    parser.add_argument("--split", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--streaming", action="store_true")
    args = parser.parse_args()

    split = resolve_split(args.split)
    dataset = load_dataset(DATASET_NAME, split=split, streaming=args.streaming)

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

    print(f"Wrote {count} GDPval tasks to {output_path}")


if __name__ == "__main__":
    main()
