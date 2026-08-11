#!/usr/bin/env bash
# Smoke-test wrapper: brings node/pnpm/py into PATH and aliases `python` -> `py`,
# then invokes the real runner with --quick 3 + MiniMax-M3-highspeed.
set -e

# Map `python` (and `python3`) to the Windows Python launcher.
alias python='py'
alias python3='py'
shopt -s expand_aliases

# Bring node/pnpm into PATH; this bash mounts Windows as /mnt/<drive>, not /<drive>.
export PATH="/mnt/d/openloomi3/openloomi/benchmark/GDPval-AA v2/openloomi-runner/.shims:/mnt/c/nodejs:/mnt/c/Users/32274/AppData/Roaming/npm:$PATH"

cd "/mnt/d/openloomi3/openloomi/benchmark/GDPval-AA v2/openloomi-runner"

bash run_gdpval_aa_v2.sh --quick 3 --provider claude --model 'MiniMax-M3-highspeed'
