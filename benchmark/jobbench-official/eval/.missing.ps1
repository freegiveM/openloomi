$ErrorActionPreference = "Continue"
$root = "D:\openloomi3\openloomi\benchmark\jobbench-official\dataset\main"
$missing = @()
foreach ($prof in Get-ChildItem -Path $root -Directory) {
  foreach ($task in Get-ChildItem -Path $prof.FullName -Directory -Filter 'task*') {
    $f = Join-Path $task.FullName 'eval_result\eval_openloomi-dev\MiniMax-M3-highspeed_judge.json'
    if (-not (Test-Path $f)) {
      $missing += "$($prof.Name)/$($task.Name)"
    }
  }
}
Write-Host "Missing tasks: $($missing.Count)"
foreach ($m in $missing) { Write-Host " - $m" }
