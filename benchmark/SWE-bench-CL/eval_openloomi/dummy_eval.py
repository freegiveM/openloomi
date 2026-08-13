"""
dummy_eval.py — one-minute dry-run that exercises the full pipeline (without
the full SWE-Agent capabilities).

Does not depend on the official v3 dummy JSON; constructs everything by hand:
- a small local repo (with one bug + one test)
- one SWE-Bench-CL-style task (base_commit + issue + FAIL_TO_PASS + PASS_TO_PASS)
- runs setup → agent → apply_patch → execute tests end-to-end

If the pipeline works:
- the agent inspects the local repo after receiving the prompt
- fixes the bug with its own tools
- emits a ```diff``` block in its reply
- harness extracts the diff → git apply → run unittest
- output is written to dummy_results.json

Usage:
    cd D:\\openloomi3\\openloomi\\benchmark\\SWE-bench-CL\\eval_openloomi
    python dummy_eval.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path

from config import OpenLoomiConfig, validate_openloomi_endpoint, CLONE_BASE_DIR


DUMMY_DIR = CLONE_BASE_DIR / "dummy_math_project"


def build_dummy_repo():
    """Hand-build a fake repo: math_utils.add incorrectly returns a - b, but
    the test expects a + b.

    Each run uses a timestamped subdirectory to avoid PermissionError from
    .git/objects being locked on Windows.
    """
    import time as _t
    ts_dir = CLONE_BASE_DIR / f"dummy_math_project_{int(_t.time())}"
    if ts_dir.exists():
        shutil.rmtree(ts_dir, ignore_errors=True)
    ts_dir.mkdir(parents=True, exist_ok=True)
    (ts_dir / "math_utils.py").write_text("def add(a, b):\n    return a - b\n",
                                            encoding="utf-8")
    (ts_dir / "test_math_utils.py").write_text(
        "import unittest\nfrom math_utils import add\n"
        "class TestMath(unittest.TestCase):\n"
        "    def test_add(self):\n"
        "        self.assertEqual(add(2, 3), 5)\n"
        "    def test_pass_to_pass(self):\n"
        "        self.assertTrue(callable(add))\n"
        "if __name__ == '__main__':\n    unittest.main()\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=ts_dir, capture_output=True)
    subprocess.run(["git", "add", "-A"], cwd=ts_dir, capture_output=True)
    subprocess.run(["git", "-c", "user.email=bot@x", "-c", "user.name=bot",
                    "commit", "-qm", "init"], cwd=ts_dir, capture_output=True)
    # Write ts_dir to DUMMY_DIR so subsequent functions can use it
    global DUMMY_DIR
    DUMMY_DIR = ts_dir
    return ts_dir


def build_dummy_dataset(repo_dir: Path):
    """Hand-build a dataset dict (same schema as SWE-Bench-CL)."""
    return {
        "metadata": {
            "name": "SWE-Bench-CL-Dummy-Local",
            "num_sequences": 1,
            "total_tasks": 1,
            "repositories": ["local/dummy_math_project"],
        },
        "sequences": [
            {
                "id": "dummy_local_sequence",
                "repo": "local/dummy_math_project",
                "num_tasks": 1,
                "tasks": [
                    {
                        "metadata": {
                            "instance_id": "local__dummy_math_project_task_1",
                            "repo": "local/dummy_math_project",
                            "base_commit": "init",  # Any base_commit is skipped by the setup path
                        },
                        "task": {
                            "problem_statement": (
                                "In `math_utils.py`, the function `add(a, b)` currently "
                                "returns `a - b`, but it should return `a + b`. Please fix it "
                                "so `add(2, 3) == 5`."
                            ),
                            "hints_text": None,
                        },
                        "evaluation": {
                            "test_patch": "",  # The dummy run does not need an external test_patch
                            "FAIL_TO_PASS": ["test_math_utils.TestMath.test_add"],
                            "PASS_TO_PASS": ["test_math_utils.TestMath.test_pass_to_pass"],
                        },
                        "continual_learning": {
                            "sequence_position": 1,
                            "difficulty_score": 1,
                            "dependencies": [],
                            "modified_files": ["math_utils.py"],
                        },
                    }
                ],
            }
        ],
    }


def run_dummy():
    cfg = OpenLoomiConfig()
    validate_openloomi_endpoint(cfg)

    repo_dir = build_dummy_repo()
    dataset = build_dummy_dataset(repo_dir)

    from eval_procedure import SWEAgentCLEvaluator, setup_repository, CLONE_BASE_DIR

    # Key trick: bypass SWEAgentCLEvaluator's internal setup_repository "git clone first" step.
    # Use our local repo directly (skip the setup_repository probe).
    seq_id = dataset["sequences"][0]["id"]
    task = dataset["sequences"][0]["tasks"][0]
    tid = task["metadata"]["instance_id"]

    # prompt
    from prompt_template import build_task_prompt
    prompt = build_task_prompt(
        instance_id=tid, repo=task["metadata"]["repo"],
        problem_statement=task["task"]["problem_statement"],
        fail_to_pass=task["evaluation"]["FAIL_TO_PASS"],
        pass_to_pass=task["evaluation"]["PASS_TO_PASS"],
        hints=None, memory_excerpt=None, work_dir=str(repo_dir),
    )

    from openloomi_client import call_agent
    from patch_parser import extract_patch, classify_no_patch
    from eval_procedure import apply_patch

    t0 = time.time()
    reply = call_agent(prompt, work_dir=repo_dir, config=cfg,
                       log_prefix="[dummy] ")
    elapsed = time.time() - t0
    diff = extract_patch(reply) or ""
    no_patch = classify_no_patch(reply)

    print("=" * 60)
    print(f"Reply: {len(reply)} chars in {elapsed:.1f}s")
    print(f"PATCH_FOUND: {bool(diff)}; NO_PATCH_DETECTED: {no_patch}")
    print(f"Diff preview (first 800 chars):\n{diff[:800]}")
    print("=" * 60)

    # Note: when OpenLoomi is a real coding agent, it may directly fix the
    # code in the working directory (as seen on this machine), so even if the
    # diff apply fails, the files themselves may already be correct. Therefore
    # we always run the tests once, and use test success as the final verdict.
    test_proc = subprocess.run(
        ["python", "-m", "unittest", "test_math_utils", "-v"],
        cwd=str(repo_dir.resolve()), capture_output=True, text=True, timeout=60,
    )
    print(f"unittest stdout:\n{test_proc.stdout}")
    if test_proc.stderr.strip():
        print(f"unittest stderr:\n{test_proc.stderr}")
    success = test_proc.returncode == 0 and "FAIL" not in test_proc.stderr

    patch_applied = diff is not None
    if diff and not no_patch:
        # Try to apply the patch to see if the diff actually fits; this does not
        # affect the success verdict.
        if not success:  # Only attempt to apply when tests are still failing
            patch_applied = apply_patch(diff, repo_dir.resolve())
            print(f"git apply result: {patch_applied}")
            if patch_applied:
                test_proc = subprocess.run(
                    ["python", "-m", "unittest", "test_math_utils", "-v"],
                    cwd=str(repo_dir.resolve()), capture_output=True, text=True, timeout=60,
                )
                success = test_proc.returncode == 0 and "FAIL" not in test_proc.stderr

    out = {
        "instance_id": tid,
        "openloomi_provider": cfg.provider,
        "agent_reply_chars": len(reply),
        "patch_found": bool(diff),
        "patch_len": len(diff),
        "patch_applied": patch_applied,
        "unittest_passed": success,
        "elapsed_sec": round(elapsed, 1),
        "reply_tail": reply[-500:],
    }
    Path("./dummy_results.json").write_text(
        json.dumps(out, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    run_dummy()
