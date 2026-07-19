#!/usr/bin/env bash
# OpenLoomi Codex plugin — Linux install helper.
# SPDX-License-Identifier: Apache-2.0
#
# Invoked by loomi-bridge.installOpenLoomi only after the user explicitly
# runs `install-openloomi --confirm`. The codex bridge has already
# resolved the latest official Linux asset, verified its SHA-256 against
# the GitHub release digest, and downloaded it into a temp file. It then
# passes that local file path as $1 to this script.
#
# This script's job is purely the OS-level install. It dispatches on the
# downloaded artifact's extension:
#   .deb            -> sudo dpkg -i (apt-get -f install fallback)
#   .rpm            -> sudo rpm -Uvh
#   .AppImage       -> copy to ~/.local/bin/openloomi, chmod +x
#   .tar.gz / .tgz  -> extract into $OPENLOOMI_INSTALL_ROOT (default /opt/openloomi)
#
# Companion to plugins/claude/scripts/install-assets/setup.linux.sh —
# kept structurally aligned. Real differences:
#   - This script does NOT call the GitHub Releases API or pick an asset.
#     The codex bridge already resolved + downloaded the artifact and
#     picked the right one for the host platform/arch before us.
#   - We require the artifact path as $1 instead of deriving it.
#   - We emit a single structured JSON line on stdout describing the
#     installed binary path, so the bridge can attach it to the install
#     record (version / tag / assetUrl come from the bridge's earlier
#     resolution, not from this script).
#
# Reference: https://openloomi.ai/docs/install/linux

set -euo pipefail

artifact="${1:-}"
DOCS_BASE="${OPENLOOMI_DOCS_BASE:-https://openloomi.ai}"
INSTALL_ROOT="${OPENLOOMI_INSTALL_ROOT:-/opt/openloomi}"

log() { printf "[openloomi-installer] %s\n" "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }

if [[ -z "${artifact}" ]]; then
  fail "Usage: $0 <path-to-openloomi-artifact>"
fi
if [[ ! -f "${artifact}" ]]; then
  fail "Artifact not found at: ${artifact}"
fi

# Dispatch on the artifact extension. The bridge already picked the right
# asset for this host, so we trust the extension it downloaded.
lower="$(printf '%s' "${artifact}" | tr '[:upper:]' '[:lower:]')"

case "${lower}" in
  *.deb)
    require sudo
    require dpkg
    log "Installing .deb via dpkg (may require sudo)…"
    sudo dpkg -i "${artifact}" || sudo apt-get -f install -y \
      || fail "dpkg install failed. Install manually from ${DOCS_BASE}/docs/install/linux."
    ;;
  *.rpm)
    require sudo
    require rpm
    log "Installing .rpm via rpm (may require sudo)…"
    sudo rpm -Uvh "${artifact}" \
      || fail "rpm install failed. Install manually from ${DOCS_BASE}/docs/install/linux."
    ;;
  *.appimage)
    log "Installing AppImage into ~/.local/bin/openloomi…"
    mkdir -p "${HOME}/.local/bin"
    cp "${artifact}" "${HOME}/.local/bin/openloomi"
    chmod +x "${HOME}/.local/bin/openloomi"
    ;;
  *.tar.gz|*.tgz)
    require tar
    log "Extracting tarball into ${INSTALL_ROOT}…"
    if [[ -w "$(dirname "${INSTALL_ROOT}")" || -w "${INSTALL_ROOT}" ]]; then
      mkdir -p "${INSTALL_ROOT}"
      tar -xzf "${artifact}" -C "${INSTALL_ROOT}"
    else
      require sudo
      sudo mkdir -p "${INSTALL_ROOT}"
      sudo tar -xzf "${artifact}" -C "${INSTALL_ROOT}" \
        || fail "tar extract failed. Install manually from ${DOCS_BASE}/docs/install/linux."
    fi
    ;;
  *)
    fail "Unsupported Linux artifact type: ${artifact}. Install manually from ${DOCS_BASE}/docs/install/linux."
    ;;
esac

# Resolve the installed main binary. Prefer the tarball install root, then
# the AppImage location, then PATH.
bin="${INSTALL_ROOT}/openloomi"
if [[ ! -x "${bin}" ]]; then
  if [[ -x "${HOME}/.local/bin/openloomi" ]]; then
    bin="${HOME}/.local/bin/openloomi"
  else
    bin="$(command -v openloomi || true)"
  fi
fi

if [[ -z "${bin}" || ! -x "${bin}" ]]; then
  # OpenLoomi files were installed but the main binary isn't placed yet —
  # the desktop app's first launch does this. Report an empty binPath so
  # the bridge can guide the user, instead of failing.
  bin=""
  log "OpenLoomi files installed, but the main binary is not on PATH yet."
  log "Launch the OpenLoomi desktop app once so it places the main binary,"
  log "then re-run setup-status from the Codex plugin to finish setup."
else
  log "Verifying the OpenLoomi install…"
  log "  found main binary at: ${bin}"
fi

# Emit a single structured JSON line on stdout for the bridge. The bridge
# already knows version / tag / assetUrl from its earlier GitHub release
# resolution; we only report what this script verified on disk (binPath).
printf '{"binPath":"%s","version":"","tag":"","assetUrl":""}\n' "${bin}"

log "Install complete. Re-run setup-status to continue."
