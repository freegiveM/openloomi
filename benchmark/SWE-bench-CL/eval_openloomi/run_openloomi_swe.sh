#!/usr/bin/env bash
# ============================================================================
# run_openloomi_swe.sh
# ============================================================================
# One-shot runner that wires OpenLoomi into the SWE-Bench-CL evaluation harness.
#
# What it does:
#   1. Verifies the OpenLoomi service is reachable (default http://127.0.0.1:3515)
#   2. Verifies the Python 3.8 venv exists; if not, creates it with uv
#      (including host dependencies + an old pytest)
#   3. Per SEQUENCE, installs the SWE-Bench-CL repos into the venv
#      (django, sympy, pytest-dev, ...)
#   4. Invokes eval_procedure.py to run no_mem / mem (by default, both)
#   5. Outputs swe_agent_cl_results.json + swe_agent_cl_analysis.json
#
# Usage:
#   # Default (1 task as a sanity check)
#   ./run_openloomi_swe.sh
#
#   # 5 tasks
#   SEQ_TASK_LIMIT=5 ./run_openloomi_swe.sh
#
#   # Only one sequence
#   SEQUENCES=django_django_sequence,pytest-dev_pytest_sequence SEQ_TASK_LIMIT=3 ./run_openloomi_swe.sh
#
#   # Baseline only (no memory)
#   RUN_KINDS=no_mem ./run_openloomi_swe.sh
#
#   # Dry run (only check the environment, do not invoke the agent)
#   DRY_RUN=1 ./run_openloomi_swe.sh
#
# Exit codes:
#   0 = success
#   1 = OpenLoomi unreachable / dataset missing / Python interpreter problem
#   2 = harness finished but success_rate=0 (not necessarily a failure; see README)
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# Paths and default config
# ----------------------------------------------------------------------------
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "${HARNESS_DIR}/.." && pwd)/data"
DATASET="${DATASET:-${DATA_DIR}/SWE-Bench-CL-Curriculum.json}"

# OpenLoomi service
OPENLOOMI_HOST="${OPENLOOMI_HOST:-127.0.0.1}"
OPENLOOMI_PORT="${OPENLOOMI_PORT:-3515}"
OPENLOOMI_URL="http://${OPENLOOMI_HOST}:${OPENLOOMI_PORT}"

# Python
# Default Python 3.12 on Windows; override with ``PY312``.
# Under WSL the path is ``/mnt/c/...``; under PowerShell/cmd it is ``/c/...``.
PY312_CANDIDATES=(
  "/mnt/c/Users/32274/AppData/Local/Programs/Python/Python312/python.exe"
  "/c/Users/32274/AppData/Local/Programs/Python/Python312/python.exe"
  "python3.12"
  "python"
)
PY312_DEFAULT=""
for cand in "${PY312_CANDIDATES[@]}"; do
  if [[ -x "${cand}" ]] || have "${cand}"; then
    PY312_DEFAULT="${cand}"
    break
  fi
done
PY312="${PY312:-${PY312_DEFAULT}}"
[[ -z "${PY312}" ]] && die "Python 3.12 interpreter not found; specify with PY312=/path/to/python"

# Invoking Python on the Windows side:
#   - Linux-side executable is exec'd directly
#   - Windows paths (``D:/...`` / ``/c/...`` / ``/mnt/c/...``) go through powershell.exe -File
# Because cmd.exe is blocked under PowerShell, powershell is the only reliable entry point.
PS="powershell.exe"
PS_ARGS=(-NoProfile -ExecutionPolicy Bypass -File)
PS_TMP="${HARNESS_DIR}/.run_py_$$.ps1"
cleanup_run_py() { rm -f "${PS_TMP}" "${HARNESS_DIR}/.run_py_*.ps1" 2>/dev/null || true; }
trap 'cleanup_run_py; rm -f "${HARNESS_DIR}/.pick_repos_$$.py"' EXIT
run_py() {
  local py="$1"; shift
  local py_native
  case "${py}" in
    /*)
      if have cygpath; then
        py_native="$(cygpath -w "${py}" 2>/dev/null || echo "${py}")"
      else
        case "${py}" in
          /mnt/?/*)
            local drv; drv=$(printf '%s' "${py:5:1}" | tr 'a-z' 'A-Z')
            py_native="${drv}:${py:7}" ;;
          *) py_native="${py}" ;;
        esac
      fi
      ;;
    *)  # command name or Windows path (Windows paths contain ``:``)
      if [[ "${py}" == *:* ]]; then
        py_native="${py}"
      else
        "${py}" "$@"; return
      fi
      ;;
  esac
  local py_ps; py_ps="$(printf '%s' "${py_native}" | sed "s|'|''|g")"
  printf '& "%s"' "${py_ps}"
  # Simple quoting: wrap in double quotes; do not escape inner " since the path has none
  for a in "$@"; do
    printf ' "%s"' "$a"
  done
  printf '\n' > "${PS_TMP}"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}"
}

PY38_VENV="${HARNESS_DIR}/.venv38"
PY38_BIN="${PY38_VENV}/bin/python"
# The path is different on Windows; the runner auto-adapts
[[ -x "${PY38_VENV}/Scripts/python.exe" ]] && PY38_BIN="${PY38_VENV}/Scripts/python.exe"

# Repository install directory
CLONED_DIR="${HARNESS_DIR}/cloned_repos"

# Evaluation control
RUN_KINDS="${RUN_KINDS:-no_mem,mem}"   # comma-separated, accepts no_mem / mem
SEQUENCES="${SEQUENCES:-}"              # empty = run all; comma-separated sequence IDs
# By default each sequence takes all tasks; pass ``SEQ_TASK_LIMIT=N`` to cap
SEQ_TASK_LIMIT="${SEQ_TASK_LIMIT:-0}"    # 0 / empty / negative = no limit

# Safety net: to run multiple sequences (more than one repo) in one harness
# session, the ``pip install`` inside venv38 must not conflict across repos.
# At startup the script installs only the first repo from ``PICK_REPOS``; if
# you really want to run several repos in one shot, do it across multiple
# invocations.
MAX_SEQUENCES_PER_RUN="${MAX_SEQUENCES_PER_RUN:-1}"

# Time
AGENT_TIMEOUT="${AGENT_TIMEOUT:-1800}"   # per-task agent cap (seconds)

# Behavior switches
DRY_RUN="${DRY_RUN:-0}"
SKIP_DJANGO_INSTALL="${SKIP_DJANGO_INSTALL:-0}"

# ----------------------------------------------------------------------------
# Utility functions
# ----------------------------------------------------------------------------
log()  { printf "[%s] %s\n" "$(date '+%H:%M:%S')" "$*"; }
err()  { printf "[%s][ERROR] %s\n" "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { err "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Convert a WSL-style path ``/mnt/c/Users/...`` to Windows-style
# ``C:/Users/...`` so Windows-side tools (python, uv) can read it.
# Prefer cygpath (available in Git Bash / MSYS); otherwise convert manually.
to_windows_path() {
  local p="$1"
  if have cygpath; then
    cygpath -w "${p}" 2>/dev/null || echo "${p}"
  else
    case "${p}" in
      /mnt/?/*)
        local d="${p:5:1}"
        d="$(printf '%s' "${d}" | tr 'a-z' 'A-Z')"
        printf '%s:/%s' "${d}" "${p:7}"
        ;;
      *) echo "${p}" ;;
    esac
  fi
}

# ----------------------------------------------------------------------------
# 1. Preflight
# ----------------------------------------------------------------------------
log "=== STEP 1/5: preflight ==="
log "Harness dir  : ${HARNESS_DIR}"
log "Dataset      : ${DATASET}"
log "OpenLoomi URL: ${OPENLOOMI_URL}"
log "PY312        : ${PY312}"
log "PY38 venv    : ${PY38_VENV}"
log "Run kinds    : ${RUN_KINDS}"
log "Sequences    : ${SEQUENCES:-<ALL>}"
log "Task limit   : ${SEQ_TASK_LIMIT}"

[[ -f "${DATASET}" ]] || die "Dataset not found: ${DATASET} (please confirm the SWE-bench-cl data file exists)"

# Verify OpenLoomi is reachable
# If running under WSL (where 127.0.0.1 doesn't work), automatically switch to the Windows host IP.
if ! curl -fsS "${OPENLOOMI_URL}/api/native/providers" -o /dev/null --max-time 10; then
  # Probe: might be WSL, look up the host IP
  if have wslpath && [[ -n "${WSL_INTEROP:-}" || -f /proc/sys/kernel/osrelease ]]; then
    WIN_HOST_IP="$(awk '/nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
    if [[ -n "${WIN_HOST_IP}" ]]; then
      OPENLOOMI_URL="http://${WIN_HOST_IP}:${OPENLOOMI_PORT}"
      log "WSL detected; retrying OpenLoomi via host IP: ${OPENLOOMI_URL}"
    fi
  fi
  if ! curl -fsS "${OPENLOOMI_URL}/api/native/providers" -o /dev/null --max-time 10; then
    die "OpenLoomi is unreachable: ${OPENLOOMI_URL}
  Hint: run the following inside apps/web:
        cd ${HARNESS_DIR}/../../apps/web
        \$env:PORT=${OPENLOOMI_PORT}
        pnpm tauri dev --config src-tauri/tauri.conf.dev.json"
  fi
fi
log "OpenLoomi OK via ${OPENLOOMI_URL}"

# uv tool
have uv || die "uv not found; install from https://github.com/astral-sh/uv"
log "uv: $(uv --version)"

# ----------------------------------------------------------------------------
# 2. Python 3.8 venv
# ----------------------------------------------------------------------------
log "=== STEP 2/5: Python 3.8 venv ==="
if [[ ! -x "${PY38_BIN}" ]]; then
  log "creating venv at ${PY38_VENV}"
  uv venv --python 3.8 --seed "${PY38_VENV}"
  log "installing harness deps into venv"
  uv pip install --python "${PY38_BIN}" \
      requests python-dotenv python-patch tqdm matplotlib pandas ipython
else
  log "venv exists; checking pip..."
  PY38_BIN_NATIVE="$(to_windows_path "${PY38_BIN}")"
  if ! "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE:-${PS_TMP}}" 2>/dev/null; then
    :
  fi
  # Install pip into venv38 if missing
  printf '& "%s" -m ensurepip --default-pip\n' "${PY38_BIN_NATIVE//\'/''}" > "${PS_TMP}"
  PS_TMP_NATIVE="$(to_windows_path "${PS_TMP}")"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}" 2>&1 | tail -n 3 || true
fi

# Verify venv38 actually works
"${PY38_BIN}" -c "import requests" >/dev/null 2>&1 \
  || die "venv38 is not usable; check ${PY38_BIN}"

log "venv38 OK."

# ----------------------------------------------------------------------------
# 3. Install the SWE-Bench-CL repos (selected by SEQUENCES)
# ----------------------------------------------------------------------------
log "=== STEP 3/5: install repo source into venv38 ==="

# Find the repos to run from DATASET
DATASET_NATIVE="$(to_windows_path "${DATASET}")"
# Write the helper Python script to a temp file to side-step heredoc + Windows
# path-expansion conflicts
TMPPY="${HARNESS_DIR}/.pick_repos_$$.py"
trap 'rm -f "${TMPPY}"' EXIT
cat > "${TMPPY}" <<'PYEOF'
import json, sys
path, wanted = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
wanted_set = {s.strip() for s in wanted.split(",") if s.strip()}
seen = set()
for seq in data["sequences"]:
    sid = seq["id"]
    if wanted_set and sid not in wanted_set: continue
    repo = seq.get("repo") or seq["tasks"][0]["metadata"]["repo"]
    if repo in seen: continue
    seen.add(repo)
    print(repo)
PYEOF
TMPPY_NATIVE="$(to_windows_path "${TMPPY}")"
PY312_NATIVE="$(to_windows_path "${PY312}")"
PY312_PS="$(printf '%s' "${PY312_NATIVE}" | sed "s|'|''|g")"
TMPPY_PS="$(printf '%s' "${TMPPY_NATIVE}")"
DATASET_PS="$(printf '%s' "${DATASET_NATIVE}")"
PS_TMP_NATIVE="$(to_windows_path "${PS_TMP}")"
printf '& "%s" "%s" "%s" "%s"\n' "${PY312_PS}" "${TMPPY_PS}" "${DATASET_PS}" "${SEQUENCES}" > "${PS_TMP}"
PICK_REPOS=$( "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}" )
# Strip Windows-style CRLF so bash doesn't try to exec ``repo\r`` as a command
PICK_REPOS="$(printf '%s' "${PICK_REPOS}" | tr -d '\r')"

if [[ -z "${PICK_REPOS}" ]]; then
  log "No repo to install (SEQUENCES may be empty)."
else
  # Conflict guard: a single script run only installs the **first** entry in PICK_REPOS
  PICK_REPOS_FIRST="$(printf '%s\n' "${PICK_REPOS}" | sed -n '1p')"
  EXTRA_REPOS="$(printf '%s\n' "${PICK_REPOS}" | sed -n '2p')"
  if [[ -n "${EXTRA_REPOS}" ]]; then
    log "[WARN] SEQUENCES contains multiple repos (${PICK_REPOS// /, }). venv38 can only install one at a time."
    log "[WARN] This run will install only: ${PICK_REPOS_FIRST}; run the rest in separate invocations:"
    for r in ${EXTRA_REPOS}; do
      log "       SEQUENCES=$r SEQ_TASK_LIMIT=0 bash ./run_openloomi_swe.sh"
    done
    PICK_REPOS="${PICK_REPOS_FIRST}"
  fi
  log "Repos: ${PICK_REPOS}"
  for repo in ${PICK_REPOS}; do
    # django/django -> cloned_repos/django__django
    sanitized="${repo//\//__}"
    repo_dir="${CLONED_DIR}/${sanitized}"
    log "  ${repo}: ${repo_dir}"
    if [[ ! -d "${repo_dir}" ]]; then
      log "    cloning..."
      mkdir -p "${CLONED_DIR}"
      git clone "https://github.com/${repo}.git" "${repo_dir}" || \
        log "    [WARN] git clone failed for ${repo}, will skip"
    fi
    # For Python repos: install source into venv38 with uv (used by the harness to run tests)
    if [[ "${SKIP_DJANGO_INSTALL}" != "1" && ( -f "${repo_dir}/setup.py" || -f "${repo_dir}/pyproject.toml" ) ]]; then
      log "    installing repo source into venv38 (editable/develop mode)..."
      REPO_DIR_NATIVE="$(to_windows_path "${repo_dir}")"
      PY38_NATIVE="$(to_windows_path "${PY38_BIN}")"
      # Invoke venv38's own python install via powershell.
      # Use ``-e`` (editable/develop) mode: imports in the venv go straight to
      # the working tree instead of copying .py files into site-packages — this
      # completely avoids the stale-file problem left by ``setup.py install``
      # (which previously mangled site-packages subdirectories like django/core/
      # into ``~ore/`` form, causing ModuleNotFoundError on every FAIL_TO_PASS).
      # No separate stale cleanup is needed.
      cat > "${PS_TMP}" <<PSX
& "${PY38_NATIVE}" -m pip install -e "${REPO_DIR_NATIVE}" 2>&1 | Select-Object -Last 5
PSX
      "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}" \
        || log "    [WARN] pip install -e ${repo} into venv38 failed"
    fi
  done
fi

# ----------------------------------------------------------------------------
# 4. Run eval_procedure
# ----------------------------------------------------------------------------
log "=== STEP 4/5: run eval_procedure.py ==="

EVAL_PYTHON_VAL="${PY38_BIN}"
EVAL_PYTHON_VAL_NATIVE="$(to_windows_path "${PY38_BIN}")"

# Env-var string
ENV_ARGS=(
  "OPENLOOMI_CL_EVAL_PYTHON=${EVAL_PYTHON_VAL_NATIVE}"
  "OPENLOOMI_CL_TASK_LIMIT=${SEQ_TASK_LIMIT}"
  "OPENLOOMI_TIMEOUT=${AGENT_TIMEOUT}"
)
if [[ -n "${SEQUENCES}" ]]; then
  ENV_ARGS+=("OPENLOOMI_CL_SEQUENCE_IDS=${SEQUENCES}")
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  log "[DRY_RUN] would invoke:"
  printf '  %s ' "${ENV_ARGS[@]}"; printf '\n'
  printf '  %s eval_procedure.py\n' "${PY312}"
  log "OK, dry-run done."
  exit 0
fi

# Run no_mem
if [[ "${RUN_KINDS}" == *"no_mem"* ]]; then
  log ">>> running NO_MEM baseline"
  PS_BODY=""
  for kv in "${ENV_ARGS[@]}"; do
    PS_BODY="${PS_BODY}\$env:${kv%%=*}='${kv#*=}'; "
  done
  HARNESS_NATIVE="$(to_windows_path "${HARNESS_DIR}")"
  PY312_NATIVE="$(to_windows_path "${PY312}")"
  PY312_PS="$(printf '%s' "${PY312_NATIVE}" | sed "s|'|''|g")"
  HARNESS_PS="$(printf '%s' "${HARNESS_NATIVE}")"
  printf '%s& "%s" "%s/eval_procedure.py"\n' "${PS_BODY}" "${PY312_PS}" "${HARNESS_PS}" > "${PS_TMP}"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}"
fi

# Run mem
if [[ "${RUN_KINDS}" == *"mem"* ]]; then
  log ">>> running MEM (with jaccard memory)"
  PS_BODY=""
  for kv in "${ENV_ARGS[@]}"; do
    PS_BODY="${PS_BODY}\$env:${kv%%=*}='${kv#*=}'; "
  done
  HARNESS_NATIVE="$(to_windows_path "${HARNESS_DIR}")"
  PY312_NATIVE="$(to_windows_path "${PY312}")"
  PY312_PS="$(printf '%s' "${PY312_NATIVE}" | sed "s|'|''|g")"
  HARNESS_PS="$(printf '%s' "${HARNESS_NATIVE}")"
  printf '%s& "%s" "%s/eval_procedure.py"\n' "${PS_BODY}" "${PY312_PS}" "${HARNESS_PS}" > "${PS_TMP}"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}"
fi

# ----------------------------------------------------------------------------
# 5. Summarize results
# ----------------------------------------------------------------------------
log "=== STEP 5/5: summarize ==="
RESULTS_FILE="${HARNESS_DIR}/swe_agent_cl_results.json"
ANALYSIS_FILE="${HARNESS_DIR}/swe_agent_cl_analysis.json"

if [[ -f "${RESULTS_FILE}" ]]; then
  log "Results:   ${RESULTS_FILE}"
  log "Analysis:  ${ANALYSIS_FILE}"
  # Write the summarize script to a temp file inside the harness, to be run by Windows python
  SUMSCRIPT="${HARNESS_DIR}/.summarize_$$.py"
  cat > "${SUMSCRIPT}" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print()
print("=" * 60)
print(f"{'run_id':<35} {'mem':<6} {'success_rate':<14} {'attempted/succ'}")
print("-" * 60)
for run_id, r in data.items():
    o = r["overall"]
    print(f"{run_id:<35} {str(r['memory_enabled']):<6} "
          f"{o['success_rate']:<14.2%} {o['tasks_attempted']}/{o['tasks_succeeded']}")
print("=" * 60)
PYEOF
  RESULTS_NATIVE="$(to_windows_path "${RESULTS_FILE}")"
  SUMSCRIPT_NATIVE="$(to_windows_path "${SUMSCRIPT}")"
  PY312_NATIVE="$(to_windows_path "${PY312}")"
  PY312_PS="$(printf '%s' "${PY312_NATIVE}" | sed "s|'|''|g")"
  SUMS_PS="$(printf '%s' "${SUMSCRIPT_NATIVE}")"
  RES_PS="$(printf '%s' "${RESULTS_NATIVE}")"
  printf '& "%s" "%s" "%s"\n' "${PY312_PS}" "${SUMS_PS}" "${RES_PS}" > "${PS_TMP}"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}"
  rm -f "${SUMSCRIPT}"
else
  err "Results file not found: ${RESULTS_FILE}"
  exit 2
fi

log "Done."
exit 0