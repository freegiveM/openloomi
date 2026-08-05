"""Convert the OpenLoomi runner output into the submission JSONL format
that the GDPVal-AA pair-wise grader (grader/GDPVal_Eval) expects.

Each output line is one (model, task) submission record:

    {
      "model": "openloomi::claude-sonnet-4-5",
      "task_id": "83d10b06-...",
      "prompt": "...",                 # original task prompt
      "reference_files": ["..."],      # original GDPval reference files
      "submission_files": [            # absolute paths to the deliverables
        "/abs/path/to/results/artifacts/<task_id>/report.pdf"
      ],
      "metadata": {                    # occupation, sector, etc.
        "occupation": "...",
        "sector": "..."
      },
      "session_id": "...",             # OpenLoomi session id (if any)
      "duration_ms": 12345,
      "tool_calls": ["Read", "Write", ...]
    }

Usage:
    python scripts/evaluate.py \\
        --run results/gdpval_aa_v2_run.json \\
        --output results/submissions/openloomi_claude-sonnet-4-5.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def _resolve_archive_paths(
    artifacts_dir: Path, prediction: Dict[str, Any]
) -> List[str]:
    """Map the recorded deliverable paths to absolute paths on disk.

    Prefer `archive_path` (set by the runner when the file was copied to
    `results/artifacts/<task_id>/`). Fall back to the workdir-relative path
    resolved against the task's `work_dir`.
    """
    paths: List[str] = []
    workdir = Path(prediction.get("work_dir") or "")
    for deliverable in prediction.get("deliverables") or []:
        archive = deliverable.get("archive_path")
        if archive:
            full = artifacts_dir.parent / archive
            if full.exists():
                paths.append(str(full.resolve()))
                continue
        rel = deliverable.get("workdir_path")
        if rel and workdir:
            candidate = workdir / rel
            if candidate.exists():
                paths.append(str(candidate.resolve()))
    return paths


def _reference_files_for(task: Dict[str, Any]) -> List[str]:
    """Extract the upstream reference file list from the GDPval raw row.

    The HF `openai/gdpval` row keeps reference files under
    `reference_files` (or a similar name). Be defensive: try several keys.
    """
    raw = task.get("raw") or {}
    candidates = (
        "reference_files",
        "reference_file_paths",
        "reference_paths",
        "attachments",
        "input_files",
    )
    for key in candidates:
        value = raw.get(key)
        if isinstance(value, list) and all(isinstance(v, str) for v in value):
            return [str(v) for v in value]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
    return []


def _build_model_slug(run: Dict[str, Any]) -> str:
    provider = (run.get("provider") or "openloomi").strip() or "openloomi"
    model = (run.get("model") or "unknown").strip() or "unknown"
    safe = model.replace("/", "-").replace("\\", "-")
    return f"openloomi::{provider}::{safe}"


def _build_submission_record(
    model_slug: str,
    task: Dict[str, Any],
    prediction: Dict[str, Any],
    artifacts_dir: Path,
) -> Dict[str, Any]:
    metadata = {}
    for src in (prediction.get("metadata"), task.get("metadata")):
        if isinstance(src, dict):
            for key, value in src.items():
                if value is not None and key not in metadata:
                    metadata[key] = value

    return {
        "model": model_slug,
        "task_id": task.get("task_id") or prediction.get("task_id"),
        "prompt": prediction.get("prompt") or task.get("prompt"),
        "reference_files": _reference_files_for(task),
        "submission_files": _resolve_archive_paths(artifacts_dir, prediction),
        "metadata": metadata,
        "session_id": prediction.get("session_id"),
        "duration_ms": prediction.get("duration_ms"),
        "tool_calls": prediction.get("tool_calls") or [],
        "usage": prediction.get("usage"),
        "error": prediction.get("error"),
    }


def iter_predictions(run: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    predictions = run.get("predictions") or []
    if isinstance(predictions, list):
        for item in predictions:
            if isinstance(item, dict):
                yield item


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run",
        type=Path,
        required=True,
        help="Path to the gdpval_aa_v2_run.json produced by `pnpm benchmark`",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Where to write the submission JSONL",
    )
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        default=None,
        help="Override artifacts directory (default: <run-dir>/artifacts)",
    )
    parser.add_argument(
        "--include-errors",
        action="store_true",
        help="Include failed runs in the output (default: skip them)",
    )
    args = parser.parse_args(argv)

    if not args.run.exists():
        print(f"error: run file not found: {args.run}", file=sys.stderr)
        return 1

    # Tolerate UTF-8 BOM (PowerShell `Set-Content` writes one by default).
    raw_text = args.run.read_text(encoding="utf-8-sig")
    run = json.loads(raw_text)
    artifacts_dir = args.artifacts_dir or args.run.parent / "artifacts"

    # Build a task_id -> raw row lookup from any side data if the runner
    # embedded the original task object; otherwise best-effort.
    task_lookup: Dict[str, Dict[str, Any]] = {}
    for prediction in iter_predictions(run):
        if isinstance(prediction.get("metadata"), dict):
            task_lookup.setdefault(
                prediction["task_id"],
                {
                    "task_id": prediction["task_id"],
                    "prompt": prediction.get("prompt"),
                    "metadata": prediction.get("metadata"),
                },
            )

    model_slug = _build_model_slug(run)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    with args.output.open("w", encoding="utf-8") as handle:
        for prediction in iter_predictions(run):
            if prediction.get("error") and not args.include_errors:
                continue
            record = _build_submission_record(
                model_slug,
                task_lookup.get(prediction["task_id"], {}),
                prediction,
                artifacts_dir,
            )
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            written += 1

    print(f"Wrote {written} submission record(s) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
