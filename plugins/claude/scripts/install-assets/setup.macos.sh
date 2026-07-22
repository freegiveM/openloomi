#!/usr/bin/env bash
# OpenLoomi Claude Code plugin — macOS install helper.
# SPDX-License-Identifier: Apache-2.0
#
# Invoked only after the user explicitly runs `/openloomi:install [--yes]`.
# The plugin always asks y/N before executing this script.
#
# What this does (and does NOT do):
#   ✓ Checks that `curl` is on PATH.
#   ✓ Resolves the .dmg URL from the GitHub Releases API (or skips network
#     when OPENLOOMI_DMG_PATH is set, or pins to OPENLOOMI_VERSION=vX.Y.Z
#     instead of /releases/latest).
#   ✓ Downloads the latest stable `OpenLoomi.app.dmg` into a temp dir
#     (unless OPENLOOMI_DMG_PATH is set, in which case we copy the local
#     file instead of curling).
#   ✓ Mounts the DMG with `hdiutil`, drags OpenLoomi.app to /Applications,
#     and unmounts.
#   ✓ Emits a structured JSON line on stdout for the bridge.
#   ✗ Never touches `~/.openloomi/token` or any credential.
#   ✗ Never modifies shell rc files or `~/.claude/settings.json`.
#
# Env-var contract (issue #401, restricted-network install):
#   OPENLOOMI_REPO         Override the GitHub `owner/repo` slug.
#                          Default: `melandlabs/openloomi`.
#   OPENLOOMI_VERSION      Pin the release tag (e.g. `v0.8.6`). Replaces
#                          `/releases/latest` with `/releases/tags/<tag>`.
#                          Ignored if OPENLOOMI_DMG_PATH is set.
#   OPENLOOMI_DMG_PATH     macOS-only. Absolute path to a pre-staged .dmg
#                          on disk. When set and the file exists, the
#                          GitHub release lookup is skipped entirely and
#                          the local .dmg is used. Useful for corporate
#                          proxies / mirrors that block GitHub asset CDNs.
#                          Legacy aliases accepted for back-compat:
#                          `OPENLOOMI_DMG` and the `--offline <path>` CLI
#                          flag.
#   OPENLOOMI_DOCS_BASE    Override the docs base URL. Default
#                          `https://openloomi.ai`.
#   GITHUB_TOKEN / GH_TOKEN
#                          Optional GitHub Bearer token for the releases
#                          API. Lifts the anonymous 60 req/hr IP-based
#                          limit to 5,000 req/hr (issue #399).
#   OPENLOOMI_VERSION_TAG  (offline-path only) Override the tag_name field
#                          synthesized for a pre-staged DMG. Most users
#                          never set this.
#
# Reference: https://openloomi.ai/docs/install/macos
# Restricted-network companion: https://openloomi.ai/docs/install/restricted-network

set -eo pipefail

REPO_SLUG="${OPENLOOMI_REPO:-melandlabs/openloomi}"
GITHUB_RELEASE_LATEST="https://api.github.com/repos/${REPO_SLUG}/releases/latest"
DOCS_BASE="${OPENLOOMI_DOCS_BASE:-https://openloomi.ai}"

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

log() { printf "[openloomi-installer] %s\n" "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

# Cross-platform file-size readback (BSD stat on macOS, GNU stat on
# Linux). Used by the download progress monitor below. Falls back to
# `wc -c` so this helper works on any POSIX box.
file_size_bytes() {
  local p="$1"
  if [[ ! -f "${p}" ]]; then
    echo 0
    return
  fi
  if stat -f %z "${p}" >/dev/null 2>&1; then
    stat -f %z "${p}"
  elif stat -c %s "${p}" >/dev/null 2>&1; then
    stat -c %s "${p}"
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
      # bytes/sec * 1000 -> bytes per millisecond
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

require curl
require hdiutil
require rsync

# Resolve the offline-DMG path from any of the supported knobs, in priority
# order (first non-empty wins):
#   1. `--offline <path>` / `--offline=<path>` CLI flag
#   2. `OPENLOOMI_DMG_PATH` env var (issue #401 official name)
#   3. `OPENLOOMI_DMG` env var (legacy alias)
#   4. `OPENLOOMI_VERSION` IF it happens to point at an existing file
#      (keeps back-compat with a previous pre-#401 convention where users
#       set OPENLOOMI_VERSION=/path/to.dmg as a side channel).
#
# `OPENLOOMI_VERSION=vX.Y.Z` (a non-existent path or a literal semver) is
# NOT treated as an offline path — that case is handled later as a tag pin.
offline_dmg=""
prev=""
for arg in "$@"; do
  if [[ "${prev}" == "--offline" ]]; then
    offline_dmg="${arg}"
    break
  fi
  case "${arg}" in
    --offline=*) offline_dmg="${arg#--offline=}"; break ;;
    --offline)   prev="--offline" ;;
  esac
done
if [[ -z "${offline_dmg}" && -n "${OPENLOOMI_DMG_PATH:-}" ]]; then
  offline_dmg="${OPENLOOMI_DMG_PATH}"
fi
if [[ -z "${offline_dmg}" && -n "${OPENLOOMI_DMG:-}" ]]; then
  offline_dmg="${OPENLOOMI_DMG}"
fi
if [[ -z "${offline_dmg}" && -n "${OPENLOOMI_VERSION:-}" && -f "${OPENLOOMI_VERSION}" ]]; then
  offline_dmg="${OPENLOOMI_VERSION}"
fi

workdir=$(mktemp -d -t openloomi-install.XXXXXX)
trap 'rm -rf "${workdir}"' EXIT
dmg="${workdir}/OpenLoomi.dmg"
asset_url=""
tag_name=""
version=""

if [[ -n "${offline_dmg}" ]]; then
  if [[ ! -f "${offline_dmg}" ]]; then
    fail "Offline DMG not found at: ${offline_dmg}"
  fi
  log "stage=download skipped source=offline target=${offline_dmg}"
  cp "${offline_dmg}" "${dmg}"
  asset_url="file://${offline_dmg}"
  # Best-effort: derive tag/version from a filename like
  # `OpenLoomi-0.8.6.dmg` (or `OpenLoomi_1.2.3-rc.1.dmg`) so downstream
  # consumers still see a version. Strip the `.dmg` suffix first so the
  # dot inside pre-release identifiers (e.g. `1.2.3-rc.1`) doesn't
  # terminate the match.
  base=$(basename "${offline_dmg}")
  base="${base%.dmg}"
  if [[ "${base}" =~ [Oo]pen[Ll]oomi[-_]?([0-9]+\.[0-9]+\.[0-9][A-Za-z0-9._+-]*) ]]; then
    version="${BASH_REMATCH[1]}"
    tag_name="${OPENLOOMI_VERSION_TAG:-v${version}}"
  else
    tag_name="${OPENLOOMI_VERSION_TAG:-}"
    version=""
  fi
else
  # 1. Resolve the .dmg asset URL + tag. We pin to a specific tag when
  #    OPENLOOMI_VERSION is set as a literal semver, otherwise resolve
  #    /releases/latest. We hit the GitHub releases API once and pull both
  #    fields from the same payload — no second round-trip, no `--version`
  #    call on the inner Tauri binary (which would flash a GUI window).
  if [[ -n "${OPENLOOMI_VERSION:-}" ]]; then
    log "stage=download skipped source=release_lookup target=${OPENLOOMI_VERSION}"
    GITHUB_RELEASE_URL="https://api.github.com/repos/${REPO_SLUG}/releases/tags/${OPENLOOMI_VERSION}"
  else
    log "stage=download skipped source=release_lookup target=latest"
    GITHUB_RELEASE_URL="${GITHUB_RELEASE_LATEST}"
  fi

  # Capture headers + body in a single request so we can both detect a
  # secondary rate-limit 403 (issue #399) and still parse the JSON. Using
  # `-sSL` (not `-fsSL`) on purpose: we want the body even on 403 so we
  # can surface a useful error message instead of just "Could not
  # resolve the .dmg asset URL."
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
    | sed -n 's/.*"browser_download_url":[[:space:]]*"\([^"]*\.dmg\)".*/\1/p' \
    | head -n1 || true)
  tag_name=$(printf '%s' "${release_json}" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1 || true)
  # Pull the matching asset's `size` (bytes) from the same payload so the
  # bridge can render percent / ETA without a second round-trip. The sed
  # pipeline collects every "size": <num> occurrence; we keep the first
  # that follows a `.dmg` URL. If absent, totalBytes is reported as 0 and
  # the progress monitor skips percent/ETA.
  asset_size=$(printf '%s' "${release_json}" \
    | awk '
        /"browser_download_url":[[:space:]]*"[^"]*\.dmg"/ { seen=1; next }
        seen && /"size":[[:space:]]*[0-9]+/ {
          match($0, /"size":[[:space:]]*[0-9]+/);
          n = substr($0, RSTART, RLENGTH);
          sub(/.*:/, "", n);
          print n; exit
        }
      ' || true)

  # Strip a leading "v" / "V" from tag_name so downstream consumers get a
  # clean semver-ish version (e.g. "v0.8.6" → "0.8.6"). Fall back to ""
  # if the API didn't return a tag_name.
  version=$(printf '%s' "${tag_name}" | sed -E 's/^[vV]//')

  if [[ -z "${asset_url}" ]]; then
    fail "Could not resolve the .dmg asset URL. Visit ${DOCS_BASE}/docs/install/macos (or /docs/install/restricted-network for corporate-proxy install) and install manually."
  fi

  # 2. Download with structured progress + bounded retries (issue #398).
  download_with_progress "${asset_url}" "${dmg}" "${asset_size:-0}"
fi

# 3. Mount + copy.
mountpoint=$(mktemp -d -t openloomi-mount.XXXXXX)
log "stage=mount start target=${mountpoint}"
hdiutil attach -nobrowse -mountpoint "${mountpoint}" "${dmg}" >/dev/null || fail "hdiutil attach failed."
trap 'hdiutil detach "${mountpoint}" >/dev/null 2>&1 || true; rm -rf "${workdir}" "${mountpoint}"' EXIT
log "stage=mount ok"

if [[ ! -d "${mountpoint}/OpenLoomi.app" ]]; then
  fail "DMG did not contain OpenLoomi.app."
fi

log "stage=install start target=/Applications/OpenLoomi.app"
if [[ -w "/Applications" ]]; then
  rsync -a --delete "${mountpoint}/OpenLoomi.app/" "/Applications/OpenLoomi.app/"
else
  sudo rsync -a --delete "${mountpoint}/OpenLoomi.app/" "/Applications/OpenLoomi.app/" || fail "sudo rsync failed."
fi
log "stage=install ok"

# 4. Verify install.
log "stage=verify start"
bin="/Applications/OpenLoomi.app/Contents/MacOS/openloomi"
if [[ -x "${bin}" ]]; then
  log "Verifying the OpenLoomi install…"
  log "  found main binary at: ${bin}"
  log "  resolved version: ${version:-unknown} (from tag ${tag_name:-unknown})"
  log "stage=verify ok"
else
  # OpenLoomi.app is on disk but the inner helper binary isn't laid down
  # yet. For signed .app bundles this is rare (the DMG already carries
  # the inner binary), but if it does happen we still exit 0 — the bridge
  # will detect this and launch OpenLoomi.app to finalize.
  bin=""
  log "OpenLoomi.app was installed to /Applications, but the inner helper binary is not yet present."
  log "The bridge will launch OpenLoomi.app to finalize the install on the next /openloomi:setup call."
  log "stage=verify deferred reason=helper_binary_missing"
fi

# Emit a structured JSON line on stdout that the bridge parses for the
# resolved version and asset URL. We print to stdout (not stderr) so the
# bridge's stdout capture picks it up cleanly. Human-readable progress
# goes to stderr above.
printf '{"version":"%s","tag":"%s","assetUrl":"%s","binPath":"%s"}\n' \
  "${version}" "${tag_name}" "${asset_url}" "${bin}"

log "Install complete. Re-run /openloomi:setup from Claude Code to continue."
