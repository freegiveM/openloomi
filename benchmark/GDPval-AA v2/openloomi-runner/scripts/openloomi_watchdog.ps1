# OpenLoomi dev server watchdog. Polls port 3515 every 60s. If the port
# is unreachable, restarts OpenLoomi dev (with IS_TAURI=true) and waits
# for it to become ready. Logs everything to a file under
# `results/openloomi_watchdog.log` so the human can see when restarts
# happened.
#
# The Runner is not managed by this watchdog — the Runner is started
# separately by the operator after OpenLoomi is up.

$ErrorActionPreference = "Continue"
$logFile = "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\openloomi_watchdog.log"

function Write-Log {
    param([string]$msg)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss"), $msg
    Add-Content -Path $logFile -Value $line
    Write-Output $line
}

function Is-OpenLoomi-Up {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 `
            http://127.0.0.1:3515/api/native/providers
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Start-OpenLoomi {
    Write-Log "OpenLoomi dev not reachable — killing any node processes and restarting"
    Get-Process | Where-Object { $_.ProcessName -eq "node" } | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 5

    Set-Location -LiteralPath "D:\openloomi3\openloomi\apps\web"
    $env:IS_TAURI = "true"
    $env:NODE_OPTIONS = "--max-old-space-size=16384 --require ./scripts/patch-http-timeout.cjs"
    $env:PORT = "3515"
    Start-Process -FilePath "D:\openloomi3\openloomi\node_modules\.bin\next.cmd" `
        -ArgumentList @("dev", "--turbo") `
        -RedirectStandardOutput "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\openloomi_stdout.log" `
        -RedirectStandardError "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\openloomi_stderr.log" `
        -WindowStyle Hidden
    Write-Log "OpenLoomi dev launched, waiting for readiness"
}

Write-Log "watchdog started"
while ($true) {
    if (-not (Is-OpenLoomi-Up)) {
        Start-OpenLoomi
        # wait up to 5 min for it to come up
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 10
            if (Is-OpenLoomi-Up) {
                $ready = $true
                break
            }
        }
        if ($ready) {
            Write-Log "OpenLoomi dev is up again"
        } else {
            Write-Log "OpenLoomi dev still not reachable after 5 min; will retry next cycle"
        }
    }
    Start-Sleep -Seconds 60
}