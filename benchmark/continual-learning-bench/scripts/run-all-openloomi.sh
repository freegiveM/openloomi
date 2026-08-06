#!/usr/bin/env bash
# Run every CL-bench task against the OpenLoomi system.
# Run inside WSL Ubuntu (NOT Windows PowerShell).
#
# Prereqs already done (in this order):
#   1. OpenLoomi dev server running on port 3515 (token in ~/.openloomi/token)
#   2. Docker CE installed inside WSL (dockerd running)
#   3. clbench setup --all (or at least the per-task setup commands below)
#   4. CL-bench .venv exists at /mnt/d/clbench-work/continual-learning-bench/.venv
#      and its bin/clbench wrapper works
#
# Usage:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/run-all-openloomi.sh
#   bash .../run-all-openloomi.sh --quick            # 1 stage / 3 runs / 5 instances per task
#   bash .../run-all-openloomi.sh --full             # default schedule (5 stages / 5 runs / 50 instances)
#   bash .../run-all-openloomi.sh --task exploitable_poker   # just one task
#   bash .../run-all-openloomi.sh --model claude-sonnet-4-5

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"
CLBENCH="$REPO/.venv/bin/clbench"

# ---- argument parsing -----------------------------------------------------
MODE="default"     # default | quick | full | <schedule name>
TARGET_TASK=""     # empty = all tasks
MODEL="claude-sonnet-4-5"
SKIP_SETUP=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --quick) MODE="quick"; shift ;;
        --full)  MODE="full"; shift ;;
        --default-schedule) MODE="default"; shift ;;
        --task) TARGET_TASK="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --skip-setup) SKIP_SETUP=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }
err()  { printf "\033[1;31m%s\033[0m\n" "$*"; }

bold "Run-all OpenLoomi"
echo "  REPO  = $REPO"
echo "  CLB   = $CLBENCH"
echo "  MODE  = $MODE"
echo "  TASK  = ${TARGET_TASK:-<all>}"
echo "  MODEL = $MODEL"

# ---- prereq checks --------------------------------------------------------
[ -x "$CLBENCH" ] || { err "clbench wrapper not found at $CLBENCH"; exit 1; }
ok "clbench wrapper: $($CLBENCH --version 2>&1 | head -1)"

command -v docker >/dev/null 2>&1 || { err "docker CLI not in PATH"; exit 1; }
docker info >/dev/null 2>&1 || { err "dockerd not running; start it with: sudo nohup dockerd > /tmp/dockerd.log 2>&1 &"; exit 1; }
ok "docker: $(docker --version)"

curl -sS --max-time 3 http://172.31.224.1:3515/ -o /dev/null -w "OpenLoomi TCP: %{http_code}\n" \
    || warn "OpenLoomi not reachable at 172.31.224.1:3515 (run start-openloomi.ps1 in another PowerShell window)"

# ---- setup (optional) -----------------------------------------------------
if [ "$SKIP_SETUP" -eq 0 ]; then
    bold "Step 1: per-task setup (idempotent, skips already-downloaded files)"
    for task in ${TARGET_TASK:-database_exploration sales_prediction codebase_adaptation exploitable_poker cohort_studies blind_spectrum_monitoring}; do
        # Only run setup for tasks that declare has_setup.
        if "$CLBENCH" inspect task "$task" 2>/dev/null | grep -qE 'has_setup = True|has_setup: True'; then
            echo "--- setup $task ---"
            if [ "$task" = "database_exploration" ]; then
                # Use HF mirror for CN networks.
                HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" "$CLBENCH" setup "$task" 2>&1 | tail -5 || warn "$task setup failed (continuing)"
            else
                "$CLBENCH" setup "$task" 2>&1 | tail -5 || warn "$task setup failed (continuing)"
            fi
        else
            echo "--- $task: no setup needed ---"
        fi
    done
fi

# ---- per-task run ---------------------------------------------------------
bold "Step 2: run tasks"
cd "$REPO" || exit 1

# Schedule mapping by task. "default" = the task's own default schedule.
# "quick" = 1-stage 3-run 5-instance fast pass.
# "full"  = same as "default" for now.
schedule_for() {
    local task="$1"
    case "$MODE" in
        quick) echo "quick_test" ;;
        full)  echo "default" ;;
        *)     echo "default" ;;   # default mode = each task's default schedule
    esac
}

run_task() {
    local task="$1"
    local schedule
    schedule=$(schedule_for "$task")
    bold ">>> RUN $task  (schedule=$schedule, system=openloomi, model=$MODEL)"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "DRY: $CLBENCH run $task --schedule $schedule --system openloomi --system.model $MODEL"
        return 0
    fi
    "$CLBENCH" run "$task" \
        --schedule "$schedule" \
        --system openloomi \
        --system.model "$MODEL" \
        2>&1 | tail -25
    echo ""
    echo "Artifacts for $task:"
    ls -lah "$REPO/results/$task/" 2>/dev/null | tail -5
    echo ""
}

# Order: lightweight to heavyweight so we fail fast on bugs.
TASKS_DEFAULT="exploitable_poker cohort_studies blind_spectrum_monitoring database_exploration sales_prediction codebase_adaptation"
TASKS="${TARGET_TASK:-$TASKS_DEFAULT}"

for task in $TASKS; do
    run_task "$task"
done

bold "Step 3: aggregate"
echo "All results:"
ls -lah "$REPO/results/" 2>/dev/null
echo ""
echo "Open the live dashboard for any of these:"
find "$REPO/results" -name "manifest.json" 2>/dev/null | head -5

bold "DONE"
ok "All tasks finished. Viewers live under $REPO/results/<task>/"
