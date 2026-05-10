#!/usr/bin/env bash
#
# Rsync the local bundle (see bundle-for-vm.sh) to the VM and reload PM2.
# Usage from monorepo root:
#   ./apps/listener/deploy/sync-to-vm.sh USER@EXTERNAL_IP
#
# SSH auth:
#   If ~/.ssh/google_compute_engine exists (same as gcloud compute ssh), it is used automatically.
#   Override: GCP_SSH_IDENTITY=/path/to/private_key
#   Plain ssh/agent only: GCP_SSH_IDENTITY= ./apps/listener/deploy/sync-to-vm.sh user@host
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BUNDLE="${REPO_ROOT}/apps/listener/deploy/bundle"
TARGET="${1:-${DEPLOY_HOST:-}}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

resolve_identity() {
  if [[ -n "${GCP_SSH_IDENTITY+x}" ]] && [[ -z "${GCP_SSH_IDENTITY}" ]]; then
    printf '%s\n' ""
    return
  fi
  local id="${GCP_SSH_IDENTITY:-$HOME/.ssh/google_compute_engine}"
  if [[ -f "$id" ]]; then
    printf '%s\n' "$id"
  else
    printf '%s\n' ""
  fi
}

rsync_rsh_string() {
  local identity
  identity="$(resolve_identity)"
  if [[ -n "$identity" ]]; then
    printf '%s\n' "ssh -i ${identity} -o IdentitiesOnly=yes"
  else
    printf '%s\n' "ssh"
  fi
}

remote_pm2() {
  local identity
  identity="$(resolve_identity)"
  if [[ -n "$identity" ]]; then
    ssh -i "$identity" -o IdentitiesOnly=yes "$1" \
      'bash -lc "cd /opt/atent/listener && if pm2 describe atent-listener >/dev/null 2>&1; then pm2 reload ecosystem.config.cjs --update-env; else pm2 start ecosystem.config.cjs; fi && pm2 save"'
  else
    ssh "$1" \
      'bash -lc "cd /opt/atent/listener && if pm2 describe atent-listener >/dev/null 2>&1; then pm2 reload ecosystem.config.cjs --update-env; else pm2 start ecosystem.config.cjs; fi && pm2 save"'
  fi
}

if [[ -z "${TARGET}" ]]; then
  die "Usage: $0 USER@host_or_ip
  Example: $0 atent_office@34.57.84.184
  Or:       DEPLOY_HOST=user@ip $0"
fi

if [[ ! -d "${BUNDLE}/dist" ]] || [[ ! -f "${BUNDLE}/package.json" ]]; then
  die "Missing bundle. Run first:\n  ./apps/listener/deploy/bundle-for-vm.sh"
fi

if [[ -z "$(resolve_identity)" ]]; then
  log "Note: ~/.ssh/google_compute_engine not found — using default ssh (agent/config)."
  log "If you get 'Permission denied (publickey)', run once: gcloud compute ssh INSTANCE --zone=ZONE"
  log "Or: export GCP_SSH_IDENTITY=~/.ssh/id_ed25519"
fi

RSH="$(rsync_rsh_string)"
log "Rsync ${BUNDLE}/ → ${TARGET}:/opt/atent/listener/"
rsync -az --delete --progress -e "${RSH}" "${BUNDLE}/" "${TARGET}:/opt/atent/listener/"

log "Reloading PM2 on remote..."
remote_pm2 "${TARGET}"

log "Done. Check: curl -sS http://YOUR_VM_IP:3001/api/health"
