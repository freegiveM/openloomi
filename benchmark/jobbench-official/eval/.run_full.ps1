$ErrorActionPreference = "Continue"

# Make jq (used by run_judge.sh) reachable inside bash.
$jqDir = "C:\Users\32274\AppData\Local\Microsoft\WinGet\Packages\jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe"
if (Test-Path (Join-Path $jqDir "jq.exe")) {
  $env:Path = $env:Path + ";$jqDir"
}

$logPath = "D:\openloomi3\openloomi\benchmark\jobbench-official\eval\logs\run_judge_minimax_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"
$logDir  = Split-Path $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host "[run] start at $(Get-Date -Format 'HH:mm:ss')"
Write-Host "[run] mode=resumable (tasks 1-18 done in prior run; minimax provider with MiniMax-M3-highspeed, MAX_CONCURRENT=2)"
Write-Host "[run] LOG=$logPath"

$bashExe = "C:\Program Files\Git\bin\bash.exe"
$bashScript = "D:\openloomi3\openloomi\benchmark\jobbench-official\eval\.run_full_inner.sh"

# Start-Process with -RedirectStandardOutput gives bash a log file and
# detaches cleanly.  Powershell returns immediately, the spawned bash +
# python + judge.py chain runs in its own process group.
$proc = Start-Process -FilePath $bashExe `
  -ArgumentList @($bashScript) `
  -NoNewWindow `
  -RedirectStandardOutput $logPath `
  -RedirectStandardError "$logPath.err" `
  -PassThru
Write-Host "[run] spawner PID=$($proc.Id)  bashScript=$bashScript"

# Wait briefly, then verify the child process is alive.
Start-Sleep -Seconds 8
$saved = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($saved) {
  Write-Host "[run] spawner alive: PID=$($proc.Id) CPU=$([math]::Round($saved.CPU,1))"
} else {
  Write-Host "[run] spawner exited prematurely; check $logPath"
}
