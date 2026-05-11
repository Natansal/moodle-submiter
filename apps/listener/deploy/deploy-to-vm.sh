#!/usr/bin/env bash
#
# Build the Linux VM bundle (Docker) and rsync it to the GCP host + PM2 reload.
# Run from anywhere:
#   ./apps/listener/deploy/deploy-to-vm.sh USER@EXTERNAL_IP
#
# Or set DEPLOY_HOST (same format):
#   DEPLOY_HOST=atent_office@34.57.84.184 ./apps/listener/deploy/deploy-to-vm.sh
#
# Skip the Docker bundle when you only changed env / want a fast rsync (bundle must exist):
#   SYNC_ONLY=1 ./apps/listener/deploy/deploy-to-vm.sh USER@IP
#
# SSH: same as sync-to-vm.sh (~/.ssh/google_compute_engine, GCP_SSH_IDENTITY, etc.)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# Allow accidental `script -- user@host` (npm-style); otherwise $1 becomes `--`.
if [[ "${1:-}" == "--" ]]; then
  shift
fi
TARGET="${1:-${DEPLOY_HOST:-}}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ -z "${TARGET}" ]]; then
  die "Usage: $0 USER@host_or_ip
  Example: $0 atent_office@34.57.84.184
  Or:       DEPLOY_HOST=user@ip $0

Optional:
  SYNC_ONLY=1   Skip bundle-for-vm.sh (reuse existing apps/listener/deploy/bundle/)"
fi

if [[ "${TARGET}" == "--" ]]; then
  die "Target was '--'. First argument must be user@host (remove stray '--' before the host)."
fi

cd "${REPO_ROOT}"

if [[ "${SYNC_ONLY:-}" == "1" ]]; then
  log "SYNC_ONLY=1 — skipping bundle (using existing ${REPO_ROOT}/apps/listener/deploy/bundle/)"
else
  log "Building Linux bundle…"
  "${SCRIPT_DIR}/bundle-for-vm.sh"
fi

log "Syncing to ${TARGET}…"
"${SCRIPT_DIR}/sync-to-vm.sh" "${TARGET}"

log "Deploy finished."
