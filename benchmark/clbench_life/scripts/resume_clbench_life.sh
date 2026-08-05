#!/usr/bin/env bash
# Resume CL-bench-Life: clean up failed checkpoints, then re-run the benchmark.
#
# Usage:
#   bash scripts/resume_clbench_life.sh
#
# Or with explicit override of the checkpoint directory:
#   CHECKPOINT_DIR=/path/to/checkpoints bash scripts/resume_clbench_life.sh
#
# What this script does:
#   1. Scans the checkpoint directory for files whose `response` field starts
#      with "Error:" or "ERROR:" (agent call failures, timeouts, etc.).
#   2. Moves those files into a timestamped backup directory so the resume
#      logic will treat them as not-yet-done and re-evaluate them.
#   3. Invokes `pnpm benchmark` which uses the cleaned checkpoints and
#      evaluates any missing tasks.

set -euo pipefail

# -------- Configuration ------------------------------------------------------
PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECKPOINT_DIR="${CHECKPOINT_DIR:-D:/openloomi_val_results/clbench_life/checkpoints/clbench-life}"
DATASET="${DATASET:-$PACKAGE_DIR/dataset/clbench-life.jsonl}"
BENCHMARK_TYPE="${BENCHMARK_TYPE:-clbench-life}"
OUTPUT="${OUTPUT:-D:/openloomi_val_results/clbench_life/results/clbench_life_result_resumed.json}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="$(dirname "$CHECKPOINT_DIR")/_trash_resumed_$STAMP"

# -------- Helpers ------------------------------------------------------------
die() {
  echo "[resume] error: $*" >&2
  exit 1
}

note() {
  echo "[resume] $*"
}

# Detect whether a checkpoint file's response field is an error prefix.
# Reads JSON via python (always available on Git Bash / WSL).
is_error_checkpoint() {
  local file="$1"
  python - "$file" <<'PY'
import json, sys
p = sys.argv[1]
try:
    with open(p, "r", encoding="utf-8") as f:
        obj = json.load(f)
    resp = obj.get("response", "")
    sys.exit(0 if (isinstance(resp, str) and (resp.startswith("Error:") or resp.startswith("ERROR:"))) else 1)
except Exception:
    sys.exit(2)
PY
}

# -------- Step 1: preflight --------------------------------------------------
note "package dir   : $PACKAGE_DIR"
note "checkpoint dir: $CHECKPOINT_DIR"
note "dataset       : $DATASET"
note "backup dir    : $BACKUP_DIR"
note "output        : $OUTPUT"

[ -d "$CHECKPOINT_DIR" ] || die "checkpoint dir not found: $CHECKPOINT_DIR"
[ -f "$DATASET" ]        || die "dataset not found: $DATASET"
command -v python >/dev/null 2>&1 || die "python is required (used by is_error_checkpoint)"
command -v pnpm   >/dev/null 2>&1 || die "pnpm not found in PATH"

# -------- Step 2: clean failed checkpoints ----------------------------------
mkdir -p "$BACKUP_DIR"

note "scanning for failed checkpoints..."

# Build the move list first so the move phase never gets confused mid-loop.
mapfile -t error_files < <(
  find "$CHECKPOINT_DIR" -maxdepth 1 -type f -name "*.json" -print0 |
  while IFS= read -r -d '' f; do
    if is_error_checkpoint "$f" >/dev/null 2>&1; then
      printf '%s\0' "$f"
    fi
  done
)

total_to_move=${#error_files[@]}
note "found $total_to_move failed checkpoint(s) to move"

moved=0
move_failed=0
if [ "$total_to_move" -gt 0 ]; then
  for f in "${error_files[@]}"; do
    if mv -f "$f" "$BACKUP_DIR/"; then
      moved=$((moved + 1))
    else
      move_failed=$((move_failed + 1))
    fi
  done
fi

remaining=$(find "$CHECKPOINT_DIR" -maxdepth 1 -type f -name "*.json" | wc -l | tr -d ' ')

note "moved        : $moved"
note "move failed  : $move_failed"
note "source left  : $remaining"
note "backup at    : $BACKUP_DIR"

# -------- Step 3: resume the benchmark --------------------------------------
cd "$PACKAGE_DIR"

if [ ! -d node_modules ]; then
  note "node_modules missing, running pnpm install..."
  pnpm install
fi

note "running benchmark..."
export CLBENCH_CHECKPOINT_DIR="$CHECKPOINT_DIR"

pnpm benchmark -- \
  --dataset "$DATASET" \
  --benchmark "$BENCHMARK_TYPE" \
  --output "$OUTPUT"

note "done. summary written to $OUTPUT"
note "failed checkpoints are preserved at $BACKUP_DIR"