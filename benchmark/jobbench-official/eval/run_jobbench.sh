#!/usr/bin/env bash
# Run JobBench on OpenLoomi (development build).
#
# Pipeline:
#   1. Ensure the JobBench dataset is present (download if missing).
#   2. Verify that the development OpenLoomi API is reachable.
#   3. Verify that openloomi-ctl is on disk.
#   4. Verify or capture the auth token.
#   5. Launch the OpenLoomi runner against the configured split.
#
# Resumable: tasks with non-empty `model_output/<output_model>/` are skipped.
# Use --force to re-run every task from scratch.
#
# Cross-platform: works in Git Bash, WSL, and PowerShell with `bash`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOBBENCH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EVAL_DIR="${JOBBENCH_DIR}/eval"
LOGS_DIR="${EVAL_DIR}/logs"
DATASET_REPO="${JOBBENCH_DATASET_REPO:-JobBench/job-bench}"
OPENLOOMI_REPO="${JOBBENCH_OPENLOOMI_REPO:-D:\openloomi3\openloomi}"

OPENLOOMI_API_URL="${OPENLOOMI_API_URL:-http://127.0.0.1:3515}"
OPENLOOMI_CTL="${OPENLOOMI_CTL:-D:\openloomi_installer_version\cli\openloomi-ctl.exe}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.openloomi/token}"

SPLIT="main"
OUTPUT_MODEL="openloomi-dev"
RUN_LABEL=""
MAX_CONCURRENT=1
TIMEOUT=3600
PROVIDER=""
MODEL=""
FORCE="0"
SKIP_DOWNLOAD="0"
SKIP_CHECKS="0"

print_help() {
  cat <<'EOF'
Usage:
  ./run_jobbench.sh [options]

Options:
  --split <main|easy>            Dataset split (default: main).
  --output-model <name>          Output directory under model_output/ (default: openloomi-dev).
  --run-label <text>             Extra suffix appended to the output dir to keep variants separate.
  --max-concurrent <n>           Concurrency (default: 1).
  --timeout <seconds>            Per-task timeout in seconds (default: 3600).
  --provider <name>              Forward to openloomi-ctl (e.g. claude, codex, opencode).
  --model <id>                   Forward to openloomi-ctl.
  --api-url <url>                OpenLoomi API base URL (default: http://127.0.0.1:3515).
  --openloomi-ctl <path>         Full path to openloomi-ctl.exe.
  --token-file <path>            Path to the OpenLoomi auth token (default: ~/.openloomi/token).
  --dataset-repo <repo>          Hugging Face dataset repo (default: JobBench/job-bench).
  --openloomi-repo <path>        OpenLoomi repo path for the auto-download helper.
  --force                        Re-run every task and overwrite existing outputs.
  --skip-download                Do not download the dataset, even if it is missing.
  --skip-checks                  Skip the OpenLoomi API and CLI sanity checks.
  --help                         Show this message.

Environment variables (override CLI flags):
  OPENLOOMI_API_URL
  OPENLOOMI_CTL
  TOKEN_FILE
  JOBBENCH_DATASET_REPO
  JOBBENCH_OPENLOOMI_REPO

Outputs:
  - eval/logs/openloomi_main_terminal_<timestamp>.log  (terminal transcript)
  - eval/logs/openloomi_main_openloomi-dev_<ts>.json   (run summary)
  - dataset/<split>/<profession>/<task>/model_output/<output_model>/
  - dataset/<split>/<profession>/<task>/model_traj/<output_model>/attempt_*.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --split)              SPLIT="$2"; shift 2;;
    --output-model)       OUTPUT_MODEL="$2"; shift 2;;
    --run-label)          RUN_LABEL="$2"; shift 2;;
    --max-concurrent)     MAX_CONCURRENT="$2"; shift 2;;
    --timeout)            TIMEOUT="$2"; shift 2;;
    --provider)           PROVIDER="$2"; shift 2;;
    --model)              MODEL="$2"; shift 2;;
    --api-url)            OPENLOOMI_API_URL="$2"; shift 2;;
    --openloomi-ctl)      OPENLOOMI_CTL="$2"; shift 2;;
    --token-file)         TOKEN_FILE="$2"; shift 2;;
    --dataset-repo)       DATASET_REPO="$2"; shift 2;;
    --openloomi-repo)     OPENLOOMI_REPO="$2"; shift 2;;
    --force)              FORCE="1"; shift;;
    --skip-download)      SKIP_DOWNLOAD="1"; shift;;
    --skip-checks)        SKIP_CHECKS="1"; shift;;
    --help|-h)            print_help; exit 0;;
    *) echo "Unknown option: $1" >&2; print_help; exit 2;;
  esac
done

mkdir -p "${LOGS_DIR}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TERMINAL_LOG="${LOGS_DIR}/openloomi_main_terminal_${TIMESTAMP}.log"

log() { printf '[run_jobbench] %s\n' "$*"; }

# Pipe everything to the transcript as well as stdout.
exec > >(tee -a "${TERMINAL_LOG}") 2>&1

log "OpenLoomi repo        : ${OPENLOOMI_REPO}"
log "JobBench root         : ${JOBBENCH_DIR}"
log "Dataset repo          : ${DATASET_REPO}"
log "Split                 : ${SPLIT}"
log "Output model          : ${OUTPUT_MODEL}"
log "Run label             : ${RUN_LABEL:-<none>}"
log "OpenLoomi API URL     : ${OPENLOOMI_API_URL}"
log "openloomi-ctl         : ${OPENLOOMI_CTL}"
log "Token file            : ${TOKEN_FILE}"
log "Concurrency           : ${MAX_CONCURRENT}"
log "Per-task timeout (s)  : ${TIMEOUT}"
log "Provider / Model      : ${PROVIDER:-<default>} / ${MODEL:-<default>}"
log "Force overwrite       : ${FORCE}"

# ---------------------------------------------------------------------------
# 1. Dataset check / download
# ---------------------------------------------------------------------------
DATASET_ROOT="${JOBBENCH_DIR}/dataset/${SPLIT}"
if [[ ! -d "${DATASET_ROOT}" ]] || [[ -z "$(ls -A "${DATASET_ROOT}" 2>/dev/null)" ]]; then
  if [[ "${SKIP_DOWNLOAD}" == "1" ]]; then
    log "ERROR: dataset missing and --skip-download is set."
    log "       Expected: ${DATASET_ROOT}"
    exit 2
  fi
  log "Dataset missing. Downloading ${DATASET_REPO}..."
  DOWNLOAD_SCRIPT="${SCRIPT_DIR}/download_dataset_windows.py"
  if [[ ! -f "${DOWNLOAD_SCRIPT}" ]]; then
    log "ERROR: ${DOWNLOAD_SCRIPT} not found. Re-create it or pass --skip-download."
    exit 2
  fi
  pushd "${JOBBENCH_DIR}" >/dev/null
  python "${DOWNLOAD_SCRIPT}"
  popd >/dev/null
else
  log "Dataset already present at ${DATASET_ROOT}."
fi

# ---------------------------------------------------------------------------
# 2. Sanity checks
# ---------------------------------------------------------------------------
if [[ "${SKIP_CHECKS}" != "1" ]]; then
  log "Checking OpenLoomi API at ${OPENLOOMI_API_URL}..."
  API_HOST="$(printf '%s' "${OPENLOOMI_API_URL}" | sed -E 's#^https?://##; s#/.*$##')"
  API_PORT="$(printf '%s' "${OPENLOOMI_API_URL}" | sed -E 's#^.*:([0-9]+).*$#\1#')"
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Test-NetConnection -ComputerName '${API_HOST%:*}' -Port ${API_PORT} | Select-Object -ExpandProperty TcpTestSucceeded" \
      | grep -q "True" || {
        log "ERROR: cannot reach ${OPENLOOMI_API_URL}. Start pnpm tauri:dev first."
        exit 2
      }
  elif command -v nc >/dev/null 2>&1; then
    nc -z "${API_HOST}" "${API_PORT}" || {
      log "ERROR: cannot reach ${OPENLOOMI_API_URL}. Start pnpm tauri:dev first."
      exit 2
    }
  fi
  log "OpenLoomi API reachable."

  log "Checking openloomi-ctl..."
  if [[ ! -f "${OPENLOOMI_CTL}" ]]; then
    log "ERROR: openloomi-ctl not found at ${OPENLOOMI_CTL}."
    log "       Use --openloomi-ctl <path> to override."
    exit 2
  fi
  log "openloomi-ctl present."

  log "Checking auth token..."
  if [[ -z "${OPENLOOMI_AUTH_TOKEN:-}" ]]; then
    if [[ ! -f "${TOKEN_FILE}" ]]; then
      log "ERROR: token file not found at ${TOKEN_FILE} and OPENLOOMI_AUTH_TOKEN is empty."
      log "       Log in through the OpenLoomi desktop app, or set OPENLOOMI_AUTH_TOKEN."
      exit 2
    fi
    log "Token file found at ${TOKEN_FILE}."
  else
    log "Using OPENLOOMI_AUTH_TOKEN from environment."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Build runner command
# ---------------------------------------------------------------------------
PYPY_ARGS=(
  "${EVAL_DIR}/run_benchmark_openloomi.py"
  --split "${SPLIT}"
  --openloomi-ctl "${OPENLOOMI_CTL}"
  --output-model "${OUTPUT_MODEL}"
  --max-concurrent "${MAX_CONCURRENT}"
  --timeout "${TIMEOUT}"
)
[[ -n "${RUN_LABEL}"   ]] && PYPY_ARGS+=(--run-label "${RUN_LABEL}")
[[ -n "${PROVIDER}"    ]] && PYPY_ARGS+=(--provider "${PROVIDER}")
[[ -n "${MODEL}"       ]] && PYPY_ARGS+=(--model "${MODEL}")
[[ "${FORCE}" == "1"   ]] && PYPY_ARGS+=(--force)

log "Launching runner:"
printf '   %q ' python "${PYPY_ARGS[@]}"
printf '\n'

# ---------------------------------------------------------------------------
# 4. Export environment
# ---------------------------------------------------------------------------
export OPENLOOMI_API_URL
export OPENLOOMI_CLI_DIRECT="0"
if [[ -z "${OPENLOOMI_AUTH_TOKEN:-}" && -f "${TOKEN_FILE}" ]]; then
  # Strip whitespace; the file may be Base64 or plain JWT depending on version.
  export OPENLOOMI_AUTH_TOKEN="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
fi

cd "${JOBBENCH_DIR}"
python "${PYPY_ARGS[@]}"
RUNNER_EXIT=$?

log "Runner exit code: ${RUNNER_EXIT}"
log "Terminal log    : ${TERMINAL_LOG}"
exit ${RUNNER_EXIT}
