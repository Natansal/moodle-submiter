#!/usr/bin/env bash
#
# Build a self-contained listener bundle for GCP (Linux x86_64), suitable for rsync to e2-micro.
# Run on your Mac from the monorepo root:
#   ./apps/listener/deploy/bundle-for-vm.sh
#
# Default: build inside Docker (linux/amd64) so native deps (sharp, Prisma engines) match the VM.
# Requires Docker Desktop (or Colima, etc.) to be **running**.
#
# If Docker isn’t available:
#   • Start Docker Desktop and re-run, OR
#   • MAC_BUNDLE_ONLY=1 ./apps/listener/deploy/bundle-for-vm.sh
#     (macOS binaries — do not rsync that bundle to a Linux GCP VM.)
#

set -euo pipefail

docker_daemon_ok() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_REL="apps/listener/deploy/bundle"
OUT_ABS="${REPO_ROOT}/${OUT_REL}"
NODE_IMAGE="${NODE_IMAGE:-node:20-bookworm-slim}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cd "${REPO_ROOT}"

copy_ecosystem() {
  cp "${SCRIPT_DIR}/ecosystem.config.cjs" "${DEPLOY_OUT}/"
}

bundle_docker() {
  log "Building Linux bundle in Docker (${NODE_IMAGE}, linux/amd64)..."
  rm -rf "${OUT_ABS}"
  mkdir -p "$(dirname "${OUT_ABS}")"
  local inner
  inner="$(cat <<'EOF'
set -euo pipefail
apt-get update -qq
# git: Baileys → libsignal-node (git URL); required for pnpm deploy dependency resolution
apt-get install -y -qq git openssl ca-certificates
rm -rf /var/lib/apt/lists/*
corepack enable && corepack prepare pnpm@9.15.0 --activate
export CI=true
cd /repo
pnpm install --frozen-lockfile
pnpm --filter @repo/database exec prisma generate
pnpm turbo run build --filter=@app/listener
rm -rf /out/listener-bundle
pnpm --filter @app/listener deploy -P /out/listener-bundle
mkdir -p "$(dirname "/repo/PLACEHOLDER_OUT")"
rm -rf "/repo/PLACEHOLDER_OUT"
mv /out/listener-bundle "/repo/PLACEHOLDER_OUT"
EOF
)"
  inner="${inner//PLACEHOLDER_OUT/${OUT_REL}}"
  docker run --rm --platform linux/amd64 \
    -v "${REPO_ROOT}:/repo:rw" \
    -w /repo \
    "${NODE_IMAGE}" \
    bash -lc "${inner}"
  DEPLOY_OUT="$(cd "${OUT_ABS}" && pwd)"
  copy_ecosystem
}

bundle_mac() {
  log "Building bundle on host (macOS). Native modules will NOT match Linux — do not rsync this to GCP."
  local tmp_bundle
  tmp_bundle="${TMPDIR:-/tmp}/atent-listener-bundle.$$"
  rm -rf "${tmp_bundle}"
  export CI=true
  pnpm install --frozen-lockfile
  pnpm --filter @repo/database exec prisma generate
  pnpm turbo run build --filter=@app/listener
  # Deploy to a path outside apps/listener/ — pnpm otherwise nests apps/listener/... under the package.
  pnpm --filter @app/listener deploy -P "${tmp_bundle}"
  rm -rf "${OUT_ABS}"
  mkdir -p "$(dirname "${OUT_ABS}")"
  mv "${tmp_bundle}" "${OUT_ABS}"
  DEPLOY_OUT="$(cd "${OUT_ABS}" && pwd)"
  copy_ecosystem
}

if [[ "${MAC_BUNDLE_ONLY:-}" == "1" ]]; then
  bundle_mac
elif docker_daemon_ok; then
  bundle_docker
else
  die "$(cat <<'EOF'
Cannot build the Linux/GCP bundle: Docker is not running or not reachable.

For GCP (e2-micro), native modules must match linux/amd64:
  1. Start Docker Desktop (or your Docker engine), then re-run:
       ./apps/listener/deploy/bundle-for-vm.sh

Or build on macOS only (do NOT rsync this to a Linux VM):
       MAC_BUNDLE_ONLY=1 ./apps/listener/deploy/bundle-for-vm.sh
EOF
)"
fi

log "Bundle ready: ${DEPLOY_OUT:-${OUT_ABS}}"
log "Next: ./apps/listener/deploy/sync-to-vm.sh user@VM_EXTERNAL_IP"
