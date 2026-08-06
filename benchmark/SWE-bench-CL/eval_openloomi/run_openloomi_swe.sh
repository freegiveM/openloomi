#!/usr/bin/env bash
# ============================================================================
# run_openloomi_swe.sh
# ============================================================================
# 一条命令把 OpenLoomi 接到 SWE-Bench-CL 评测 harness 上跑。
#
# 工作内容：
#   1. 检查 OpenLoomi 服务可达（默认 http://127.0.0.1:3515）
#   2. 检查 Python 3.8 venv 存在；不存在则用 uv 装好（含本机依赖 + 老 pytest）
#   3. 根据 SEQUENCE，把 SWE-Bench-CL 仓库装进 venv（django, sympy, pytest-dev, …）
#   4. 调用 eval_procedure.py 跑 no_mem / mem（默认两个 run 都跑）
#   5. 输出 swe_agent_cl_results.json + swe_agent_cl_analysis.json
#
# 用法：
#   # 跑默认（1 条 task 做 sanity）
#   ./run_openloomi_swe.sh
#
#   # 跑 5 条 task
#   SEQ_TASK_LIMIT=5 ./run_openloomi_swe.sh
#
#   # 只跑某一组 sequence
#   SEQUENCES=django_django_sequence,pytest-dev_pytest_sequence SEQ_TASK_LIMIT=3 ./run_openloomi_swe.sh
#
#   # 只跑 baseline（不开 memory）
#   RUN_KINDS=no_mem ./run_openloomi_swe.sh
#
#   # dry run（只检查环境，不真跑 agent）
#   DRY_RUN=1 ./run_openloomi_swe.sh
#
# 退出码：
#   0 = 成功
#   1 = OpenLoomi 服务不通 / 数据集缺失 / Python 解释器有问题
#   2 = harness 跑完但 success_rate=0（不一定算失败，详见 README）
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 路径与默认配置
# ----------------------------------------------------------------------------
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "${HARNESS_DIR}/.." && pwd)/data"
DATASET="${DATASET:-${DATA_DIR}/SWE-Bench-CL-Curriculum.json}"

# OpenLoomi 服务
OPENLOOMI_HOST="${OPENLOOMI_HOST:-127.0.0.1}"
OPENLOOMI_PORT="${OPENLOOMI_PORT:-3515}"
OPENLOOMI_URL="http://${OPENLOOMI_HOST}:${OPENLOOMI_PORT}"

# Python
# 默认 Windows 上的 Python 3.12；用 ``PY312`` 覆盖。
# WSL 视角下路径在 ``/mnt/c/...``；PowerShell/cmd 视角下是 ``/c/...``。
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
[[ -z "${PY312}" ]] && die "找不到 Python 3.12 解释器，请用 PY312=/path/to/python 显式指定"

# 调用 Windows 端 python：
#   - Linux 视角的可执行直接 exec
#   - Windows 路径（``D:/...`` / ``/c/...`` / ``/mnt/c/...``）走 powershell.exe -File
# 因为 cmd.exe 在 PowerShell 下被禁止，powershell 是唯一可靠的入口。
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
    *)  # 命令名或 Windows path（Windows path 含 ``:``）
      if [[ "${py}" == *:* ]]; then
        py_native="${py}"
      else
        "${py}" "$@"; return
      fi
      ;;
  esac
  local py_ps; py_ps="$(printf '%s' "${py_native}" | sed "s|'|''|g")"
  printf '& "%s"' "${py_ps}"
  # 简单 quote：双引号包起来；不转义内部"因为路径里没有"
  for a in "$@"; do
    printf ' "%s"' "$a"
  done
  printf '\n' > "${PS_TMP}"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}"
}

PY38_VENV="${HARNESS_DIR}/.venv38"
PY38_BIN="${PY38_VENV}/bin/python"
# 在 Windows 下路径不一样，runner 会自动适配
[[ -x "${PY38_VENV}/Scripts/python.exe" ]] && PY38_BIN="${PY38_VENV}/Scripts/python.exe"

# 仓库安装目录
CLONED_DIR="${HARNESS_DIR}/cloned_repos"

# 评测控制
RUN_KINDS="${RUN_KINDS:-no_mem,mem}"   # 逗号分隔，可选 no_mem / mem
SEQUENCES="${SEQUENCES:-}"              # 空 = 跑全部；逗号分隔 sequence ID
# 默认每个 sequence 取全部 task；要截取就传 ``SEQ_TASK_LIMIT=N``
SEQ_TASK_LIMIT="${SEQ_TASK_LIMIT:-0}"    # 0 / 空 / 负 = 不限

# 防误跑提示：要让一个 harness session 跑多个 sequence（不止 1 个 repo），
# 必须保证 venv38 里 ``pip install`` 不会跨 repo 冲突。脚本启动时只装一次
# ``PICK_REPOS`` 里的第一个；如果你确实想一次性跑多个 repo，建议分次跑。
MAX_SEQUENCES_PER_RUN="${MAX_SEQUENCES_PER_RUN:-1}"

# 时间
AGENT_TIMEOUT="${AGENT_TIMEOUT:-1800}"   # 单条 task agent 上限（秒）

# 行为开关
DRY_RUN="${DRY_RUN:-0}"
SKIP_DJANGO_INSTALL="${SKIP_DJANGO_INSTALL:-0}"

# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------
log()  { printf "[%s] %s\n" "$(date '+%H:%M:%S')" "$*"; }
err()  { printf "[%s][ERROR] %s\n" "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { err "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# 把 WSL 风格路径 ``/mnt/c/Users/...`` 转 Windows 风格 ``C:/Users/...``，
# 这样 Windows 端的工具（python, uv）能读到。
# 优先用 cygpath（Git Bash / MSYS 都有）；否则手工转换。
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
# 1. 预检
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

[[ -f "${DATASET}" ]] || die "Dataset not found: ${DATASET}（请确认 SWE-bench-cl 数据文件存在）"

# OpenLoomi 服务可达
# 如果是在 WSL 里跑（127.0.0.1 不通），自动改用 Windows host IP。
if ! curl -fsS "${OPENLOOMI_URL}/api/native/providers" -o /dev/null --max-time 10; then
  # 探测：可能是 WSL，看 host IP
  if have wslpath && [[ -n "${WSL_INTEROP:-}" || -f /proc/sys/kernel/osrelease ]]; then
    WIN_HOST_IP="$(awk '/nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
    if [[ -n "${WIN_HOST_IP}" ]]; then
      OPENLOOMI_URL="http://${WIN_HOST_IP}:${OPENLOOMI_PORT}"
      log "WSL detected; retrying OpenLoomi via host IP: ${OPENLOOMI_URL}"
    fi
  fi
  if ! curl -fsS "${OPENLOOMI_URL}/api/native/providers" -o /dev/null --max-time 10; then
    die "OpenLoomi 服务不可达：${OPENLOOMI_URL}
  提示：请在 apps/web 目录里运行：
        cd ${HARNESS_DIR}/../../apps/web
        \$env:PORT=${OPENLOOMI_PORT}
        pnpm tauri dev --config src-tauri/tauri.conf.dev.json"
  fi
fi
log "OpenLoomi OK via ${OPENLOOMI_URL}"

# uv 工具
have uv || die "未找到 uv，请先安装：https://github.com/astral-sh/uv"
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
  # 给 venv38 装 pip（如果缺）
  printf '& "%s" -m ensurepip --default-pip\n' "${PY38_BIN_NATIVE//\'/''}" > "${PS_TMP}"
  PS_TMP_NATIVE="$(to_windows_path "${PS_TMP}")"
  "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}" 2>&1 | tail -n 3 || true
fi

# 验证 venv38 能跑
"${PY38_BIN}" -c "import requests" >/dev/null 2>&1 \
  || die "venv38 不可用，请检查 ${PY38_BIN}"

log "venv38 OK."

# ----------------------------------------------------------------------------
# 3. 安装 SWE-Bench-CL 仓库（按 SEQUENCES 选择）
# ----------------------------------------------------------------------------
log "=== STEP 3/5: install repo source into venv38 ==="

# 从 DATASET 中找本次要跑的仓库
DATASET_NATIVE="$(to_windows_path "${DATASET}")"
# 把 Python 脚本写到临时文件，绕过 heredoc 与 Windows Python 路径展开的冲突
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
# 清掉 Windows-style CRLF，否则 bash 会试图执行 ``repo\r`` 当命令
PICK_REPOS="$(printf '%s' "${PICK_REPOS}" | tr -d '\r')"

if [[ -z "${PICK_REPOS}" ]]; then
  log "No repo to install (SEQUENCES 可能为空)."
else
  # 防冲突：单次脚本启动只装 PICK_REPOS 里的**第一个**
  PICK_REPOS_FIRST="$(printf '%s\n' "${PICK_REPOS}" | sed -n '1p')"
  EXTRA_REPOS="$(printf '%s\n' "${PICK_REPOS}" | sed -n '2p')"
  if [[ -n "${EXTRA_REPOS}" ]]; then
    log "[WARN] SEQUENCES 包含多个 repo（${PICK_REPOS// /, }）。venv38 一次只能装 1 个。"
    log "[WARN] 本次只装：${PICK_REPOS_FIRST}；其余请分次跑："
    for r in ${EXTRA_REPOS}; do
      log "       SEQUENCES=$r SEQ_TASK_LIMIT=0 bash ./run_openloomi_swe.sh"
    done
    PICK_REPOS="${PICK_REPOS_FIRST}"
  fi
  log "Repos: ${PICK_REPOS}"
  for repo in ${PICK_REPOS}; do
    # 把 django/django → cloned_repos/django__django
    sanitized="${repo//\//__}"
    repo_dir="${CLONED_DIR}/${sanitized}"
    log "  ${repo}: ${repo_dir}"
    if [[ ! -d "${repo_dir}" ]]; then
      log "    cloning..."
      mkdir -p "${CLONED_DIR}"
      git clone "https://github.com/${repo}.git" "${repo_dir}" || \
        log "    [WARN] git clone failed for ${repo}, will skip"
    fi
    # 对 Python 仓库：用 uv 把源码装进 venv38（harness 跑测试时使用）
    if [[ "${SKIP_DJANGO_INSTALL}" != "1" && ( -f "${repo_dir}/setup.py" || -f "${repo_dir}/pyproject.toml" ) ]]; then
      log "    installing repo source into venv38 (editable/develop mode)..."
      REPO_DIR_NATIVE="$(to_windows_path "${repo_dir}")"
      PY38_NATIVE="$(to_windows_path "${PY38_BIN}")"
      # 通过 powershell 调 venv38 自己的 python install。
      # 用 ``-e`` (editable/develop) 模式：venv 里的 import 直接走 working tree，
      # 不在 site-packages 里复制 .py 文件 —— 彻底避开 setup.py install 留下的
      # stale 文件问题（曾导致 site-packages/django/core/ 等子目录被错改成
      # ``~ore/`` 形式，跑测试时 ModuleNotFoundError → 所有 FAIL_TO_PASS 报 UNKNOWN）。
      # 不再需要单独跑 stale cleanup。
      cat > "${PS_TMP}" <<PSX
& "${PY38_NATIVE}" -m pip install -e "${REPO_DIR_NATIVE}" 2>&1 | Select-Object -Last 5
PSX
      "${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}" \
        || log "    [WARN] pip install -e ${repo} into venv38 failed"
    fi
  done
fi

# ----------------------------------------------------------------------------
# 4. 跑 eval_procedure
# ----------------------------------------------------------------------------
log "=== STEP 4/5: run eval_procedure.py ==="

EVAL_PYTHON_VAL="${PY38_BIN}"
EVAL_PYTHON_VAL_NATIVE="$(to_windows_path "${PY38_BIN}")"

# 环境变量串
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

# 跑 no_mem
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

# 跑 mem
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
# 5. 汇总结果
# ----------------------------------------------------------------------------
log "=== STEP 5/5: summarize ==="
RESULTS_FILE="${HARNESS_DIR}/swe_agent_cl_results.json"
ANALYSIS_FILE="${HARNESS_DIR}/swe_agent_cl_analysis.json"

if [[ -f "${RESULTS_FILE}" ]]; then
  log "Results:   ${RESULTS_FILE}"
  log "Analysis:  ${ANALYSIS_FILE}"
  # 把 summarize 脚本写到 harness 内临时文件，给 Windows python 跑
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