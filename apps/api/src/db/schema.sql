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
