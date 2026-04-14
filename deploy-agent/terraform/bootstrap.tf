# APIs, service account, IAM bindings.
# These are the "chicken and egg" resources needed before anything else.

locals {
  required_apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "sql-component.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
    "storage.googleapis.com",
    "iamcredentials.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.required_apis)
  service            = each.value
  disable_on_destroy = false
}

# ─── Dedicated service account for the agent ──────────────────────────────────
# (Currently prod uses the default compute SA; this creates a cleaner one.
#  To adopt: `terraform import google_service_account.agent <email>`.)

resource "google_service_account" "agent" {
  account_id   = "deploy-agent"
  display_name = "Wave Deploy Agent runtime"
  depends_on   = [google_project_service.enabled]
}

# IAM roles the agent needs to manage deployed projects + its own infra
locals {
  agent_roles = [
    "roles/run.admin",                    # deploy/manage Cloud Run services
    "roles/iam.serviceAccountUser",       # act as service accounts
    "roles/artifactregistry.admin",       # push + delete images (orphan cleanup)
    "roles/cloudbuild.builds.editor",     # trigger Cloud Build
    "roles/storage.admin",                # GCS tarballs + build sources + bucket metadata
    "roles/cloudsql.client",              # connect to Cloud SQL
    "roles/cloudsql.instanceUser",        # IAM DB auth (if used)
    "roles/secretmanager.secretAccessor", # read secrets at runtime
    "roles/compute.networkUser",          # Direct VPC egress
    "roles/dns.admin",                    # (reserved for future Cloud DNS)
    "roles/logging.logWriter",            # Cloud Run writes logs
    "roles/monitoring.metricWriter",      # Cloud Run writes metrics
  ]
}

resource "google_project_iam_member" "agent" {
  for_each = toset(local.agent_roles)
  project  = var.gcp_project
  role     = each.value
  member   = "serviceAccount:${google_service_account.agent.email}"
}

# Allow Cloud Build's default SA to deploy Cloud Run + push to AR
data "google_project" "current" {}

resource "google_project_iam_member" "cloudbuild_run_admin" {
  project = var.gcp_project
  role    = "roles/run.admin"
  member  = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"
}

resource "google_project_iam_member" "cloudbuild_sa_user" {
  project = var.gcp_project
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"
}
