"""Download the JobBench HF dataset straight to its final layout on Windows.

The official ./setup.sh calls `hf download`, which stages files under a
cache directory with double-hashed .incomplete names. On Windows those
paths exceed MAX_PATH (260) for long profession names like
`secretaries_and_administrative_assistants_except_legal_medical_and_executive`.

This script streams every file directly into dataset/main and dataset/easy.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from huggingface_hub import HfApi

REPO = "JobBench/job-bench"
BASE = Path(__file__).resolve().parent / "dataset"
WORKERS = 8


def destination(path: str) -> Path:
    if path.startswith("dataset/"):
        return BASE / "main" / path.removeprefix("dataset/")
    return BASE / "easy" / path.removeprefix("dataset_easy/")


def download(path: str) -> tuple[str, str]:
    target = destination(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size > 0:
        return path, "skip"
    quoted = "/".join(urllib.parse.quote(part) for part in path.split("/"))
    url = f"https://huggingface.co/datasets/{REPO}/resolve/main/{quoted}"
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            return path, "ok"
        except Exception as error:
            last_error = error
            target.unlink(missing_ok=True)
            time.sleep(1.5 * (attempt + 1))
    return path, f"error: {last_error}"


def main() -> int:
    files = HfApi().list_repo_files(REPO, repo_type="dataset")
    files = [path for path in files if path.startswith(("dataset/", "dataset_easy/"))]
    print(f"Downloading {len(files)} files to {BASE}", flush=True)
    counts = {"ok": 0, "skip": 0, "error": 0}
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(download, path) for path in files]
        for index, future in enumerate(as_completed(futures), 1):
            path, status = future.result()
            key = "error" if status.startswith("error:") else status
            counts[key] += 1
            if key == "error":
                print(f"ERROR {path}: {status}", file=sys.stderr, flush=True)
            if index % 50 == 0 or index == len(files):
                print(f"[{index}/{len(files)}] {counts}", flush=True)
    return 1 if counts["error"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
