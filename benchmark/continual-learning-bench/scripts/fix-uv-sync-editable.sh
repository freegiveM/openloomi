#!/usr/bin/env bash
# Final workaround for the cl-benchmark editable-wheel + python launcher issue.
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/fix-uv-sync-editable.sh

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"
VENV="$REPO/.venv"
SRC_DIR="/mnt/d/clbench-work/continual-learning-bench/src"

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }

bold "Step 1: ensure uv works and venv exists"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
uv --version || { warn "uv broken"; exit 1; }
if [ ! -x "$VENV/bin/python3.13" ]; then
    warn "no venv at $VENV; creating one"
    cd "$REPO" || exit 1
    uv venv --python 3.13 2>&1 | tail -3
fi
ok "venv: $($VENV/bin/python3.13 --version)"

bold "Step 2: install all runtime deps via uv pip"
cd "$REPO" || exit 1
export UV_LINK_MODE=copy
uv pip install \
    "huggingface-hub>=0.23.0" \
    "litellm==1.81.6" \
    "openai==2.16.0" \
    "pre-commit==4.5.1" \
    "pydantic==2.12.5" \
    "python-dotenv==1.2.1" \
    "scipy>=1.14.0" \
    "tqdm==4.67.2" \
    "texasholdem==0.11.0" \
    "matplotlib==3.10.8" \
    "datasets==4.6.0" \
    "mini-swe-agent==2.2.4" \
    "swebench==4.1.0" \
    "pandas>=2.2" \
    "numpy>=2.1" \
    "scikit-learn>=1.6" \
    "pyyaml>=6.0" \
    "lifelines>=0.29" \
    "pytest==9.0.2" \
    "ruff==0.14.8" \
    "vulture>=2.16" \
    2>&1 | tail -8

bold "Step 3: expose src/ via .pth so 'import src.cli' works"
# Find the venv's site-packages directory (handles python version variance).
SITE_DIR="$("$VENV/bin/python3.13" -c "import site; print(site.getsitepackages()[0])")"
ok "site-packages: $SITE_DIR"

PTH_FILE="$SITE_DIR/_clbenchmark_src.pth"
# .pth files must be a SINGLE LINE that is a path string. python adds it to sys.path.
printf '%s\n' "$SRC_DIR" > "$PTH_FILE"
ok "Wrote .pth:"
cat "$PTH_FILE"

# Sanity check: python can import the package
"$VENV/bin/python3.13" -c "import src.cli; print('src.cli import OK, main =', src.cli.main)" \
    || { warn "src.cli import failed"; exit 1; }

bold "Step 4: write clbench wrapper that uses python3.13 directly"
WRAPPER="$VENV/bin/clbench"
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env python3.13
import sys
from src.cli import main
if __name__ == "__main__":
    sys.exit(main())
EOF
chmod +x "$WRAPPER"
# Verify
ls -la "$WRAPPER"
ok "Wrapper written."

bold "Step 5: clbench list sanity check"
"$WRAPPER" list 2>&1 | head -60

bold "DONE"
ok "If clbench list printed tasks/systems above, you're good."
echo ""
echo "Run benchmarks with:"
echo "  $WRAPPER run exploitable_poker --schedule quick_test --system openloomi --system.model claude-sonnet-4-5"
