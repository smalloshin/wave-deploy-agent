-- Deploy Agent Database Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(60) NOT NULL UNIQUE,
  source_type VARCHAR(50) NOT NULL,
  source_url TEXT,
  detected_language VARCHAR(50),
  detected_framework VARCHAR(100),
  status VARCHAR(50) NOT NULL DEFAULT 'submitted',
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

-- Scan Reports
CREATE TABLE IF NOT EXISTS scan_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  semgrep_findings JSONB,
  trivy_findings JSONB,
  llm_analysis JSONB,
  auto_fixes JSONB,
  verification_results JSONB,
  threat_summary TEXT,
  cost_estimate JSONB,
  resource_plan JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'scanning',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_reports_project ON scan_reports(project_id);

-- Migration for existing installs: add resource_plan column if missing
ALTER TABLE scan_reports ADD COLUMN IF NOT EXISTS resource_plan JSONB;

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_report_id UUID NOT NULL REFERENCES scan_reports(id) ON DELETE CASCADE,
  reviewer_email VARCHAR(255),
  decision VARCHAR(20),
  comments TEXT,
  preview_url TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_scan_report ON reviews(scan_report_id);
CREATE INDEX IF NOT EXISTS idx_reviews_decision ON reviews(decision);

-- Deployments
CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_id UUID REFERENCES reviews(id),
  cloud_run_service VARCHAR(255),
  cloud_run_url TEXT,
  custom_domain VARCHAR(255),
  ssl_status VARCHAR(50),
  terraform_config TEXT,
  health_status VARCHAR(50) DEFAULT 'unknown',
  canary_results JSONB,
  git_pr_url TEXT,
  deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);

-- State machine audit log
CREATE TABLE IF NOT EXISTS state_transitions (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_state VARCHAR(50),
  to_state VARCHAR(50) NOT NULL,
  triggered_by VARCHAR(255) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_project ON state_transitions(project_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_created ON state_transitions(created_at);

-- Backfill: ensure every project has a projectGroup + groupName (singletons group by their own id)
UPDATE projects
SET config = jsonb_set(
               jsonb_set(config, '{projectGroup}', to_jsonb(id::text)),
               '{groupName}', to_jsonb(name)
             )
WHERE config->>'projectGroup' IS NULL;

UPDATE projects
SET config = jsonb_set(config, '{groupName}', to_jsonb(name))
WHERE config->>'groupName' IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_group ON projects((config->>'projectGroup'));

-- Backfill: ensure all projects default to allowUnauthenticated = true (public access)
-- This fixes projects created before the default was corrected in deploy-worker.ts
UPDATE projects
SET config = jsonb_set(config, '{allowUnauthenticated}', 'true')
WHERE config->>'allowUnauthenticated' = 'false'
   OR config->>'allowUnauthenticated' IS NULL;

-- ─── Versioning support (Netlify-like deploy model) ───
-- Each deployment is an immutable snapshot with its own Cloud Run revision.
-- Only one deployment is "published" (receiving production traffic) at a time.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS image_uri TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS revision_name VARCHAR(255);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS preview_url TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT false;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- Deployed source snapshot — post-fix code (with generated Dockerfile) captured
-- at the moment of successful deploy. Stored long-term so users can download
-- the exact deployed version and continue development from a secure baseline.
-- Lives in gs://wave-deploy-agent-deployed/{slug}/v{version}.tgz (365d lifecycle).
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deployed_source_gcs_uri TEXT;

-- Projects: deploy lock prevents auto-publish; published_deployment_id tracks active version
ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_deployment_id UUID REFERENCES deployments(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_locked BOOLEAN DEFAULT false;

-- ─── GitHub webhook auto-deploy (Versioning Phase 3) ───
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_webhook_secret TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_branch TEXT DEFAULT 'main';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_deploy BOOLEAN DEFAULT false;

-- ═══════════════════════════════════════════════════════════════
-- RBAC / Auth (Phase 1: permissive mode, zero-downtime migration)
-- ═══════════════════════════════════════════════════════════════

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL UNIQUE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  is_system BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role_id UUID REFERENCES roles(id) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Sessions (httpOnly cookie)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- API Keys (Bot / MCP / CI)
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  key_prefix VARCHAR(16) NOT NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- Auth audit log
CREATE TABLE IF NOT EXISTS auth_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  resource VARCHAR(255),
  ip_address INET,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_log(user_id);

-- Seed system roles (idempotent via ON CONFLICT)
INSERT INTO roles (name, permissions, description, is_system)
VALUES
  ('admin', ARRAY['*'], 'Full access to everything', true),
  ('reviewer',
    ARRAY['projects:read','reviews:read','reviews:decide','deploys:read','versions:read','mcp:access'],
    'Security reviewer — can approve/reject deploys',
    true),
  ('viewer',
    ARRAY['projects:read','reviews:read','deploys:read','versions:read','infra:read','settings:read'],
    'Read-only monitoring',
    true)
ON CONFLICT (name) DO UPDATE
  SET permissions = EXCLUDED.permissions,
      description = EXCLUDED.description,
      is_system = EXCLUDED.is_system;
