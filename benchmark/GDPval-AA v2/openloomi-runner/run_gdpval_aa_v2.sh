#!/usr/bin/env bash
# run_gdpval_aa_v2.sh — End-to-end workflow for the GDPval-AA v2 evaluation
# on top of the OpenLoomi harness.
#
# What this script does (in order):
#   1. Sanity check the environment (Node, pnpm, Python, OpenLoomi server).
#   2. (Re)install pnpm workspace deps so the new package is linked.
#   3. Download / refresh the openai/gdpval gold subset (220 tasks) to
#      ../dataset/gdpval_gold.jsonl.
#   4. Run the OpenLoomi runner (`@openloomi/benchmark-gdpval-aa-v2`).
#      The runner is resumable — re-running skips tasks already in the
#      output JSON.
#   5. Convert the run summary into the pair-wise-grader-ready submission
#      JSONL under results/submissions/.
#
# Usage:
#   bash run_gdpval_aa_v2.sh                 # full 220-task run
#   bash run_gdpval_aa_v2.sh --quick 3       # smoke test on 3 tasks
#   bash run_gdpval_aa_v2.sh --provider codex --model gpt-5-codex
#   bash run_gdpval_aa_v2.sh --skip-download # dataset already on disk
#   bash run_gdpval_aa_v2.sh --skip-run      # only re-export submissions
#   bash run_gdpval_aa_v2.sh --no-resume     # start from scratch
#
# Env overrides (all optional):
#   OPENLOOMI_API_URL   default http://127.0.0.1:3515
#   OPENLOOMI_TOKEN_PATH  default ~/.openloomi/token
#   OPENLOOMI_DEFAULT_PROVIDER  default claude
#   OPENLOOMI_DEFAULT_MODEL     default claude-sonnet-4-5
#   GDPVAL_AA_V2_TASK_TIMEOUT_MS  default 1800000 (30 min)
#
# Prereqs:
#   - `pnpm tauri:dev` (or just the web server) running in another terminal.
#   - Inside the desktop app: Settings -> AI / API -> save your
#     baseUrl/apiKey/model. That's the model that will be used.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Runner lives at:  benchmark/GDPval-AA v2/openloomi-runner/
# Dataset lives at: benchmark/GDPval-AA v2/dataset/
# So the dataset is one directory up from the runner.
GDPVAL_DATASET_DIR="$SCRIPT_DIR/.."
DATASET_JSONL="$GDPVAL_DATASET_DIR/dataset/gdpval_gold.jsonl"
RESULTS_DIR="$SCRIPT_DIR/results"
RUN_JSON="$RESULTS_DIR/gdpval_aa_v2_run.json"
SUBMISSIONS_DIR="$RESULTS_DIR/submissions"
HF_TOKEN="${HF_TOKEN:-}"
LOG_PREFIX="[gdpval-aa-v2]"

# ---------------------------------------------------------------------------
# Default knobs
# ---------------------------------------------------------------------------
PROVIDER="${OPENLOOMI_DEFAULT_PROVIDER:-claude}"
MODEL="${OPENLOOMI_DEFAULT_MODEL:-claude-sonnet-4-5}"
QUICK=""
SKIP_DOWNLOAD=0
SKIP_RUN=0
NO_RESUME=0
TIMEOUT_MS="${GDPVAL_AA_V2_TASK_TIMEOUT_MS:-1800000}"
ALLOWED_TOOLS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --quick|-q) QUICK="$2"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="$2"; shift 2 ;;
    --allowed-tools) ALLOWED_TOOLS="$2"; shift 2 ;;
    --skip-download) SKIP_DOWNLOAD=1; shift ;;
    --skip-run) SKIP_RUN=1; shift ;;
    --no-resume) NO_RESUME=1; shift ;;
    --hf-token) HF_TOKEN="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,40p' "$0"; exit 0 ;;
    *)
      echo "$LOG_PREFIX unknown arg: $1" >&2
      exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------
say() { printf "%b\n" "$LOG_PREFIX $*"; }
die() { printf "%b\n" "$LOG_PREFIX ERROR: $*" >&2; exit 1; }
hr()   { printf "\n%s\n" "------------------------------------------------------------"; }

# ---------------------------------------------------------------------------
# 1. Sanity checks
# ---------------------------------------------------------------------------
hr; say "1. Sanity checks"

require_cmd() {
  # Try `command -v` first (POSIX), then `where.exe` / `which.exe` as a
  # fallback for environments where the PATH isn't fully inherited
  # (e.g. Git Bash launched from PowerShell).
  if command -v "$1" >/dev/null 2>&1; then return 0; fi
  if command -v where.exe >/dev/null 2>&1 && where.exe "$1" >/dev/null 2>&1; then return 0; fi
  if command -v which >/dev/null 2>&1 && which "$1" >/dev/null 2>&1; then return 0; fi
  die "$1 is required but not installed"
}

# If `node` / `pnpm` aren't on PATH (common in Git-Bash-from-PowerShell
# scenarios), inject the well-known Windows install paths so the rest of
# the script can run. This is a no-op on macOS / Linux.
if ! command -v node >/dev/null 2>&1; then
  for cand in /c/nodejs /c/Program\ Files/nodejs; do
    if [[ -x "$cand/node.exe" || -x "$cand/node" ]]; then
      export PATH="$cand:$PATH"
      break
    fi
  done
fi
if ! command -v pnpm >/dev/null 2>&1; then
  for cand in "$HOME/AppData/Roaming/npm" "/c/Users/32274/AppData/Roaming/npm"; do
    if [[ -d "$cand" ]]; then
      export PATH="$cand:$PATH"
      break
    fi
  done
fi

require_cmd node
require_cmd pnpm
require_cmd python
require_cmd curl

NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
PNPM_VERSION="$(pnpm --version 2>/dev/null || echo unknown)"
PY_VERSION="$(python --version 2>&1 || python3 --version 2>&1 || true)"
say "node    : $NODE_VERSION"
say "pnpm    : $PNPM_VERSION"
say "python  : $PY_VERSION"
say "cwd     : $SCRIPT_DIR"

if [[ "$PY_VERSION" != *"Python 3"* ]]; then
  die "Python 3 is required (got: $PY_VERSION)"
fi

# ---------------------------------------------------------------------------
# 2. Probe OpenLoomi server
# ---------------------------------------------------------------------------
hr; say "2. OpenLoomi server probe"

OPENLOOMI_API_URL="${OPENLOOMI_API_URL:-http://127.0.0.1:3515}"
say "checking $OPENLOOMI_API_URL/api/native/providers ..."

if ! curl -sS -m 5 "$OPENLOOMI_API_URL/api/native/providers" >/dev/null 2>&1; then
  cat >&2 <<EOF
$LOG_PREFIX ERROR: OpenLoomi server is not reachable at $OPENLOOMI_API_URL.

Did you forget to start it? In a separate terminal run:

    cd "$ROOT_DIR"
    pnpm tauri:dev

Then in the desktop app: Settings -> AI / API -> save your baseUrl /
apiKey / model. That's the model used for every task. After the
desktop app is up, re-run this script.
EOF
  exit 1
fi

# Pull bearer token (default location)
OPENLOOMI_TOKEN_PATH="${OPENLOOMI_TOKEN_PATH:-$HOME/.openloomi/token}"
if [[ ! -f "$OPENLOOMI_TOKEN_PATH" ]]; then
  say "WARN: bearer token not found at $OPENLOOMI_TOKEN_PATH (continuing anyway — the server may be in dev mode)"
else
  say "bearer token: $OPENLOOMI_TOKEN_PATH ($(wc -c < "$OPENLOOMI_TOKEN_PATH" | tr -d ' ') bytes)"
fi

# Verify /api/native/agent roundtrip with a tiny prompt
AUTH_ARGS=()
if [[ -f "$OPENLOOMI_TOKEN_PATH" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer $(tr -d '\r\n[:space:]' < "$OPENLOOMI_TOKEN_PATH")")
fi

PROBE_BODY='{"prompt":"ping","provider":"claude","permissionMode":"bypassPermissions","platform":"benchmark-gdpval-aa-v2-probe","useProvidedWorkDir":true,"workDir":"'"$RESULTS_DIR"'.probe","modelConfig":{"model":"'"$MODEL"'"}}'

mkdir -p "$RESULTS_DIR"
PROBE_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -m 30 \
  -H "Content-Type: application/json" \
  "${AUTH_ARGS[@]}" \
  -X POST \
  --data "$PROBE_BODY" \
  "$OPENLOOMI_API_URL/api/native/agent" 2>/dev/null || echo "000")

if [[ "$PROBE_STATUS" == "200" ]]; then
  say "agent endpoint OK (200)"
else
  say "WARN: /api/native/agent probe returned HTTP $PROBE_STATUS (continuing — the runner will surface real errors)"
fi

# ---------------------------------------------------------------------------
# 3. Install / refresh workspace deps
# ---------------------------------------------------------------------------
hr; say "3. Workspace dependencies"

# Re-link the new package only (fast); fall back to full install on first run.
if pnpm list --depth -1 --filter @openloomi/benchmark-gdpval-aa-v2 >/dev/null 2>&1; then
  say "@openloomi/benchmark-gdpval-aa-v2 is already linked in the workspace"
else
  say "linking @openloomi/benchmark-gdpval-aa-v2 into the workspace"
  ( cd "$ROOT_DIR" && pnpm install --filter @openloomi/benchmark-gdpval-aa-v2 --no-frozen-lockfile )
fi

# Make sure the Python deps for the dataset downloader are present.
if ! python -c "import datasets" >/dev/null 2>&1; then
  say "installing Python dataset deps (datasets, huggingface_hub, pyarrow)"
  python -m pip install -U datasets huggingface_hub pyarrow >/dev/null
fi

# ---------------------------------------------------------------------------
# 4. Download / refresh the openai/gdpval gold subset
# ---------------------------------------------------------------------------
hr; say "4. Dataset"

if (( SKIP_DOWNLOAD )); then
  say "--skip-download set, expecting existing dataset at $DATASET_JSONL"
  [[ -f "$DATASET_JSONL" ]] || die "dataset not found: $DATASET_JSONL"
else
  mkdir -p "$GDPVAL_DATASET_DIR/dataset"
  if [[ -n "$HF_TOKEN" ]]; then
    export HF_TOKEN
    say "downloading openai/gdpval with HF_TOKEN (220 tasks) -> $DATASET_JSONL"
  else
    say "downloading openai/gdpval (220 tasks) -> $DATASET_JSONL"
    say "(set HF_TOKEN to avoid HF rate limits)"
  fi
  ( cd "$GDPVAL_DATASET_DIR/dataset" && python download_gdpval.py --output gdpval_gold.jsonl )
fi

TASK_COUNT=$(wc -l < "$DATASET_JSONL" | tr -d ' ')
say "dataset has $TASK_COUNT task(s)"

# 4b. Pre-fetch every task's reference files (PDF / Excel / CSV / image).
#     The OpenLoomi runner forwards these to /api/native/agent via the
#     v2 fileAttachments contract, exactly the way Stirrup injects them
#     into its E2B sandbox. Idempotent — already-cached files are skipped.
say "pre-fetching reference files -> $GDPVAL_DATASET_DIR/dataset/reference_files"
( cd "$GDPVAL_DATASET_DIR/dataset" && python fetch_reference_files.py --concurrency 8 )

# ---------------------------------------------------------------------------
# 5. Run the OpenLoomi benchmark
# ---------------------------------------------------------------------------
hr; say "5. OpenLoomi harness run"

mkdir -p "$RESULTS_DIR"

if (( SKIP_RUN )); then
  say "--skip-run set, skipping the harness run"
else
  if (( NO_RESUME )); then
    rm -f "$RUN_JSON"
    RESUME_FLAG="--no-resume"
  else
    RESUME_FLAG="--resume"
  fi

  QUICK_FLAG=()
  if [[ -n "$QUICK" ]]; then
    QUICK_FLAG=(--quick "$QUICK")
  fi

  TOOLS_FLAG=()
  if [[ -n "$ALLOWED_TOOLS" ]]; then
    TOOLS_FLAG=(--allowed-tools "$ALLOWED_TOOLS")
  fi

  say "provider=$PROVIDER  model=$MODEL  timeout=${TIMEOUT_MS}ms"
  say "output=$RUN_JSON"
  [[ -n "$QUICK" ]] && say "smoke run: first $QUICK task(s) only"

  ( cd "$ROOT_DIR" && pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- \
      --dataset "$DATASET_JSONL" \
      --output  "$RUN_JSON" \
      --reference-index "$GDPVAL_DATASET_DIR/dataset/reference_files/reference_files_index.json" \
      --provider "$PROVIDER" \
      --model    "$MODEL" \
      --timeout-ms "$TIMEOUT_MS" \
      --permission-mode bypassPermissions \
      "${QUICK_FLAG[@]}" \
      "${TOOLS_FLAG[@]}" \
      $RESUME_FLAG \
    )
fi

[[ -f "$RUN_JSON" ]] || die "run summary not found at $RUN_JSON (the runner must have exited before writing)"

# ---------------------------------------------------------------------------
# 6. Build the submission JSONL
# ---------------------------------------------------------------------------
hr; say "6. Submission JSONL"

mkdir -p "$SUBMISSIONS_DIR"
SAFE_MODEL="$(printf '%s' "$MODEL" | tr '/\\' '--')"
SUBMISSION_JSONL="$SUBMISSIONS_DIR/openloomi_${PROVIDER}_${SAFE_MODEL}.jsonl"

say "writing $SUBMISSION_JSONL"
python "$SCRIPT_DIR/scripts/evaluate.py" \
  --run "$RUN_JSON" \
  --output "$SUBMISSION_JSONL"

WRITTEN=$(wc -l < "$SUBMISSION_JSONL" | tr -d ' ')
DELIVERABLES_TOTAL=$(python -c "
import json
total = 0
for line in open(r'''$SUBMISSION_JSONL''', encoding='utf-8'):
    total += len(json.loads(line).get('submission_files') or [])
print(total)
")

hr
say "DONE"
say "  run summary  : $RUN_JSON"
say "  submission   : $SUBMISSION_JSONL ($WRITTEN records, $DELIVERABLES_TOTAL deliverable file(s))"
say "  artifacts    : $RESULTS_DIR/artifacts/"
say "  per-task dirs: $RESULTS_DIR/workdirs/"

cat <<EOF

Next steps:
  1) Inspect the deliverables:
       explorer "$RESULTS_DIR\\artifacts"
  2) Run the benchmark with a second model (e.g. codex) to get a
     comparable submission JSONL.
  3) Feed both JSONLs into the pair-wise grader:
       cd "$GDPVAL_DATASET_DIR/grader/GDPVal_EVal"
       \$env:GEMINI_API_KEY="..."
       python -m gdpval.grading.pairwise_grader ...   # see GDPVal_Eval README
       python -m gdpval.elo.bradley_terry --matches matches.jsonl
EOF
