# Cloud Run v2 services: agent API + Web UI. All secrets pulled from Secret
# Manager. First apply uses :latest; subsequent deploys handled by cloudbuild.yaml.

locals {
  ar_base = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project}/deploy-agent"
}

# ─── API ───────────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "api" {
  name     = "deploy-agent-api"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.agent.email
    timeout                          = "900s"
    max_instance_request_concurrency = 160

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    # Direct VPC egress on default network so API can reach the Redis VM
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = "default"
        subnetwork = "default"
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.deploy_agent.connection_name]
      }
    }

    containers {
      image = "${local.ar_base}/api:${var.api_image_tag}"

      ports {
        container_port = 4000
      }

      resources {
        cpu_idle          = false # no throttling
        startup_cpu_boost = true
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      # Non-secret env vars
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GCP_PROJECT"
        value = var.gcp_project
      }
      env {
        name  = "GCP_REGION"
        value = var.gcp_region
      }
      env {
        name  = "CORS_ORIGIN"
        value = var.cors_origins
      }
      env {
        name  = "CLOUDFLARE_ZONE_ID"
        value = var.cloudflare_zone_id
      }
      env {
        name  = "CLOUDFLARE_ZONE_NAME"
        value = var.cloudflare_zone_name
      }
      env {
        name  = "SHARED_REDIS_HOST"
        value = google_compute_instance.shared_redis.network_interface[0].network_ip
      }
      env {
        name  = "SHARED_REDIS_PORT"
        value = "6379"
      }

      # Secret-backed env vars
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["anthropic-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["openai-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GITHUB_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["github-token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CLOUDFLARE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["cloudflare-token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SHARED_REDIS_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["redis-password"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.agent_access,
    google_project_iam_member.agent,
  ]

  lifecycle {
    # cloudbuild.yaml updates image tag on every deploy; ignore image drift
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ─── Web UI ────────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "web" {
  name     = "deploy-agent-web"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.agent.email
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = "${local.ar_base}/web:${var.web_image_tag}"

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "NEXT_PUBLIC_API_URL"
        value = "https://${var.api_domain}"
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ─── Discord Bot ──────────────────────────────────────────────────────────────
# WebSocket-based bot: always-on (min=1, no-cpu-throttling), no public access.
# Health check HTTP server on :8080 for Cloud Run startup probe.

resource "google_cloud_run_v2_service" "bot" {
  name     = "deploy-agent-bot"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.agent.email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      image = "${local.ar_base}/bot:${var.bot_image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle          = false # no throttling — WebSocket bot needs always-on CPU
        startup_cpu_boost = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      # Non-secret env vars
      env {
        name  = "API_BASE_URL"
        value = "https://${var.api_domain}"
      }

      # Secret-backed env vars
      env {
        name = "DISCORD_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["DISCORD_TOKEN"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DISCORD_APP_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["DISCORD_APP_ID"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DISCORD_GUILD_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["DISCORD_GUILD_ID"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DISCORD_CHANNEL_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["DISCORD_CHANNEL_ID"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["anthropic-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["openai-api-key"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.agent_access,
    google_project_iam_member.agent,
  ]

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

# Bot is NOT public — only Cloud Run's internal health check needs access
