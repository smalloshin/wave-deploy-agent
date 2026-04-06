import { v4 as uuid } from 'uuid';
import { query, getOne } from '../db/index';
import {
  canTransition,
  InvalidTransitionError,
  type ProjectStatus,
  type Project,
  type ScanReport,
  type Review,
  type Deployment,
} from '@deploy-agent/shared';

export async function createProject(input: {
  name: string;
  sourceType: string;
  sourceUrl?: string;
  config?: Record<string, unknown>;
}): Promise<Project> {
  const baseSlug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 55); // Leave room for suffix like "-2", "-99"

  // Find a unique slug by checking for collisions and appending a numeric suffix
  let slug = baseSlug;
  const existing = await query(
    `SELECT slug FROM projects WHERE slug = $1 OR slug LIKE $2 ORDER BY slug`,
    [baseSlug, `${baseSlug}-%`]
  );
  if (existing.rows.length > 0) {
    const takenSlugs = new Set(existing.rows.map((r: Record<string, unknown>) => r.slug as string));
    if (takenSlugs.has(baseSlug)) {
      // Find the next available suffix
      let suffix = 2;
      while (takenSlugs.has(`${baseSlug}-${suffix}`)) {
        suffix++;
      }
      slug = `${baseSlug}-${suffix}`.slice(0, 60);
      console.log(`[Orchestrator] Slug collision: "${baseSlug}" taken, using "${slug}"`);
    }
  }

  const result = await query(
    `INSERT INTO projects (name, slug, source_type, source_url, config)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.name, slug, input.sourceType, input.sourceUrl ?? null, JSON.stringify(input.config ?? {})]
  );

  // Ensure every project belongs to a group — singleton projects group by themselves.
  const row = result.rows[0];
  const cfg = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) ?? {};
  if (!cfg.projectGroup) {
    cfg.projectGroup = row.id as string;
    cfg.groupName = cfg.groupName ?? input.name;
    await query('UPDATE projects SET config = $1 WHERE id = $2', [JSON.stringify(cfg), row.id]);
    row.config = cfg;
  } else if (!cfg.groupName) {
    // Backfill groupName from current name if monorepo flow forgot it
    cfg.groupName = input.name.replace(/-(?:backend|frontend|api|web|worker|server|client|app)$/i, '');
    await query('UPDATE projects SET config = $1 WHERE id = $2', [JSON.stringify(cfg), row.id]);
    row.config = cfg;
  }

  await logTransition(row.id, null, 'submitted', 'system', { action: 'create' });
  return rowToProject(row);
}

export async function transitionProject(
  projectId: string,
  toState: ProjectStatus,
  triggeredBy: string,
  metadata: Record<string, unknown> = {}
): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  if (!canTransition(project.status, toState)) {
    throw new InvalidTransitionError(project.status, toState);
  }

  const result = await query(
    `UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [toState, projectId]
  );

  await logTransition(projectId, project.status, toState, triggeredBy, metadata);
  return rowToProject(result.rows[0]);
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await getOne('SELECT * FROM projects WHERE id = $1', [id]);
  return row ? rowToProject(row) : null;
}

export async function listProjects(): Promise<Project[]> {
  const result = await query('SELECT * FROM projects ORDER BY created_at DESC');
  return result.rows.map(rowToProject);
}

export async function createScanReport(projectId: string): Promise<ScanReport> {
  const existing = await query(
    'SELECT COALESCE(MAX(version), 0) as max_version FROM scan_reports WHERE project_id = $1',
    [projectId]
  );
  const version = (existing.rows[0]?.max_version ?? 0) + 1;

  const result = await query(
    `INSERT INTO scan_reports (project_id, version)
     VALUES ($1, $2)
     RETURNING *`,
    [projectId, version]
  );
  return rowToScanReport(result.rows[0]);
}

export async function updateScanReport(
  id: string,
  updates: Partial<{
    semgrepFindings: unknown;
    trivyFindings: unknown;
    llmAnalysis: unknown;
    autoFixes: unknown;
    verificationResults: unknown;
    threatSummary: string;
    costEstimate: unknown;
    resourcePlan: unknown;
    status: string;
  }>
): Promise<ScanReport> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.semgrepFindings !== undefined) { sets.push(`semgrep_findings = $${idx++}`); params.push(JSON.stringify(updates.semgrepFindings)); }
  if (updates.trivyFindings !== undefined) { sets.push(`trivy_findings = $${idx++}`); params.push(JSON.stringify(updates.trivyFindings)); }
  if (updates.llmAnalysis !== undefined) { sets.push(`llm_analysis = $${idx++}`); params.push(JSON.stringify(updates.llmAnalysis)); }
  if (updates.autoFixes !== undefined) { sets.push(`auto_fixes = $${idx++}`); params.push(JSON.stringify(updates.autoFixes)); }
  if (updates.verificationResults !== undefined) { sets.push(`verification_results = $${idx++}`); params.push(JSON.stringify(updates.verificationResults)); }
  if (updates.threatSummary !== undefined) { sets.push(`threat_summary = $${idx++}`); params.push(updates.threatSummary); }
  if (updates.costEstimate !== undefined) { sets.push(`cost_estimate = $${idx++}`); params.push(JSON.stringify(updates.costEstimate)); }
  if (updates.resourcePlan !== undefined) { sets.push(`resource_plan = $${idx++}`); params.push(JSON.stringify(updates.resourcePlan)); }
  if (updates.status !== undefined) { sets.push(`status = $${idx++}`); params.push(updates.status); }

  params.push(id);
  const result = await query(
    `UPDATE scan_reports SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rowToScanReport(result.rows[0]);
}

export async function getLatestScanReport(projectId: string): Promise<ScanReport | null> {
  const row = await getOne(
    'SELECT * FROM scan_reports WHERE project_id = $1 ORDER BY version DESC LIMIT 1',
    [projectId]
  );
  return row ? rowToScanReport(row) : null;
}

export async function createReview(scanReportId: string, previewUrl?: string): Promise<Review> {
  const result = await query(
    `INSERT INTO reviews (scan_report_id, preview_url) VALUES ($1, $2) RETURNING *`,
    [scanReportId, previewUrl ?? null]
  );
  return rowToReview(result.rows[0]);
}

export async function submitReview(
  reviewId: string,
  decision: 'approved' | 'rejected',
  reviewerEmail: string,
  comments?: string
): Promise<Review> {
  const result = await query(
    `UPDATE reviews SET decision = $1, reviewer_email = $2, comments = $3, reviewed_at = NOW()
     WHERE id = $4 RETURNING *`,
    [decision, reviewerEmail, comments ?? null, reviewId]
  );
  return rowToReview(result.rows[0]);
}

export async function createDeployment(
  projectId: string,
  reviewId?: string
): Promise<Deployment> {
  const result = await query(
    `INSERT INTO deployments (project_id, review_id) VALUES ($1, $2) RETURNING *`,
    [projectId, reviewId ?? null]
  );
  return rowToDeployment(result.rows[0]);
}

export async function updateDeployment(
  id: string,
  updates: Partial<{
    cloudRunService: string;
    cloudRunUrl: string;
    customDomain: string;
    sslStatus: string;
    healthStatus: string;
    canaryResults: unknown;
    gitPrUrl: string;
    terraformConfig: string;
    deployedAt: Date;
  }>
): Promise<Deployment> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.cloudRunService !== undefined) { sets.push(`cloud_run_service = $${idx++}`); params.push(updates.cloudRunService); }
  if (updates.cloudRunUrl !== undefined) { sets.push(`cloud_run_url = $${idx++}`); params.push(updates.cloudRunUrl); }
  if (updates.customDomain !== undefined) { sets.push(`custom_domain = $${idx++}`); params.push(updates.customDomain); }
  if (updates.sslStatus !== undefined) { sets.push(`ssl_status = $${idx++}`); params.push(updates.sslStatus); }
  if (updates.healthStatus !== undefined) { sets.push(`health_status = $${idx++}`); params.push(updates.healthStatus); }
  if (updates.canaryResults !== undefined) { sets.push(`canary_results = $${idx++}`); params.push(JSON.stringify(updates.canaryResults)); }
  if (updates.gitPrUrl !== undefined) { sets.push(`git_pr_url = $${idx++}`); params.push(updates.gitPrUrl); }
  if (updates.terraformConfig !== undefined) { sets.push(`terraform_config = $${idx++}`); params.push(updates.terraformConfig); }
  if (updates.deployedAt !== undefined) { sets.push(`deployed_at = $${idx++}`); params.push(updates.deployedAt); }

  if (sets.length === 0) {
    const row = await getOne('SELECT * FROM deployments WHERE id = $1', [id]);
    if (!row) throw new Error(`Deployment not found: ${id}`);
    return rowToDeployment(row);
  }

  params.push(id);
  const result = await query(
    `UPDATE deployments SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw new Error(`Deployment not found: ${id}`);
  return rowToDeployment(result.rows[0]);
}

export async function getDeploymentsByProject(projectId: string): Promise<Deployment[]> {
  const result = await query(
    'SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return result.rows.map(rowToDeployment);
}

export async function updateProjectConfig(
  projectId: string,
  config: Record<string, unknown>,
): Promise<Project> {
  const result = await query(
    `UPDATE projects SET config = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(config), projectId]
  );
  if (result.rows.length === 0) throw new Error(`Project not found: ${projectId}`);
  return rowToProject(result.rows[0]);
}

export async function deleteProjectFromDb(projectId: string): Promise<void> {
  // ON DELETE CASCADE handles scan_reports, reviews, deployments, state_transitions
  await query('DELETE FROM projects WHERE id = $1', [projectId]);
}

async function logTransition(
  projectId: string,
  fromState: ProjectStatus | null,
  toState: ProjectStatus,
  triggeredBy: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO state_transitions (project_id, from_state, to_state, triggered_by, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, fromState, toState, triggeredBy, JSON.stringify(metadata)]
  );
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    sourceType: row.source_type as Project['sourceType'],
    sourceUrl: row.source_url as string | null,
    detectedLanguage: row.detected_language as string | null,
    detectedFramework: row.detected_framework as string | null,
    status: row.status as ProjectStatus,
    config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as Project['config'],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToScanReport(row: Record<string, unknown>): ScanReport {
  // Parse findings from DB JSON columns
  const semgrepFindings = parseJsonField(row.semgrep_findings) as Array<Record<string, unknown>> ?? [];
  const trivyFindings = parseJsonField(row.trivy_findings) as Array<Record<string, unknown>> ?? [];
  const llmAnalysis = parseJsonField(row.llm_analysis) as {
    findings?: Array<Record<string, unknown>>;
    autoFixes?: Array<Record<string, unknown>>;
    summary?: string;
  } | null;
  // auto_fixes column stores apply results: {applied, diff, explanation, verificationPassed}
  const applyResults = (parseJsonField(row.auto_fixes) as Array<Record<string, unknown>>) ?? [];
  // LLM auto-fix suggestions: {findingId, filePath, originalCode, fixedCode, explanation}
  const llmAutoFixes = llmAnalysis?.autoFixes ?? [];

  // Merge all findings into one list
  const allFindings = [
    ...semgrepFindings,
    ...trivyFindings,
    ...(llmAnalysis?.findings ?? []),
  ];

  // Merge auto-fix data: combine LLM suggestions with apply results
  // Each LLM suggestion may have a corresponding apply result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergedAutoFixes: any[] = llmAutoFixes.map((suggestion, i) => ({
    ...suggestion,
    applied: applyResults[i]?.applied ?? false,
    diff: applyResults[i]?.diff ?? '',
  }));
  // If there are more apply results than suggestions (shouldn't happen, but safe)
  for (let i = llmAutoFixes.length; i < applyResults.length; i++) {
    mergedAutoFixes.push(applyResults[i]);
  }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    version: row.version as number,
    findings: allFindings as unknown as ScanReport['findings'],
    autoFixes: mergedAutoFixes as unknown as ScanReport['autoFixes'],
    threatSummary: (row.threat_summary as string) ?? '',
    costEstimate: row.cost_estimate as ScanReport['costEstimate'],
    resourcePlan: (parseJsonField(row.resource_plan) as ScanReport['resourcePlan']) ?? null,
    status: row.status as ScanReport['status'],
    createdAt: new Date(row.created_at as string),
  };
}

function parseJsonField(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val; // already parsed by pg driver
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
}

function rowToReview(row: Record<string, unknown>): Review {
  return {
    id: row.id as string,
    scanReportId: row.scan_report_id as string,
    reviewerEmail: row.reviewer_email as string | null,
    decision: row.decision as Review['decision'],
    comments: row.comments as string | null,
    previewUrl: row.preview_url as string | null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

function rowToDeployment(row: Record<string, unknown>): Deployment {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    reviewId: row.review_id as string | null,
    cloudRunService: row.cloud_run_service as string | null,
    cloudRunUrl: row.cloud_run_url as string | null,
    customDomain: row.custom_domain as string | null,
    sslStatus: row.ssl_status as string | null,
    terraformConfig: row.terraform_config as string | null,
    healthStatus: row.health_status as Deployment['healthStatus'],
    canaryResults: row.canary_results as Deployment['canaryResults'],
    gitPrUrl: row.git_pr_url as string | null,
    deployedAt: row.deployed_at ? new Date(row.deployed_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}
