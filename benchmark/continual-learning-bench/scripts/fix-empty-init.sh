#!/usr/bin/env bash
# Diagnose & fix: the 0-byte src/__init__.py is the root cause of the import failure.
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/fix-empty-init.sh

set -u

REPO="/mnt/d/clbench-work/continual-learning-bench"
INIT_PY="$REPO/src/__init__.py"

echo "==== current __init__.py ===="
ls -la "$INIT_PY"
echo "--- content (should be 0 bytes) ---"
wc -c "$INIT_PY"
od -c "$INIT_PY" | head -3

echo ""
echo "==== writing a real __init__.py (this is what every Python package needs) ===="
# Empty __init__.py is legal but apparently broken on this WSL/9P combo.
# Replace with a comment so the file is non-empty and has a clear mtime.
cat > "$INIT_PY" <<'EOF'
"""cl-benchmark: continual learning benchmark framework."""
EOF
ls -la "$INIT_PY"
wc -c "$INIT_PY"
echo "--- new content ---"
cat "$INIT_PY"

echo ""
echo "==== test: can we import now? ===="
PY="$REPO/.venv/bin/python3.13"
"$PY" -c "import sys; sys.path.insert(0, '$REPO'); import src.cli; print('OK:', src.cli.main)" 2>&1

echo ""
echo "==== rewrite wrapper to cd into REPO before import (most robust) ===="
WRAPPER="$REPO/.venv/bin/clbench"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env $REPO/.venv/bin/python3.13
import os
import sys
HERE = "$REPO"
os.chdir(HERE)
sys.path.insert(0, HERE)
from src.cli import main
if __name__ == "__main__":
    sys.exit(main())
EOF
chmod +x "$WRAPPER"
echo "--- new wrapper content ---"
cat "$WRAPPER"

echo ""
echo "==== sanity check: clbench list ===="
"$WRAPPER" list 2>&1 | head -60
echo "exit=$?"
