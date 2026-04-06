# Cloud Run domain mappings. DNS records (CNAME to ghs.googlehosted.com) must
# be created manually in Cloudflare; see outputs.tf for the exact records.

resource "google_cloud_run_domain_mapping" "api" {
  location = var.gcp_region
  name     = var.api_domain

  metadata {
    namespace = var.gcp_project
  }

  spec {
    route_name = google_cloud_run_v2_service.api.name
  }
}

resource "google_cloud_run_domain_mapping" "web" {
  location = var.gcp_region
  name     = var.web_domain

  metadata {
    namespace = var.gcp_project
  }

  spec {
    route_name = google_cloud_run_v2_service.web.name
  }
}
