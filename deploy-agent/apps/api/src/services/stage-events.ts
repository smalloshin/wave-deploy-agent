/**
 * Stage-event recorder for the deployment observability timeline.
 *
 * Every deploy emits stage transitions: extract → build → push → deploy →
 * health_check → ssl. Each transition is one row. The Timeline endpoint reads
 * these rows to render a 7-stage stepper UI.
 *
 * Failure-tolerance: writes are best-effort. A DB error here MUST NOT crash
 * the deploy pipeline. If the row write fails, we log and move on — the
 * deployment itself is the source of truth, the timeline is observability
 * scaffolding.
 */

import { query } from '../db/index';

export type StageName =
  | 'upload'
  | 'extract'
  | 'build'
  | 'push'
  | 'deploy'
  | 'health_check'
  | 'ssl';

export type StageStatus = 'started' | 'succeeded' | 'failed' | 'skipped';

export interface StageEventRow {
  id: number;
  deployment_id: string;
  stage: StageName;
  status: StageStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Record a stage transition. Best-effort — never throws.
 *
 * @param deploymentId UUID of the deployment row
 * @param stage one of 7 fixed stage names
 * @param status started | succeeded | failed | skipped
 * @param metadata optional JSON payload (build_id, error message, duration_ms, ...)
 */
export async function recordStageEvent(
  deploymentId: string,
  stage: StageName,
  status: StageStatus,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (!deploymentId) {
    // Pre-deployment record creation can call us with an empty id; treat as no-op
    // (e.g. extract:started before createDeployment in some refactor scenarios)
    return;
  }
  try {
    await query(
      `INSERT INTO deployment_stage_events (deployment_id, stage, status, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [deploymentId, stage, status, JSON.stringify(metadata ?? {})]
    );
  } catch (err) {
    // Swallow — observability must never crash the deploy.
    console.warn(
      `[stage-events] failed to record ${stage}:${status} for deployment=${deploymentId}: ${(err as Error).message}`
    );
  }
}

/**
 * Read all stage events for a deployment, in chronological order.
 */
export async function getStageEvents(deploymentId: string): Promise<StageEventRow[]> {
  const r = await query<StageEventRow>(
    `SELECT id, deployment_id, stage, status, metadata, created_at
       FROM deployment_stage_events
      WHERE deployment_id = $1
      ORDER BY created_at ASC, id ASC`,
    [deploymentId]
  );
  return r.rows;
}

/**
 * Aggregate raw events into one row per stage with the most-recent status.
 *
 * Priority order (when two events land same stage): failed > started >
 * succeeded > skipped. (A retry that succeeded after a failure should still
 * surface the failure to the user; they can re-deploy if they want a clean
 * timeline.)
 *
 * Returns array in the canonical 7-stage order, missing stages omitted.
 */
const STAGE_ORDER: StageName[] = [
  'upload', 'extract', 'build', 'push', 'deploy', 'health_check', 'ssl',
];
const STATUS_PRIORITY: Record<StageStatus, number> = {
  failed: 4,
  started: 3,
  succeeded: 2,
  skipped: 1,
};

export interface StageSummary {
  stage: StageName;
  status: StageStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
}

export function summarizeStages(events: StageEventRow[]): StageSummary[] {
  const byStage = new Map<StageName, StageEventRow[]>();
  for (const e of events) {
    const stage = e.stage as StageName;
    if (!STAGE_ORDER.includes(stage)) continue;
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage)!.push(e);
  }

  const result: StageSummary[] = [];
  for (const stage of STAGE_ORDER) {
    const list = byStage.get(stage);
    if (!list || list.length === 0) continue;
    // Pick the highest-priority status, but track started/finished from raw timestamps
    let chosen = list[0];
    for (const e of list) {
      if (STATUS_PRIORITY[e.status as StageStatus] > STATUS_PRIORITY[chosen.status as StageStatus]) {
        chosen = e;
      }
    }
    const started = list.find(e => e.status === 'started');
    const ended = [...list].reverse().find(e => e.status === 'succeeded' || e.status === 'failed' || e.status === 'skipped');
    const startedAt = started ? new Date(started.created_at).toISOString() : null;
    const finishedAt = ended ? new Date(ended.created_at).toISOString() : null;
    const durationMs = startedAt && finishedAt
      ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
      : null;
    result.push({
      stage,
      status: chosen.status as StageStatus,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      metadata: chosen.metadata ?? {},
    });
  }
  return result;
}
