#!/usr/bin/env bash
# import.sh — adopt existing prod resources into Terraform state.
# Run this ONCE after a fresh `terraform init`. Idempotent: already-imported
# resources produce a warning and continue.

set -uo pipefail

TF=/opt/homebrew/bin/terraform
PROJECT=wave-deploy-agent
REGION=asia-east1
REDIS_ZONE=asia-east1-b

# Skip resource if already in state
try_import() {
  local addr=$1 id=$2
  if $TF state show "$addr" &>/dev/null; then
    echo "  ⚠ $addr already in state"
    return
  fi
  echo "▶ importing: $addr"
  $TF import "$addr" "$id" 2>&1 | tail -3
  echo ""
}

# ─── APIs ───────────────────────────────────────────────────────────────────
for api in \
  run.googleapis.com \
  sqladmin.googleapis.com \
  sql-component.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com
do
  try_import "google_project_service.enabled[\"$api\"]" "$PROJECT/$api"
done

# ─── Storage + Artifact Registry ────────────────────────────────────────────
try_import "google_storage_bucket.cloudbuild" "${PROJECT}_cloudbuild"
try_import "google_artifact_registry_repository.deploy_agent" \
  "projects/$PROJECT/locations/$REGION/repositories/deploy-agent"

# ─── Cloud SQL ──────────────────────────────────────────────────────────────
try_import "google_sql_database_instance.deploy_agent" \
  "projects/$PROJECT/instances/deploy-agent-db"
try_import "google_sql_database.deploy_agent" \
  "projects/$PROJECT/instances/deploy-agent-db/databases/deploy_agent"
try_import "google_sql_user.deploy_agent" \
  "$PROJECT/deploy-agent-db/deploy_agent"

# ─── Redis VM ───────────────────────────────────────────────────────────────
try_import "google_compute_firewall.redis_internal" \
  "projects/$PROJECT/global/firewalls/shared-redis-internal"
try_import "google_compute_instance.shared_redis" \
  "projects/$PROJECT/zones/$REDIS_ZONE/instances/shared-redis"

# ─── Secrets (we just created these via gcloud) ─────────────────────────────
for s in anthropic-api-key openai-api-key github-token cloudflare-token redis-password database-url; do
  try_import "google_secret_manager_secret.secrets[\"$s\"]" \
    "projects/$PROJECT/secrets/$s"
  try_import "google_secret_manager_secret_version.versions[\"$s\"]" \
    "projects/$PROJECT/secrets/$s/versions/1"
  try_import "google_secret_manager_secret_iam_member.default_compute_access[\"$s\"]" \
    "projects/$PROJECT/secrets/$s roles/secretmanager.secretAccessor serviceAccount:770983127516-compute@developer.gserviceaccount.com"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Import complete. Run:  terraform plan"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
