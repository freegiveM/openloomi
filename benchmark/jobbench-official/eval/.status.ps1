$ErrorActionPreference = "Continue"

# Check the run_judge_minimax log size + processes.
$logDir = "D:\openloomi3\openloomi\benchmark\jobbench-official\eval\logs"
$logs   = Get-ChildItem -Path $logDir -Filter "run_judge_minimax_*.log" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($logs) {
  Write-Host "[status] log: $($logs.FullName)"
  Write-Host "[status] size: $([math]::Round($logs.Length/1KB, 1)) KB   lastWrite: $($logs.LastWriteTime.ToString('HH:mm:ss'))"
} else {
  Write-Host "[status] no run_judge_minimax_*.log yet"
}

$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.StartTime -gt [datetime]'2026-08-05 15:30:00'
}
Write-Host ""
Write-Host "[status] recent processes:"
$procs | Select-Object Id,ProcessName,@{n='CPU';e={[math]::Round($_.CPU,1)}},StartTime | Format-Table -AutoSize | Out-String | Write-Host

# Tail last 60 lines of the log if it exists.
if ($logs) {
  Write-Host ""
  Write-Host "[status] tail (last 80 lines):"
  Get-Content -Tail 80 $logs.FullName | Write-Host
}
