#!/usr/bin/env bash
# One-shot repair:
#   1. Force-remove any half-configured packages (dpkg --remove --force-remove-reinstreq).
#   2. Reinstall ca-certificates, build-essential, python3 cleanly.
#   3. Reinstall uv (the previous binary segfaulted because python3-setuptools was broken).
#   4. uv sync --all-extras with Aliyun PyPI mirror.
#   5. clbench list sanity check.
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/fix-dpkg-and-sync.sh

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }

bold "Step 1: find and force-remove half-configured packages"
# Show dpkg's view of broken state.
dpkg --audit 2>&1 | head -20
# Force-remove the offending python3-setuptools-whl (and any other half-installed ones).
for pkg in $(dpkg --get-selections | awk '/hold$|reinstreq$/ {print $1}'); do
    warn "force-removing half-installed: $pkg"
    DEBIAN_FRONTEND=noninteractive dpkg --remove --force-remove-reinstreq "$pkg" 2>&1 | tail -3
done
# Some packages are unpacked-but-not-configured (state iU, cU). Purge them too.
for pkg in $(dpkg -l | awk '/^iU|^cU|^hF/ {print $2}'); do
    warn "purging unpacked/half-configured: $pkg"
    DEBIAN_FRONTEND=noninteractive dpkg --purge --force-remove-reinstreq "$pkg" 2>&1 | tail -3
done
# Try the normal configure pass after the force removes.
DEBIAN_FRONTEND=noninteractive dpkg --configure -a 2>&1 | tail -3 || true
DEBIAN_FRONTEND=noninteractive apt-get install -f -y 2>&1 | tail -3 || true

bold "Step 2: reinstall ca-certificates + base tools"
apt-get update 2>&1 | tail -3
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl wget git gnupg lsb-release apt-transport-https 2>&1 | tail -5
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential pkg-config 2>&1 | tail -3
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv 2>&1 | tail -3
apt-get clean
rm -rf /var/lib/apt/lists/*

bold "Step 3: reinstall uv (the old binary segfaulted because python3-setuptools was broken)"
rm -rf "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx" "$HOME/.local/share/uv"
# Try Aliyun mirror first.
if curl -fsSL --max-time 20 https://mirrors.aliyun.com/uv/install.sh -o /tmp/uv-install.sh 2>/dev/null; then
    sh /tmp/uv-install.sh
    ok "uv installed via Aliyun mirror"
else
    warn "Aliyun uv mirror failed, falling back to astral.sh"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ok "uv installed via astral.sh"
fi
# Symlink into /usr/local/bin so every new shell sees it.
install -m 0755 "$HOME/.local/bin/uv" /usr/local/bin/uv
uv --version || { warn "uv --version still failing; bailing"; exit 1; }

bold "Step 4: uv sync --all-extras (3-5 min)"
cd "$REPO" || { warn "repo not found at $REPO"; exit 1; }
export UV_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
uv sync --all-extras 2>&1 | tail -20

bold "Step 5: clbench list sanity check"
uv run clbench list 2>&1 | head -50

bold "DONE"
ok "Setup complete. Next: install Docker Desktop in Windows, then run the smoke test."
