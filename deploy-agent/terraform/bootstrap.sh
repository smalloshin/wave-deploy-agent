#!/usr/bin/env bash
# bootstrap.sh — rebuild wave-deploy-agent from scratch.
#
# Prerequisites:
#   1. GCP project exists + billing enabled
#   2. gcloud authed as Owner/Editor: `gcloud auth login && gcloud auth application-default login`
#   3. terraform >= 1.5 installed
#   4. terraform/terraform.tfvars filled in (copy from .example)
#
# Run from the deploy-agent/ directory:
#   ./terraform/bootstrap.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f terraform.tfvars ]]; then
  echo "❌ terraform/terraform.tfvars not found."
  echo "   Copy terraform.tfvars.example and fill in real values, then re-run."
  exit 1
fi

# Extract project from tfvars
PROJECT=$(grep -E '^gcp_project' terraform.tfvars | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/')
REGION=$(grep -E '^gcp_region' terraform.tfvars | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/' || echo "asia-east1")
TFSTATE_BUCKET="${PROJECT}-tfstate"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Project:        $PROJECT"
echo "  Region:         $REGION"
echo "  TF state:       gs://${TFSTATE_BUCKET}/deploy-agent"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
read -rp "Proceed? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 0

# ─── Step 1: Set gcloud project ──────────────────────────────────────────────
echo ""
echo "▶ Setting gcloud project to $PROJECT..."
gcloud config set project "$PROJECT"

# ─── Step 2: Enable minimum APIs needed to create the state bucket ──────────
echo ""
echo "▶ Enabling storage + iam APIs (needed to create tfstate bucket)..."
gcloud services enable storage.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com --quiet

# ─── Step 3: Create tfstate bucket (idempotent) ──────────────────────────────
echo ""
echo "▶ Creating tfstate bucket if missing..."
if ! gsutil ls -b "gs://${TFSTATE_BUCKET}" &>/dev/null; then
  gsutil mb -l "$REGION" -b on "gs://${TFSTATE_BUCKET}"
  gsutil versioning set on "gs://${TFSTATE_BUCKET}"
  echo "   ✓ Created gs://${TFSTATE_BUCKET} (versioning enabled)"
else
  echo "   ✓ Already exists"
fi

# ─── Step 4: Terraform init + apply ──────────────────────────────────────────
echo ""
echo "▶ terraform init..."
terraform init \
  -backend-config="bucket=${TFSTATE_BUCKET}" \
  -backend-config="prefix=deploy-agent" \
  -reconfigure

echo ""
echo "▶ terraform plan..."
terraform plan -out=tfplan

echo ""
read -rp "Apply plan? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 0

terraform apply tfplan
rm -f tfplan

# ─── Step 5: First build + deploy ────────────────────────────────────────────
echo ""
echo "▶ Triggering first Cloud Build (api + web images)..."
cd ..
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions="SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo bootstrap)" .

# ─── Step 6: DB schema migration ─────────────────────────────────────────────
echo ""
echo "▶ Running DB schema migrations..."
API_URL=$(cd terraform && terraform output -raw api_url)
curl -fsS -X POST "${API_URL}/api/internal/migrate" || \
  echo "   (Migration endpoint not implemented yet — run apps/api/src/db/migrate.ts manually)"

# ─── Step 7: DNS records to create ───────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Bootstrap complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Next step: create these DNS records in Cloudflare"
cd terraform && terraform output dns_records_to_create
echo ""
echo "  Then verify:"
echo "    curl \$(terraform output -raw api_url)/health"
