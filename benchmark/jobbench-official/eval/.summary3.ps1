$ErrorActionPreference = "Continue"
$root = "D:\openloomi3\openloomi\benchmark\jobbench-official\dataset\main"

$files = Get-ChildItem -Path $root -Recurse -Filter "MiniMax-M3-highspeed_judge.json" -ErrorAction SilentlyContinue |
         Where-Object { $_.FullName -like "*\eval_result\eval_openloomi-dev\*" }

Write-Host "files found = $($files.Count)"

$ok = @(); $fail = @()
foreach ($f in $files) {
  $taskRel = $f.FullName.Substring($root.Length + 1)
  $taskRel = $taskRel -replace '\\eval_result\\.*$', ''
  $raw = Get-Content $f.FullName -Raw
  try {
    $d = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $d.total_score) { $fail += "$taskRel -- total_score=null"; continue }
    $ok += $taskRel
  } catch {
    $fail += "$taskRel -- $($_.Exception.Message)"
  }
}
Write-Host "ok=$($ok.Count)  fail=$($fail.Count)"
foreach ($x in $fail) { Write-Host "FAIL: $x" }
