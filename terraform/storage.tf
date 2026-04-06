# Cloud Build sources bucket + Artifact Registry repo with cleanup policies.

resource "google_storage_bucket" "cloudbuild" {
  name     = "${var.gcp_project}_cloudbuild"
  location = "US" # matches existing prod (multi-region); cannot relocate without recreate
  force_destroy = false

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age              = 30
      matches_prefix   = ["sources/"]
      send_age_if_zero = true
      with_state       = "ANY"
    }
  }

  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  depends_on = [google_project_service.enabled]

  lifecycle {
    ignore_changes = [
      labels, # managed by Cloud Build, fluctuates
    ]
  }
}

resource "google_artifact_registry_repository" "deploy_agent" {
  location      = var.gcp_region
  repository_id = "deploy-agent"
  format        = "DOCKER"
  description   = "Images for deploy-agent itself and all deployed user projects"

  # Keep 5 most recent tagged versions per package, delete untagged >7d, tagged >30d
  cleanup_policies {
    id     = "keep-recent-tagged"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "delete-old-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7d
    }
  }
  cleanup_policies {
    id     = "delete-old-tagged"
    action = "DELETE"
    condition {
      tag_state  = "TAGGED"
      older_than = "2592000s" # 30d
    }
  }

  depends_on = [google_project_service.enabled]
}
