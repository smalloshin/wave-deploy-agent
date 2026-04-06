# All sensitive values live in Secret Manager, referenced by Cloud Run via
# value_source.secret_key_ref. Values come from terraform.tfvars (gitignored).

locals {
  database_url = "postgresql://${google_sql_user.deploy_agent.name}:${var.db_password}@/${google_sql_database.deploy_agent.name}?host=/cloudsql/${google_sql_database_instance.deploy_agent.connection_name}"
  secrets = {
    database-url      = local.database_url
    redis-password    = var.redis_password
    anthropic-api-key = var.anthropic_api_key
    openai-api-key    = var.openai_api_key
    github-token      = var.github_token
    cloudflare-token  = var.cloudflare_token
  }
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = local.secrets
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "versions" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.secrets[each.key].id
  secret_data = each.value
}

# Grant runtime SA access to all secrets (new deploy-agent SA)
resource "google_secret_manager_secret_iam_member" "agent_access" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.secrets[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent.email}"
}

# Also grant the current prod SA (default compute SA) access — remove once
# Cloud Run services have migrated to the new deploy-agent SA.
resource "google_secret_manager_secret_iam_member" "default_compute_access" {
  for_each  = local.secrets
  secret_id = google_secret_manager_secret.secrets[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}
