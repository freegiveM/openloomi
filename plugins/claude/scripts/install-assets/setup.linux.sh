#!/usr/bin/env bash
# OpenLoomi Claude Code plugin — Linux install helper.
# SPDX-License-Identifier: Apache-2.0
#
# Invoked only after the user explicitly runs
# `node loomi-bridge.mjs install [--yes]`. Never auto-executed.
#
# Strategy:
#   • Try the official .deb / .rpm / AppImage asset attached to the latest
#     stable GitHub release. Pick whichever matches the host's package
#     manager.
#   • Fall back to printing a manual install link if the asset layout
#     doesn't fit (e.g. Alpine / Arch / NixOS).
#
# Reference: https://openloomi.ai/docs/install/linux

set -eo pipefail

REPO_SLUG="${OPENLOOMI_REPO:-melandlabs/openloomi}"
GITHUB_RELEASE_URL="https://api.github.com/repos/${REPO_SLUG}/releases/latest"
DOCS_BASE="${OPENLOOMI_DOCS_BASE:-https://openloomi.ai}"
INSTALL_ROOT="${OPENLOOMI_INSTALL_ROOT:-/opt/openloomi}"

# Optional GitHub auth. The Releases API is unauthenticated by default,
# which trips the secondary rate limit at ~60 req/hr per IP and surfaces
# as a silent `curl -f` 403 → "Could not resolve the .dmg asset URL."
# Sending a Bearer token lifts that to 5,000 req/hr. Both env var names
# are accepted (GITHUB_TOKEN is the gh CLI convention; GH_TOKEN is what
# GitHub Actions exports by default).
# https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting
GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
declare -a GITHUB_AUTH_HEADERS=()
if [[ -n "${GITHUB_TOKEN}" ]]; then
  GITHUB_AUTH_HEADERS=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# Offline / restricted-network path (issue #399, companion docs #401).
# Priority order, first non-empty wins:
#   1. `--offline <path>` / `--offline=<path>` CLI flag
#   2. `OPENLOOMI_DMG_PATH` env var (the macOS official name; we accept
#      it here for cross-platform consistency, even though Linux uses
#      .deb / .rpm / .AppImage / .tar.gz rather than .dmg)
#   3. `OPENLOOMI_DMG` env var (legacy alias)
#   4. `OPENLOOMI_VERSION` IF it happens to point at an existing file
#      (back-compat with a pre-#401 side-channel convention). A literal
#      semver like OPENLOOMI_VERSION=v0.8.4 is NOT treated as a path.
OFFLINE_ARTIFACT=""
prev=""
for arg in "$@"; do
  if [[ "${prev}" == "--offline" ]]; then
    OFFLINE_ARTIFACT="${arg}"
    break
  fi
  case "${arg}" in
    --offline=*) OFFLINE_ARTIFACT="${arg#--offline=}"; break;;
    --offline)   prev="--offline";;
  esac
done
if [[ -z "${OFFLINE_ARTIFACT}" && -n "${OPENLOOMI_DMG_PATH:-}" ]]; then
  OFFLINE_ARTIFACT="${OPENLOOMI_DMG_PATH}"
fi
if [[ -z "${OFFLINE_ARTIFACT}" && -n "${OPENLOOMI_DMG:-}" ]]; then
  OFFLINE_ARTIFACT="${OPENLOOMI_DMG}"
fi
if [[ -z "${OFFLINE_ARTIFACT}" && -n "${OPENLOOMI_VERSION:-}" && -f "${OPENLOOMI_VERSION}" ]]; then
  OFFLINE_ARTIFACT="${OPENLOOMI_VERSION}"
fi

log() { printf "[openloomi-installer] %s\n" "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }

require curl
require tar

# Cross-platform file-size readback (BSD stat on macOS, GNU stat on
# Linux). Used by the download progress monitor below. Falls back to
# `wc -c` so this helper works on any POSIX box.
file_size_bytes() {
  local p="$1"
  if [[ ! -f "${p}" ]]; then
    echo 0
    return
  fi
  if stat -c %s "${p}" >/dev/null 2>&1; then
    stat -c %s "${p}"
  elif stat -f %z "${p}" >/dev/null 2>&1; then
    stat -f %z "${p}"
  else
    wc -c < "${p}" | tr -d ' '
  fi
}

# One-attempt monitor tick: read the partial file's size, compute
# percent/ETA, and emit a structured progress line. `start_ts` is
# epoch-seconds captured at curl start; `total_bytes` is the asset's
# declared size (or 0 when unknown, in which case percent/ETA are -1).
emit_progress() {
  local out_partial="$1"
  local total_bytes="$2"
  local start_ts="$3"
  # Trim any leading/trailing whitespace: the release-payload awk
  # that extracts asset_size can leave a leading space on the
  # number, which would otherwise fail the ^[0-9]+$ regex below
  # and pin pct to -1.
  total_bytes="${total_bytes#"${total_bytes%%[![:space:]]*}"}"
  total_bytes="${total_bytes%"${total_bytes##*[![:space:]]}"}"
  local now_ts
  now_ts=$(date +%s)
  local elapsed_ms=$(( (now_ts - start_ts) * 1000 ))
  local bytes
  bytes=$(file_size_bytes "${out_partial}")
  local pct=-1
  local eta_ms=-1
  if [[ "${total_bytes}" =~ ^[0-9]+$ ]] && (( total_bytes > 0 )) && (( elapsed_ms > 0 )); then
    pct=$(( bytes * 100 / total_bytes ))
    if (( bytes > 0 )); then
      local rate_bytes_per_ms=$(( bytes / elapsed_ms ))
      if (( rate_bytes_per_ms > 0 )); then
        eta_ms=$(( (total_bytes - bytes) / rate_bytes_per_ms ))
      fi
    fi
  fi
  log "stage=download progress percent=${pct} downloaded=${bytes} total=${total_bytes:-0} elapsedMs=${elapsed_ms} etaMs=${eta_ms}"
}

# Classify a curl/HTTP failure into a sanitized reason string safe to
# print on stderr. We never include the URL or response body — just the
# status family and the recoverable hint.
classify_failure() {
  local curl_status="$1"
  local http_status="$2"
  local hdr_file="$3"
  if [[ "${http_status}" =~ ^[0-9]+$ ]] && (( http_status >= 500 )); then
    echo "http_${http_status}"
  elif [[ "${http_status}" == "403" ]] && [[ -f "${hdr_file}" ]] \
       && grep -qiE '^X-RateLimit-Remaining:[[:space:]]*0' "${hdr_file}"; then
    echo "rate_limited"
  elif [[ "${http_status}" =~ ^[0-9]+$ ]] && (( http_status >= 400 )); then
    echo "http_${http_status}"
  elif (( curl_status == 28 )); then
    echo "curl_28_timeout"
  elif (( curl_status == 35 )); then
    echo "curl_35_tls"
  elif (( curl_status == 22 )); then
    echo "curl_22_http"
  elif (( curl_status == 6 )); then
    echo "curl_6_host"
  elif (( curl_status == 7 )); then
    echo "curl_7_connect"
  else
    echo "curl_${curl_status}"
  fi
}

# Decide whether a failure is transient enough to retry. HTTP 4xx
# (except 408 / 429) and TLS errors are NOT retried — the user must
# change something. HTTP 5xx, rate-limit, and curl transient errors are.
should_retry() {
  local reason="$1"
  case "${reason}" in
    rate_limited|http_5*|http_408|http_429|curl_7_connect|curl_6_host|curl_28_timeout)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# Bounded download routine with structured progress and retry (issue
# #398). The bridge owns process lifecycle (timeout / SIGKILL); the
# helper owns the network request. Returns the original curl exit
# code on final failure so the bridge sees `EXIT_22` / `EXIT_28` /
# `EXIT_35` instead of a generic `EXIT_1`.
download_with_progress() {
  local url="$1"
  local out="$2"
  local total_bytes="${3:-0}"
  local max_attempts=4   # 1 initial + 3 retries

  log "stage=download target=${url} totalBytes=${total_bytes:-0} attempts=${max_attempts}"

  local attempt=1
  while (( attempt <= max_attempts )); do
    local hdr_file status_file partial_file stderr_file
    hdr_file=$(mktemp)
    status_file=$(mktemp)
    partial_file="${out}.partial"
    stderr_file=$(mktemp)

    local start_ts
    start_ts=$(date +%s)

    # Background curl:
    #   -sSL            silent, follow redirects
    #   -D              dump response headers (for rate-limit detection)
    #   -w '%{http_code}' write final HTTP status to stdout (= status_file)
    #   -o              partial output file
    # We deliberately do NOT use `-f` so HTTP 4xx/5xx produce a body
    # we can inspect; we map to exit 22 ourselves in classify_failure.
    curl -sSL "${GITHUB_AUTH_HEADERS[@]}" \
      -D "${hdr_file}" \
      -w '%{http_code}' \
      -o "${partial_file}" \
      "${url}" \
      > "${status_file}" \
      2> "${stderr_file}" &
    local curl_pid=$!

    # 1 Hz monitor loop. `kill -0` succeeds while the process is alive.
    while kill -0 "${curl_pid}" 2>/dev/null; do
      emit_progress "${partial_file}" "${total_bytes}" "${start_ts}"
      sleep 1
    done

    wait "${curl_pid}" 2>/dev/null
    local curl_status=$?
    local http_status
    http_status=$(cat "${status_file}" 2>/dev/null | tr -d '[:space:]' || echo "")
    local reason
    reason=$(classify_failure "${curl_status}" "${http_status}" "${hdr_file}")

    # Success path: 2xx (or 3xx followed by 2xx after follow) and curl clean.
    if (( curl_status == 0 )) && [[ "${http_status}" =~ ^[23][0-9][0-9]$ ]]; then
      mv "${partial_file}" "${out}"
      local end_ts
      end_ts=$(date +%s)
      local elapsed_ms=$(( (end_ts - start_ts) * 1000 ))
      log "stage=download ok elapsedMs=${elapsed_ms} bytes=${total_bytes:-0}"
      rm -f "${hdr_file}" "${status_file}" "${stderr_file}"
      return 0
    fi

    # Failure path. Retry transient cases.
    if (( attempt < max_attempts )) && should_retry "${reason}"; then
      attempt=$((attempt + 1))
      local sleep_s=$(( attempt * 2 ))
      log "retry=${attempt} reason=${reason} httpStatus=${http_status:-?} curlStatus=${curl_status} sleepMs=$((sleep_s * 1000))"
      rm -f "${hdr_file}" "${status_file}" "${stderr_file}" "${partial_file}"
      sleep "${sleep_s}"
      continue
    fi

    # Final failure: emit the diagnostic and propagate curl's exit so
    # the bridge maps it to a stable EXIT_<n> code with the right
    # actionable hints (EXIT_22 / EXIT_28 / EXIT_35).
    log "stage=download failed reason=${reason} httpStatus=${http_status:-?} curlStatus=${curl_status}"
    rm -f "${hdr_file}" "${status_file}" "${stderr_file}" "${partial_file}"
    return "${curl_status}"
  done

  # Unreachable — the loop above always returns or exits.
  return 1
}

pick_package() {
  if   command -v apt-get  >/dev/null 2>&1; then echo "deb"
  elif command -v dnf     >/dev/null 2>&1; then echo "rpm"
  elif command -v yum     >/dev/null 2>&1; then echo "rpm"
  elif command -v pacman  >/dev/null 2>&1; then echo "appimage"
  else                                         echo "tarball"
  fi
}

pkg=$(pick_package)
log "Detected package family: ${pkg}"

case "${pkg}" in
  deb|rpm|appimage|tarball)
    asset_name="openloomi-${pkg}.${pkg}"
    [ "${pkg}" = "tarball" ] && asset_name="openloomi-linux-x64.tar.gz"
    [ "${pkg}" = "deb" ]     && asset_name="openloomi-linux-amd64.deb"
    [ "${pkg}" = "rpm" ]     && asset_name="openloomi-linux-x86_64.rpm"
    [ "${pkg}" = "appimage" ] && asset_name="openLoomi-x86_64.AppImage"
    ;;
  *)
    fail "Could not determine package family."
    ;;
esac

asset_url=""
asset_size=0
if [[ -n "${OFFLINE_ARTIFACT}" ]]; then
  if [[ ! -f "${OFFLINE_ARTIFACT}" ]]; then
    fail "--offline: file not found at ${OFFLINE_ARTIFACT}"
  fi
  asset_name=$(basename "${OFFLINE_ARTIFACT}")
  asset_url="file://${OFFLINE_ARTIFACT}"
  # In offline mode, trust the file extension rather than pick_package()'s
  # host-side guess — the caller may have downloaded a .rpm onto an apt
  # host (or vice-versa) for cross-distro classroom installs.
  case "$(printf '%s' "${asset_name}" | tr '[:upper:]' '[:lower:]')" in
    *.deb)             pkg="deb";;
    *.rpm)             pkg="rpm";;
    *.appimage)        pkg="appimage";;
    *.tar.gz|*.tgz)    pkg="tarball";;
    *) fail "Unsupported offline artifact (extension): ${asset_name}. Expected .deb / .rpm / .AppImage / .tar.gz.";;
  esac
  log "stage=download skipped source=offline target=${OFFLINE_ARTIFACT}"
else
  log "stage=download skipped source=release_lookup target=latest"
  # Capture headers + body in a single request so we can both detect a
  # secondary rate-limit 403 (issue #399) and still parse the JSON.
  hdr_file=$(mktemp)
  release_json=$(curl -sSL "${GITHUB_AUTH_HEADERS[@]}" \
    -D "${hdr_file}" "${GITHUB_RELEASE_URL}" || true)

  if grep -qiE '^HTTP/[0-9.]+ 403' "${hdr_file}" \
     && grep -qiE '^X-RateLimit-Remaining:[[:space:]]*0' "${hdr_file}"; then
    rm -f "${hdr_file}"
    log "rate_limited: GitHub anonymous limit hit. Set GITHUB_TOKEN to raise the limit, or wait and retry."
    # Map to curl's HTTP-error exit so the bridge receives EXIT_22
    # and surfaces the corporate-proxy / GITHUB_TOKEN guidance.
    exit 22
  fi
  rm -f "${hdr_file}"

  asset_url=$(printf '%s' "${release_json}" \
    | sed -n "s/.*\"browser_download_url\":[[:space:]]*\"\\([^\"]*${asset_name}\\)\".*/\\1/p" \
    | head -n1 || true)

  # Pull the matching asset's `size` (bytes) from the same payload so the
  # bridge can render percent / ETA without a second round-trip. The awk
  # pipeline collects every "size": <num> occurrence after the first
  # `asset_name` URL match. If absent, totalBytes is 0 and percent/ETA
  # are skipped.
  asset_size=$(printf '%s' "${release_json}" \
    | awk -v asset="${asset_name}" '
        index($0, asset) { seen=1; next }
        seen && /"size":[[:space:]]*[0-9]+/ {
          match($0, /"size":[[:space:]]*[0-9]+/);
          n = substr($0, RSTART, RLENGTH);
          sub(/.*:/, "", n);
          print n; exit
        }
      ' || true)
  if [[ -z "${asset_size}" ]]; then asset_size=0; fi

  if [[ -z "${asset_url}" ]]; then
    log "Could not resolve ${asset_name} from latest release."
    log "Please follow manual instructions at ${DOCS_BASE}/docs/install/linux"
    exit 0
  fi
fi

workdir=$(mktemp -d -t openloomi-install.XXXXXX)
trap 'rm -rf "${workdir}"' EXIT
archive="${workdir}/${asset_name}"

if [[ "${asset_url}" == file://* ]]; then
  # Offline path — no network call. Just copy and emit a clear
  # "skipped/network" event so the bridge knows we never hit GitHub.
  log "stage=download skipped source=local target=${asset_url#file://}"
  cp "${asset_url#file://}" "${archive}"
else
  download_with_progress "${asset_url}" "${archive}" "${asset_size}"
fi

log "stage=install start target=${pkg}"
case "${pkg}" in
  deb)
    require sudo
    sudo dpkg -i "${archive}" || sudo apt-get -f install -y
    ;;
  rpm)
    require sudo
    sudo rpm -Uvh "${archive}"
    ;;
  appimage)
    mkdir -p "${HOME}/.local/bin"
    cp "${archive}" "${HOME}/.local/bin/openloomi"
    chmod +x "${HOME}/.local/bin/openloomi"
    ;;
  tarball)
    mkdir -p "${INSTALL_ROOT}"
    tar -xzf "${archive}" -C "${INSTALL_ROOT}"
    ;;
esac
log "stage=install ok"

log "stage=verify start"
bin="/opt/openloomi/openloomi"
if [[ ! -x "${bin}" ]]; then
  bin=$(command -v openloomi || true)
fi
if [[ -z "${bin}" || ! -x "${bin}" ]]; then
  # OpenLoomi is installed (e.g. /opt/openloomi/ exists) but the main
  # binary hasn't been placed yet — the desktop app's first launch does
  # this. Exit 0 with a friendly note so the bridge can guide the user,
  # instead of failing and making them think the install broke.
  log "OpenLoomi files installed, but the main binary is not on PATH yet."
  log "Launch the OpenLoomi desktop app once so it places the main binary,"
  log "then re-run /openloomi:setup from Claude Code to finish setup."
  log "stage=verify deferred reason=helper_binary_missing"
  exit 0
fi

log "Verifying the OpenLoomi install…"
log "  found main binary at: ${bin}"
log "  (version is reported by the desktop app on first launch — calling --version on the Tauri main binary would flash a GUI window)"
log "stage=verify ok"

log "Install complete. Re-run /openloomi:setup to continue."
