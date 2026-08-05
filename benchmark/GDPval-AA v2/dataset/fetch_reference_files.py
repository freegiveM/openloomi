#!/usr/bin/env python3
"""Pre-download every GDPval reference file referenced by gdpval_gold.jsonl.

GDPval tasks ship with up to ~17 reference files per task (PDF / Excel / CSV /
image / etc.). The official Stirrup harness injects them into the E2B sandbox's
working directory before the agent starts. We do the same for the OpenLoomi
runner by pre-downloading all of them to a local cache.

The runner then reads this cache at task start and forwards every file to
OpenLoomi's `fileAttachments` field, which writes them into the task's workDir.

Usage:
    python fetch_reference_files.py [--dataset gdpval_gold.jsonl] [--cache reference_files]

Output:
    <cache>/<task_id>/<original-filename>      # the binary
    reference_files_index.json                  # {task_id: [abs_path, ...]}

Concurrency defaults to 8 in-flight downloads; bump --concurrency on a fast
network. Safe to re-run — already-cached files are skipped via content-hash.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

import httpx


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _url_for_task(task: dict) -> list[str]:
    """Return HF CDN URLs for the task's reference files (may be empty)."""
    raw = task.get("raw") or {}
    urls = raw.get("reference_file_urls")
    if isinstance(urls, list):
        return [u for u in urls if isinstance(u, str) and u]
    # Fallback: synthesize from reference_file_hf_uris.
    hf_uris = raw.get("reference_file_hf_uris")
    if isinstance(hf_uris, list):
        out: list[str] = []
        for u in hf_uris:
            if not isinstance(u, str) or not u.startswith("hf://"):
                continue
            # hf://datasets/<repo>@<rev>/<path> -> https URL
            without = u[len("hf://"):]
            parts = without.split("/", 2)
            if len(parts) < 3:
                continue
            repo, rest = parts[0], parts[1]  # e.g. openai/gdpval
            if "@" in repo:
                repo_name, rev = repo.split("@", 1)
            else:
                repo_name, rev = repo, "main"
            path_in_repo = rest + "/" + parts[2] if False else parts[2]
            out.append(
                f"https://huggingface.co/datasets/{repo_name}/resolve/{rev}/{path_in_repo}"
            )
        return out
    return []


def _filename_from_url(url: str) -> str:
    return Path(url.split("?", 1)[0]).name or "file"


async def _download_one(
    client: httpx.AsyncClient,
    url: str,
    target: Path,
    *,
    retries: int = 3,
) -> Optional[Path]:
    if target.exists() and target.stat().st_size > 0:
        return target
    for attempt in range(1, retries + 1):
        try:
            async with client.stream("GET", url, follow_redirects=True) as resp:
                resp.raise_for_status()
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_suffix(target.suffix + ".part")
                with tmp.open("wb") as fh:
                    async for chunk in resp.aiter_bytes(1 << 20):
                        fh.write(chunk)
                tmp.replace(target)
                return target
        except Exception as exc:  # noqa: BLE001
            if attempt == retries:
                print(
                    f"  ! failed {url} -> {target.name}: {exc}",
                    file=sys.stderr,
                )
                return None
            await asyncio.sleep(1.5 * attempt)
    return None


async def _run(
    dataset_path: Path,
    cache_dir: Path,
    concurrency: int,
    limit: Optional[int],
) -> int:
    tasks: list[dict] = []
    with dataset_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            tasks.append(json.loads(line))
    if limit is not None:
        tasks = tasks[:limit]
    print(f"Loaded {len(tasks)} task(s) from {dataset_path}")

    sem = asyncio.Semaphore(concurrency)
    index: dict[str, list[str]] = {}

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=15.0),
        headers={"User-Agent": "gdpval-aa-v2-openloomi/1.0"},
    ) as client:
        async def work(task: dict) -> None:
            urls = _url_for_task(task)
            if not urls:
                return
            task_id = task["task_id"]
            paths: list[str] = []
            async with sem:
                for url in urls:
                    fname = _filename_from_url(url)
                    target = cache_dir / task_id / fname
                    result = await _download_one(client, url, target)
                    if result is not None:
                        paths.append(str(result.resolve()))
            if paths:
                index[task_id] = paths

        start = time.time()
        await asyncio.gather(*(work(t) for t in tasks))
        elapsed = time.time() - start

    total_files = sum(len(v) for v in index.values())
    total_bytes = 0
    for paths in index.values():
        for p in paths:
            try:
                total_bytes += Path(p).stat().st_size
            except OSError:
                pass

    cache_dir.mkdir(parents=True, exist_ok=True)
    index_path = cache_dir / "reference_files_index.json"
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"Done: {total_files} file(s), "
        f"{total_bytes / (1024 * 1024):.1f} MB, "
        f"{elapsed:.1f}s. Index -> {index_path}"
    )
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    here = Path(__file__).resolve().parent
    p.add_argument("--dataset", type=Path, default=here / "gdpval_gold.jsonl")
    p.add_argument("--cache", type=Path, default=here / "reference_files")
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()
    if not args.dataset.exists():
        print(f"error: dataset not found: {args.dataset}", file=sys.stderr)
        return 1
    return asyncio.run(
        _run(args.dataset, args.cache, args.concurrency, args.limit)
    )


if __name__ == "__main__":
    raise SystemExit(main())
