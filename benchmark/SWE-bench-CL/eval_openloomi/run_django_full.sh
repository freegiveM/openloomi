#!/usr/bin/env bash
# ============================================================================
# run_django_full.sh
# ============================================================================
# One-shot runner for all 50 tasks in django_django_sequence.
# Built on top of run_openloomi_swe.sh; defaults are pre-configured (venv38,
# django repo, Python 3.8) — only requires OpenLoomi running at :3515.
#
# After completion, two files are written:
#   logs/django_full_<timestamp>.log     ← all stdout / stderr
#   swe_agent_cl_results.json            ← per-task success/fail
#
# Usage:
#   cd D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi
#   bash ./run_django_full.sh
#
# Or run in the background (recommended):
#   bash ./run_django_full.sh > /dev/null 2>&1 &
#
# To stop mid-run:
#   kill $(cat logs/django_full.pid 2>/dev/null) 2>/dev/null
# ============================================================================

set -euo pipefail

# Lock dir: only one full-run at a time (to avoid clobbering results)
LOCKFILE="${HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/logs/django_full.lock"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${HARNESS_DIR}/logs"
mkdir -p "${LOG_DIR}"

# Prevent re-entry
exec 9>"${LOCKFILE}"
if ! flock -n 9; then
    echo "[FATAL] Another run_django_full.sh is still running. Please kill it first."
    exit 1
fi

# Write PID file for easy kill
PID_FILE="${LOG_DIR}/django_full.pid"
echo "$$" > "${PID_FILE}"

# ---------------------------------------------------------------------------
# Actually run: invoke run_openloomi_swe.sh with fixed arguments
# ---------------------------------------------------------------------------
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/django_full_${TIMESTAMP}.log"
echo "[INFO] Log written to: ${LOG_FILE}"
echo "[INFO] 50 django tasks, split across no_mem / mem two groups, est. 5-10 hours"
echo "[INFO] After completion, inspect ${HARNESS_DIR}/swe_agent_cl_results.json"

# Key parameters:
#   SEQUENCES=django_django_sequence   → only run django
#   SEQ_TASK_LIMIT=0                    → all 50 (no limit)
#   RUN_KINDS=no_mem,mem                → two-group comparison
#   OPENLOOMI_TIMEOUT=1800              → 30 min cap per task
SEQUENCES=django_django_sequence \
SEQ_TASK_LIMIT=0 \
RUN_KINDS=no_mem,mem \
OPENLOOMI_TIMEOUT=1800 \
    bash "${HARNESS_DIR}/run_openloomi_swe.sh" \
    2>&1 | tee -a "${LOG_FILE}"

# Clean up PID file (trap doesn't fire on exit)
rm -f "${PID_FILE}"