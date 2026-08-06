#!/usr/bin/env bash
# run-clbench-on-openloomi.sh
# One-shot: take a fresh Windows machine to a running CL-bench evaluation against
# the local OpenLoomi service.
#
# This script is meant to be run inside WSL Ubuntu. It does NOT need sudo
# (it tolerates either root or non-root) and it is idempotent: re-running it
# skips work that is already done (uv venv, docker images, OpenLoomi .env).
#
# Pipeline:
#   1. Detect environment (WSL, user, Windows host IP, free RAM, free disk)
#   2. Ensure WSL-visible OpenLoomi config (env, token path)
#   3. Ensure Docker CE is installed and running inside WSL
#   4. Ensure CL-bench repo is cloned and venv is built
#   5. Verify OpenLoomi HTTP is reachable from WSL
#   6. Run a smoke test (one task, quick_test schedule) so you can see end-to-end
#      behavior. Pass --full to run the real per-task default schedule.
#   7. If --all, run every task sequentially.
#
# Usage:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/run-clbench-on-openloomi.sh
#   bash .../run-clbench-on-openloomi.sh --task exploitable_poker
#   bash .../run-clbench-on-openloomi.sh --full
#   bash .../run-clbench-on-openloomi.sh --all
#   bash .../run-clbench-on-openloomi.sh --model claude-sonnet-4-5
#   bash .../run-clbench-on-openloomi.sh --skip-docker
#   bash .../run-clbench-on-openloomi.sh --dry-run

set -u

# ============================================================
# Defaults
# ============================================================
REPO_WIN="D:\clbench-work\continual-learning-bench"
REPO_LINUX="/mnt/d/clbench-work/continual-learning-bench"
SCRIPTS_WIN="D:\openloomi3\openloomi\benchmark\continual-learning-bench\scripts"
SCRIPTS_LINUX="/mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts"
TOKEN_FILE_LINUX="/mnt/c/Users/32274/.openloomi/token"
ENV_FILE="$REPO_LINUX/.env"
VENV="$REPO_LINUX/.venv"
CLBENCH="$VENV/bin/clbench"
PY="$VENV/bin/python3.13"
HOST_IP_DEFAULT="172.31.224.1"
OPENLOOMI_PORT=3515
OPENLOOMI_URL="http://${HOST_IP_DEFAULT}:${OPENLOOMI_PORT}"
MODEL="claude-sonnet-4-5"
TASK=""
MODE="quick"            # quick | full
RUN_ALL=0
SKIP_DOCKER=0
SKIP_SETUP=0
SKIP_OPENLOOMI_CHECK=0
DRY_RUN=0
REQUIRED_IMAGES=(
    "pgasawa2/continual-learning-bench:sales-prediction"
    "pgasawa2/continual-learning-bench:tablib"
    "pgasawa2/continual-learning-bench:tenacity"
)

# ============================================================
# Tiny styling
# ============================================================
bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }
err()  { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }
hr()   { printf -- "----------------------------------------\n"; }

# ============================================================
# Argument parsing
# ============================================================
while [ $# -gt 0 ]; do
    case "$1" in
        --task)   TASK="$2"; shift 2 ;;
        --quick)  MODE="quick"; shift ;;
        --full)   MODE="full"; shift ;;
        --all)    RUN_ALL=1; shift ;;
        --model)  MODEL="$2"; shift 2 ;;
        --skip-docker) SKIP_DOCKER=1; shift ;;
        --skip-setup)  SKIP_SETUP=1; shift ;;
        --skip-openloomi-check) SKIP_OPENLOOMI_CHECK=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,40p' "$0"
            exit 0 ;;
        *) err "Unknown arg: $1"; exit 1 ;;
    esac
done

# ============================================================
# Step 1: environment detection
# ============================================================
bold "Step 1: environment detection"
IS_WSL=0
if [ -f /proc/version ] && grep -qiE "microsoft|wsl" /proc/version; then
    IS_WSL=1
fi
if [ "$IS_WSL" -ne 1 ]; then
    err "This script must run inside WSL Ubuntu (not Windows PowerShell)."
    err "Open PowerShell and run: wsl"
    exit 1
fi
ok "WSL: yes ($(uname -r))"

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT=1
    sudo() { "$@"; }
    ok "user: root (sudo passthrough)"
else
    ok "user: $(whoami)"
fi

# Best-effort Windows host IP. Default to 172.31.224.1, but allow override.
HOST_IP="$HOST_IP_DEFAULT"
if [ -f /etc/resolv.conf ]; then
    DETECTED=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || true)
    if [ -n "$DETECTED" ]; then
        HOST_IP="$DETECTED"
    fi
fi
OPENLOOMI_URL="http://${HOST_IP}:${OPENLOOMI_PORT}"
ok "Windows host IP: $HOST_IP"
ok "OpenLoomi URL:    $OPENLOOMI_URL"

FREE_RAM_GB=$(awk '/^MemAvailable:/{printf "%.1f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "?")
FREE_DISK_GB=$(df -BG "$REPO_LINUX" 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}')
ok "free RAM: ${FREE_RAM_GB} GB | free disk (D:): ${FREE_DISK_GB:-?} GB"

# ============================================================
# Step 2: OpenLoomi env (.env, token)
# ============================================================
bold "Step 2: OpenLoomi config"
if [ ! -f "$TOKEN_FILE_LINUX" ]; then
    err "OpenLoomi token not found at $TOKEN_FILE_LINUX"
    err "Fix: start OpenLoomi once (it writes the token on first run), or copy an existing one there."
    exit 1
fi
TOK_BYTES=$(wc -c < "$TOKEN_FILE_LINUX")
ok "OpenLoomi token: $TOKEN_FILE_LINUX ($TOK_BYTES bytes)"

if [ ! -f "$ENV_FILE" ]; then
    warn ".env missing at $ENV_FILE, creating from .env.openloomi.example"
    EXAMPLE="$REPO_LINUX/.env.openloomi.example"
    if [ -f "$EXAMPLE" ]; then
        cp "$EXAMPLE" "$ENV_FILE"
        # Patch the actual host IP
        sed -i "s|^OPENLOOMI_BASE_URL=.*|OPENLOOMI_BASE_URL=${OPENLOOMI_URL}|" "$ENV_FILE"
        sed -i "s|^OPENLOOMI_TOKEN_PATH=.*|OPENLOOMI_TOKEN_PATH=${TOKEN_FILE_LINUX}|" "$ENV_FILE"
        ok ".env created with base_url=$OPENLOOMI_URL"
    else
        cat > "$ENV_FILE" <<EOF
OPENLOOMI_BASE_URL=${OPENLOOMI_URL}
OPENLOOMI_TOKEN_PATH=${TOKEN_FILE_LINUX}
OPENLOOMI_AGENT=default
EOF
        warn ".env.openloomi.example also missing; wrote minimal .env"
    fi
else
    ok ".env present at $ENV_FILE"
fi

# ============================================================
# Step 3: Docker CE inside WSL
# ============================================================
if [ "$SKIP_DOCKER" -eq 0 ]; then
    bold "Step 3: Docker CE"
    if ! command -v docker >/dev/null 2>&1; then
        err "docker not installed."
        err "Run install: bash $SCRIPTS_LINUX/install-docker-ce.sh"
        exit 1
    fi
    ok "docker: $(docker --version)"

    # Try to talk to dockerd; if not, restart it.
    if ! docker info >/dev/null 2>&1; then
        warn "dockerd not running; restarting"
        PID=$(cat /var/run/docker.pid 2>/dev/null || true)
        if [ -n "$PID" ]; then
            kill -9 "$PID" 2>/dev/null || true
        fi
        rm -f /var/run/docker.pid /var/run/docker.sock
        nohup dockerd > /tmp/dockerd.log 2>&1 &
        disown
        sleep 6
    fi
    if ! docker info >/dev/null 2>&1; then
        err "dockerd still not running. Last log lines:"
        tail -15 /tmp/dockerd.log >&2
        exit 1
    fi
    ok "dockerd: $(docker info 2>&1 | grep '^Server Version' | head -1)"

    # Pull missing images.
    for IMG in "${REQUIRED_IMAGES[@]}"; do
        if docker image inspect "$IMG" >/dev/null 2>&1; then
            ok "image present: $IMG"
        else
            warn "pulling: $IMG (may take a few minutes)"
            docker pull "$IMG" 2>&1 | tail -3 || warn "  pull failed; some tasks may not work"
        fi
    done
else
    warn "Step 3 skipped (--skip-docker)"
fi

# ============================================================
# Step 4: CL-bench repo + venv
# ============================================================
bold "Step 4: CL-bench repo and venv"
if [ ! -d "$REPO_LINUX" ]; then
    err "Repo not found at $REPO_LINUX"
    err "Run from Windows: git clone https://github.com/pgasawa/continual-learning-bench D:\\clbench-work\\continual-learning-bench"
    exit 1
fi
ok "repo: $REPO_LINUX"

# The empty __init__.py bug: ensure src/__init__.py has bytes.
INIT="$REPO_LINUX/src/__init__.py"
if [ -f "$INIT" ] && [ ! -s "$INIT" ]; then
    warn "src/__init__.py is empty; rewriting (WSL 9P filesystem bug)"
    printf '"""cl-benchmark: continual learning benchmark framework."""\n' > "$INIT"
fi
ok "src/__init__.py: $(wc -c < "$INIT") bytes"

# Ensure venv exists.
if [ ! -x "$PY" ]; then
    warn "venv missing or wrong python; creating with uv"
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
    cd "$REPO_LINUX"
    uv venv --python 3.13 2>&1 | tail -3
fi
ok "venv: $($PY --version)"

# Install all runtime deps if any are missing.
MISSING=$("$PY" -c "import litellm,pydantic,huggingface_hub" 2>&1 | grep -c "ModuleNotFoundError" || true)
if [ "$MISSING" -gt 0 ]; then
    warn "runtime deps missing; installing via uv pip"
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
    export UV_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
    export UV_LINK_MODE=copy
    cd "$REPO_LINUX"
    uv pip install \
        "huggingface-hub>=0.23.0" "litellm==1.81.6" "openai==2.16.0" \
        "pre-commit==4.5.1" "pydantic==2.12.5" "python-dotenv==1.2.1" \
        "scipy>=1.14.0" "tqdm==4.67.2" "texasholdem==0.11.0" \
        "matplotlib==3.10.8" "datasets==4.6.0" "mini-swe-agent==2.2.4" \
        "swebench==4.1.0" "pandas>=2.2" "numpy>=2.1" "scikit-learn>=1.6" \
        "pyyaml>=6.0" "lifelines>=0.29" "pytest==9.0.2" "ruff==0.14.8" \
        "vulture>=2.16" 2>&1 | tail -5
fi
ok "deps: installed"

# Make sure src/ is importable and the clbench wrapper exists.
SITE_DIR="$("$PY" -c "import site; print(site.getsitepackages()[0])")"
PTH="$SITE_DIR/_clbenchmark_src.pth"
if [ ! -f "$PTH" ] || [ "$(cat "$PTH")" != "$REPO_LINUX/src" ]; then
    printf '%s\n' "$REPO_LINUX/src" > "$PTH"
    ok "wrote $PTH"
fi

if [ ! -x "$CLBENCH" ]; then
    cat > "$CLBENCH" <<EOF
#!/usr/bin/env $PY
import os, sys
HERE = "$REPO_LINUX"
os.chdir(HERE)
sys.path.insert(0, HERE)
from src.cli import main
if __name__ == "__main__":
    sys.exit(main())
EOF
    chmod +x "$CLBENCH"
    ok "wrote $CLBENCH wrapper"
fi

# Sanity: import works and clbench list runs.
"$PY" -c "import sys; sys.path.insert(0, '$REPO_LINUX/src'); import src.cli; print('import ok')" \
    || { err "src.cli import failed"; exit 1; }
"$CLBENCH" list >/dev/null 2>&1 \
    && ok "clbench list works" \
    || warn "clbench list returned non-zero (some task modules may be missing)"

# ============================================================
# Step 5: OpenLoomi HTTP reachable
# ============================================================
if [ "$SKIP_OPENLOOMI_CHECK" -eq 0 ]; then
    bold "Step 5: OpenLoomi HTTP"
    CODE=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "$OPENLOOMI_URL/" 2>/dev/null || echo "000")
    case "$CODE" in
        200|401|403) ok "OpenLoomi HTTP: $CODE (reachable)" ;;
        000)
            err "OpenLoomi not reachable at $OPENLOOMI_URL"
            err "Start it from Windows PowerShell:"
            err "  powershell -ExecutionPolicy Bypass -File $SCRIPTS_WIN\\start-openloomi-minimal.ps1"
            err "It will block that PowerShell window; open another PowerShell for CL-bench."
            exit 1
            ;;
        *) warn "OpenLoomi HTTP: $CODE (unexpected but server is up)" ;;
    esac
else
    warn "Step 5 skipped (--skip-openloomi-check)"
fi

# ============================================================
# Step 6: per-task setup (idempotent)
# ============================================================
if [ "$SKIP_SETUP" -eq 0 ]; then
    bold "Step 6: per-task setup (idempotent)"
    for t in database_exploration sales_prediction codebase_adaptation exploitable_poker cohort_studies blind_spectrum_monitoring; do
        if "$CLBENCH" inspect task "$t" 2>/dev/null | grep -qE 'has_setup = True|has_setup: True'; then
            echo "--- setup $t ---"
            if [ "$t" = "database_exploration" ]; then
                HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" "$CLBENCH" setup "$t" 2>&1 | tail -3 || warn "  $t setup failed (HF likely unreachable)"
            else
                "$CLBENCH" setup "$t" 2>&1 | tail -3 || warn "  $t setup failed"
            fi
        else
            echo "--- $t: no setup needed ---"
        fi
    done
else
    warn "Step 6 skipped (--skip-setup)"
fi

# ============================================================
# Step 7: warmup
# ============================================================
bold "Step 7: warmup (prime Next.js chunk cache)"
ok "Probing OpenLoomi homepage to compile _next chunks..."
for i in 1 2 3; do
    CODE=$(curl -sS --max-time 120 -o /dev/null -w "%{http_code}" "$OPENLOOMI_URL/" 2>/dev/null || echo "000")
    if [ "$CODE" = "200" ]; then ok "warmup attempt $i: 200"; break; fi
    warn "warmup attempt $i: $CODE, retrying in 5s"
    sleep 5
done

# ============================================================
# Step 8: run
# ============================================================
bold "Step 8: run"
if [ "$RUN_ALL" -eq 1 ] && [ -z "$TASK" ]; then
    TARGET_TASKS="exploitable_poker cohort_studies blind_spectrum_monitoring database_exploration sales_prediction codebase_adaptation"
elif [ -n "$TASK" ]; then
    TARGET_TASKS="$TASK"
else
    TARGET_TASKS="exploitable_poker"
fi

case "$MODE" in
    quick) SCHEDULE="quick_test" ;;
    full)  SCHEDULE="default" ;;
esac

ok "model:    $MODEL"
ok "mode:     $MODE (schedule=$SCHEDULE)"
ok "tasks:    $TARGET_TASKS"

if [ "$DRY_RUN" -eq 1 ]; then
    for t in $TARGET_TASKS; do
        echo "DRY: $CLBENCH run $t --schedule $SCHEDULE --system openloomi --system.model $MODEL"
    done
    exit 0
fi

cd "$REPO_LINUX"
for t in $TARGET_TASKS; do
    bold ">>> RUN $t"
    "$CLBENCH" run "$t" \
        --schedule "$SCHEDULE" \
        --system openloomi \
        --system.model "$MODEL" \
        2>&1 | tail -20
    hr
done

bold "Step 9: results"
ls -lah "$REPO_LINUX/results/" 2>/dev/null
echo ""
echo "Open in browser:"
echo "  file:///$(echo "$REPO_LINUX" | sed 's|/mnt/c|C:|' | sed 's|/mnt/d|D:|' | sed 's|/|\\|g')\\viewers\\single_task_viewer.html"
find "$REPO_LINUX/results" -name "manifest.json" 2>/dev/null | head -5

bold "DONE"
