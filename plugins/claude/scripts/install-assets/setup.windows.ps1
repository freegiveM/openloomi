# OpenLoomi Claude Code plugin — Windows install helper.
# SPDX-License-Identifier: Apache-2.0
#
# Invoked only after the user explicitly runs
# `node loomi-bridge.mjs install [--yes]`. Never auto-executed.
#
# Strategy:
#   • Detect winget, then try to install via winget if available.
#   • Else download the latest .msi from the GitHub releases.
#   • Verify by running the installed helper CLI's --version.
#
# Reference: https://openloomi.ai/docs/install/windows

$ErrorActionPreference = "Stop"

$Repo        = if ($env:OPENLOOMI_REPO) { $env:OPENLOOMI_REPO } else { "melandlabs/openloomi" }
$ReleaseUrl  = "https://api.github.com/repos/$Repo/releases/latest"
$DocsBase    = if ($env:OPENLOOMI_DOCS_BASE) { $env:OPENLOOMI_DOCS_BASE } else { "https://openloomi.ai" }

# Optional GitHub auth. The Releases API is unauthenticated by default,
# which trips the secondary rate limit at ~60 req/hr per IP and surfaces
# as a silent 403 → "No MSI asset found." Sending a Bearer token lifts
# that to 5,000 req/hr. Both env var names are accepted (GITHUB_TOKEN is
# the gh CLI convention; GH_TOKEN is what GitHub Actions exports by
# default).
# https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting
$Token       = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
$ApiHeaders  = @{ "User-Agent" = "openloomi-claude-plugin" }
if ($Token) { $ApiHeaders["Authorization"] = "Bearer $Token" }

# Offline / restricted-network path (issue #399, companion docs #401).
# Priority order, first non-empty wins:
#   1. `--offline <path>` / `--offline=<path>` CLI flag
#   2. `OPENLOOMI_DMG_PATH` env var (the macOS official name; we accept
#      it here for cross-platform consistency, even though Windows uses
#      .msi rather than .dmg)
#   3. `OPENLOOMI_DMG` env var (legacy alias)
#   4. `OPENLOOMI_VERSION` IF it happens to point at an existing file
#      (back-compat with a pre-#401 side-channel convention). A literal
#      semver like OPENLOOMI_VERSION=v0.8.5 is NOT treated as a path.
$OfflineMsi = $null
$OfflineArg = $null
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq "--offline") {
    if ($i + 1 -lt $args.Count) { $OfflineArg = $args[$i + 1] }
    break
  }
  if ($args[$i] -like "--offline=*") {
    $OfflineArg = $args[$i] -replace '^--offline=', ''
    break
  }
}
if ($OfflineArg) { $OfflineMsi = $OfflineArg }
elseif ($env:OPENLOOMI_DMG_PATH) { $OfflineMsi = $env:OPENLOOMI_DMG_PATH }
elseif ($env:OPENLOOMI_DMG)      { $OfflineMsi = $env:OPENLOOMI_DMG }
elseif ($env:OPENLOOMI_VERSION -and (Test-Path $env:OPENLOOMI_VERSION)) {
  $OfflineMsi = $env:OPENLOOMI_VERSION
}

function Log($msg)    { Write-Host "[openloomi-installer] $msg" -ForegroundColor Cyan }
function Fail($msg)   { Log "ERROR: $msg"; exit 1 }

# One-attempt monitor tick: read the partial file's length, compute
# percent/ETA, and emit a structured progress line. Mirrors the bash
# helper so the bridge sees the same shape across platforms.
function Emit-DownloadProgress {
  param(
    [string]$PartialPath,
    [long]$TotalBytes,
    [datetime]$StartTime
  )
  $now = Get-Date
  $elapsedMs = [int][math]::Max(0, ($now - $StartTime).TotalMilliseconds)
  $downloaded = 0
  if (Test-Path $PartialPath) {
    $downloaded = (Get-Item $PartialPath).Length
  }
  $pct = -1
  $etaMs = -1
  if ($TotalBytes -gt 0 -and $elapsedMs -gt 0) {
    $pct = [int](($downloaded * 100) / $TotalBytes)
    if ($downloaded -gt 0) {
      $rateBytesPerMs = [int]($downloaded / $elapsedMs)
      if ($rateBytesPerMs -gt 0) {
        $etaMs = [int](($TotalBytes - $downloaded) / $rateBytesPerMs)
      }
    }
  }
  Log "stage=download progress percent=$pct downloaded=$downloaded total=$TotalBytes elapsedMs=$elapsedMs etaMs=$etaMs"
}

# Classify an exception into a sanitized reason string safe to print on
# stderr. Mirrors the bash helper's reason taxonomy.
function Classify-Failure {
  param([System.Exception]$Ex)
  $msg = if ($Ex) { $Ex.Message } else { "" }
  if ($msg -match 'TLS|SSL|certificate|handshake') { return 'curl_35_tls' }
  if ($msg -match 'timeout|timed out|TimeoutException') { return 'curl_28_timeout' }
  if ($msg -match '403') { return 'http_403' }
  if ($msg -match '404') { return 'http_404' }
  if ($msg -match '500|502|503|504') { return 'http_5xx' }
  if ($msg -match 'name resolution|NameResolution') { return 'curl_6_host' }
  if ($msg -match 'connection|connect') { return 'curl_7_connect' }
  return "exception"
}

# Map an HTTP status code (or class) to the curl-style exit code the
# bridge expects. 4xx → 22 (HTTP error), timeout → 28, TLS → 35.
function Get-ExitCodeForFailure {
  param([int]$CurlStatus, [string]$Reason)
  if ($CurlStatus -ne 0) { return $CurlStatus }
  switch ($Reason) {
    'curl_22_http'    { return 22 }
    'curl_28_timeout' { return 28 }
    'curl_35_tls'     { return 35 }
    'http_403'        { return 22 }
    'http_404'        { return 22 }
    'http_5xx'        { return 22 }
    'curl_6_host'     { return 6 }
    'curl_7_connect'  { return 7 }
    default           { return 1 }
  }
}

# Decide whether a failure is transient enough to retry. Mirrors the
# bash helper's policy: 5xx, timeouts, and connect failures retry; 4xx
# (except 408/429) and TLS errors don't.
function Should-Retry {
  param([string]$Reason)
  switch ($Reason) {
    'curl_28_timeout' { return $true }
    'curl_7_connect'  { return $true }
    'curl_6_host'     { return $true }
    'http_5xx'        { return $true }
    'http_408'        { return $true }
    'http_429'        { return $true }
    default           { return $false }
  }
}

# Bounded download routine with structured progress and retry (issue
# #398). The bridge owns process lifecycle (timeout / SIGKILL); the
# helper owns the network request. Returns a stable exit code (22 / 28
# / 35) on final failure so the bridge maps it to EXIT_<n> with the
# right actionable hints.
function Download-WithProgress {
  param(
    [string]$Url,
    [string]$OutPath,
    [long]$TotalBytes = 0,
    [int]$MaxAttempts = 4   # 1 initial + 3 retries
  )

  Log "stage=download target=$Url totalBytes=$TotalBytes attempts=$MaxAttempts"

  $attempt = 1
  while ($attempt -le $MaxAttempts) {
    $headers = @{ "User-Agent" = "openloomi-claude-plugin" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }

    $partialPath = "$OutPath.partial"
    $httpStatus = 0
    $reason = ""
    $startTime = Get-Date
    $downloaded = 0

    try {
      # Use HttpClient with ResponseHeadersRead so we get the response
      # object before the body is consumed — required for streaming.
      $client = [System.Net.Http.HttpClient]::new()
      $client.Timeout = [System.TimeSpan]::FromMinutes(30)
      $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
      foreach ($k in $headers.Keys) {
        if ($k -eq 'Authorization') {
          $request.Headers.TryAddWithoutValidation($k, $headers[$k]) | Out-Null
        } else {
          $request.Headers.TryAddWithoutValidation($k, $headers[$k]) | Out-Null
        }
      }
      $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      $httpStatus = [int]$response.StatusCode
      $actualTotal = [long]$response.Content.Headers.ContentLength
      if ($actualTotal -gt 0) { $TotalBytes = $actualTotal }
      $contentStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $output = [System.IO.File]::Open($partialPath, [System.IO.FileMode]::Create)
      $buffer = New-Object byte[] 8192
      $lastEmit = $startTime
      try {
        while (($read = $contentStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $output.Write($buffer, 0, $read)
          $downloaded += $read
          $now = Get-Date
          if (($now - $lastEmit).TotalSeconds -ge 1) {
            Emit-DownloadProgress -PartialPath $partialPath -TotalBytes $TotalBytes -StartTime $startTime
            $lastEmit = $now
          }
        }
      } finally {
        $output.Close()
        $contentStream.Close()
        $response.Dispose()
      }

      if ($httpStatus -ge 200 -and $httpStatus -lt 400) {
        Move-Item -Force $partialPath $OutPath
        $elapsedMs = [int][math]::Max(0, ((Get-Date) - $startTime).TotalMilliseconds)
        Log "stage=download ok elapsedMs=$elapsedMs bytes=$TotalBytes"
        $client.Dispose()
        return 0
      }

      # HTTP error — classify and consider retry.
      $reason = "http_$httpStatus"
      if ($httpStatus -eq 403 -and $response.Headers.Contains("X-RateLimit-Remaining")) {
        $remaining = $response.Headers.GetValues("X-RateLimit-Remaining") | Select-Object -First 1
        if ($remaining -eq '0') { $reason = "rate_limited" }
      }
    } catch {
      $reason = Classify-Failure $_
    } finally {
      if ($client) { $client.Dispose() }
    }

    $exitCode = Get-ExitCodeForFailure -CurlStatus 0 -Reason $reason

    if ($attempt -lt $MaxAttempts -and (Should-Retry $reason)) {
      $attempt += 1
      $sleepMs = $attempt * 2000
      Log "retry=$attempt reason=$reason httpStatus=$httpStatus curlStatus=$exitCode sleepMs=$sleepMs"
      Start-Sleep -Milliseconds $sleepMs
      continue
    }

    Log "stage=download failed reason=$reason httpStatus=$httpStatus curlStatus=$exitCode"
    if (Test-Path $partialPath) { Remove-Item -Force $partialPath }
    return $exitCode
  }

  # Unreachable — the loop above always returns or exits.
  return 1
}

# 1. Prefer winget
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
  Log "Installing via winget (id: OpenLoomi.OpenLoomi)…"
  try {
    Log "stage=install start target=winget"
    winget install --id OpenLoomi.OpenLoomi --silent --accept-package-agreements --accept-source-agreements
    $bin = (Get-Command openloomi.exe -ErrorAction SilentlyContinue)?.Source
    if (-not $bin) {
      $candidate = Join-Path $env:LOCALAPPDATA "OpenLoomi\openloomi.exe"
      if (Test-Path $candidate) { $bin = $candidate }
    }
    if ($bin) {
      Log "stage=install ok"
      Log "stage=verify start"
      Log "Verifying the OpenLoomi install…"
      Log "  found main binary at: $bin"
      Log "  (version is reported by the desktop app on first launch — calling --version on the Tauri main binary would flash a GUI window)"
      Log "stage=verify ok"
      Log "Install complete. Re-run /openloomi:setup to continue."
      exit 0
    }
  } catch {
    Log "winget install failed; falling back to direct .msi download."
  }
}

# 2. Fallback: download MSI
if ($OfflineMsi) {
  if (-not (Test-Path $OfflineMsi)) {
    Fail "--offline: file not found at $OfflineMsi"
  }
  Log "stage=download skipped source=offline target=$OfflineMsi"
  # Synthesize an asset record with the same shape Invoke-RestMethod
  # would have returned, so the rest of the script is branch-agnostic.
  $msiAsset = [PSCustomObject]@{
    name                 = Split-Path -Leaf $OfflineMsi
    browser_download_url = (Resolve-Path $OfflineMsi).Path
    size                 = (Get-Item $OfflineMsi).Length
  }
} else {
  Log "stage=download skipped source=release_lookup target=latest"
  try {
    $release = Invoke-RestMethod -Uri $ReleaseUrl -Headers $ApiHeaders
  } catch {
    # Invoke-RestMethod throws on non-2xx. Distinguish a secondary
    # rate-limit 403 (issue #399) from any other failure so the user
    # gets an actionable hint instead of a generic "Failed to fetch."
    $resp = $_.Exception.Response
    $statusCode = $null
    if ($resp) { $statusCode = [int]$resp.StatusCode }
    if ($statusCode -eq 403 -and $resp) {
      $remaining = $resp.Headers["X-RateLimit-Remaining"]
      if ($remaining -and [int]$remaining -eq 0) {
        Log "rate_limited: GitHub anonymous limit hit. Set GITHUB_TOKEN to raise the limit, or wait and retry."
        # Map to curl's HTTP-error exit so the bridge receives EXIT_22
        # and surfaces the corporate-proxy / GITHUB_TOKEN guidance.
        exit 22
      }
    }
    Fail "Failed to fetch latest release: $($_.Exception.Message)"
  }
  $msiAsset = $release.assets | Where-Object { $_.name -like "OpenLoomi-Setup-*.msi" } | Select-Object -First 1
  if (-not $msiAsset) {
    Fail "No MSI asset found. Visit $DocsBase/docs/install/windows and install manually."
  }
}

$workdir   = Join-Path ([System.IO.Path]::GetTempPath()) ("openloomi-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workdir | Out-Null
$msi       = Join-Path $workdir $msiAsset.name

# Streaming download with 1Hz progress + bounded retries (issue #398).
$dlExit = Download-WithProgress -Url $msiAsset.browser_download_url -OutPath $msi -TotalBytes ([long]$msiAsset.size)
if ($dlExit -ne 0) { exit $dlExit }

Log "stage=install start target=msiexec"
Log "Running installer (elevated)…"
$proc = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$msi`"", "/qn", "/norestart") -Verb RunAs -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  Fail "MSI installer exited with code $($proc.ExitCode)."
}
Log "stage=install ok"

Log "stage=verify start"
$bin = Join-Path $env:LOCALAPPDATA "OpenLoomi\openloomi.exe"
if (-not (Test-Path $bin)) {
  $bin = (Get-Command openloomi.exe -ErrorAction SilentlyContinue)?.Source
}
if (-not $bin -or -not (Test-Path $bin)) {
  Fail "Install completed but the OpenLoomi main binary is not on PATH or in %LOCALAPPDATA%\OpenLoomi. Open OpenLoomi once to finalize."
}

Log "Verifying the OpenLoomi install…"
Log "  found main binary at: $bin"
Log "  (version is reported by the desktop app on first launch — calling --version on the Tauri main binary would flash a GUI window)"
Log "stage=verify ok"

Log "Install complete. Re-run /openloomi:setup to continue."
