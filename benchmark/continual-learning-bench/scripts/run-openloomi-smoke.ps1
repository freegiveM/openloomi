# run-openloomi-smoke.ps1
# 在 WSL 内跑一个最小烟囱测试，确认 OpenLoomi system 联通。
# 用法：
#   powershell -ExecutionPolicy Bypass -File D:\openloomi3\openloomi\benchmark\continual-learning-bench\scripts\run-openloomi-smoke.ps1
# 可选参数：
#   -Task exploitable_poker   默认 exploitable_poker
#   -Schedule quick_test       默认 quick_test
#   -Model claude-sonnet-4-5   默认 claude-sonnet-4-5

[CmdletBinding()]
param(
    [string]$Task = "exploitable_poker",
    [string]$Schedule = "quick_test",
    [string]$Model = "claude-sonnet-4-5",
    [string]$RepoPath = "D:\clbench-work\continual-learning-bench"
)

$ErrorActionPreference = "Stop"
$wslRepoPath = $RepoPath -replace '\\', '/' -replace '^([A-Z]):', '/mnt/$1'

$defaultDistro = (wsl -l -q | Select-String -Pattern "Ubuntu" -SimpleMatch -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $defaultDistro) {
    Write-Host "找不到 Ubuntu 发行版" -ForegroundColor Red
    exit 1
}

Write-Host "在 WSL 内执行: clbench run $Task --schedule $Schedule --system openloomi --system.model $Model" -ForegroundColor Cyan
wsl -d $defaultDistro -- bash -lc "cd '$wslRepoPath' && uv run clbench run $Task --schedule $Schedule --system openloomi --system.model $Model"
