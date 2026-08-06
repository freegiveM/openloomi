#!/usr/bin/env bash
# Final fix v2: rewrite clbench wrapper to explicitly prepend src/ to sys.path
# (instead of relying on .pth files which don't always activate in shebang-launched scripts).
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/fix-wrapper.sh

set -u

VENV="/mnt/d/clbench-work/continual-learning-bench/.venv"
PY="$VENV/bin/python3.13"
WRAPPER="$VENV/bin/clbench"
SRC_DIR="/mnt/d/clbench-work/continual-learning-bench/src"

[ -x "$PY" ] || { echo "FAIL: $PY does not exist"; exit 1; }
[ -d "$SRC_DIR" ] || { echo "FAIL: $SRC_DIR does not exist"; exit 1; }

cat > "$WRAPPER" <<EOF
#!/usr/bin/env $PY
import sys
sys.path.insert(0, "$SRC_DIR")
from src.cli import main
if __name__ == "__main__":
    sys.exit(main())
EOF
chmod +x "$WRAPPER"

echo "==== wrapper content ===="
cat "$WRAPPER"
echo ""
echo "==== sanity check: clbench list ===="
"$WRAPPER" list 2>&1 | head -60
EXIT=$?
echo ""
echo "==== exit code: $EXIT ===="
