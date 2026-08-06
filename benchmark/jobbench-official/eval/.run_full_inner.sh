set -e
export JUDGE_PROVIDER="anthropic"
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-cp-vaKirCaOffifXjVc9SDDZG7sl2DSGkugGrhKMLhXESW7P4wksXdRElDY3m03Tw-ZjcPwzsoPU6A-3YNBUzQN1qh6iww8F9lC8sxzudNpJppM2jZmPVkkMWM"
export JUDGE_MODELS="MiniMax-M3-highspeed"
export EVAL_MODEL="openloomi-dev"
export MAX_CONCURRENT="2"
export MAX_JUDGE_WORKERS="2"
export TARGET_DIR="/d/openloomi3/openloomi/benchmark/jobbench-official/dataset/main"
export TEMP_DIR="/tmp/jb_judge_minimax"
mkdir -p "$TEMP_DIR"
cd /d/openloomi3/openloomi/benchmark/jobbench-official
exec bash eval/run_judge.sh
