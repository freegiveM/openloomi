#!/usr/bin/env bash
# Diagnose why src import fails from the wrapper.
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/diag-import.sh

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"
PY="$REPO/.venv/bin/python3.13"

echo "==== 1: does src/ exist? ===="
ls -la "$REPO" | head -5
echo "--- src/ contents ---"
ls -la "$REPO/src" 2>&1 | head -20
echo ""
echo "==== 2: which directory actually resolves to src/? ===="
# Different filesystems / case sensitivity can hide the dir.
find "$REPO" -maxdepth 2 -type d -name src 2>&1
echo ""
echo "==== 3: try direct import with sys.path ===="
"$PY" <<'EOF'
import sys
print("python:", sys.executable)
print("version:", sys.version)
sys.path.insert(0, "/mnt/d/clbench-work/continual-learning-bench/src")
print("sys.path[0]:", sys.path[0])
try:
    import src.cli
    print("src.cli OK, main =", src.cli.main)
except Exception as e:
    print("FAIL:", type(e).__name__, e)
EOF
echo ""
echo "==== 4: check wrapper content again (bytes may have stray BOM) ===="
file "$REPO/.venv/bin/clbench"
echo "--- raw bytes (first 200) ---"
head -c 200 "$REPO/.venv/bin/clbench" | od -c | head -10
