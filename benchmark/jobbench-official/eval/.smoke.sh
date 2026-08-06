#!/usr/bin/env bash
# Smoke-test judge on a single task to validate the Anthropic -> minimax path.
set -e
cd /d/openloomi3/openloomi/benchmark/jobbench-official

export JUDGE_PROVIDER=anthropic
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-cp-vaKirCaOffifXjVc9SDDZG7sl2DSGkugGrhKMLhXESW7P4wksXdRElDY3m03Tw-ZjcPwzsoPU6A-3YNBUzQN1qh6iww8F9lC8sxzudNpJppM2jZmPVkkMWM"
export JUDGE_MODELS="MiniMax-M3-highspeed"
export EVAL_MODEL="openloomi-dev"
export TARGET_DIR="/d/openloomi3/openloomi/benchmark/jobbench-official/dataset/main"
export MAX_CONCURRENT=4
export MAX_JUDGE_WORKERS=4
export JUDGE_PYTHON="$(command -v python || command -v python3)"

echo "[smoke] JUDGE_PYTHON=$JUDGE_PYTHON"
"$JUDGE_PYTHON" -c "import openai, anthropic; print('openai', openai.__version__, '/ anthropic', anthropic.__version__)"

# Restrict to a single task + single model: only this profession/task.
export TARGET_TASK_REGEX="training_and_development_specialists/task3"

# We can't pass an extra CLI flag through run_judge.sh, but we can scope
# TARGET_DIR via a custom python invocation that pre-imports discover_tasks.
# Simpler: invoke judge.py directly for this one model+task while preserving
# run_judge.sh's lock + detail-log behaviour.

MODEL_OUTPUT_DIR="/d/openloomi3/openloomi/benchmark/jobbench-official/dataset/main/training_and_development_specialists/task3/model_output/openloomi-dev"
RUBRICS_FILE="/d/openloomi3/openloomi/benchmark/jobbench-official/dataset/main/training_and_development_specialists/task3/RUBRICS.json"
RESULT_DIR="/d/openloomi3/openloomi/benchmark/jobbench-official/dataset/main/training_and_development_specialists/task3/eval_result/eval_openloomi-dev"
mkdir -p "$RESULT_DIR"
SAFE_NAME="MiniMax-M3-highspeed"
RESULT_FILE="$RESULT_DIR/${SAFE_NAME}_judge.json"
LOCK_FILE="$RESULT_DIR/.${SAFE_NAME}_judge.lock"
DETAIL_DIR="/d/openloomi3/openloomi/benchmark/jobbench-official/eval/logs/detail"
mkdir -p "$DETAIL_DIR"

echo "[smoke] running judge.py on the smoke task..."
"$JUDGE_PYTHON" /d/openloomi3/openloomi/benchmark/jobbench-official/eval/judge.py \
    --output-dir "$MODEL_OUTPUT_DIR" \
    --rubrics-file "$RUBRICS_FILE" \
    --details-file "$RESULT_FILE" \
    --judge-model "MiniMax-M3-highspeed" \
    --provider anthropic \
    --anthropic-base-url "https://api.minimaxi.com/anthropic" \
    --anthropic-auth-token "$ANTHROPIC_AUTH_TOKEN" \
    --max-workers 4 \
    --max-retries 1 \
    --timeout-per-rubric 300 \
    --evaluated-model "openloomi-dev" \
    --lock-file "$LOCK_FILE" \
    --detail-log-dir "$DETAIL_DIR" \
    --detail-log-prefix "smoke_tds_task3"
echo "[smoke] exit=$?"
echo "[smoke] result file:"
ls -la "$RESULT_FILE" || true
echo "[smoke] result summary:"
"$JUDGE_PYTHON" -c "
import json,sys
p=r'$RESULT_FILE'
try:
    d=json.loads(open(p,encoding='utf-8').read())
    print('total_score:', d.get('reward',{}).get('total_score'))
    print('max_score:', d.get('reward',{}).get('max_score'))
    print('pass_rate:', d.get('reward',{}).get('pass_rate'))
    print('rubrics_judged:', len(d.get('rubrics',[])))
    for r in d.get('rubrics',[]):
        print('  - passed=', r['result']['passed'], 'criteria_passed=', r['result']['criteria_passed'], '/', r['result']['criteria_count'])
except Exception as e:
    print('parse failed:', e)
"
