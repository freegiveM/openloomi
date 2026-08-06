"""
config.py
=========
集中所有可调配置。和 OpenLoomi 服务端解耦：只有 OpenLoomiConfig 用环境变量。
其余（数据集路径、test_cmd、memory 设置）都是 hugging 的本地常量。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # 读 eval_openloomi/.env


# ============================================================================
# 数据集
# ============================================================================

DATASET_PATH = "../data/SWE-Bench-CL-Curriculum.json"

# 仓库本地缓存根目录（每个 repo + base_commit 会 git clone 到这里）
CLONE_BASE_DIR = Path("./cloned_repos")


# ============================================================================
# 评测
# ============================================================================

# 默认 test_command。SWE-Bench Verified 仓库多跑 pytest；改这个即可切换。
DEFAULT_TEST_COMMAND = os.getenv(
    "OPENLOOMI_CL_TEST_COMMAND", "python -m pytest -x --tb=short -q"
)

# ``EVAL_PYTHON`` 指定跑测试时调用的 python 解释器；空字符串用系统默认。
# SWE-Bench-CL 旧仓库（如 django 3.x, pytest-dev 5.x）需要 Python 3.8~3.10；
# 当 ``.venv38/Scripts/python.exe`` 装好老 pytest 时，设：
#   EVAL_PYTHON=D:/.../eval_openloomi/.venv38/Scripts/python.exe
EVAL_PYTHON = os.getenv("OPENLOOMI_CL_EVAL_PYTHON", "")


# ============================================================================
# OpenLoomi
# ============================================================================

class OpenLoomiConfig:
    """/api/native/agent 调用参数。所有项都支持环境变量覆写。"""

    base_url: str = os.getenv("OPENLOOMI_BASE_URL", "http://127.0.0.1:3515")
    provider: str = os.getenv("OPENLOOMI_PROVIDER", "claude")
    platform: str = os.getenv("OPENLOOMI_PLATFORM", "swe-bench-cl")
    timeout: int = int(os.getenv("OPENLOOMI_TIMEOUT", "1800"))  # 30 min default (was 20)
    use_provided_work_dir: bool = os.getenv(
        "OPENLOOMI_USE_PROVIDED_WORK_DIR", "true"
    ).lower() != "false"


# ============================================================================
# Memory（FAISS / sentence-transformers）
# ============================================================================

# 默认 SemanticMemory 用 jaccard-like 轻量 backend（不需要装 torch/sklearn）
# 切到 "faiss" 才用完整 sentence-transformers + FAISS（MemoryError 风险）
EMBEDDING_MODEL = os.getenv("OPENLOOMI_CL_EMBEDDING", "jaccard")
MEMORY_BACKEND = EMBEDDING_MODEL  # "jaccard" | "faiss"
MEMORY_K_RESULTS = int(os.getenv("OPENLOOMI_CL_MEMORY_K", "3"))
MEMORY_MAX_CONTEXT_CHARS = int(
    os.getenv("OPENLOOMI_CL_MEMORY_MAX_CHARS", "6000")
)


# ============================================================================
# 行为控制
# ============================================================================

ENABLE_MEMORY = os.getenv("OPENLOOMI_CL_ENABLE_MEMORY", "true").lower() != "false"

# 每个 sequence 跑前 N 个 task；None 表示全部
SEQUENCE_TASK_LIMIT: int | None = int(os.getenv("OPENLOOMI_CL_TASK_LIMIT", "0")) or None

# 要跑的 sequence ID；None 表示跑全部 8 个
# 从 env ``OPENLOOMI_CL_SEQUENCE_IDS`` 读（逗号分隔），默认全跑
_seqs_env = os.getenv("OPENLOOMI_CL_SEQUENCE_IDS", "").strip()
SEQUENCE_IDS: list[str] | None = (
    [s.strip() for s in _seqs_env.split(",") if s.strip()] or None
)


# ============================================================================
# 输出
# ============================================================================

RESULTS_PATH = Path("./swe_agent_cl_results.json")
ANALYSIS_PATH = Path("./swe_agent_cl_analysis.json")
LOG_DIR = Path("./logs")
LOG_DIR.mkdir(exist_ok=True)


# ============================================================================
# 验证
# ============================================================================

def validate_openloomi_endpoint(cfg: OpenLoomiConfig) -> None:
    """提前 fail-fast：探测 /api/native/providers 看服务是否在跑。"""
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
