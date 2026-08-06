#!/usr/bin/env bash
# ============================================================================
# run_django_full.sh
# ============================================================================
# 一条命令跑完 django_django_sequence 的全部 50 条 task。
# 基于 run_openloomi_swe.sh；默认值已经全部预设好（venv38、django repo、
# Python 3.8）——只需要 OpenLoomi 服务在 :3515 跑着就能直接跑。
#
# 跑完会写两个文件：
#   logs/django_full_<timestamp>.log     ← 全部 stdout / stderr
#   swe_agent_cl_results.json            ← 每条 task 的 success/fail
#
# 用法：
#   cd D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi
#   bash ./run_django_full.sh
#
# 或者后台挂着跑（推荐）：
#   bash ./run_django_full.sh > /dev/null 2>&1 &
#
# 想中途停：
#   kill $(cat logs/django_full.pid 2>/dev/null) 2>/dev/null
# ============================================================================

set -euo pipefail

# 锁目录：同一时间只能跑一个 full-run（避免重复写 results）
LOCKFILE="${HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/logs/django_full.lock"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${HARNESS_DIR}/logs"
mkdir -p "${LOG_DIR}"

# 防重入
exec 9>"${LOCKFILE}"
if ! flock -n 9; then
    echo "[FATAL] 另一个 run_django_full.sh 还在跑。请先 kill 它。"
    exit 1
fi

# 写 PID 文件方便 kill
PID_FILE="${LOG_DIR}/django_full.pid"
echo "$$" > "${PID_FILE}"

# ---------------------------------------------------------------------------
# 实际跑：调 run_openloomi_swe.sh，传固定的参数
# ---------------------------------------------------------------------------
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/django_full_${TIMESTAMP}.log"
echo "[INFO] 日志写到：${LOG_FILE}"
echo "[INFO] 50 条 django task，分 no_mem / mem 两组跑，预计 5-10 小时"
echo "[INFO] 跑完看 ${HARNESS_DIR}/swe_agent_cl_results.json"

# 关键参数：
#   SEQUENCES=django_django_sequence   → 只跑 django
#   SEQ_TASK_LIMIT=0                    → 全部 50 条（不限）
#   RUN_KINDS=no_mem,mem                → 两组对比
#   OPENLOOMI_TIMEOUT=1800              → 单 task 上限 30 分钟
SEQUENCES=django_django_sequence \
SEQ_TASK_LIMIT=0 \
RUN_KINDS=no_mem,mem \
OPENLOOMI_TIMEOUT=1800 \
    bash "${HARNESS_DIR}/run_openloomi_swe.sh" \
    2>&1 | tee -a "${LOG_FILE}"

# 清理 PID 文件（trap 在 exit 时不会触发）
rm -f "${PID_FILE}"