$run = Get-Content 'D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\gdpval_aa_v2_run.json' -Raw | ConvertFrom-Json
$zero = $run.predictions | Where-Object { ($_.metadata.error -eq $null) -and $_.deliverables.Count -eq 0 }
$results = foreach ($p in $zero) {
  $wd = Join-Path 'D:\openloomi3\openloomi\results\workdirs' $p.task_id
  $log = Join-Path $wd '_openloomi_sse_debug.log'
  if (-not (Test-Path $log)) { continue }
  $pollingStart = $null
  $exit = $null
  $lines = Get-Content $log
  for ($i=0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'fs-polling: start workDir=') {
      $pollingStart = [datetime]::Parse($lines[$i].Substring(1, 24))
    }
    if ($lines[$i] -match 'no top-level change for') {
      $exit = [datetime]::Parse($lines[$i].Substring(1, 24))
    }
  }
  if (-not $pollingStart -or -not $exit) { continue }
  $files = Get-ChildItem $wd -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '_openloomi_sse_debug.log' -and $_.Name -ne '_repro_debug.log' }
  $newestFile = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $newestTime = $null
  $newestName = 'none'
  if ($newestFile) {
    $newestTime = $newestFile.LastWriteTime.ToUniversalTime()
    $newestName = $newestFile.Name
  }
  $exitToFileSec = if ($newestTime) { [math]::Round(($newestTime - $exit).TotalSeconds) } else { 'NA' }
  $startToFileSec = if ($newestTime) { [math]::Round(($newestTime - $pollingStart).TotalSeconds) } else { 'NA' }
  [PSCustomObject]@{
    task_id = $p.task_id
    pollingStart = $pollingStart.ToString('HH:mm:ss')
    exit = $exit.ToString('HH:mm:ss')
    newestFile = $newestName
    fileTime = if ($newestTime) { $newestTime.ToString('HH:mm:ss') } else { 'NA' }
    exitToFileSec = $exitToFileSec
    startToFileSec = $startToFileSec
  }
}
$results | Select-Object -First 20 | Format-Table -AutoSize -Wrap
"--- summary ---"
$results | Group-Object exitToFileSec | Sort-Object Name | Format-Table -AutoSize
"--- late writers (file after exit) ---"
$results | Where-Object { $_.exitToFileSec -gt 0 } | Measure-Object | Select-Object Count
"--- file before start ---"
$results | Where-Object { $_.startToFileSec -lt 0 } | Measure-Object | Select-Object Count