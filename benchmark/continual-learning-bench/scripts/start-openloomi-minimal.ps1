# start-openloomi-minimal.ps1
# Bare-minimum OpenLoomi dev server. Bypasses pnpm / run-cross-env / turbopack.
# Just runs next dev with sane flags. No Tauri, no cross-env wrapper, no secrets rewrite.
# Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File D:\openloomi3\openloomi\benchmark\continual-learning-bench\scripts\start-openloomi-minimal.ps1

[CmdletBinding()]
param(
    [int]$Port = 3515,
    [int]$MaxOldSpaceMB = 3072,    # 3 GB is plenty for plain webpack-based dev
    [string]$WebRoot = "D:\openloomi3\openloomi\apps\web"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==== OpenLoomi dev (minimal) ====" -ForegroundColor Cyan
Write-Host "Web root : $WebRoot"
Write-Host "Port     : $Port"
Write-Host "Heap     : ${MaxOldSpaceMB} MB"
Write-Host "Backend  : webpack (not turbo)"
Write-Host ""

# 1. Kill any stragglers
Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 2. Sanity
$envFile = "$WebRoot\.env"
# pnpm monorepo puts next in the root node_modules, not apps/web/node_modules.
# WebRoot is apps/web, so we need to go up TWO levels to find the repo root.
$repoRoot = Split-Path (Split-Path $WebRoot -Parent) -Parent
$nextBin = Join-Path $repoRoot "node_modules\next\dist\bin\next"
if (-not (Test-Path $envFile)) { Write-Host "$envFile missing" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $nextBin)) { Write-Host "$nextBin missing - run pnpm install --filter web (in $repoRoot)" -ForegroundColor Red; exit 1 }
Write-Host "Sanity OK (.env + next bin at $nextBin)" -ForegroundColor Green

# 3. Set env
$env:NODE_OPTIONS = "--max-old-space-size=$MaxOldSpaceMB"
$env:PORT = $Port
$env:HOSTNAME = "0.0.0.0"
# Make sure any cross-env wrapper from the previous attempts is cleared.
Remove-Item Env:NODE_OPTIONS_PREV -ErrorAction SilentlyContinue

# 4. Run
Write-Host "Launching: node `"$nextBin`" dev --webpack" -ForegroundColor Cyan
Write-Host "Watch for 'Ready in' / 'Local: http://localhost:$Port'" -ForegroundColor Cyan
Write-Host "Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

Push-Location $WebRoot
try {
    # next is hoisted to the monorepo root by pnpm; use the absolute path.
    node "$nextBin" dev --webpack
} finally {
    Pop-Location
}
