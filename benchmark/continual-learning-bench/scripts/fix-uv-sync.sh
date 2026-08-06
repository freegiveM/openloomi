#!/usr/bin/env bash
# Re-try uv sync using official PyPI for hf-xet (Aliyun mirror ships a broken wheel).
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/fix-uv-sync.sh

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }

bold "Step 1: pick PyPI index"
# Use Aliyun for most packages, but fall back to official PyPI for the bad hf-xet wheel.
# UV_INDEX_URL controls everything; the issue is the broken wheel is also on Aliyun.
# Switch to official PyPI for the whole sync (it has the same files plus correct hf-xet).
export UV_INDEX_URL="https://pypi.org/simple/"
# Add Aliyun as fallback for speed on big packages.
# export UV_EXTRA_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
ok "Using official PyPI for this sync (Aliyun's hf-xet wheel is broken)."

bold "Step 2: force --link-mode=copy to avoid WSL hardlink warnings"
export UV_LINK_MODE=copy

bold "Step 3: uv sync --all-extras"
cd "$REPO" || { warn "repo not found at $REPO"; exit 1; }
uv sync --all-extras 2>&1 | tail -30 || warn "uv sync had warnings"

bold "Step 4: clbench list sanity check"
uv run clbench list 2>&1 | head -60

bold "DONE"
ok "Setup complete if clbench list printed tasks and systems."
