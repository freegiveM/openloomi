"""
config.py
=========
Centralizes all tunable configuration. Decoupled from the OpenLoomi server:
only OpenLoomiConfig reads from environment variables. Everything else
(dataset path, test_cmd, memory settings) is a local constant.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # Load eval_openloomi/.env


# ============================================================================
# Dataset
# ============================================================================

DATASET_PATH = "../data/SWE-Bench-CL-Curriculum.json"

# Local cache root for cloned repos (each repo + base_commit will be git-cloned here)
CLONE_BASE_DIR = Path("./cloned_repos")


# ============================================================================
# Evaluation
# ============================================================================

# Default test_command. SWE-Bench Verified repos mostly use pytest; change this
# to switch test runners.
DEFAULT_TEST_COMMAND = os.getenv(
    "OPENLOOMI_CL_TEST_COMMAND", "python -m pytest -x --tb=short -q"
)

# ``EVAL_PYTHON`` specifies the Python interpreter used to run tests; an empty
# string means use the system default. SWE-Bench-CL old repos (e.g. django 3.x,
# pytest-dev 5.x) need Python 3.8~3.10. Once ``.venv38/Scripts/python.exe`` is
# provisioned with an old pytest, set:
#   EVAL_PYTHON=D:/.../eval_openloomi/.venv38/Scripts/python.exe
EVAL_PYTHON = os.getenv("OPENLOOMI_CL_EVAL_PYTHON", "")


# ============================================================================
# OpenLoomi
# ============================================================================

class OpenLoomiConfig:
    """Parameters for /api/native/agent. Every field supports env-var override."""

    base_url: str = os.getenv("OPENLOOMI_BASE_URL", "http://127.0.0.1:3515")
    provider: str = os.getenv("OPENLOOMI_PROVIDER", "claude")
    platform: str = os.getenv("OPENLOOMI_PLATFORM", "swe-bench-cl")
    timeout: int = int(os.getenv("OPENLOOMI_TIMEOUT", "1800"))  # 30 min default (was 20)
    use_provided_work_dir: bool = os.getenv(
        "OPENLOOMI_USE_PROVIDED_WORK_DIR", "true"
    ).lower() != "false"


# ============================================================================
# Memory (FAISS / sentence-transformers)
# ============================================================================

# By default, SemanticMemory uses a jaccard-like lightweight backend (no torch/sklearn
# required). Switch to "faiss" to use the full sentence-transformers + FAISS stack
# (risk of MemoryError on large datasets).
EMBEDDING_MODEL = os.getenv("OPENLOOMI_CL_EMBEDDING", "jaccard")
MEMORY_BACKEND = EMBEDDING_MODEL  # "jaccard" | "faiss"
MEMORY_K_RESULTS = int(os.getenv("OPENLOOMI_CL_MEMORY_K", "3"))
MEMORY_MAX_CONTEXT_CHARS = int(
    os.getenv("OPENLOOMI_CL_MEMORY_MAX_CHARS", "6000")
)


# ============================================================================
# Behavior control
# ============================================================================

ENABLE_MEMORY = os.getenv("OPENLOOMI_CL_ENABLE_MEMORY", "true").lower() != "false"

# Run the first N tasks per sequence; None means all
SEQUENCE_TASK_LIMIT: int | None = int(os.getenv("OPENLOOMI_CL_TASK_LIMIT", "0")) or None

# Sequence IDs to run; None means run all 8. Read from the
# ``OPENLOOMI_CL_SEQUENCE_IDS`` env (comma-separated); default is run-all.
_seqs_env = os.getenv("OPENLOOMI_CL_SEQUENCE_IDS", "").strip()
SEQUENCE_IDS: list[str] | None = (
    [s.strip() for s in _seqs_env.split(",") if s.strip()] or None
)


# ============================================================================
# Output
# ============================================================================

RESULTS_PATH = Path("./swe_agent_cl_results.json")
ANALYSIS_PATH = Path("./swe_agent_cl_analysis.json")
LOG_DIR = Path("./logs")
LOG_DIR.mkdir(exist_ok=True)


# ============================================================================
# Validation
# ============================================================================

def validate_openloomi_endpoint(cfg: OpenLoomiConfig) -> None:
    """Fail-fast: probe /api/native/providers to verify the service is running."""
    import requests
    url = cfg.base_url.rstrip("/") + "/api/native/providers"
    try:
        resp = requests.get(url, timeout=5)
        resp.raise_for_status()
        print(f"[OpenLoomi] OK: {cfg.base_url} (provider={cfg.provider})", flush=True)
    except Exception as e:
        raise RuntimeError(
            f"OpenLoomi endpoint unreachable at {cfg.base_url}: {e}\n"
            "Start it first: cd openloomi/apps/web && pnpm tauri dev"
        ) from e
