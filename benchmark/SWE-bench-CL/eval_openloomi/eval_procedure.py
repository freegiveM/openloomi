"""
eval_procedure.py
=================

**与官方 eval_v3_swe-agent 的关系**：

| 官方 v3 §              | 本目录实现 |
|------------------------|---|
| §1 Setup               | 文件顶部 + config.py |
| §2 Load dataset        | `load_swe_bench_cl()` |
| §2.5 setup_repository  | `setup_repository()`（git clone + reset + clean，与官方一致） |
| §3 Model               | ★ **替换** —— 由 OpenLoomi 整体承担，**不再有 get_llm()** |
| §4 Tools (手写 ACI)    | ★ **删除** —— OpenLoomi 自带 Bash/Read/Edit/Grep/Glob |
| §5 Semantic memory     | `SemanticMemory` 精简版（FAISS + sentence-transformers） |
| §6 LangGraph 5-node    | ★ **删除** —— 改成单层 for 循环；每 task 单次 /api/native/agent |
| §7 Evaluation          | `apply_patch` + `run_evaluation_tests` + `check_test_outcomes` |
| §8 Experiments         | `SWEAgentCLEvaluator` + memory × no-memory 双组 |
| §9 Results Analysis    | `analyze_results()` |

调用粒度（与官方 v3 不同）：
    - v3：每个 task 调 5 个 LLM（planner/executor/reflector/solver/tool）
    - 本目录：每个 task 调 1 次 /api/native/agent ——
      让 OpenLoomi 内部完整地 plan → execute → reflect → 输出 final diff

工作流：
    for task in sequence:
        repo_dir = setup_repository(repo, base_commit)
        prompt  = build_task_prompt(task, repo_dir, memory=memory_excerpt)
        reply   = openloomi_call(prompt, workDir=repo_dir)  # OpenLoomi 自己用工具链跑
        diff    = extract_patch(reply)
        apply_patch_test(diff, repo_dir)
        success = run_pytest(repo_dir) and check_FAIL_TO_PASS / PASS_TO_PASS
        record(success, diff)
        if memory_enabled: memory.add(task, diff, success)
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

import requests
import re
import urllib.request
import urllib.error
from tqdm import tqdm


# 自动从 .env 加载敏感 env（如果 caller 没设）。
# 优先级：process env > user-scope registry > .env
def _load_env_file():
    env_path = Path(__file__).resolve().parents[2] / "clbench" / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except OSError as e:
        logger.warning("failed to load .env: %s", e)


_load_env_file()

from config import (
    ANALYSIS_PATH,
    CLONE_BASE_DIR,
    DATASET_PATH,
    DEFAULT_TEST_COMMAND,
    EVAL_PYTHON,
    LOG_DIR,
    OpenLoomiConfig,
    RESULTS_PATH,
    ENABLE_MEMORY,
    SEQUENCE_TASK_LIMIT,
    SEQUENCE_IDS as CFG_SEQUENCE_IDS,
    validate_openloomi_endpoint,
    EMBEDDING_MODEL,
    MEMORY_K_RESULTS,
    MEMORY_MAX_CONTEXT_CHARS,
)
from openloomi_client import OpenLoomiConfig as _OLCfg, call_agent
from prompt_template import build_task_prompt
from patch_parser import extract_patch, classify_no_patch

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("swe_bench_cl_openloomi")

CLONE_BASE_DIR.mkdir(exist_ok=True)
import patch as patch_parser  # python-patch
try:
    import flake8.api.legacy as _flake8_api  # noqa: F401  (optional, future use)
    FLAKE8_AVAILABLE = True
except ImportError:
    FLAKE8_AVAILABLE = False


# ============================================================================
# §2 Load dataset
# ============================================================================

def load_swe_bench_cl(path: str = DATASET_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)
    logger.info("Loaded %d sequences / %d tasks from %s",
                d["metadata"]["num_sequences"], d["metadata"]["total_tasks"], path)
    return d


# ============================================================================
# §2.5 setup_repository（与官方 v3 完全一致）
# ============================================================================

def setup_repository(repo_identifier: str,
                     commit_hash: str,
                     base_clones_dir: Path,
                     force_reset: bool = True,
                     dummy_files_setup=None) -> Path:
    """git clone + reset --hard 到 base_commit。
    Returns absolute path to the (now on base_commit) repo dir.

    与官方 v3 略不同：
      我们**不**调 ``git clean -fdx``。OpenLoomi agent 会直接在工作目录里
      改文件（不是输出 diff 让 harness 改），所以前一条 task 留下的修改必须
      保留给 evaluate 使用；用 ``git stash`` / patch apply 控制边界。
      上游 v3 自己写 5 个 LangGraph 节点，自己跑 ripgrep/find_file，
      不会绕到 working tree 之外；我们让 OpenLoomi 的改动天然落盘。
    """
    # --- local/* (dummy 数据集路径) ---
    if repo_identifier.startswith("local/"):
        project_name = repo_identifier.split("/", 1)[1]
        local = base_clones_dir / f"local__{project_name}"
        local.mkdir(parents=True, exist_ok=True)
        if dummy_files_setup is not None:
            dummy_files_setup(local)
        else:
            for item in local.iterdir():
                if item.is_file(): item.unlink()
                elif item.is_dir():
                    import shutil; shutil.rmtree(item)
            (local / "README.md").write_text(
                "# Dummy project\n\nGenerated for SWE-Bench-CL dry-run.\n",
                encoding="utf-8",
            )
        subprocess.run(["git", "init", "-q"], cwd=local, capture_output=True)
        subprocess.run(["git", "add", "-A"], cwd=local, capture_output=True)
        subprocess.run(["git", "-c", "user.email=bot@x", "-c", "user.name=bot",
                        "commit", "-qm", "init"], cwd=local, capture_output=True)
        return local.resolve()

    sanitized = repo_identifier.replace("/", "__")
    local = base_clones_dir / sanitized
    try:
        if not local.exists():
            logger.info("Cloning %s → %s", repo_identifier, local)
            local.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "clone", f"https://github.com/{repo_identifier}.git", str(local)],
                check=True, timeout=900, capture_output=True,
            )
        subprocess.run(["git", "fetch"], cwd=local, check=True, timeout=300, capture_output=True)
        # 关键差别：用 ``git reset --hard`` 而不是 ``git clean -fdx``。
        # OpenLoomi agent 修改的工作树会被前一条 task 影响；
        # 所以每条 task 开始前我们都需要切回 base_commit，然后再让 agent 重新改。
        subprocess.run(["git", "reset", "--hard", commit_hash],
                       cwd=local, check=True, timeout=120, capture_output=True)
        # 仅当 force_reset=True 时额外 clean。但默认开 force_reset 会有副作用：
        # 如果用户自己 ``force_reset=False``，agent 的工作文件就在 working tree
        # 残留；此处不开。
        # if force_reset:
        #     subprocess.run(["git", "clean", "-fdx"],
        #                    cwd=local, check=True, timeout=120, capture_output=True)
        return local.resolve()
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="ignore") if e.stderr else "N/A"
        logger.error("git failure on %s@%s: %s", repo_identifier, commit_hash, stderr)
        raise


# ============================================================================
# §3 (New) OpenLoomi client wrapper
# ============================================================================

def run_agent_on_task(
    *,
    task: dict,
    sequence_id: str,
    repo_path: Path,
    memory_excerpt: Optional[str],
    cfg: OpenLoomiConfig,
    run_id: str,
    task_idx: int,
) -> tuple[bool, str, str, str]:
    """调用 OpenLoomi 一整轮。

    Returns:
        (success_bool, agent_reply_text, diff_from_reply, wd_diff)
        diff_from_reply: agent 输出里抠出的 patch（可能含 ```diff``` 块）
        wd_diff: 工作目录 ``git diff`` 产物（agent 直接改文件时非空）
    """
    instance_id = task["metadata"]["instance_id"]
    repo = task["metadata"]["repo"]
    problem = task["task"]["problem_statement"]
    hints = task["task"].get("hints_text")
    fail_to_pass = task["evaluation"].get("FAIL_TO_PASS", [])
    pass_to_pass = task["evaluation"].get("PASS_TO_PASS", [])

    prompt = build_task_prompt(
        instance_id=instance_id,
        repo=repo,
        problem_statement=problem,
        fail_to_pass=fail_to_pass,
        pass_to_pass=pass_to_pass,
        hints=hints,
        memory_excerpt=memory_excerpt,
        work_dir=str(repo_path),
    )

    log_prefix = f"[{run_id}|{sequence_id}|{task_idx}|{instance_id}] "
    t0 = time.time()
    reply = call_agent(prompt, work_dir=repo_path, config=cfg, log_prefix=log_prefix)
    logger.info("%sagent took %.1fs, reply %d chars",
                log_prefix, time.time() - t0, len(reply))

    # 1) 优先尝试从 agent 回复中抠 unified diff
    diff_from_reply = extract_patch(reply) or ""

    # 2) 兜底：直接用 ``git diff`` 把 agent 在工作目录里真实做出的改动抓出来
    #    （agent 不输出 patch 而是直接编辑文件，这里能拿到 "真相"）
    try:
        wd_diff = subprocess.run(
            ["git", "diff"],
            cwd=str(repo_path), capture_output=True, text=True, timeout=60,
        ).stdout
    except Exception:
        wd_diff = ""

    # 3) 优先用 ``git diff``（工作目录里的真实改动）。
    #    因为 OpenLoomi 在 workDir 里已经直接改文件了，git diff 比 agent
    #    在对话里复述的 diff 更可靠。
    diff = wd_diff if wd_diff else diff_from_reply

    no_patch = classify_no_patch(reply) and not diff
    ok = bool(diff) and not no_patch
    return ok, reply, diff_from_reply, wd_diff


# ============================================================================
# §5 精简版 Semantic memory（FAISS + sentence-transformers）
# ============================================================================

class SemanticMemory:
    """轻量语义记忆；只存当前 sequence 的 task 经验，per-task 写、per-prompt 读。

    **Backend 选项**（由环境变量 ``OPENLOOMI_CL_EMBEDDING_BACKEND`` 选）：
      - ``jaccard`` (默认): char n-gram + Jaccard，零外部依赖
      - ``qwen``: OpenRouter 调 qwen/qwen3-embedding-8b (4096 维) + numpy 余弦
      - ``faiss``:  同 qwen，但用 faiss.IndexFlatIP 索引

    选 qwen/faiss 需要环境变量 ``OPENROUTER_API_KEY``。
    """

    def __init__(self, k_results: int = MEMORY_K_RESULTS,
                 max_chars: int = MEMORY_MAX_CONTEXT_CHARS):
        self.k = k_results
        self.max_chars = max_chars
        self.docs: list = []  # [{text, meta, vec}]
        self.embeddings = None  # np.ndarray shape (N, D), FAISS/numpy 都用
        self.index = None  # faiss IndexFlatIP if backend=faiss
        self._backend: str | None = None
        self._embed_dim: int | None = None
        self._embed_cache: dict[str, list[float]] = {}  # text -> vec, 避免重复调用

    def _ensure_deps(self):
        """按 env 选 backend；失败时降级到 jaccard。"""
        if self._backend is not None:
            return
        backend = os.getenv("OPENLOOMI_CL_EMBEDDING_BACKEND", "jaccard").lower().strip()
        if backend in ("qwen", "faiss"):
            if not os.getenv("OPENROUTER_API_KEY"):
                logger.warning("OPENROUTER_API_KEY 未设，memory 降级到 jaccard backend")
                self._backend = "jaccard"
            else:
                try:
                    if backend == "faiss":
                        import faiss  # noqa
                    import numpy  # noqa
                    self._backend = backend
                except ImportError as e:
                    logger.warning("faiss/numpy import failed (%s)，降级到 jaccard", e)
                    self._backend = "jaccard"
        else:
            self._backend = "jaccard"
        logger.info("SemanticMemory backend = %s", self._backend)

    def _embed_one(self, text: str) -> list[float]:
        """调 OpenRouter qwen embedding；带 cache 避免重复。"""
        if text in self._embed_cache:
            return self._embed_cache[text]
        # truncate 防止超 token 限
        snippet = text[:4000]
        key = os.environ["OPENROUTER_API_KEY"]
        body = json.dumps({
            "model": "qwen/qwen3-embedding-8b",
            "input": [snippet],
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/embeddings",
            data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.loads(r.read())
                vec = resp["data"][0]["embedding"]
        except Exception as e:
            logger.warning("OpenRouter embedding failed: %s；fallback to zero vector", e)
            # fallback：返回零向量，但 dim 必须已确定；用 4096 默认
            vec = [0.0] * (self._embed_dim or 4096)
        self._embed_cache[text] = vec
        if self._embed_dim is None:
            self._embed_dim = len(vec)
        return vec

    def _vector(self, text: str):
        """统一返回：(jaccard_set | dense_list) 取决于 backend。"""
        if self._backend == "jaccard":
            words = set(text.lower().split()[:200])
            grams3 = set([text[max(0, i):i+3].lower() for i in range(len(text)-2)])
            return words | grams3
        else:
            return self._embed_one(text)

    def _jaccard(self, a: set, b: set) -> float:
        if not a or not b: return 0.0
        return len(a & b) / len(a | b)

    def _cosine(self, a: list, b: list) -> float:
        import math
        if not a or not b: return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        if na == 0 or nb == 0: return 0.0
        return dot / (na * nb)

    def add(self, task: dict, sequence_id: str, diff: str, success: bool,
            extra: dict | None = None):
        self._ensure_deps()
        meta = {
            "instance_id": task["metadata"]["instance_id"],
            "sequence_id": sequence_id,
            "success": success,
        }
        if extra: meta.update(extra)
        text = (
            f"{'[SUCCESS]' if success else '[FAIL]'} {task['metadata']['instance_id']}\n"
            f"Problem: {task['task']['problem_statement'][:600]}\n"
            f"Diff: {(diff or '')[:1200]}"
        )
        vec = self._vector(text)
        self.docs.append({"text": text, "meta": meta, "vec": vec})
        # 重建 FAISS 索引（50 task 量级，O(N) 重建可接受）
        if self._backend == "faiss":
            self._rebuild_faiss_index()
        elif self._backend == "qwen":
            import numpy as np
            arrs = [np.asarray(d["vec"], dtype=np.float32) for d in self.docs]
            self.embeddings = np.vstack(arrs) if arrs else None

    def _rebuild_faiss_index(self):
        import faiss, numpy as np
        if not self.docs:
            self.index = None
            return
        arrs = [np.asarray(d["vec"], dtype=np.float32) for d in self.docs]
        mat = np.vstack(arrs)
        # 余弦相似 = inner product on L2-normalized vectors
        faiss.normalize_L2(mat)
        self.index = faiss.IndexFlatIP(mat.shape[1])
        self.index.add(mat)

    def relevant(self, query: str, sequence_id: str, k: int | None = None) -> str:
        if not self.docs: return ""
        k = k or self.k
        scored = []
        if self._backend == "jaccard":
            qv = self._vector(query)
            for d in self.docs:
                if d["meta"].get("sequence_id") != sequence_id: continue
                if d["meta"].get("instance_id") == query: continue
                s = self._jaccard(qv, d["vec"])
                scored.append((s, d))
        elif self._backend == "faiss":
            import numpy as np
            qv = np.asarray(self._vector(query), dtype=np.float32).reshape(1, -1)
            faiss.normalize_L2(qv)
            D, I = self.index.search(qv, min(k * 3, len(self.docs)))
            for score, idx in zip(D[0].tolist(), I[0].tolist()):
                if idx < 0: continue
                d = self.docs[idx]
                if d["meta"].get("sequence_id") != sequence_id: continue
                if d["meta"].get("instance_id") == query: continue
                scored.append((float(score), d))
        else:  # qwen
            qv = self._vector(query)
            for d in self.docs:
                if d["meta"].get("sequence_id") != sequence_id: continue
                if d["meta"].get("instance_id") == query: continue
                s = self._cosine(qv, d["vec"])
                scored.append((s, d))

        scored.sort(key=lambda x: -x[0])
        out, used = [], 0
        for s, d in scored[:k]:
            t = d["text"]
            if used + len(t) > self.max_chars:
                t = t[: max(0, self.max_chars - used)]
            out.append(t)
            used += len(t)
            if used >= self.max_chars: break
        return "\n---\n".join(out)

    def clear(self):
        self.docs = []
        self.embeddings = None
        self.index = None


# ============================================================================
# §7 Evaluation —— apply_patch + run pytest + check FAIL/PASS
# ============================================================================

def apply_patch(patch_content: str, repo_path: Path) -> bool:
    if not patch_content.strip():
        return False
    try:
        pset = patch_parser.fromstring(patch_content.encode())
        if pset and pset.apply(root=str(repo_path)):
            return True
    except Exception:
        pass
    tmp = repo_path / ".openloomi_eval.patch"
    try:
        # 用 write_bytes 保留原始字节（避免 Windows write_text 把 LF → CRLF，
        # 这会破坏长 patch 的 hunk 行号偏移并触发 git apply "corrupt patch"）
        tmp.write_bytes(patch_content.encode("utf-8"))
        check = subprocess.run(["git", "apply", "--check", str(tmp)],
                               cwd=repo_path, capture_output=True, text=True, timeout=60)
        if check.returncode != 0:
            logger.warning("git apply --check failed: %s", check.stderr or check.stdout)
            return False
        apply = subprocess.run(["git", "apply", str(tmp)], cwd=repo_path,
                               capture_output=True, text=True, timeout=60)
        return apply.returncode == 0
    finally:
        if tmp.exists():
            try: tmp.unlink()
            except OSError: pass


def run_pytest(repo_path: Path, command: str = DEFAULT_TEST_COMMAND):
    # 如果 EVAL_PYTHON 已配置，把命令开头的 "python" 替换成 venv38 python。
    # 注意：必须用 list args + shell=False，否则 PowerShell 会把 ``python.exe``
    # 当 cmdlet、``"..."`` args 当 ScriptBlock，导致跑不起来。
    eval_py = EVAL_PYTHON
    args = shlex.split(command) if command else []
    if eval_py and args and args[0] == "python":
        args[0] = eval_py
    try:
        p = subprocess.run(args, shell=False, cwd=str(repo_path),
                           capture_output=True, text=True, timeout=900)
        return p.returncode == 0, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return False, "", "test timeout"
    except Exception as e:
        return False, "", f"pytest error: {e}"


# ----------------------------------------------------------------------------
# Repo-aware test command detection
# ----------------------------------------------------------------------------

def detect_test_command(repo_path: Path) -> str:
    """根据仓库类型挑最合适的测试命令。

    - Django: 用 ``tests/runtests.py <module>``（在 eval 中调 ``evaluate_task`` 时
      会再窄到 FAIL_TO_PASS 模块）。完整 ``runtests.py`` 太快。
    - 其它: 默认 ``python -m pytest -q``。
    - 备选: dot env ``OPENLOOMI_CL_TEST_COMMAND`` 覆盖。
    """
    # 用户覆盖
    env_cmd = os.getenv("OPENLOOMI_CL_TEST_COMMAND")
    if env_cmd:
        return env_cmd

    # 各种探测
    if (repo_path / "tests" / "runtests.py").exists() and "django" in repo_path.name.lower():
        # Django: 没指定模块就跑全部；evaluate_task 会解析 FAIL_TO_PASS 拿到模块
        return "python tests/runtests.py --verbosity=2"

    if (repo_path / "pytest.ini").exists() or (repo_path / "pyproject.toml").exists():
        return "python -m pytest -x --tb=short -q"

    return "python -m unittest discover -s tests"


def check_test_outcomes(stdout: str, stderr: str,
                         fail_to_pass: list[str],
                         pass_to_pass: list[str]) -> bool:
    """看 FAIL_TO_PASS 是否真的变成 PASS，以及 PASS_TO_PASS 没回归。

    支持多种 runner 的输出格式：
        - pytest:  `... PASSED` /  `... FAILED`
        - django:  `test_xxx (...) ... ok` /  `... FAIL` /  `... ERROR`
        - unittest: `ok` / `FAIL`
    解析策略：先从 ``test_id`` 抽方法名（兼容 ``test_xxx (ClassOrFile)`` /
    ``test_xxx (file.Class.method)`` / ``file::Class::method`` 三种格式），
    再用正则在该行里抽 pass/fail 标记。
    """
    out_lines = (stdout + "\n" + stderr).splitlines()

    def method_name(test_id: str) -> str:
        """从各式 test_id 抽方法名（test_xxx 之类）。"""
        # pytest id: `tests/foo.py::Class::test_xxx`
        if "::" in test_id:
            return test_id.split("::")[-1].split()[0]
        # django / unittest 风格: `test_xxx (some.Class)`
        if "(" in test_id:
            return test_id.split("(")[0].strip()
        # 兜底：python dotted
        return test_id.split(".")[-1]

    def status_of(test_id: str) -> str:
        name = method_name(test_id)
        # 在行里 grep 这个方法名 + 三种 output pattern
        for line in out_lines:
            if not line: continue
            if name not in line: continue
            # 提取 " ... ok" / " ... FAIL" / " ... ERROR" 这种尾部
            tail_pass = re.search(r"\.\.\.\s*ok\s*(?:\(.+\))?\s*$", line)
            tail_fail = re.search(r"\.\.\.\s*(FAIL|ERROR)\b", line)
            pytest_v = re.search(rf"::\s*{re.escape(name)}\s+(PASSED|FAILED|ERROR|SKIPPED)\b", line)
            if pytest_v:
                return "PASSED" if pytest_v.group(1) == "PASSED" else "FAILED"
            if tail_fail:
                return "FAILED"
            if tail_pass:
                return "PASSED"
        return "UNKNOWN"

    for t in fail_to_pass:
        if status_of(t) != "PASSED":
            logger.warning("FAIL_TO_PASS not passed: %s (status=%s)", t, status_of(t))
            return False
    for t in pass_to_pass:
        if status_of(t) == "FAILED":
            logger.warning("PASS_TO_PASS regressed: %s", t)
            return False
    return True


def evaluate_task(task: dict, repo_path: Path,
                  command: str = DEFAULT_TEST_COMMAND) -> bool:
    """Apply the task's test_patch, run the test command, check FAIL_TO_PASS/PASS_TO_PASS.

    对 django 这种大仓库：用 ``tests/runtests.py <module>`` 跑特定模块（从
    FAIL_TO_PASS 列表抽）。其它：用 pytest 全跑，但 FAIL_TO_PASS 是子集。

    关键：command 默认是 ``DEFAULT_TEST_COMMAND``，但如果你给空字符串，
    会让本函数内部用 ``detect_test_command()`` 探测 repo 类型。
    """
    ev = task["evaluation"]
    test_patch = ev.get("test_patch")
    if test_patch and not apply_patch(test_patch, repo_path):
        logger.warning("test_patch failed to apply; using whatever the repo already has.")

    # 如果 caller 给了 default 但 repo 是 django，replace 成 django 测试
    if not command or command == DEFAULT_TEST_COMMAND:
        command = detect_test_command(repo_path)
        logger.info("auto-selected test command: %s", command)

    # django 用 FAIL_TO_PASS 中的模块名做定向跑（第一个 FAIL_TO_PASS 拿 module）
    fail_to_pass = ev.get("FAIL_TO_PASS", [])
    if "django" in repo_path.name.lower() and (repo_path / "tests" / "runtests.py").exists():
        mods = _extract_django_modules(fail_to_pass)
        if mods:
            command = f"python tests/runtests.py --verbosity=2 {' '.join(mods)}"

    ok, stdout, stderr = run_pytest(repo_path, command)
    # 兜底：某些 runner rc != 0 但 stdout 里有 "OK"，依然认为通过
    if "OK" in (stdout + stderr) and "FAILED" not in (stderr):
        ok = True
    final = check_test_outcomes(stdout, stderr, fail_to_pass,
                                  ev.get("PASS_TO_PASS", []))
    logger.info("task evaluation: test_rc=%s, FAIL_TO_PASS/PASS_TO_PASS check=%s",
                ok, final)
    return final


def _extract_django_modules(fail_to_pass: list[str]) -> list[str]:
    """从 FAIL_TO_PASS 列表抽 django app 名。e.g.
        'test_paginator_iteration (pagination.tests.PaginationTests)'
        → 'pagination'
    """
    mods = []
    for t in fail_to_pass:
        m = re.search(r"\(([\w.]+)\.tests", t)
        if m:
            mod = m.group(1)
            if mod not in mods:
                mods.append(mod)
    return mods


# ============================================================================
# §8 Evaluator —— 与官方 v3 主循环同构
# ============================================================================

class SWEAgentCLEvaluator:
    def __init__(self, dataset: dict, cfg: OpenLoomiConfig):
        self.dataset = dataset
        self.cfg = cfg
        self.results: dict[str, Any] = {}

    def run_one(self, sequence_ids: Optional[list[str]] = None,
                task_limit: Optional[int] = None,
                memory_enabled: bool = True,
                run_id: Optional[str] = None) -> dict:
        sequence_ids = sequence_ids or [s["id"] for s in self.dataset["sequences"]]
        run_id = run_id or f"{int(time.time())}-mem{int(memory_enabled)}"

        memory = SemanticMemory() if memory_enabled else None
        if memory:
            logger.info("Memory: ENABLED, embedding=%s", EMBEDDING_MODEL)
        else:
            logger.info("Memory: DISABLED (baseline run)")

        per_seq_results: dict[str, Any] = {}

        # checkpoint dir
        ckpt_root = Path("./logs/checkpoints") / run_id
        ckpt_root.mkdir(parents=True, exist_ok=True)

        for seq_idx, seq_id in enumerate(sequence_ids):
            seq = next((s for s in self.dataset["sequences"] if s["id"] == seq_id), None)
            if not seq:
                continue
            logger.info("=" * 70)
            logger.info("Sequence %d/%d: %s  (%d tasks, memory=%s)",
                        seq_idx + 1, len(sequence_ids), seq_id, seq["num_tasks"], memory_enabled)
            logger.info("=" * 70)

            sr = {
                "tasks_total": seq["num_tasks"],
                "tasks_attempted": 0,
                "tasks_succeeded": 0,
                "task_details": {},
            }
            tasks_sorted = sorted(seq["tasks"],
                                  key=lambda t: t["continual_learning"]["sequence_position"])
            if task_limit:
                tasks_sorted = tasks_sorted[:task_limit]

            for task_idx, task in enumerate(tqdm(tasks_sorted, desc=f"{seq_id}")):
                tid = task["metadata"]["instance_id"]
                repo_id = task["metadata"]["repo"]
                base_commit = task["metadata"]["base_commit"]
                t0 = time.time()

                # checkpoint: 跳过已完成
                ckpt_path = ckpt_root / f"{tid}.json"
                if ckpt_path.exists():
                    try:
                        cached = json.loads(ckpt_path.read_text(encoding="utf-8"))
                        logger.info("%s cached: success=%s (skip)",
                                    f"[{tid}]", cached.get("success"))
                        d = cached["task_details"] = {**cached.get("task_details", {})}
                        # 把缓存的 details 整段塞到当前任务的 details，并 short-circuit
                        if cached.get("success") is not None:
                            sr["tasks_attempted"] += int(cached.get("attempted", 1))
                            sr["tasks_succeeded"] += int(cached.get("success", 0))
                            sr["task_details"][tid] = cached.get("task_details", {})
                            continue
                    except Exception as e:  # noqa: BLE001
                        logger.warning("bad checkpoint %s: %s — re-run", ckpt_path, e)

                # === ① 干净仓库 + 切到 base_commit ===
                try:
                    repo_path = setup_repository(repo_id, base_commit, CLONE_BASE_DIR)
                except Exception as e:  # noqa: BLE001
                    logger.error("setup_repository failed: %s", e)
                    sr["task_details"][tid] = {"success": False, "error": f"setup: {e}"}
                    continue

                # === ② memory excerpt（同一 sequence 内复用） ===
                excerpt = ""
                if memory:
                    excerpt = memory.relevant(
                        query=tid,  # 用 tid 作 query 让 sequence 内同 repo 的命中优先
                        sequence_id=seq_id,
                    )

                # === ③ 调 OpenLoomi 整条 task（带 retry） ===
                # OpenLoomi agent 偶发 "AgentOutputEventBusError" 等内部 abort；
                # 默认重试 2 次，每次间隔 3s
                ok_diff = False
                reply = ""
                diff_from_reply = ""
                wd_diff = ""
                last_err: Optional[Exception] = None
                for attempt in range(3):
                    try:
                        ok_diff, reply, diff_from_reply, wd_diff = run_agent_on_task(
                            task=task, sequence_id=seq_id, repo_path=repo_path,
                            memory_excerpt=excerpt or None,
                            cfg=self.cfg, run_id=run_id, task_idx=task_idx,
                        )
                        # "OK" 但 reply 几乎为空且没 diff，往往意味着 OpenLoomi 内部 abort
                        if len(reply) < 50 and not wd_diff and not diff_from_reply:
                            raise RuntimeError(
                                f"agent returned empty reply ({len(reply)} chars), "
                                "likely internal abort"
                            )
                        break
                    except Exception as e:  # noqa: BLE001
                        last_err = e
                        logger.warning("OpenLoomi call attempt %d/3 failed: %s",
                                       attempt + 1, e)
                        time.sleep(3 + attempt * 2)  # 3, 5, 7s
                else:
                    logger.error("OpenLoomi call failed after 3 attempts: %s", last_err)
                    sr["task_details"][tid] = {
                        "success": False, "error": f"agent: {last_err}",
                    }
                    continue

                # 综合最终 diff 用于日志
                diff = wd_diff if wd_diff else diff_from_reply

                # === ④ apply diff（仅在 agent 没直接改文件时才需要） + 跑测试 ===
                if diff_from_reply and not wd_diff:
                    # 尝试 apply agent 给的 patch
                    patch_applied = bool(diff) and apply_patch(diff, repo_path)
                    logger.info("%s only patch (apply required): patch_applied=%s (diff_len=%d)",
                                f"[{tid}]", patch_applied, len(diff or ""))
                else:
                    # agent 直接改了文件，diff 是 git diff 实时产物
                    patch_applied = True
                    logger.info("%s working_tree_diff=%d chars; running tests directly",
                                f"[{tid}]", len(diff or ""))

                # 真实跑测试，拿 FAIL_TO_PASS / PASS_TO_PASS 结果
                # （OpenLoomi 是否已经修过文件不重要，harness 只看当下 repo 状态）
                try:
                    success = evaluate_task(task, repo_path)
                except Exception as e:
                    logger.error("evaluate_task raised: %s", e)
                    success = False

                if not diff:
                    logger.info("%s no diff returned by agent", f"[{tid}]")
                if not success and not patch_applied:
                    logger.info("%s task NOT resolved (diff apply failed and tests fail)",
                                f"[{tid}]")

                # === ⑤ 记录 + 写 memory ===
                sr["tasks_attempted"] += 1
                if success: sr["tasks_succeeded"] += 1
                # reply 完整保存（之前只存 tail，会让 diff 抽取失败）
                sr["task_details"][tid] = {
                    "success": success,
                    "patch_len": len(diff or ""),
                    "patch_applied": patch_applied,
                    "reply_chars": len(reply),
                    "elapsed_sec": round(time.time() - t0, 1),
                    "reply_full": reply[:8000] if reply else "",  # 截前 8k 字符足够解析 diff
                }
                # checkpoint: 立刻持久化
                try:
                    ckpt_path.write_text(
                        json.dumps({
                            "instance_id": tid,
                            "success": success,
                            "attempted": 1,
                            "task_details": sr["task_details"][tid],
                        }, ensure_ascii=False),
                        encoding="utf-8",
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("failed to write ckpt: %s", e)
                if memory:
                    memory.add(task, seq_id, diff, success=success,
                              extra={"position": task_idx})

                # === 每 5 个 task dump 一次 partial result（防止进程被杀丢数据） ===
                done = sr["tasks_attempted"]
                if done > 0 and done % 5 == 0:
                    try:
                        partial = {
                            "run_id": run_id,
                            "openloomi_provider": self.cfg.provider,
                            "memory_enabled": memory_enabled,
                            "embedding_backend": os.getenv("OPENLOOMI_CL_EMBEDDING_BACKEND", "jaccard"),
                            "sequence_id": seq_id,
                            "tasks_total": sr["tasks_total"],
                            "tasks_attempted": sr["tasks_attempted"],
                            "tasks_succeeded": sr["tasks_succeeded"],
                            "success_rate": sr["tasks_succeeded"] / max(1, sr["tasks_attempted"]),
                            "last_task_idx": task_idx,
                            "task_details": sr["task_details"],
                        }
                        partial_path = Path("./logs") / f"swe_agent_cl_partial_{run_id}.json"
                        partial_path.write_text(
                            json.dumps(partial, ensure_ascii=False, default=str),
                            encoding="utf-8",
                        )
                        logger.info("[partial] dumped %s (attempted=%d, succeeded=%d)",
                                    partial_path.name, sr["tasks_attempted"], sr["tasks_succeeded"])
                    except Exception as e:  # noqa: BLE001
                        logger.warning("failed to dump partial: %s", e)

            sr["summary"] = {
                "success_rate": sr["tasks_succeeded"] / max(1, sr["tasks_attempted"]),
            }
            per_seq_results[seq_id] = sr
            logger.info("Sequence %s done. success=%d/%d = %.1f%%",
                        seq_id, sr["tasks_succeeded"], sr["tasks_attempted"],
                        sr["summary"]["success_rate"] * 100)

        total_succ = sum(s["tasks_succeeded"] for s in per_seq_results.values())
        total_att = sum(s["tasks_attempted"] for s in per_seq_results.values())
        out = {
            "run_id": run_id,
            "openloomi_provider": self.cfg.provider,
            "memory_enabled": memory_enabled,
            "sequences": per_seq_results,
            "overall": {
                "success_rate": total_succ / max(1, total_att),
                "tasks_attempted": total_att,
                "tasks_succeeded": total_succ,
            },
        }
        self.results[run_id] = out
        return out


# ============================================================================
# §9 Results Analysis（与官方 v3 简化版一致）
# ============================================================================

def analyze_results(results: dict) -> dict:
    summary_rows: list[dict] = []
    for run_id, r in results.items():
        for seq_id, sr in r["sequences"].items():
            summary_rows.append({
                "run_id": run_id,
                "memory": r["memory_enabled"],
                "provider": r.get("openloomi_provider"),
                "sequence_id": seq_id,
                "success_rate": sr["summary"]["success_rate"],
                "tasks_attempted": sr["tasks_attempted"],
                "tasks_succeeded": sr["tasks_succeeded"],
            })
    if not summary_rows:
        return {"summary": "empty"}
    return {"summary": summary_rows}


# ============================================================================
# Main
# ============================================================================

def main():
    cfg = OpenLoomiConfig()
    validate_openloomi_endpoint(cfg)   # fail-fast
    dataset = load_swe_bench_cl()
    evaluator = SWEAgentCLEvaluator(dataset, cfg)

    seq_ids = CFG_SEQUENCE_IDS or [s["id"] for s in dataset["sequences"]]

    all_results: dict[str, Any] = {}
    # 与官方 v3 §8 Experiments 一样跑两个对比组：memory_on 与 memory_off。
    # 两个互不污染：每次都新建 SemanticMemory（或不建）。
    # 顺序上先跑 no_mem（baseline）再跑 mem，避免上一轮状态泄漏。
    # 支持 env ``OPENLOOMI_CL_RUN_KINDS``（逗号分隔，可选 no_mem / mem）。
    kinds_env = os.getenv("OPENLOOMI_CL_RUN_KINDS", "no_mem,mem").lower()
    wanted = set(k.strip() for k in kinds_env.split(",") if k.strip())
    runs = []
    if "no_mem" in wanted: runs.append(("no_mem", False))
    if "mem"    in wanted: runs.append(("mem", True))
    if not runs:
        runs = [("no_mem", False), ("mem", True)]
    for label, mem in runs:
        run_id = f"{int(time.time())}-{label}"
        logger.info("=== Launching run: %s (memory=%s) ===", run_id, mem)
        all_results[run_id] = evaluator.run_one(
            sequence_ids=seq_ids,
            task_limit=SEQUENCE_TASK_LIMIT,
            memory_enabled=mem,
            run_id=run_id,
        )

    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(all_results, f, indent=2, default=str)
    logger.info("Saved %s", RESULTS_PATH)

    with open(ANALYSIS_PATH, "w", encoding="utf-8") as f:
        json.dump(analyze_results(all_results), f, indent=2, default=str)
    logger.info("Saved %s", ANALYSIS_PATH)


if __name__ == "__main__":
    main()
