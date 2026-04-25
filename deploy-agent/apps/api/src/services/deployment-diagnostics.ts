/**
 * Deployment diagnostics — LLM-cached failure / slowness explanations.
 *
 * Tier 3 of the observability stack. Surfaces when a deploy fails or runs
 * unusually slow; the user opens the detail page and clicks "Explain why" —
 * we read the relevant log + state, ask an LLM, cache the result by an
 * immutable key (build_id for failures during build; deployment_id for
 * deploy-stage failures and slowness).
 *
 * Cache invariants:
 *   - cache_key + kind is UNIQUE in DB (enforced by schema constraint).
 *   - We attempt INSERT first; on unique violation we read the existing row
 *     (concurrent diagnose calls converge on a single LLM run).
 *   - The cache is content-addressable: same build_id → same diagnosis.
 *     We never invalidate; if the user wants a re-run, delete the row.
 *
 * Returns: { cached: boolean, diagnosis: DiagnosticRow }.
 */

import { query } from '../db/index';
import { getStageEvents } from './stage-events';
import { fetchBuildLogOnce } from './build-log-poller';
import { callLLM } from './llm-analyzer';

export type DiagnosticKind = 'failure' | 'slow';

export interface DiagnosticSuggestion {
  title: string;
  body: string;
}

export interface DiagnosticRow {
  id: number;
  deployment_id: string | null;
  cache_key: string;
  kind: DiagnosticKind;
  summary: string;
  root_cause: string | null;
  suggestions: DiagnosticSuggestion[];
  log_excerpt: string | null;
  status_excerpt: Record<string, unknown> | null;
  model: string | null;
  created_at: Date;
}

export interface DiagnoseResult {
  cached: boolean;
  diagnosis: DiagnosticRow;
}

/**
 * Read a diagnosis from cache by (cache_key, kind), or null if absent.
 */
async function readCache(cacheKey: string, kind: DiagnosticKind): Promise<DiagnosticRow | null> {
  const r = await query<DiagnosticRow>(
    `SELECT id, deployment_id, cache_key, kind, summary, root_cause, suggestions,
            log_excerpt, status_excerpt, model, created_at
       FROM deployment_diagnostics
      WHERE cache_key = $1 AND kind = $2`,
    [cacheKey, kind]
  );
  return r.rows[0] ?? null;
}

/**
 * Compute the deterministic cache key for a deployment's failure / slowness.
 *
 * Failure:
 *   - If build:failed → 'build:' + build_id (cached across all deployments using
 *     the same build, useful when a retried deploy hits the same docker error).
 *   - Else (deploy/health_check/ssl failed) → 'deploy:' + deployment_id.
 *
 * Slow:
 *   - Always 'deploy:' + deployment_id (per-attempt; we don't deduplicate slow
 *     diagnoses across retries because environmental factors vary).
 */
export function computeCacheKey(args: {
  kind: DiagnosticKind;
  deploymentId: string;
  buildId: string | null;
  failureStage: string | null;
}): string {
  const { kind, deploymentId, buildId, failureStage } = args;
  if (kind === 'failure' && failureStage === 'build' && buildId) {
    return `build:${buildId}`;
  }
  return `deploy:${deploymentId}`;
}

interface LLMDiagnosis {
  summary: string;
  root_cause: string;
  suggestions: DiagnosticSuggestion[];
}

const FAILURE_PROMPT = `You are a senior site-reliability engineer diagnosing a failed deployment.

You will be given:
1. The list of stage events with status (extract / build / push / deploy / health_check / ssl).
2. The build log excerpt (last ~200 lines of stderr/stdout from Cloud Build).

Your job:
1. Identify ONE root cause in plain language. The user is a solo founder who isn't an SRE; avoid jargon.
2. Provide 2-4 concrete suggestions, ordered by likelihood of fix. Each must be actionable in <5 minutes.
3. If the failure is in build: probably a Dockerfile / dependency issue.
   If in deploy: probably env vars, IAM, or memory.
   If in health_check: probably PORT, healthcheck path, or cold-start crash.
   If in ssl: probably DNS not pointed yet — usually wait, not act.

Output STRICT JSON only, matching this schema (no prose around it):
{
  "summary": "<one-sentence headline, bilingual zh-TW/en separated by ' / '>",
  "root_cause": "<2-4 sentence explanation, bilingual>",
  "suggestions": [
    { "title": "<short bilingual>", "body": "<1-2 sentence detail, bilingual>" }
  ]
}`;

const SLOW_PROMPT = `You are a senior site-reliability engineer reviewing a slow deployment.

Stages and their durations are provided. Identify which stage was the bottleneck
and suggest concrete optimizations. Same bilingual JSON format as failure analysis.`;

/**
 * Run the LLM diagnosis. Pure function — does not touch the cache.
 */
async function runDiagnosis(args: {
  kind: DiagnosticKind;
  stageDigest: string;
  logExcerpt: string;
}): Promise<{ diagnosis: LLMDiagnosis; model: string }> {
  const system = args.kind === 'failure' ? FAILURE_PROMPT : SLOW_PROMPT;
  const user = `Stages:\n${args.stageDigest}\n\nLog excerpt (last lines):\n${args.logExcerpt || '(no log available)'}`;

  const { text, provider } = await callLLM(system, user, 1200);

  // Parse JSON (LLM sometimes wraps in markdown code fence — strip it)
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed: LLMDiagnosis;
  try {
    parsed = JSON.parse(cleaned) as LLMDiagnosis;
  } catch {
    // Fall back to a generic structure when the LLM returns non-JSON.
    parsed = {
      summary: text.slice(0, 200) || 'Diagnosis unavailable / 無法產生診斷',
      root_cause: text.slice(200, 800) || '',
      suggestions: [],
    };
  }
  // Defensive defaults
  if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
  if (typeof parsed.summary !== 'string') parsed.summary = 'Diagnosis incomplete';
  if (typeof parsed.root_cause !== 'string') parsed.root_cause = '';

  return { diagnosis: parsed, model: provider };
}

/**
 * Tail the last `lines` lines of a multi-line string. Used to keep the LLM
 * prompt small; the bottom of a build log usually carries the error.
 */
function tail(text: string, lines: number): string {
  const arr = text.split('\n');
  return arr.slice(-lines).join('\n');
}

/**
 * Diagnose a deployment. Cache-first; only calls the LLM on miss.
 *
 * On unique-key conflict (concurrent callers raced), we re-read the cache
 * and return the winner's row. This keeps LLM calls singleton-per-key.
 */
export async function diagnoseDeployment(deploymentId: string, kind: DiagnosticKind): Promise<DiagnoseResult> {
  // 1. Gather inputs from stage events
  const events = await getStageEvents(deploymentId);
  if (events.length === 0) {
    throw new Error('No stage events recorded for this deployment yet');
  }

  // Find first failed stage (for cache key) and the build_id (if any)
  const failedEvent = events.find(e => e.status === 'failed');
  const failureStage = failedEvent?.stage ?? null;
  const buildEvent = [...events].reverse().find(e =>
    e.stage === 'build' && (e.status === 'succeeded' || e.status === 'failed')
  );
  const buildId = (buildEvent?.metadata as { build_id?: string } | undefined)?.build_id ?? null;

  // For 'failure' kind, sanity-check that something actually failed.
  if (kind === 'failure' && !failedEvent) {
    throw new Error('No failed stage found; cannot diagnose a successful deployment');
  }

  const cacheKey = computeCacheKey({ kind, deploymentId, buildId, failureStage });

  // 2. Cache check
  const cached = await readCache(cacheKey, kind);
  if (cached) return { cached: true, diagnosis: cached };

  // 3. Build the LLM input
  const stageDigest = events.map(e =>
    `  ${e.created_at.toISOString()} ${e.stage}:${e.status} ${JSON.stringify(e.metadata ?? {})}`
  ).join('\n');

  let logExcerpt = '';
  if (buildId) {
    try {
      const proj = await query<{ config: unknown }>(
        `SELECT p.config FROM projects p JOIN deployments d ON d.project_id = p.id WHERE d.id = $1`,
        [deploymentId]
      );
      const cfg = typeof proj.rows[0]?.config === 'string'
        ? JSON.parse(proj.rows[0].config)
        : (proj.rows[0]?.config as Record<string, unknown> | undefined);
      const gcpProject = (cfg?.gcpProject as string | undefined) ?? process.env.GCP_PROJECT;
      if (gcpProject) {
        const log = await fetchBuildLogOnce(buildId, `${gcpProject}_cloudbuild`);
        if (log) logExcerpt = tail(log.text, 200);
      }
    } catch (err) {
      // Soft-fail: diagnose with whatever we have
      console.warn(`[diagnostics] log fetch failed: ${(err as Error).message}`);
    }
  }

  // 4. Run LLM
  const { diagnosis, model } = await runDiagnosis({ kind, stageDigest, logExcerpt });

  // 5. Insert with ON CONFLICT DO NOTHING; on race, re-read winner.
  const insert = await query<DiagnosticRow>(
    `INSERT INTO deployment_diagnostics
       (deployment_id, cache_key, kind, summary, root_cause, suggestions,
        log_excerpt, status_excerpt, model)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
     ON CONFLICT (cache_key, kind) DO NOTHING
     RETURNING id, deployment_id, cache_key, kind, summary, root_cause, suggestions,
               log_excerpt, status_excerpt, model, created_at`,
    [
      deploymentId,
      cacheKey,
      kind,
      diagnosis.summary,
      diagnosis.root_cause,
      JSON.stringify(diagnosis.suggestions ?? []),
      logExcerpt || null,
      JSON.stringify({ stages: events.map(e => ({ stage: e.stage, status: e.status })) }),
      model,
    ]
  );

  if (insert.rows.length > 0) {
    return { cached: false, diagnosis: insert.rows[0] };
  }

  // Race lost — re-read the winning row.
  const winner = await readCache(cacheKey, kind);
  if (!winner) {
    // This shouldn't happen unless the unique constraint is missing.
    throw new Error('Diagnose race lost but no cached row found');
  }
  return { cached: true, diagnosis: winner };
}
