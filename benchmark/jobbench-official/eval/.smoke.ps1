$ErrorActionPreference = "Continue"
$env:JUDGE_PROVIDER      = "anthropic"
$env:ANTHROPIC_BASE_URL  = "https://api.minimaxi.com/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = "sk-cp-vaKirCaOffifXjVc9SDDZG7sl2DSGkugGrhKMLhXESW7P4wksXdRElDY3m03Tw-ZjcPwzsoPU6A-3YNBUzQN1qh6iww8F9lC8sxzudNpJppM2jZmPVkkMWM"

$ROOT   = "D:\openloomi3\openloomi\benchmark\jobbench-official"
$TASK   = Join-Path $ROOT "dataset\main\training_and_development_specialists\task3"
$OUT    = Join-Path $TASK "model_output\openloomi-dev"
$RUB    = Join-Path $TASK "RUBRICS.json"
$RESDIR = Join-Path $TASK "eval_result\eval_openloomi-dev"
New-Item -ItemType Directory -Force -Path $RESDIR | Out-Null
$RES    = Join-Path $RESDIR "MiniMax-M3-highspeed_judge.json"
$LOCK   = Join-Path $RESDIR ".MiniMax-M3-highspeed_judge.lock"
$DETDIR = Join-Path $ROOT "eval\logs\detail"
New-Item -ItemType Directory -Force -Path $DETDIR | Out-Null

Write-Host "[smoke] openai/anthropic versions:"
python -c "import openai, anthropic; print('openai', openai.__version__, '/ anthropic', anthropic.__version__)" | Out-Host

Write-Host "[smoke] running judge.py ..."
python (Join-Path $ROOT "eval\judge.py") `
  --output-dir $OUT `
  --rubrics-file $RUB `
  --details-file $RES `
  --judge-model "MiniMax-M3-highspeed" `
  --provider anthropic `
  --anthropic-base-url "https://api.minimaxi.com/anthropic" `
  --anthropic-auth-token $env:ANTHROPIC_AUTH_TOKEN `
  --max-workers 4 `
  --max-retries 1 `
  --timeout-per-rubric 300 `
  --evaluated-model "openloomi-dev" `
  --lock-file $LOCK `
  --detail-log-dir $DETDIR `
  --detail-log-prefix "smoke_tds_task3"
$rc = $LASTEXITCODE
Write-Host "[smoke] judge exit=$rc"

if (Test-Path $RES) {
  Write-Host "[smoke] result summary:"
  python -c @"
import json
p = r'$RES'
d = json.loads(open(p, encoding='utf-8').read())
r = d.get('reward', {})
print('total_score:', r.get('total_score'))
print('max_score:', r.get('max_score'))
print('pass_rate:', r.get('pass_rate'))
print('judged_models:', d.get('evaluated_model'), '/', d.get('judge_model'))
print('rubrics:', len(d.get('rubrics', [])))
for r2 in d.get('rubrics', []):
  print('  - passed=', r2['result']['passed'], 'criteria_passed=', r2['result']['criteria_passed'], '/', r2['result']['criteria_count'])
"@
}
