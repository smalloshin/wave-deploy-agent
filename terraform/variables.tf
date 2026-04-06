variable "gcp_project" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP region"
  type        = string
  default     = "asia-east1"
}

variable "redis_zone" {
  description = "GCP zone for shared Redis VM"
  type        = string
  default     = "asia-east1-b"
}

variable "api_domain" {
  description = "Custom domain for API service (DNS must point to Cloud Run)"
  type        = string
}

variable "web_domain" {
  description = "Custom domain for Web UI (DNS must point to Cloud Run)"
  type        = string
}

variable "cors_origins" {
  description = "Comma-separated allowed CORS origins for the API"
  type        = string
}

# ─── Secrets (stored in Secret Manager) ────────────────────────────────────────
# These are read from env vars or terraform.tfvars; never commit to git.

variable "db_password" {
  description = "Cloud SQL deploy_agent user password"
  type        = string
  sensitive   = true
}

variable "redis_password" {
  description = "Shared Redis instance password"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for LLM analysis"
  type        = string
  sensitive   = true
}

variable "openai_api_key" {
  description = "OpenAI API key (fallback LLM)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_token" {
  description = "GitHub PAT for cloning private repos + security fixes"
  type        = string
  sensitive   = true
}

variable "cloudflare_token" {
  description = "Cloudflare API token for DNS management"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for DNS records"
  type        = string
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name (e.g. punwave.com)"
  type        = string
}

# ─── Scaling knobs ─────────────────────────────────────────────────────────────

variable "api_image_tag" {
  description = "Container image tag for API service"
  type        = string
  default     = "latest"
}

variable "web_image_tag" {
  description = "Container image tag for Web service"
  type        = string
  default     = "latest"
}

variable "api_min_instances" {
  type    = number
  default = 1
}

variable "api_max_instances" {
  type    = number
  default = 3
}
