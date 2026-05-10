#!/usr/bin/env bash
# One-time (or after new secrets): grant Cloud Run's runtime service account access to
# Secret Manager secrets listed in .env (same keys as deploy.sh uses).
#
# Default runtime SA: PROJECT_NUMBER-compute@developer.gserviceaccount.com
# Override: RUNTIME_SA=my-run-sa@PROJECT_ID.iam.gserviceaccount.com bash grant-secret-access.sh
#
# Requires: gcloud auth, roles/secretmanager.admin or owner on the project.

set -euo pipefail

export PROJECT_ID="${PROJECT_ID:-project-0c632182-1993-43ca-86d}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

# https://cloud.google.com/run/docs/reference/container-contract#reserved-env
reserved='|PORT|K_SERVICE|K_REVISION|K_CONFIGURATION|'

if [[ -z "${RUNTIME_SA:-}" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

MEMBER="serviceAccount:${RUNTIME_SA}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "grant-secret-access.sh: missing ${ENV_FILE}" >&2
  exit 1
fi

echo "Granting roles/secretmanager.secretAccessor to ${MEMBER} on secrets from .env keys..."

seen="|"
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

  echo "  → ${key}"
  gcloud secrets add-iam-policy-binding "${key}" \
    --project="${PROJECT_ID}" \
    --member="${MEMBER}" \
    --role="roles/secretmanager.secretAccessor"
done < "${ENV_FILE}"

echo "Done. Redeploy with: pnpm --dir apps/worker run deploy"
