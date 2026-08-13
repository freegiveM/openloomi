"""
eval_procedure.py
=================

**Relationship to the official eval_v3_swe-agent**:

| Official v3 §          | This directory's implementation |
|------------------------|---|
| §1 Setup               | top of file + config.py |
| §2 Load dataset        | `load_swe_bench_cl()` |
| §2.5 setup_repository  | `setup_repository()` (git clone + reset + clean, identical to official) |
| §3 Model               | ★ **Replaced** — OpenLoomi handles this end-to-end; `get_llm()` is gone |
| §4 Tools (hand-rolled ACI) | ★ **Removed** — OpenLoomi ships Bash/Read/Edit/Grep/Glob |
| §5 Semantic memory     | Slimmed-down `SemanticMemory` (FAISS + sentence-transformers) |
| §6 LangGraph 5-node    | ★ **Removed** — flattened to a single for-loop; one /api/native/agent call per task |
| §7 Evaluation          | `apply_patch` + `run_evaluation_tests` + `check_test_outcomes` |
| §8 Experiments         | `SWEAgentCLEvaluator` + memory × no-memory two-group |
| §9 Results Analysis    | `analyze_results()` |

Call granularity (differs from official v3):
    - v3: each task calls 5 LLMs (planner/executor/reflector/solver/tool)
    - This directory: each task calls /api/native/agent once —
      letting OpenLoomi internally do plan → execute → reflect → emit the final diff

Workflow:
    for task in sequence:
        repo_dir = setup_repository(repo, base_commit)
        prompt  = build_task_prompt(task, repo_dir, memory=memory_excerpt)
        reply   = openloomi_call(prompt, workDir=repo_dir)  # OpenLoomi drives its own toolchain
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


# Auto-load sensitive env vars from .env (when caller did not set them).
# Precedence: process env > user-scope registry > .env
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
# §2.5 setup_repository (identical to official v3)
# ============================================================================

def setup_repository(repo_identifier: str,
                     commit_hash: str,
                     base_clones_dir: Path,
                     force_reset: bool = True,
                     dummy_files_setup=None) -> Path:
    """git clone + reset --hard to base_commit.
    Returns absolute path to the (now on base_commit) repo dir.

    Slightly different from official v3:
      We do **NOT** run ``git clean -fdx``. OpenLoomi's agent directly edits
      files in the working directory (rather than emitting a diff for the
      harness to apply), so modifications left by the previous task must be
      preserved for evaluation; boundaries are controlled with ``git stash``
      and patch apply. Upstream v3 hand-writes 5 LangGraph nodes and runs
      ripgrep/find_file itself, never leaving the working tree; we let
      OpenLoomi's edits land on disk naturally.
    """
    # --- local/* (dummy dataset path) ---
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
        # Retry git fetch on transient network failures (e.g. "Recv failure:
        # Connection was reset" when an upstream ISP sends a TCP RST). We use
        # exponential backoff so the loop self-heals without manual intervention.
        fetch_attempts = 4   # 1 original + 3 retries
        fetch_ok = False
        last_fetch_err: Optional[Exception] = None
        for fa in range(fetch_attempts):
            try:
                subprocess.run(
                    ["git", "fetch"], cwd=local, check=True, timeout=300, capture_output=True,
                )
                fetch_ok = True
                break
            except subprocess.CalledProcessError as e:
                last_fetch_err = e
                stderr_snip = (e.stderr.decode(errors="ignore") if e.stderr else "")[-300:]
                # Only retry on network-layer failures; other errors (missing
                # commit, auth failure, etc.) are re-raised immediately.
                transient = any(s in stderr_snip for s in (
                    "Recv failure", "Connection was reset",
                    "Could not resolve host", "RPC failed",
                    "fatal: unable to access", "Connection timed out",
                ))
                if not transient:
                    raise
                wait = 5 * (2 ** fa)  # 5, 10, 20, 40s
                logger.warning("git fetch transient failure (attempt %d/%d): %s; retry in %ds",
                               fa + 1, fetch_attempts, stderr_snip.strip(), wait)
                time.sleep(wait)
        if not fetch_ok:
            raise last_fetch_err  # type: ignore[misc]
        # Key difference: use ``git reset --hard`` rather than ``git clean -fdx``.
        # OpenLoomi agent's working-tree edits are influenced by the previous task,
        # so before each task we need to roll back to base_commit and let the agent
        # redo its edits.
        subprocess.run(["git", "reset", "--hard", commit_hash],
                       cwd=local, check=True, timeout=120, capture_output=True)
        # Only run an extra clean when force_reset=True. Leaving force_reset on
        # by default has side effects: when the user passes ``force_reset=False``,
        # the agent's working files linger in the working tree; we do not enable
        # it here.
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
    """Run one full round of OpenLoomi.

    Returns:
        (success_bool, agent_reply_text, diff_from_reply, wd_diff)
        diff_from_reply: patch extracted from the agent's output (may include ```diff``` blocks)
        wd_diff: ``git diff`` output from the working directory (non-empty when
                 the agent edits files directly)
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

    # 1) First try to extract the unified diff from the agent's reply
    diff_from_reply = extract_patch(reply) or ""

    # 2) Fallback: use ``git diff`` to capture what the agent actually changed in
    #    the working directory (when the agent edits files directly instead of
    #    emitting a patch, this gets us the "truth").
    try:
        wd_diff = subprocess.run(
            ["git", "diff"],
            cwd=str(repo_path), capture_output=True, text=True, timeout=60,
        ).stdout
    except Exception:
        wd_diff = ""

    # 3) Prefer ``git diff`` (the real working-tree changes) because OpenLoomi has
    #    already modified files in workDir; git diff is more reliable than the
    #    diff the agent paraphrases back in the conversation.
    diff = wd_diff if wd_diff else diff_from_reply

    no_patch = classify_no_patch(reply) and not diff
    ok = bool(diff) and not no_patch
    return ok, reply, diff_from_reply, wd_diff


# ============================================================================
# §5 Slimmed-down Semantic memory (FAISS + sentence-transformers)
# ============================================================================

class SemanticMemory:
    """Lightweight semantic memory; stores per-sequence task experience only,
    written per task, read per prompt.

    **Backend options** (selected via ``OPENLOOMI_CL_EMBEDDING_BACKEND``):
      - ``jaccard`` (default): char n-gram + Jaccard, no external dependencies
      - ``qwen``: OpenRouter call to qwen/qwen3-embedding-8b (4096-dim) + numpy cosine
      - ``faiss``: same as qwen but indexed with faiss.IndexFlatIP

    Selecting qwen/faiss requires the ``OPENROUTER_API_KEY`` environment variable.
    """

    def __init__(self, k_results: int = MEMORY_K_RESULTS,
                 max_chars: int = MEMORY_MAX_CONTEXT_CHARS):
        self.k = k_results
        self.max_chars = max_chars
        self.docs: list = []  # [{text, meta, vec}]
        self.embeddings = None  # np.ndarray shape (N, D), shared by FAISS / numpy
        self.index = None  # faiss IndexFlatIP if backend=faiss
        self._backend: str | None = None
        self._embed_dim: int | None = None
        self._embed_cache: dict[str, list[float]] = {}  # text -> vec, avoids repeated calls

    def _ensure_deps(self):
        """Pick the backend from env; fall back to jaccard on failure."""
        if self._backend is not None:
            return
        backend = os.getenv("OPENLOOMI_CL_EMBEDDING_BACKEND", "jaccard").lower().strip()
        if backend in ("qwen", "faiss"):
            if not os.getenv("OPENROUTER_API_KEY"):
                logger.warning("OPENROUTER_API_KEY not set; memory falls back to the jaccard backend")
                self._backend = "jaccard"
            else:
                try:
                    if backend == "faiss":
                        import faiss  # noqa
                    import numpy  # noqa
                    self._backend = backend
                except ImportError as e:
                    logger.warning("faiss/numpy import failed (%s); falling back to jaccard", e)
                    self._backend = "jaccard"
        else:
            self._backend = "jaccard"
        logger.info("SemanticMemory backend = %s", self._backend)

    def _embed_one(self, text: str) -> list[float]:
        """Call the OpenRouter qwen embedding endpoint; cached to avoid repeats."""
        if text in self._embed_cache:
            return self._embed_cache[text]
        # truncate to stay under the token limit
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
            logger.warning("OpenRouter embedding failed: %s; falling back to zero vector", e)
            # Fallback: return a zero vector, but the dimension must be known; use 4096 by default
            vec = [0.0] * (self._embed_dim or 4096)
        self._embed_cache[text] = vec
        if self._embed_dim is None:
            self._embed_dim = len(vec)
        return vec

    def _vector(self, text: str):
        """Uniformly returns (jaccard_set | dense_list) depending on the backend."""
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
        # Rebuild the FAISS index (at ~50 tasks, an O(N) rebuild is acceptable)
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
        # Cosine similarity = inner product on L2-normalized vectors
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
        # Use write_bytes to preserve raw bytes (Windows write_text would convert
        # LF → CRLF, which breaks long-patch hunk line offsets and triggers
        # git apply "corrupt patch").
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
    # If EVAL_PYTHON is configured, replace "python" at the start of the command
    # with the venv38 interpreter. Note: must use list args + shell=False, otherwise
    # PowerShell treats ``python.exe`` as a cmdlet and ``"..."`` args as ScriptBlocks,
    # which causes the command to fail.
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
    """Pick the most appropriate test command for the repo type.

    - Django: use ``tests/runtests.py <module>`` (when called via ``evaluate_task``,
      this is narrowed further to the FAIL_TO_PASS module). The full
      ``runtests.py`` is too fast.
    - Other: default ``python -m pytest -q``.
    - Override: dot env ``OPENLOOMI_CL_TEST_COMMAND``.
    """
    # User override
    env_cmd = os.getenv("OPENLOOMI_CL_TEST_COMMAND")
    if env_cmd:
        return env_cmd

    # Various probes
    if (repo_path / "tests" / "runtests.py").exists() and "django" in repo_path.name.lower():
        # Django: when no module is specified, run everything; evaluate_task parses
        # FAIL_TO_PASS to extract the module.
        return "python tests/runtests.py --verbosity=2"

    if (repo_path / "pytest.ini").exists() or (repo_path / "pyproject.toml").exists():
        return "python -m pytest -x --tb=short -q"

    return "python -m unittest discover -s tests"


def check_test_outcomes(stdout: str, stderr: str,
                         fail_to_pass: list[str],
                         pass_to_pass: list[str]) -> bool:
    """Verify that FAIL_TO_PASS has actually turned into PASS and that PASS_TO_PASS
    has not regressed.

    Supports output formats from multiple runners:
        - pytest:  `... PASSED` /  `... FAILED`
        - django:  `test_xxx (...) ... ok` /  `... FAIL` /  `... ERROR`
        - unittest: `ok` / `FAIL`
    Parsing strategy: first extract the method name from ``test_id`` (compatible
    with ``test_xxx (ClassOrFile)`` / ``test_xxx (file.Class.method)`` /
    ``file::Class::method`` formats), then use a regex to pull the pass/fail tag
    out of that line.
    """
    out_lines = (stdout + "\n" + stderr).splitlines()

    def method_name(test_id: str) -> str:
        """Extract the method name (e.g. test_xxx) from any test_id format."""
        # pytest id: `tests/foo.py::Class::test_xxx`
        if "::" in test_id:
            return test_id.split("::")[-1].split()[0]
        # django / unittest style: `test_xxx (some.Class)`
        if "(" in test_id:
            return test_id.split("(")[0].strip()
        # Fallback: python dotted path
        return test_id.split(".")[-1]

    def status_of(test_id: str) -> str:
        name = method_name(test_id)
        # Grep the line for this method name + three output patterns
        for line in out_lines:
            if not line: continue
            if name not in line: continue
            # Extract trailing tags like " ... ok" / " ... FAIL" / " ... ERROR"
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
            return _qmode_fallback_or_false(stdout, stderr, fail_to_pass, pass_to_pass)
    for t in pass_to_pass:
        if status_of(t) == "FAILED":
            logger.warning("PASS_TO_PASS regressed: %s", t)
            return False
    return True


def _qmode_fallback_or_false(stdout: str, stderr: str,
                              fail_to_pass: list[str],
                              pass_to_pass: list[str]) -> bool:
    """Fallback: pytest 4.x with ``-q`` only prints ``. [100%]`` without the
    ``PASSED`` label, so the ``status_of`` above always returns ``UNKNOWN``.
    In that case, infer from pytest's own summary line:

        "1 passed, 2445 deselected in 7.85 seconds"

    As long as ``N passed`` and N >= len(set of selected FAIL_TO_PASS ∪ PASS_TO_PASS)
    and there is no ``failed``/``error`` word in stderr/stdout, treat the suite
    as passing.
    """
    text = (stdout + "\n" + stderr).lower()
    if "passed" not in text and "passed" not in stdout.lower():
        return False
    # Must not see any fail/error signal
    bad = re.search(r"\b(\d+)\s+(failed|error)\b", text)
    if bad:
        return False
    # Extract "N passed" — note pytest 4.x may say "1 passed, X deselected"
    m = re.search(r"(\d+)\s+passed\b", stdout)
    if not m:
        # Fallback: look once more in the combined text
        m = re.search(r"(\d+)\s+passed\b", text)
    if not m:
        return False
    n_passed = int(m.group(1))
    # len(unique test names in selected list): we approximate with FAIL_TO_PASS
    # count because ``-k`` substitution only targets FAIL_TO_PASS keys
    needed = len(set(fail_to_pass))
    if n_passed >= needed:
        logger.info("q-mode fallback: pytest reports %d passed >= %d FAIL_TO_PASS -> "
                    "treat as PASS", n_passed, needed)
        return True
    return False


def evaluate_task(task: dict, repo_path: Path,
                  command: str = DEFAULT_TEST_COMMAND) -> bool:
    """Apply the task's test_patch, run the test command, check FAIL_TO_PASS/PASS_TO_PASS.

    For large repos like django: use ``tests/runtests.py <module>`` to run a
    specific module (extracted from the FAIL_TO_PASS list). For others: run
    pytest over everything, with FAIL_TO_PASS as the subset of interest.

    Key: ``command`` defaults to ``DEFAULT_TEST_COMMAND``, but if you pass an
    empty string, the function will internally call ``detect_test_command()``
    to probe the repo type.
    """
    ev = task["evaluation"]
    test_patch = ev.get("test_patch")
    if test_patch and not apply_patch(test_patch, repo_path):
        logger.warning("test_patch failed to apply; using whatever the repo already has.")

    # If the caller passed the default but the repo is django, switch to django tests
    if not command or command == DEFAULT_TEST_COMMAND:
        command = detect_test_command(repo_path)
        logger.info("auto-selected test command: %s", command)

    # Django: target a specific module by name from FAIL_TO_PASS
    # (the first FAIL_TO_PASS gives the module)
    fail_to_pass = ev.get("FAIL_TO_PASS", [])
    if "django" in repo_path.name.lower() and (repo_path / "tests" / "runtests.py").exists():
        mods = _extract_django_modules(fail_to_pass)
        if mods:
            command = f"python tests/runtests.py --verbosity=2 {' '.join(mods)}"
    # pytest: likewise, use FAIL_TO_PASS test ids directly as -k selectors (and
    # drop -x, otherwise the first failure stops the run and FAIL_TO_PASS all
    # become UNKNOWN). Use only FAIL_TO_PASS keywords (PASS_TO_PASS may contain
    # markers like [100%], and adding them all to -k over-collects unrelated tests).
    elif "pytest" in command:
        keys = []
        for t in fail_to_pass:
            n = t.split("::")[-1].split("(")[0].split("[")[0].strip()
            if n and n not in keys:
                keys.append(n)
        if keys:
            k_arg = " or ".join(keys)
            command = f"python -m pytest --tb=short -q -k \"{k_arg}\""

    ok, stdout, stderr = run_pytest(repo_path, command)
    # Fallback: some runners have rc != 0 but print "OK" in stdout; still treat as pass
    if "OK" in (stdout + stderr) and "FAILED" not in (stderr):
        ok = True
    final = check_test_outcomes(stdout, stderr, fail_to_pass,
                                  ev.get("PASS_TO_PASS", []))
    logger.info("task evaluation: test_rc=%s, FAIL_TO_PASS/PASS_TO_PASS check=%s",
                ok, final)
    return final


def _extract_django_modules(fail_to_pass: list[str]) -> list[str]:
    """Extract the django app name from the FAIL_TO_PASS list. e.g.
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
# §8 Evaluator — isomorphic to the official v3 main loop
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
        mem_label = "mem" if memory_enabled else "no_mem"

        for seq_idx, seq_id in enumerate(sequence_ids):
            seq = next((s for s in self.dataset["sequences"] if s["id"] == seq_id), None)
            if not seq:
                continue

            # checkpoint dir: split by sequence + mem/no_mem
            # layout: logs/<sequence_id>/<mem|no_mem>/<run_id>/<tid>.json
            ckpt_root = Path("./logs") / seq_id / mem_label / run_id
            ckpt_root.mkdir(parents=True, exist_ok=True)
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

                # checkpoint: skip already-completed tasks
                ckpt_path = ckpt_root / f"{tid}.json"
                if ckpt_path.exists():
                    try:
                        cached = json.loads(ckpt_path.read_text(encoding="utf-8"))
                        logger.info("%s cached: success=%s (skip)",
                                    f"[{tid}]", cached.get("success"))
                        d = cached["task_details"] = {**cached.get("task_details", {})}
                        # Splice the cached task_details into the current task's
                        # details and short-circuit the run.
                        if cached.get("success") is not None:
                            sr["tasks_attempted"] += int(cached.get("attempted", 1))
                            sr["tasks_succeeded"] += int(cached.get("success", 0))
                            sr["task_details"][tid] = cached.get("task_details", {})
                            continue
                    except Exception as e:  # noqa: BLE001
                        logger.warning("bad checkpoint %s: %s — re-run", ckpt_path, e)

                # === ① Clean repo + check out base_commit ===
                try:
                    repo_path = setup_repository(repo_id, base_commit, CLONE_BASE_DIR)
                except Exception as e:  # noqa: BLE001
                    logger.error("setup_repository failed: %s", e)
                    sr["task_details"][tid] = {"success": False, "error": f"setup: {e}"}
                    continue

                # === ② memory excerpt (reused within the same sequence) ===
                excerpt = ""
                if memory:
                    excerpt = memory.relevant(
                        query=tid,  # Use tid as the query so hits from the same repo within the sequence rank first
                        sequence_id=seq_id,
                    )

                # === ③ Call OpenLoomi for the entire task (with retry) ===
                # OpenLoomi's agent occasionally hits internal aborts like
                # "AgentOutputEventBusError"; default to 2 retries with 3s between
                # them.
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
                        # "OK" but reply is nearly empty and there is no diff often
                        # means OpenLoomi aborted internally.
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

                # Combine the final diff for logging purposes
                diff = wd_diff if wd_diff else diff_from_reply

                # === ④ Apply diff (only needed when the agent did NOT edit files
                #     directly) + run tests ===
                if diff_from_reply and not wd_diff:
                    # Try to apply the patch emitted by the agent
                    patch_applied = bool(diff) and apply_patch(diff, repo_path)
                    logger.info("%s only patch (apply required): patch_applied=%s (diff_len=%d)",
                                f"[{tid}]", patch_applied, len(diff or ""))
                else:
                    # Agent edited files directly; diff is the live `git diff` output
                    patch_applied = True
                    logger.info("%s working_tree_diff=%d chars; running tests directly",
                                f"[{tid}]", len(diff or ""))

                # Actually run the tests to get FAIL_TO_PASS / PASS_TO_PASS results
                # (whether OpenLoomi already modified the files does not matter; the
                # harness only inspects the current repo state).
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

                # === ⑤ Record + write memory ===
                sr["tasks_attempted"] += 1
                if success: sr["tasks_succeeded"] += 1
                # Save the full reply (previously only the tail was saved, which broke diff extraction)
                sr["task_details"][tid] = {
                    "success": success,
                    "patch_len": len(diff or ""),
                    "patch_applied": patch_applied,
                    "reply_chars": len(reply),
                    "elapsed_sec": round(time.time() - t0, 1),
                    "reply_full": reply[:8000] if reply else "",  # First 8k chars is enough to parse the diff
                }
                # checkpoint: persist immediately
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

                # === Dump a partial result every 5 tasks (to avoid losing data
                #     if the process is killed) ===
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
                        partial_path = Path("./logs") / seq_id / mem_label / f"swe_agent_cl_partial_{run_id}.json"
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
# §9 Results Analysis (consistent with the official v3 simplified version)
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
    # Like official v3 §8 Experiments, run two comparison groups: memory_on and
    # memory_off. They do not contaminate each other: a fresh SemanticMemory is
    # constructed (or omitted) for every run. Order is no_mem (baseline) first,
    # then mem, to avoid state leakage between rounds. Supports env
    # ``OPENLOOMI_CL_RUN_KINDS`` (comma-separated, accepts no_mem / mem).
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

        # After each run, save results / analysis per sequence × mem so the mem
        # run doesn't overwrite no_mem's output. Layout matches ckpt:
        #   logs/<sequence_id>/<mem|no_mem>/swe_agent_cl_results.json
        # When multiple sequences run concurrently, split into per-seq_id files.
        seq_label = "|".join(seq_ids) if seq_ids else "all"
        for seq_id in seq_ids:
            # Pull this sequence's subset out of all_results
            seq_out = {
                run_id: {
                    "run_id": run_id,
                    "memory_enabled": mem,
                    "openloomi_provider": all_results[run_id].get("openloomi_provider"),
                    "sequence_id": seq_id,
                    "summary": all_results[run_id]["sequences"].get(seq_id, {}).get("summary", {}),
                    "tasks_total": all_results[run_id]["sequences"].get(seq_id, {}).get("tasks_total", 0),
                    "tasks_attempted": all_results[run_id]["sequences"].get(seq_id, {}).get("tasks_attempted", 0),
                    "tasks_succeeded": all_results[run_id]["sequences"].get(seq_id, {}).get("tasks_succeeded", 0),
                    "task_details": all_results[run_id]["sequences"].get(seq_id, {}).get("task_details", {}),
                }
            }
            results_path = Path("./logs") / seq_id / label / "swe_agent_cl_results.json"
            results_path.parent.mkdir(parents=True, exist_ok=True)
            with open(results_path, "w", encoding="utf-8") as f:
                json.dump(seq_out, f, indent=2, default=str)
            logger.info("Saved %s", results_path)

            analysis_path = Path("./logs") / seq_id / label / "swe_agent_cl_analysis.json"
            with open(analysis_path, "w", encoding="utf-8") as f:
                json.dump(analyze_results(seq_out), f, indent=2, default=str)
            logger.info("Saved %s", analysis_path)

    # Fallback: for compatibility with older scripts, still write a copy to the
    # old path (results.json at the working directory root). Commented out to
    # avoid overwriting; to keep the old behavior, set
    # ``OPENLOOMI_CL_LEGACY_RESULTS=1``.
    if os.getenv("OPENLOOMI_CL_LEGACY_RESULTS"):
        with open(RESULTS_PATH, "w", encoding="utf-8") as f:
            json.dump(all_results, f, indent=2, default=str)
        logger.info("[legacy] Saved %s", RESULTS_PATH)
        with open(ANALYSIS_PATH, "w", encoding="utf-8") as f:
            json.dump(analyze_results(all_results), f, indent=2, default=str)
        logger.info("[legacy] Saved %s", ANALYSIS_PATH)


if __name__ == "__main__":
    main()
