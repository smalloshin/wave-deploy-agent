# Remote state stored in GCS so multiple operators can apply safely.
# Bucket must exist before `terraform init` (bootstrap.sh creates it).

terraform {
  backend "gcs" {
    # These are set via -backend-config= in bootstrap.sh:
    #   bucket = "<gcp_project>-tfstate"
    #   prefix = "deploy-agent"
  }
}
