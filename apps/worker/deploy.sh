#!/usr/bin/env bash
set -euo pipefail

# Cloud Run needs permission to read secrets: run once per project / when you add secrets:
#   bash apps/worker/grant-secret-access.sh
# (Grants the default runtime SA secretAccessor on each key from apps/worker/.env.)

# ── GCP ids (edit PROJECT_ID for your project) ─────────────────────────────
export PROJECT_ID="${PROJECT_ID:-project-0c632182-1993-43ca-86d}"
export REGION="${REGION:-europe-west1}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/atent-repo/worker:latest"

# Resolve monorepo root (works whether you run from repo root or apps/worker)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

ENV_FILE="${SCRIPT_DIR}/.env"

# Build --set-secrets from env var *names* in .env (values are ignored here).
# Assumes each Secret Manager secret id matches the env var name: VAR → VAR=VAR:latest
# Skips names Cloud Run injects itself (e.g. PORT) — see container contract.
build_set_secrets_from_dotenv() {
  local line key secrets=() seen="|"
  # https://cloud.google.com/run/docs/reference/container-contract#reserved-env
  local reserved='|PORT|K_SERVICE|K_REVISION|K_CONFIGURATION|'
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "deploy.sh: missing ${ENV_FILE}" >&2
    echo "Create it next to deploy.sh with KEY=value lines (values can be placeholders locally)." >&2
    exit 1
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line//$'\r'/}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" || "${line}" =~ ^# ]] && continue
    if [[ "${line}" =~ ^export[[:space:]]+(.+)$ ]]; then
      line="${BASH_REMATCH[1]}"
    fi
    [[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[1]}"
    [[ "${reserved}" == *"|${key}|"* ]] && continue
    [[ "${seen}" == *"|${key}|"* ]] && continue
    seen="${seen}${key}|"
    secrets+=("${key}=${key}:latest")
  done < "${ENV_FILE}"
  if [[ "${#secrets[@]}" -eq 0 ]]; then
    echo "deploy.sh: no deployable KEY=value entries in ${ENV_FILE} (after skipping reserved names like PORT)." >&2
    exit 1
  fi
  local IFS=','
  echo "${secrets[*]}"
}

SET_SECRETS="$(build_set_secrets_from_dotenv)"

# 1) Build & push image (context = repo root; Dockerfile path via cloudbuild.yaml)
#    Do NOT use `gcloud builds submit --tag ... -f ...` — `-f` is ignored; Cloud
#    Build only looks for ./Dockerfile when using --tag without --config.
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --config="${SCRIPT_DIR}/cloudbuild.yaml" \
  --substitutions="_IMAGE=${IMAGE}" \
  .

# 2) Deploy to Cloud Run — secrets mirror ${SCRIPT_DIR}/.env keys → Secret Manager (same id as key)
gcloud run deploy atent-worker \
  --project="${PROJECT_ID}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --memory 2Gi \
  --cpu-boost \
  --min-instances 0 \
  --max-instances 3 \
  --allow-unauthenticated \
  --set-secrets="${SET_SECRETS}"
