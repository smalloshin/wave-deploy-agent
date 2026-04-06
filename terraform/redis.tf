# Shared Redis VM (e2-micro COS) — one instance, multiple logical DBs (0-15)
# allocated by redis-provisioner.ts. Not for HA workloads; fine for session
# caches and rate limits.

resource "google_compute_firewall" "redis_internal" {
  name    = "shared-redis-internal"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["6379"]
  }

  source_ranges = ["10.0.0.0/8"]
  target_tags   = ["shared-redis"]

  depends_on = [google_project_service.enabled]
}

resource "google_compute_instance" "shared_redis" {
  name         = "shared-redis"
  machine_type = "e2-micro"
  zone         = var.redis_zone

  tags = ["shared-redis"]

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 10
    }
  }

  network_interface {
    network = "default"
    access_config {
      # Ephemeral public IP for pulling the Redis image on first boot
    }
  }

  metadata = {
    gce-container-declaration = yamlencode({
      spec = {
        containers = [{
          name  = "redis"
          image = "redis:7-alpine"
          args = compact([
            "redis-server",
            "--appendonly", "yes",
            "--maxmemory", "200mb",
            "--maxmemory-policy", "allkeys-lru",
            var.redis_password != "" ? "--requirepass" : "",
            var.redis_password,
          ])
          volumeMounts = [{
            name      = "redis-data"
            mountPath = "/data"
          }]
        }]
        volumes = [{
          name     = "redis-data"
          hostPath = { path = "/var/lib/redis" }
        }]
        restartPolicy = "Always"
      }
    })
  }

  service_account {
    scopes = ["logging-write", "monitoring-write"]
  }

  depends_on = [google_project_service.enabled]

  lifecycle {
    # Redis is running fine; don't trigger VM stop/restart for config drift.
    # If you need to change these, set allow_stopping_for_update = true explicitly.
    ignore_changes = [
      service_account,
      metadata,
      machine_type,
    ]
  }
}
