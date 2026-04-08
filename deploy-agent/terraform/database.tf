# Cloud SQL (PostgreSQL 16) — single shared instance for agent + all user projects.

resource "google_sql_database_instance" "deploy_agent" {
  name             = "deploy-agent-db"
  database_version = "POSTGRES_16"
  region           = var.gcp_region

  settings {
    tier              = "db-f1-micro"
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled = true
      authorized_networks {
        name  = "operator-home"
        value = "114.137.144.128/32"
      }
    }

    backup_configuration {
      enabled                        = true # ⚠ was disabled in prod pre-terraform
      start_time                     = "18:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 3
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  deletion_protection = true
  depends_on          = [google_project_service.enabled]
}

resource "google_sql_database" "deploy_agent" {
  name     = "deploy_agent"
  instance = google_sql_database_instance.deploy_agent.name
}

resource "google_sql_user" "deploy_agent" {
  name     = "deploy_agent"
  instance = google_sql_database_instance.deploy_agent.name
  password = var.db_password
}
