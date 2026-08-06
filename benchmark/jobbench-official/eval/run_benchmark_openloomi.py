#!/usr/bin/env python3
"""Run JobBench tasks with OpenLoomi's packaged one-shot CLI."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
PRINT_LOCK = threading.Lock()


@dataclass
class TaskResult:
    task: str
    status: str
    exit_code: int | None
    duration_seconds: float
    output_dir: str
    trajectory_file: str | None = None
    error: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run JobBench with OpenLoomi and write official model_output directories."
    )
    parser.add_argument("--split", choices=("main", "easy"), default="easy")
    parser.add_argument(
        "--tasks-base-dir",
        type=Path,
        help="Override dataset root containing profession/taskN directories.",
    )
    parser.add_argument(
        "--task",
        action="append",
        default=[],
        help="Only run matching profession/taskN (repeatable; glob syntax supported).",
    )
    parser.add_argument("--limit", type=int, help="Run at most N discovered tasks.")
    parser.add_argument(
        "--openloomi-ctl",
        type=Path,
        help="Path to openloomi-ctl executable; auto-detected when omitted.",
    )
    parser.add_argument("--provider", help="OpenLoomi provider override, e.g. claude or codex.")
    parser.add_argument("--model", help="OpenLoomi model override.")
    parser.add_argument("--output-model", default="openloomi")
    parser.add_argument("--run-label", default="")
    parser.add_argument("--max-concurrent", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=3600, help="Seconds per task.")
    parser.add_argument(
        "--permission-mode", choices=("deny", "bypass"), default="bypass"
    )
    parser.add_argument("--force", action="store_true", help="Replace existing outputs.")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.max_concurrent < 1:
        parser.error("--max-concurrent must be at least 1")
    if args.timeout < 1:
        parser.error("--timeout must be at least 1")
    return args


def safe_name(value: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "-_" else "-" for c in value)
    return cleaned.strip("-") or "openloomi"


def output_model_name(args: argparse.Namespace) -> str:
    name = safe_name(args.output_model)
    if args.run_label:
        name = f"{name}-{safe_name(args.run_label)}"
    return name


def find_ctl(explicit: Path | None) -> Path | None:
    if explicit:
        return explicit.expanduser().resolve()

    found = shutil.which("openloomi-ctl") or shutil.which("openloomi-ctl.exe")
    if found:
        return Path(found).resolve()

    candidates: list[Path] = []
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidates.append(
                Path(local_app_data)
                / "Programs"
                / "openloomi"
                / "cli"
                / "openloomi-ctl.exe"
            )
    elif sys.platform == "darwin":
        candidates.append(
            Path("/Applications/openloomi.app/Contents/Resources/cli/openloomi-ctl")
        )
    else:
        candidates.append(Path("/usr/lib/openloomi/cli/openloomi-ctl"))

    return next((path.resolve() for path in candidates if path.is_file()), None)


def task_key(task_dir: Path, tasks_base: Path) -> str:
    return task_dir.relative_to(tasks_base).as_posix()


def matches_task(key: str, patterns: list[str]) -> bool:
    if not patterns:
        return True
    from fnmatch import fnmatch

    normalized = key.replace("\\", "/")
    return any(fnmatch(normalized, pattern.replace("\\", "/")) for pattern in patterns)


def discover_tasks(tasks_base: Path, patterns: list[str]) -> list[Path]:
    tasks = []
    for instructions in tasks_base.glob("*/task[0-9]*/task_folder/TASK_INSTRUCTIONS.txt"):
        task_dir = instructions.parent.parent
        if matches_task(task_key(task_dir, tasks_base), patterns):
            tasks.append(task_dir)
    return sorted(tasks, key=lambda path: task_key(path, tasks_base))


def make_prompt(task_folder: Path, output_dir: Path, workspace: Path) -> str:
    return f"""=== TASK FOLDER ===
{task_folder}

=== INSTRUCTIONS ===
1. Read TASK_INSTRUCTIONS.txt in the task folder above.
2. Read and analyze the referenced files in that task folder using appropriate tools.
3. Complete every requested task and create the actual requested deliverables.
4. Save only final deliverables in the output directory below. Do not merely describe them in chat.

=== OUTPUT DIRECTORY ===
{output_dir}

IMPORTANT:
- All supplied reference files are in {task_folder}.
- Save every final deliverable directly under {output_dir}.
- Do not save intermediate or temporary files in the output directory.
- Only access files inside {workspace}, except when web research is required by the task.
- If information conflicts, analyze the conflict and justify the chosen approach.
- Use suitable tools or code to inspect XLSX, DOCX, PDF, PPTX, database, and other non-text files.
"""


def extract_cli_error(stdout: str, stderr: str) -> str:
    try:
        payload = json.loads(stdout)
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            code = error.get("code")
            return f"OpenLoomi CLI {code}: {error['message']}" if code else str(error["message"])
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass
    return stderr.strip() or stdout.strip() or "OpenLoomi produced no deliverable files"


def has_output(path: Path) -> bool:
    return path.is_dir() and any(item.is_file() for item in path.rglob("*"))


def copy_outputs(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)


def print_status(message: str) -> None:
    with PRINT_LOCK:
        print(message, flush=True)


def run_task(
    task_dir: Path,
    tasks_base: Path,
    ctl: Path,
    args: argparse.Namespace,
    model_name: str,
    temp_root: Path,
) -> TaskResult:
    key = task_key(task_dir, tasks_base)
    final_output = task_dir / "model_output" / model_name
    trajectory_dir = task_dir / "model_traj" / model_name
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    trajectory_file = trajectory_dir / f"attempt_{stamp}_{uuid.uuid4().hex[:8]}.json"
    started = time.monotonic()

    if has_output(final_output) and not args.force:
        print_status(f"SKIP {key}: output already exists")
        return TaskResult(key, "skipped", 0, 0.0, str(final_output))

    workspace = Path(tempfile.mkdtemp(prefix="jbo-", dir=temp_root))
    temp_task_folder = workspace / "task_folder"
    temp_output = workspace / "output"
    try:
        shutil.copytree(task_dir / "task_folder", temp_task_folder)
        temp_output.mkdir()
        prompt = make_prompt(temp_task_folder, temp_output, workspace)
        command = [
            str(ctl),
            "--one-shot",
            "--stdin",
            "--json",
            "--platform",
            "benchmark-jobbench",
            "--permission-mode",
            args.permission_mode,
        ]
        if args.provider:
            command.extend(("--provider", args.provider))
        if args.model:
            command.extend(("--model", args.model))

        print_status(f"RUN  {key}")
        completed = subprocess.run(
            command,
            cwd=workspace,
            input=prompt,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=args.timeout,
            env=os.environ.copy(),
        )
        duration = time.monotonic() - started
        trajectory_dir.mkdir(parents=True, exist_ok=True)
        record = {
            "task": key,
            "command": command,
            "started_at": stamp,
            "duration_seconds": round(duration, 3),
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
        trajectory_file.write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        if has_output(temp_output):
            copy_outputs(temp_output, final_output)
            status = "success" if completed.returncode == 0 else "output_with_error"
            print_status(f"DONE {key}: {status} -> {final_output}")
            return TaskResult(
                key,
                status,
                completed.returncode,
                duration,
                str(final_output),
                str(trajectory_file),
                completed.stderr.strip() or None,
            )

        error = extract_cli_error(completed.stdout, completed.stderr)
        print_status(f"FAIL {key}: {error.splitlines()[-1]}")
        return TaskResult(
            key,
            "failed",
            completed.returncode,
            duration,
            str(final_output),
            str(trajectory_file),
            error,
        )
    except subprocess.TimeoutExpired as exc:
        duration = time.monotonic() - started
        trajectory_dir.mkdir(parents=True, exist_ok=True)
        trajectory_file.write_text(
            json.dumps(
                {
                    "task": key,
                    "started_at": stamp,
                    "duration_seconds": round(duration, 3),
                    "status": "timeout",
                    "stdout": exc.stdout or "",
                    "stderr": exc.stderr or "",
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print_status(f"TIME {key}: exceeded {args.timeout}s")
        return TaskResult(
            key,
            "timeout",
            None,
            duration,
            str(final_output),
            str(trajectory_file),
            f"Timed out after {args.timeout} seconds",
        )
    except Exception as exc:  # noqa: BLE001
        duration = time.monotonic() - started
        print_status(f"FAIL {key}: {exc}")
        return TaskResult(key, "failed", None, duration, str(final_output), error=str(exc))
    finally:
        if args.keep_temp:
            print_status(f"KEEP {key}: {workspace}")
        else:
            shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    args = parse_args()
    tasks_base = (args.tasks_base_dir or ROOT_DIR / "dataset" / args.split).resolve()
    if not tasks_base.is_dir():
        print(f"Error: task root not found: {tasks_base}", file=sys.stderr)
        return 2

    tasks = discover_tasks(tasks_base, args.task)
    if args.limit:
        tasks = tasks[: args.limit]
    if not tasks:
        print("Error: no matching JobBench tasks found", file=sys.stderr)
        return 2

    model_name = output_model_name(args)
    print(f"Task root: {tasks_base}")
    print(f"Output model: {model_name}")
    print(f"Tasks selected: {len(tasks)}")
    for task in tasks:
        print(f"  - {task_key(task, tasks_base)}")

    if args.dry_run:
        return 0

    ctl = find_ctl(args.openloomi_ctl)
    if ctl is None or not ctl.is_file():
        print(
            "Error: openloomi-ctl was not found. Pass --openloomi-ctl with its full path.",
            file=sys.stderr,
        )
        return 2

    try:
        version = subprocess.run(
            [str(ctl), "--version"], capture_output=True, text=True, timeout=20
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Error: cannot execute {ctl}: {exc}", file=sys.stderr)
        return 2
    if version.returncode != 0:
        print(f"Error: openloomi-ctl check failed: {version.stderr}", file=sys.stderr)
        return 2
    print(f"OpenLoomi CLI: {ctl}")
    print(f"Version: {version.stdout.strip()}")

    temp_root = Path(tempfile.gettempdir()) / "jbo"
    temp_root.mkdir(parents=True, exist_ok=True)
    results: list[TaskResult] = []
    with ThreadPoolExecutor(max_workers=args.max_concurrent) as executor:
        futures = [
            executor.submit(
                run_task, task, tasks_base, ctl, args, model_name, temp_root
            )
            for task in tasks
        ]
        for future in as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda item: item.task)
    summary_dir = SCRIPT_DIR / "logs"
    summary_dir.mkdir(parents=True, exist_ok=True)
    summary_path = summary_dir / f"openloomi_{args.split}_{model_name}_{int(time.time())}.json"
    counts: dict[str, int] = {}
    for result in results:
        counts[result.status] = counts.get(result.status, 0) + 1
    summary_path.write_text(
        json.dumps(
            {
                "split": args.split,
                "tasks_base_dir": str(tasks_base),
                "output_model": model_name,
                "counts": counts,
                "results": [asdict(result) for result in results],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Summary: {counts}")
    print(f"Run report: {summary_path}")
    return 1 if counts.get("failed", 0) or counts.get("timeout", 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
