#!/usr/bin/env bash
# OpenLoomi Codex plugin — macOS install helper.
# SPDX-License-Identifier: Apache-2.0
#
# Invoked by loomi-bridge.installOpenLoomi only after the user explicitly
# runs `install-openloomi --confirm`. The codex bridge has already
# resolved the latest official .dmg, verified its SHA-256 against the
# GitHub release digest, and downloaded it into a temp file. It then
# passes that local file path as $1 to this script.
#
# This script's job is purely the OS-level install:
#   1. Mount the .dmg with hdiutil.
#   2. rsync OpenLoomi.app from the mount into /Applications
#      (sudo only if /Applications isn't user-writable).
#   3. Unmount and clean up.
#   4. Emit a single structured JSON line on stdout describing the
#      installed binary path, so the bridge can attach it to the
#      install record.
#
# Companion to plugins/claude/scripts/install-assets/setup.macos.sh —
# kept structurally identical so future contributors only maintain one
# shape. Real differences:
#   - This script does NOT call the GitHub Releases API. The codex
#     bridge already resolved + downloaded the artifact before us.
#   - We require a DMG path as $1 instead of deriving it.
#   - The bridge parses the JSON line on stdout to attach `binPath`
#     to the install record (version / tag / assetUrl come from the
#     bridge's earlier resolution, not from this script).
#
# Reference: https://openloomi.ai/docs/install/macos

set -euo pipefail

dmg="${1:-}"
DOCS_BASE="${OPENLOOMI_DOCS_BASE:-https://openloomi.ai}"

log() { printf "[openloomi-installer] %s\n" "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

if [[ -z "${dmg}" ]]; then
  fail "Usage: $0 <path-to-OpenLoomi.dmg>"
fi
if [[ ! -f "${dmg}" ]]; then
  fail "DMG not found at: ${dmg}"
fi

require hdiutil
require rsync

# 1. Mount.
mountpoint=$(mktemp -d -t openloomi-mount.XXXXXX)
log "Mounting DMG to ${mountpoint}"
hdiutil attach -nobrowse -mountpoint "${mountpoint}" "${dmg}" >/dev/null \
  || fail "hdiutil attach failed."
trap 'hdiutil detach "${mountpoint}" >/dev/null 2>&1 || true; rm -rf "${mountpoint}"' EXIT

if [[ ! -d "${mountpoint}/OpenLoomi.app" ]]; then
  fail "DMG did not contain OpenLoomi.app."
fi

# 2. Copy to /Applications.
log "Installing OpenLoomi.app to /Applications (may require sudo)…"
if [[ -w "/Applications" ]]; then
  rsync -a --delete "${mountpoint}/OpenLoomi.app/" "/Applications/OpenLoomi.app/"
else
  # When the bridge runs in a non-TTY context (Codex CLI) and sudo
  # needs a password, the user gets a clear "sudo rsync failed" line
  # and can re-run the install interactively from a terminal.
  sudo rsync -a --delete "${mountpoint}/OpenLoomi.app/" "/Applications/OpenLoomi.app/" \
    || fail "sudo rsync failed. Re-run from a terminal so sudo can prompt, or install manually from ${DOCS_BASE}/docs/install/macos."
fi

# 3. Verify install. The DMG already carries the inner binary, but
#    be defensive: if it's missing the bridge will launch the .app
#    on the next setup-status call to finalize.
bin="/Applications/OpenLoomi.app/Contents/MacOS/openloomi"
if [[ -x "${bin}" ]]; then
  log "Verifying the OpenLoomi install…"
  log "  found main binary at: ${bin}"
else
  bin=""
  log "OpenLoomi.app was installed to /Applications, but the inner helper binary is not yet present."
  log "The bridge will launch OpenLoomi.app to finalize the install on the next setup-status call."
fi

# 4. Emit a single structured JSON line on stdout for the bridge.
#    The bridge already knows version / tag / assetUrl from its
#    earlier GitHub release resolution; we only report what this
#    script actually verified on disk (binPath).
printf '{"binPath":"%s","version":"","tag":"","assetUrl":""}\n' "${bin}"

log "Install complete. Re-run setup-status to continue."
