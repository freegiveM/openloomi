$ErrorActionPreference = "Continue"

$root = "D:\openloomi3\openloomi\benchmark\jobbench-official\dataset\main"
$files = Get-ChildItem -Path $root -Recurse -Filter "MiniMax-M3-highspeed_judge.json" -ErrorAction SilentlyContinue |
         Where-Object { $_.FullName -like "*\eval_result\eval_openloomi-dev\*" }

Write-Host "Result files: $($files.Count)"
Write-Host ""

$rows = foreach ($f in $files) {
  $taskRel = $f.FullName.Substring($root.Length + 1)
  $taskRel = $taskRel -replace '\\eval_result\\.*$', ''
  $raw = Get-Content $f.FullName -Raw
  try { $d = $raw | ConvertFrom-Json } catch { continue }
  [PSCustomObject]@{
    Task  = $taskRel
    Score = $d.total_score
    Max   = $d.max_score
    Pass  = $d.passed_count
    Total = $d.total_count
    Rate  = $d.pass_rate
  }
}

$rows | Sort-Object Task | Format-Table -AutoSize | Out-String -Stream | Write-Host

# Aggregate
$sumScore = ($rows | Measure-Object -Property Score -Sum).Sum
$sumMax   = ($rows | Measure-Object -Property Max   -Sum).Sum
$sumPass  = ($rows | Measure-Object -Property Pass  -Sum).Sum
$sumTotal = ($rows | Measure-Object -Property Total -Sum).Sum
$norm     = if ($sumMax -gt 0) { [math]::Round($sumScore / $sumMax, 4) } else { 0 }
$avgPR    = if ($sumTotal -gt 0) { [math]::Round($sumPass  / $sumTotal, 4) } else { 0 }

Write-Host ""
Write-Host "===================================================================="
Write-Host (" TOTAL  tasks={0}  aggregate score={1}/{2} (norm={3})  rubric pass_rate={4}%" -f $rows.Count, $sumScore, $sumMax, $norm, [math]::Round($avgPR*100, 1))
Write-Host "===================================================================="
