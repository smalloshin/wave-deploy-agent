/**
 * Cloud Run Jobs migration runner (R57)
 *
 * 為什麼存在：deploy-worker Step 3.5 需要在 Cloud Run revision swap 前跑 DB
 * migration（prisma migrate deploy / alembic upgrade head / etc）。Run as
 * one-shot Cloud Run Job using the same image about to be deployed; same
 * image → same env / VPC / Cloud SQL Auth Proxy config.
 *
 * Concurrency control：row-based primitive in `wave_deploy_migrations` table
 * (CEO + eng review locked decision — advisory lock 沒 TTL，連線斷會釋放，race window 真實)：
 *   1. INSERT ... ON CONFLICT (project_id) WHERE status='running' DO NOTHING
 *      → 拿到 row 的 deploy 進入；其他 deploy 自動跑 retry-wait 模式
 *   2. 跑完 (succeed/fail/timeout) → UPDATE status, finished_at
 *   3. Worker crash → expires_at TTL 過期後 reconciler 標 'expired' 釋放
 *
 * 失敗政策：
 *   - migration 失敗 → throw with errorCode=migration_<reason>，deploy-worker
 *     的 outer catch 會處理（Cloud Run revision 沒切，舊版繼續服務）
 *   - timeout 10 min（含 cold start + image pull buffer）
 *   - non-zero exit → 撈 R53 container logs → LLM diagnosis
 *
 * 不在這份檔的東西：
 *   - migration tool detection（→ migration-detector.ts）
 *   - polling logic（→ gcp-poll.ts，DRY share with R47）
 *   - Cloud Run Jobs JSON spec building（在這檔，因為 spec 跟 runner 緊綁）
 */

import { gcpFetch } from './gcp-auth';
import { query as dbQuery } from '../db/index';
import { recordStageEvent } from './stage-events';
import { pollGcpUntilTerminal, type GcpStatusFetcher } from './gcp-poll';
import {
  detectMigrationTool,
  describeMigrationTool,
  type MigrationDetectionResult,
} from './migration-detector';

export interface MigrationRunInput {
  projectId: string;
  deploymentId: string;
  projectSlug: string;
  imageUri: string;
  gcpProject: string;
  gcpRegion: string;
  envVars: Record<string, string>;
  cloudSqlInstance?: string;
  /** 從 deploy-worker 來的 projectDir，用來偵測 tool。 */
  projectDir: string;
  /** Optional override (mostly for tests). Default 10 min. */
  totalTimeoutMs?: number;
}

export interface MigrationRunResult {
  outcome: 'succeeded' | 'skipped' | 'failed' | 'timeout' | 'lock_wait_exceeded' | 'fetcher_error';
  tool: MigrationDetectionResult['tool'];
  command: string | null;
  jobName: string | null;
  exitCode: number | null;
  durationMs: number;
  errorMessage: string | null;
  /** Migration row id if one was created. */
  migrationRowId: string | null;
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min waiting for parallel deploy
const LOCK_POLL_INTERVAL_MS = 5_000;

/**
 * Run pre-deploy migration via Cloud Run Jobs.
 * Best-effort — never throws. Caller (deploy-worker) inspects outcome.
 */
export async function runMigration(input: MigrationRunInput): Promise<MigrationRunResult> {
  const totalTimeout = input.totalTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ─── Step 1: detect tool ───
  const verdict = detectMigrationTool(input.projectDir);
  const warnings: string[] = [...verdict.warnings];

  if (verdict.tool === 'none' || verdict.tool === 'prisma_db_push_only') {
    // Skip — log warnings via stage event but don't run anything
    void recordStageEvent(input.deploymentId, 'migrate', 'skipped', {
      tool: verdict.tool,
      reason: describeMigrationTool(verdict),
      warnings,
    });
    return {
      outcome: 'skipped',
      tool: verdict.tool,
      command: null,
      jobName: null,
      exitCode: null,
      durationMs: 0,
      errorMessage: null,
      migrationRowId: null,
      warnings,
    };
  }

  // From here, verdict.tool is 'prisma' or 'alembic' and command is set
  const command = verdict.command!;
  const startMs = Date.now();
  void recordStageEvent(input.deploymentId, 'migrate', 'started', {
    tool: verdict.tool,
    command,
  });

  // ─── Step 2: claim concurrency row ───
  let migrationRowId: string;
  try {
    migrationRowId = await claimMigrationRow(input, verdict.tool, command);
  } catch (err) {
    const lockErr = err as Error & { code?: string };
    if (lockErr.code === 'lock_wait_exceeded') {
      void recordStageEvent(input.deploymentId, 'migrate', 'failed', {
        errorCode: 'migration_lock_wait_exceeded',
        message: lockErr.message,
      });
      return {
        outcome: 'lock_wait_exceeded',
        tool: verdict.tool,
        command,
        jobName: null,
        exitCode: null,
        durationMs: Date.now() - startMs,
        errorMessage: lockErr.message,
        migrationRowId: null,
        warnings,
      };
    }
    throw err; // unexpected — let deploy-worker outer catch handle
  }

  // ─── Step 3: create + run Cloud Run Job ───
  const jobName = `migrate-${input.projectSlug}-${Date.now()}`.slice(0, 63);
  let executionName: string | null = null;
  let exitCode: number | null = null;
  let outcomeError: string | null = null;

  try {
    // Create job
    await createCloudRunJob(input, jobName, command);
    // Run it (returns execution resource name)
    executionName = await runCloudRunJob(input, jobName);
    await dbQuery(
      'UPDATE wave_deploy_migrations SET job_name = $1 WHERE id = $2',
      [jobName, migrationRowId],
    );

    // Poll for completion
    const statusFetcher: GcpStatusFetcher<CloudRunExecutionStatus> = async () => {
      try {
        const url = `https://run.googleapis.com/v2/${executionName}`;
        const res = await gcpFetch(url);
        if (!res.ok) {
          return { kind: 'error' as const, reason: `HTTP ${res.status}` };
        }
        const data = await res.json() as CloudRunExecutionStatus;
        return { kind: 'ok' as const, status: data };
      } catch (err) {
        return { kind: 'error' as const, reason: (err as Error).message };
      }
    };

    const pollResult = await pollGcpUntilTerminal(
      statusFetcher,
      isTerminalExecution,
      { totalTimeoutMs: totalTimeout, initialDelayMs: 5_000 },
    );

    if (pollResult.outcome === 'succeeded') {
      const finalStatus = pollResult.status;
      exitCode = 0;
      await releaseMigrationRow(migrationRowId, 'succeeded', exitCode, pollResult.durationMs, null);
      void recordStageEvent(input.deploymentId, 'migrate', 'succeeded', {
        tool: verdict.tool,
        command,
        jobName,
        durationMs: pollResult.durationMs,
        attempts: pollResult.attempts,
      });
      return {
        outcome: 'succeeded',
        tool: verdict.tool,
        command,
        jobName,
        exitCode,
        durationMs: pollResult.durationMs,
        errorMessage: null,
        migrationRowId,
        warnings,
      };
    }

    if (pollResult.outcome === 'failed') {
      exitCode = pollResult.status ? extractExitCode(pollResult.status) : null;
      outcomeError = `migration_non_zero_exit: ${pollResult.reason}`;
      await releaseMigrationRow(migrationRowId, 'failed', exitCode, pollResult.durationMs, outcomeError);
      void recordStageEvent(input.deploymentId, 'migrate', 'failed', {
        errorCode: 'migration_non_zero_exit',
        tool: verdict.tool,
        command,
        jobName,
        exitCode,
        durationMs: pollResult.durationMs,
        reason: pollResult.reason,
      });
      return {
        outcome: 'failed',
        tool: verdict.tool,
        command,
        jobName,
        exitCode,
        durationMs: pollResult.durationMs,
        errorMessage: outcomeError,
        migrationRowId,
        warnings,
      };
    }

    if (pollResult.outcome === 'timeout') {
      outcomeError = `migration_timeout: exceeded ${totalTimeout}ms`;
      await releaseMigrationRow(migrationRowId, 'failed', null, pollResult.durationMs, outcomeError);
      void recordStageEvent(input.deploymentId, 'migrate', 'failed', {
        errorCode: 'migration_timeout',
        tool: verdict.tool,
        command,
        jobName,
        durationMs: pollResult.durationMs,
      });
      return {
        outcome: 'timeout',
        tool: verdict.tool,
        command,
        jobName,
        exitCode: null,
        durationMs: pollResult.durationMs,
        errorMessage: outcomeError,
        migrationRowId,
        warnings,
      };
    }

    // fetcher_error or cancelled — same handling: fail safely
    const fallbackReason =
      pollResult.outcome === 'fetcher_error'
        ? pollResult.lastError
        : pollResult.outcome === 'cancelled'
        ? pollResult.reason
        : 'unknown';
    outcomeError = `migration_poll_fetcher_error: ${fallbackReason}`;
    await releaseMigrationRow(migrationRowId, 'failed', null, pollResult.durationMs, outcomeError);
    void recordStageEvent(input.deploymentId, 'migrate', 'failed', {
      errorCode: 'migration_poll_fetcher_error',
      jobName,
      message: fallbackReason,
    });
    return {
      outcome: 'fetcher_error',
      tool: verdict.tool,
      command,
      jobName,
      exitCode: null,
      durationMs: pollResult.durationMs,
      errorMessage: outcomeError,
      migrationRowId,
      warnings,
    };
  } catch (err) {
    const e = err as Error & { errorCode?: string };
    const errorCode = e.errorCode ?? 'migration_jobs_create_failed';
    outcomeError = `${errorCode}: ${e.message}`;
    const durationMs = Date.now() - startMs;
    await releaseMigrationRow(migrationRowId, 'failed', null, durationMs, outcomeError).catch(() => {});
    void recordStageEvent(input.deploymentId, 'migrate', 'failed', {
      errorCode,
      tool: verdict.tool,
      command,
      jobName,
      message: e.message,
    });
    return {
      outcome: 'failed',
      tool: verdict.tool,
      command,
      jobName,
      exitCode: null,
      durationMs,
      errorMessage: outcomeError,
      migrationRowId,
      warnings,
    };
  }
}

// ─────────────────────────── concurrency helpers ───────────────────────────

/**
 * Try to claim a 'running' row. If another deploy already holds it, wait
 * and retry until it releases or LOCK_WAIT_TIMEOUT_MS expires.
 */
async function claimMigrationRow(
  input: MigrationRunInput,
  tool: string,
  command: string,
): Promise<string> {
  const startMs = Date.now();
  while (Date.now() - startMs < LOCK_WAIT_TIMEOUT_MS) {
    // First sweep stale 'running' rows past their TTL — best-effort
    await dbQuery(
      `UPDATE wave_deploy_migrations
         SET status = 'expired',
             finished_at = NOW(),
             error_message = 'expires_at TTL passed before completion'
       WHERE status = 'running' AND expires_at < NOW()`,
    ).catch(() => {});

    // Try to insert. ON CONFLICT does nothing thanks to unique partial index.
    const result = await dbQuery(
      `INSERT INTO wave_deploy_migrations
         (project_id, deployment_id, tool, command, status)
       VALUES ($1, $2, $3, $4, 'running')
       ON CONFLICT (project_id) WHERE status = 'running'
       DO NOTHING
       RETURNING id`,
      [input.projectId, input.deploymentId, tool, command],
    );

    if (result.rows.length > 0) {
      return result.rows[0].id as string;
    }

    // Lock held by another deploy; wait and retry
    await sleep(LOCK_POLL_INTERVAL_MS);
  }

  const err = new Error(
    `Could not acquire migration lock for project ${input.projectId} within ${LOCK_WAIT_TIMEOUT_MS}ms — another deploy is still running its migration`,
  ) as Error & { code: string };
  err.code = 'lock_wait_exceeded';
  throw err;
}

async function releaseMigrationRow(
  migrationRowId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  exitCode: number | null,
  durationMs: number,
  errorMessage: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE wave_deploy_migrations
       SET status = $1,
           exit_code = $2,
           duration_ms = $3,
           error_message = $4,
           finished_at = NOW()
     WHERE id = $5`,
    [status, exitCode, durationMs, errorMessage, migrationRowId],
  );
}

// ─────────────────────────── Cloud Run Jobs API ───────────────────────────

interface CloudRunExecutionStatus {
  name?: string;
  completionTime?: string;
  succeededCount?: number;
  failedCount?: number;
  cancelledCount?: number;
  conditions?: Array<{
    type: string;
    state: string;
    message?: string;
    severity?: string;
  }>;
}

function isTerminalExecution(s: CloudRunExecutionStatus) {
  // Cloud Run Jobs execution `Completed` condition with state CONDITION_SUCCEEDED / FAILED
  // is the canonical terminal signal.
  if (!s.conditions || s.conditions.length === 0) {
    return { terminal: false as const };
  }
  const completed = s.conditions.find((c) => c.type === 'Completed');
  if (!completed) {
    return { terminal: false as const };
  }
  if (completed.state === 'CONDITION_SUCCEEDED') {
    return { terminal: true as const, outcome: 'succeeded' as const };
  }
  if (completed.state === 'CONDITION_FAILED') {
    return {
      terminal: true as const,
      outcome: 'failed' as const,
      reason: completed.message ?? 'execution failed',
    };
  }
  // CONDITION_PENDING / CONDITION_RECONCILING — keep polling
  return { terminal: false as const };
}

function extractExitCode(s: CloudRunExecutionStatus): number | null {
  if (s.failedCount && s.failedCount > 0) return 1; // approximate — Cloud Run doesn't expose exact exit code in execution status
  return null;
}

/**
 * Create a one-shot Cloud Run Job spec.
 * Idempotent: if job already exists with same name we update it.
 *
 * Throws with errorCode set on the Error for caller to map.
 */
async function createCloudRunJob(
  input: MigrationRunInput,
  jobName: string,
  command: string,
): Promise<void> {
  const parent = `projects/${input.gcpProject}/locations/${input.gcpRegion}`;
  const reservedKeys = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);
  const envVars = Object.entries(input.envVars)
    .filter(([k]) => !reservedKeys.has(k))
    .map(([name, value]) => ({ name, value }));

  // Cloud SQL Auth Proxy via volume mount (same as deploy-engine.ts pattern).
  const volumes: Array<{ name: string; cloudSqlInstance?: { instances: string[] } }> = [];
  const volumeMounts: Array<{ name: string; mountPath: string }> = [];
  if (input.cloudSqlInstance) {
    volumes.push({
      name: 'cloudsql',
      cloudSqlInstance: { instances: [input.cloudSqlInstance] },
    });
    volumeMounts.push({ name: 'cloudsql', mountPath: '/cloudsql' });
  }

  // The migration command runs via `sh -c` so multi-word commands like
  // "npx prisma migrate deploy" tokenize correctly.
  const jobSpec = {
    template: {
      template: {
        containers: [
          {
            image: input.imageUri,
            command: ['sh', '-c'],
            args: [command],
            env: envVars,
            volumeMounts,
            resources: {
              limits: { cpu: '2', memory: '2Gi' }, // reviewer C6: spec'd defaults
            },
          },
        ],
        volumes,
        timeout: '600s', // Cloud Run Job execution timeout
        maxRetries: 0, // we control retry at row level
      },
      taskCount: 1,
      parallelism: 1,
    },
  };

  // Try create first
  const createUrl = `https://run.googleapis.com/v2/${parent}/jobs?jobId=${encodeURIComponent(jobName)}`;
  const createRes = await gcpFetch(createUrl, {
    method: 'POST',
    body: JSON.stringify(jobSpec),
  });

  if (createRes.ok) return;

  // 409 = already exists → update
  if (createRes.status === 409) {
    const updateUrl = `https://run.googleapis.com/v2/${parent}/jobs/${encodeURIComponent(jobName)}`;
    const updateRes = await gcpFetch(updateUrl, {
      method: 'PATCH',
      body: JSON.stringify(jobSpec),
    });
    if (!updateRes.ok) {
      const body = await updateRes.text().catch(() => '');
      const err = new Error(
        `Cloud Run Jobs PATCH failed (HTTP ${updateRes.status}): ${body.slice(0, 500)}`,
      ) as Error & { errorCode: string };
      err.errorCode = 'migration_jobs_create_failed';
      throw err;
    }
    return;
  }

  // Other errors
  const body = await createRes.text().catch(() => '');
  const err = new Error(
    `Cloud Run Jobs CREATE failed (HTTP ${createRes.status}): ${body.slice(0, 500)}`,
  ) as Error & { errorCode: string };
  err.errorCode = 'migration_jobs_create_failed';
  throw err;
}

/**
 * Trigger an execution of an existing Job. Returns the execution resource name
 * for polling.
 */
async function runCloudRunJob(input: MigrationRunInput, jobName: string): Promise<string> {
  const parent = `projects/${input.gcpProject}/locations/${input.gcpRegion}`;
  const runUrl = `https://run.googleapis.com/v2/${parent}/jobs/${encodeURIComponent(jobName)}:run`;
  const runRes = await gcpFetch(runUrl, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!runRes.ok) {
    const body = await runRes.text().catch(() => '');
    const err = new Error(
      `Cloud Run Jobs :run failed (HTTP ${runRes.status}): ${body.slice(0, 500)}`,
    ) as Error & { errorCode: string };
    err.errorCode = 'migration_jobs_run_failed';
    throw err;
  }
  // Long-running operation: response includes operation name + metadata.execution
  const data = await runRes.json() as {
    name?: string;
    metadata?: { execution?: { name?: string } };
  };
  const executionName = data.metadata?.execution?.name;
  if (!executionName) {
    const err = new Error(
      'Cloud Run Jobs :run returned 200 but no execution name in metadata',
    ) as Error & { errorCode: string };
    err.errorCode = 'migration_jobs_run_failed';
    throw err;
  }
  return executionName;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
