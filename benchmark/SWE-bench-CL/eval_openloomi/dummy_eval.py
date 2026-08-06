"""
dummy_eval.py —— 一分钟级 dry-run：完整打通链路（不含 SWE-Agent 全部能力）

不依赖官方 v3 的 dummy JSON，直接手工构造：
- 一个本地小仓库（含一个 bug + 一个测试）
- 一条 SWE-Bench-CL 风格的 task（base_commit + issue + FAIL_TO_PASS + PASS_TO_PASS）
- 跑完 setup → agent → apply_patch → 跑测试

如果链路打通：
- agent 收到 prompt 后会去查看本地仓
- 用它自己的工具修 bug
- 在回复里产出 ```diff``` 块
- harness 抓到 diff → git apply → 跑 unittest
- output 写到 dummy_results.json

用法：
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
    """手工构造一个假仓库：math_utils.add 错把 a+b 写成 a-b，测试期望 a+b。

    每次跑都用带时间戳的子目录，避免 Windows 上 .git/objects 被 lock 导致
    PermissionError。
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
    # 把 ts_dir 写到 DUMMY_DIR 让后续函数也能用
    global DUMMY_DIR
    DUMMY_DIR = ts_dir
    return ts_dir


def build_dummy_dataset(repo_dir: Path):
    """手工构造一个 dataset 字典（与 SWE-Bench-CL 同 schema）。"""
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
                            "base_commit": "init",  # 任何 base_commit 都被 setup 路径跳过
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
                            "test_patch": "",  # dummy 不需要外部 test_patch
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

    # 关键：把 SWEAgentCLEvaluator 内部 setup_repository 的"先 git clone"绕开
    # 直接用我们的本地仓（跳过 setup_repository 探测）
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

    # 注意：当 OpenLoomi 是真实 coding agent 时，它可能直接在工作目录里把代码
    # 修好（如本机所示），所以**即使 diff 没 apply 成功，文件本身可能已经正确**。
    # 因此我们始终跑一遍测试，以测试通过与否作为最终 success。
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
        # 试 apply patch，看 diff 是不是真的对得上；但不影响 success 判断
        if not success:  # 仅在测试还没过时尝试 apply
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
