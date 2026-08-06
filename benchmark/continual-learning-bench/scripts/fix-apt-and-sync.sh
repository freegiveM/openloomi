#!/usr/bin/env bash
# One-shot fix:
#   1. dpkg --configure -a to clear half-installed packages from previous OOM.
#   2. Reinstall ca-certificates so curl/wget can verify TLS.
#   3. Put uv on PATH globally (symlink into /usr/local/bin).
#   4. Run uv sync with Aliyun PyPI mirror.
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/fix-apt-and-sync.sh

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }

bold "Step 1: repair dpkg state from previous OOM kill"
DEBIAN_FRONTEND=noninteractive dpkg --configure -a 2>&1 | tail -5 || warn "dpkg --configure -a had warnings (continuing)"
DEBIAN_FRONTEND=noninteractive apt-get install -f -y 2>&1 | tail -5 || warn "apt-get install -f had warnings (continuing)"

bold "Step 2: ensure ca-certificates is present (curl was failing without it)"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates 2>&1 | tail -3

bold "Step 3: re-run the small-batch base package install (idempotent)"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    curl wget git gnupg lsb-release apt-transport-https 2>&1 | tail -3
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential pkg-config 2>&1 | tail -3
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv 2>&1 | tail -3
apt-get clean
rm -rf /var/lib/apt/lists/*

bold "Step 4: ensure uv is on PATH for every new shell"
# uv installer puts binaries in ~/.local/bin. Copy/symlink into /usr/local/bin so it survives shell restarts.
if [ -x "$HOME/.local/bin/uv" ]; then
    install -m 0755 "$HOME/.local/bin/uv" /usr/local/bin/uv
    ok "uv symlinked into /usr/local/bin/uv"
else
    warn "uv not found at $HOME/.local/bin/uv; re-installing"
    if curl -fsSL --max-time 20 https://mirrors.aliyun.com/uv/install.sh -o /tmp/uv-install.sh 2>/dev/null; then
        sh /tmp/uv-install.sh
    else
        curl -LsSf https://astral.sh/uv/install.sh | sh
    fi
    install -m 0755 "$HOME/.local/bin/uv" /usr/local/bin/uv
    ok "uv re-installed and symlinked"
fi
which uv
uv --version

bold "Step 5: uv sync --all-extras (3-5 min)"
cd "$REPO" || { warn "repo not found at $REPO"; exit 1; }
export UV_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
uv sync --all-extras 2>&1 | tail -25

bold "Step 6: clbench list sanity check"
uv run clbench list 2>&1 | head -50

bold "DONE"
ok "Setup complete. Next: install Docker Desktop in Windows, then run the smoke test."
echo "  bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/run-openloomi-smoke.sh"
