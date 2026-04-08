output "db_connection_name" {
  description = "Cloud SQL connection name (used in DATABASE_URL socket path)"
  value       = google_sql_database_instance.deploy_agent.connection_name
}

output "shared_redis_internal_ip" {
  description = "Internal IP for shared Redis VM"
  value       = google_compute_instance.shared_redis.network_interface[0].network_ip
}

output "agent_service_account" {
  description = "Runtime service account email"
  value       = google_service_account.agent.email
}

# NOTE: Cloud Run services + domain mappings are currently managed by
# cloudbuild.yaml + gcloud (services.tf.deferred + domains.tf.deferred).
# Migrate to TF once prod Cloud Run SA aligns with deploy-agent@ SA.
