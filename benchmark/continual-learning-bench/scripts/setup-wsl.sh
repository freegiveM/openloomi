#!/usr/bin/env bash
# One-shot setup for WSL Ubuntu 22.04: APT mirror, uv, CL-bench deps, sanity check.
# Run inside WSL Ubuntu (not Windows PowerShell):
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/setup-wsl.sh

# Disable -e so a single apt-get hiccup doesn't kill the whole run.
set -u

REPO_LINUX="/mnt/d/clbench-work/continual-learning-bench"

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }
err()  { printf "\033[1;31m%s\033[0m\n" "$*"; }

bold "Step 1: system info"
cat /etc/os-release | head -3
uname -a

bold "Step 2: switch APT to Aliyun mirror (only if not already)"
if [ ! -f /etc/apt/sources.list.bak ]; then
    cp /etc/apt/sources.list /etc/apt/sources.list.bak
    cat > /etc/apt/sources.list <<'EOF'
deb http://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse
deb http://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse
deb http://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse
deb http://mirrors.aliyun.com/ubuntu/ jammy-backports main restricted universe multiverse
EOF
    ok "APT switched to mirrors.aliyun.com"
else
    ok "APT mirror already configured (backup exists)"
fi

# Force IPv4 first (some campus networks have broken IPv6 routes).
echo 'Acquire::ForceIPv4 "true";' | tee /etc/apt/apt.conf.d/99force-ipv4 >/dev/null

bold "Step 3: apt update + install base packages"
apt-get update 2>&1 | tail -5 || warn "apt-get update had warnings (continuing)"
apt-get install -y --no-install-recommends \
    ca-certificates curl wget git build-essential \
    python3 python3-pip python3-venv \
    gnupg lsb-release 2>&1 | tail -10 || warn "apt-get install had warnings (continuing)"

bold "Step 4: install uv (if missing)"
if ! command -v uv >/dev/null 2>&1; then
    # Try Aliyun mirror first since astral.sh may be slow on some networks.
    if curl -fsSL --max-time 15 https://mirrors.aliyun.com/uv/install.sh -o /tmp/uv-install.sh 2>/dev/null; then
        sh /tmp/uv-install.sh
        ok "uv installed via Aliyun mirror"
    else
        warn "Aliyun uv mirror failed, falling back to astral.sh"
        curl -LsSf https://astral.sh/uv/install.sh | sh
        ok "uv installed via astral.sh"
    fi
else
    ok "uv already present: $(uv --version 2>&1 || echo unknown)"
fi
export PATH="$HOME/.local/bin:$PATH"
if ! grep -q '$HOME/.local/bin' ~/.bashrc 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

bold "Step 5: sync CL-bench dependencies"
if [ ! -d "$REPO_LINUX" ]; then
    err "Repo not found at $REPO_LINUX"
    err "Run: git clone https://github.com/pgasawa/continual-learning-bench /mnt/d/clbench-work/continual-learning-bench"
    exit 1
fi
cd "$REPO_LINUX" || { err "cd failed"; exit 1; }
ls -la | head -5
ok "Running uv sync --all-extras (this may take 2-5 minutes)..."
# Use the Aliyun PyPI mirror for the install.
export UV_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
uv sync --all-extras 2>&1 | tail -20 || warn "uv sync had warnings"

bold "Step 6: pre-commit install"
(uv run pre-commit install 2>&1 | tail -5) || warn "pre-commit install skipped"

bold "Step 7: sanity check (clbench list)"
(uv run clbench list 2>&1 | head -40) || warn "clbench list returned non-zero"

bold "Step 8: print Windows host IP for OPENLOOMI_BASE_URL"
HOST_IP=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || echo "unknown")
ok "WSL sees Windows host IP = $HOST_IP"
ok "Recommended OPENLOOMI_BASE_URL = http://${HOST_IP}:3515"

bold "DONE"
echo "Next steps:"
echo "  1. Install Docker Desktop (in Windows): D:\\downloads\\DockerDesktopInstaller.exe"
echo "  2. Copy .env:"
echo "       cp /mnt/d/clbench-work/continual-learning-bench/.env.openloomi.example \\"
echo "          /mnt/d/clbench-work/continual-learning-bench/.env"
echo "  3. Edit .env, set OPENLOOMI_BASE_URL=http://${HOST_IP}:3515 and OPENLOOMI_TOKEN_PATH"
echo "  4. Smoke test:"
echo "       cd /mnt/d/clbench-work/continual-learning-bench"
echo "       uv run clbench run exploitable_poker --schedule quick_test --system openloomi --system.model claude-sonnet-4-5"
