#!/usr/bin/env bash
#
# One-time preparation on the GCP VM (Ubuntu). Does NOT run pnpm install or build.
#
# Run as root:
#   sudo ./vm-bootstrap.sh              # uses SUDO_USER (your login, e.g. atent_office)
#   sudo ./vm-bootstrap.sh atent_office
#
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-20}"
ENV_DIR="/etc/atent"
INSTALL_DIR="/opt/atent/listener"
# Prefer explicit arg, then user who invoked sudo, then common GCE default.
APP_USER="${1:-${SUDO_USER:-ubuntu}}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID:-0}" -ne 0 ]]; then
  die "Run as root (sudo)."
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  die "User ${APP_USER} does not exist."
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt "${NODE_MAJOR}" ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x (NodeSource)..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi

npm install -g pm2

mkdir -p "${INSTALL_DIR}" "${ENV_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}"

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "${ENV_DIR}/listener.env" ]]; then
  if [[ -f "${THIS_DIR}/env.example" ]]; then
    install -m 640 -o root -g "${APP_USER}" "${THIS_DIR}/env.example" "${ENV_DIR}/listener.env"
    log "Created ${ENV_DIR}/listener.env — edit secrets before starting PM2."
  fi
else
  log "Keeping existing ${ENV_DIR}/listener.env"
fi

log ""
log "Next on this VM:"
log "  sudo nano ${ENV_DIR}/listener.env    # fill secrets; remove YOUR_* placeholders"
log ""
log "On your Mac (after ./apps/listener/deploy/bundle-for-vm.sh):"
log "  ./apps/listener/deploy/sync-to-vm.sh ${APP_USER}@VM_EXTERNAL_IP"
log ""
log "Then as ${APP_USER}:"
log "  cd ${INSTALL_DIR} && pm2 start ecosystem.config.cjs && pm2 save"
log "  pm2 startup    # run the printed sudo command once"
log "  pm2 logs atent-listener"
