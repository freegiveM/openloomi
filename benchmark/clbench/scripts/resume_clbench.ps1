# Resume CL-bench on Windows PowerShell: clean failed checkpoints, then re-run.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\resume_clbench.ps1
#
# Optional overrides via environment variables:
#   $env:CHECKPOINT_DIR = "D:\openloomi_val_results\clbench\checkpoints\clbench"
#   $env:DATASET        = "D:\...\clbench\dataset\clbench.jsonl"
#   $env:BENCHMARK_TYPE = "clbench"
#   $env:OUTPUT         = "D:\...\clbench_result_resumed.json"
#
# What this script does:
#   1. Scans the checkpoint directory for files whose `response` field starts
#      with "Error:" or "ERROR:" (agent call failures, timeouts, etc.).
#   2. Moves those files into a timestamped backup directory so the resume
#      logic will treat them as not-yet-done and re-evaluate them.
#   3. Invokes `pnpm benchmark` which uses the cleaned checkpoints and
#      evaluates any missing tasks.

$ErrorActionPreference = "Stop"

# -------- Configuration ------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageDir = Split-Path -Parent $ScriptDir

$CheckpointDir = if ($env:CHECKPOINT_DIR) { $env:CHECKPOINT_DIR } else { "D:\openloomi_val_results\clbench\checkpoints\clbench" }
$Dataset       = if ($env:DATASET)        { $env:DATASET }        else { Join-Path $PackageDir "dataset\clbench.jsonl" }
$BenchmarkType = if ($env:BENCHMARK_TYPE) { $env:BENCHMARK_TYPE } else { "clbench" }
$Output        = if ($env:OUTPUT)         { $env:OUTPUT }         else { "D:\openloomi_val_results\clbench\results\clbench_result_resumed.json" }

$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackupDir = Join-Path (Split-Path -Parent $CheckpointDir) ("_trash_resumed_" + $Stamp)

# -------- Helpers ------------------------------------------------------------
function Note($msg) { Write-Output ("[resume] " + $msg) }

function Test-IsErrorCheckpoint($path) {
    try {
        $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        $r = [string]$obj.response
        return ($r.StartsWith("Error:") -or $r.StartsWith("ERROR:"))
    } catch {
        return $false
    }
}

# -------- Step 1: preflight --------------------------------------------------
Note ("package dir   : " + $PackageDir)
Note ("checkpoint dir: " + $CheckpointDir)
Note ("dataset       : " + $Dataset)
Note ("backup dir    : " + $BackupDir)
Note ("output        : " + $Output)

if (-not (Test-Path -LiteralPath $CheckpointDir)) {
    throw "checkpoint dir not found: $CheckpointDir"
}
if (-not (Test-Path -LiteralPath $Dataset)) {
    throw "dataset not found: $Dataset"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm not found in PATH"
}

# -------- Step 2: clean failed checkpoints ----------------------------------
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
Note "scanning for failed checkpoints..."

$toMove = Get-ChildItem -LiteralPath $CheckpointDir -Filter "*.json" | Where-Object {
    Test-IsErrorCheckpoint $_.FullName
}

$totalToMove = $toMove.Count
Note ("found " + $totalToMove + " failed checkpoint(s) to move")

$moved = 0
$moveFailed = 0
foreach ($f in $toMove) {
    try {
        Move-Item -LiteralPath $f.FullName -Destination $BackupDir -Force -ErrorAction Stop
        $moved++
    } catch {
        $moveFailed++
    }
}

$remaining = (Get-ChildItem -LiteralPath $CheckpointDir -Filter "*.json" | Measure-Object).Count
Note ("moved        : " + $moved)
Note ("move failed  : " + $moveFailed)
Note ("source left  : " + $remaining)
Note ("backup at    : " + $BackupDir)

# -------- Step 3: resume the benchmark --------------------------------------
Set-Location -LiteralPath $PackageDir

if (-not (Test-Path (Join-Path $PackageDir "node_modules"))) {
    Note "node_modules missing, running pnpm install..."
    pnpm install
}

Note "running benchmark..."
$env:CLBENCH_CHECKPOINT_DIR = $CheckpointDir

pnpm benchmark -- --dataset $Dataset --benchmark $BenchmarkType --output $Output

Note ("done. summary written to " + $Output)
Note ("failed checkpoints are preserved at " + $BackupDir)