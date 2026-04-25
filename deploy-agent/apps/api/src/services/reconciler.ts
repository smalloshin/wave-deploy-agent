// Pipeline Reconciler — recovers projects whose in-process pipeline was lost
// (e.g. API container restart during SSL monitoring / canary wait).
//
// Why this exists:
//   The deploy pipeline runs as an in-process async task (no durable queue).
//   If the API container restarts mid-pipeline, the project gets stuck in
//   an intermediate state (deploying / deployed / ssl_provisioning / canary_check)
//   with `health_status` frozen at 'unknown'.
//
// What this does:
//   - On startup, scans the DB for projects stuck in intermediate states.
//   - Runs again every RECONCILE_INTERVAL_MS (default 2 min).
//   - For each stuck project, verifies the Cloud Run service is actually up,
//     then fast-forwards the state machine: deploying → deployed → ssl_provisioning
//     → canary_check → live (running the real canary check in the process).
//   - If the Cloud Run service doesn't exist, transitions to `failed`.
//
// Safety:
//   - Only touches projects whose `updated_at > STALE_THRESHOLD_MS` ago
//     (avoids racing with an actively running pipeline).
//   - Re-checks the project status after each step (defensive).

import {
  listProjects,
  transitionProject,
  updateDeployment,
  getDeploymentsByProject,
  publishDeployment,
} from './orchestrator';
import { runCanaryChecks } from './canary-monitor';
import { gcpFetch } from './gcp-auth';
import { getServiceLiveTraffic } from './deploy-engine';
import type { Deployment, Project, ProjectStatus } from '@deploy-agent/shared';

const STUCK_STATES: ProjectStatus[] = [
  'deploying',
  'deployed',
  'ssl_provisioning',
  'canary_check',
];

// How long a project must sit in an intermediate state before we consider it stuck.
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// How often the periodic reconciler runs.
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let reconcilerTimer: NodeJS.Timeout | null = null;
let isReconciling = false;

export function startReconciler(): void {
  if (reconcilerTimer) return;

  // Initial run shortly after startup (give DB a moment to be ready).
  setTimeout(() => {
    void reconcileStuckProjects().catch((err) => {
      console.error('[Reconciler] initial run failed:', (err as Error).message);
    });
  }, 10_000);

  // Then periodic reconcile.
  reconcilerTimer = setInterval(() => {
    if (isReconciling) return; // skip if previous run still in-flight
    void reconcileStuckProjects().catch((err) => {
      console.error('[Reconciler] periodic run failed:', (err as Error).message);
    });
  }, RECONCILE_INTERVAL_MS);

  console.log(
    `[Reconciler] started (interval=${RECONCILE_INTERVAL_MS / 1000}s, stale=${
      STALE_THRESHOLD_MS / 1000
    }s)`
  );
}

export function stopReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
}

export async function reconcileStuckProjects(): Promise<{
  scanned: number;
  recovered: number;
  failed: number;
  skipped: number;
  splitsDetected: number;
  splitsReconciled: number;
}> {
  if (isReconciling) {
    return { scanned: 0, recovered: 0, failed: 0, skipped: 0, splitsDetected: 0, splitsReconciled: 0 };
  }
  isReconciling = true;

  const stats = { scanned: 0, recovered: 0, failed: 0, skipped: 0, splitsDetected: 0, splitsReconciled: 0 };

  try {
    const projects = await listProjects();
    const now = Date.now();

    const stuck = projects.filter((p) => {
      if (!STUCK_STATES.includes(p.status)) return false;
      const age = now - new Date(p.updatedAt).getTime();
      return age >= STALE_THRESHOLD_MS;
    });

    if (stuck.length > 0) {
      console.log(`[Reconciler] found ${stuck.length} stuck project(s): ${stuck.map((p) => `${p.name}(${p.status})`).join(', ')}`);

      for (const project of stuck) {
        stats.scanned++;
        try {
          const outcome = await reconcileOne(project.id);
          if (outcome === 'recovered') stats.recovered++;
          else if (outcome === 'failed') stats.failed++;
          else stats.skipped++;
        } catch (err) {
          console.error(
            `[Reconciler] error reconciling ${project.name}:`,
            (err as Error).message
          );
        }
      }
    }

    // Round 10: scan ALL live projects for Cloud-Run/DB publish split state.
    // Round 9 introduced the possibility (publishRevision succeeds, then
    // publishDeployment fails); the reconciler is the only place that can
    // catch it after the fact. This runs every cycle, independent of the
    // stuck-state walk above.
    const liveCandidates = projects.filter((p) => p.status === 'live');
    for (const project of liveCandidates) {
      try {
        const split = await detectAndReconcilePublishSplit(project);
        if (split === 'split-reconciled') {
          stats.splitsDetected++;
          stats.splitsReconciled++;
        } else if (split === 'split-detected') {
          stats.splitsDetected++;
        }
      } catch (err) {
        console.error(
          `[Reconciler] split check error for ${project.name}:`,
          (err as Error).message
        );
      }
    }

    if (stuck.length > 0 || stats.splitsDetected > 0) {
      console.log(
        `[Reconciler] done — scanned=${stats.scanned} recovered=${stats.recovered} failed=${stats.failed} skipped=${stats.skipped} splitsDetected=${stats.splitsDetected} splitsReconciled=${stats.splitsReconciled}`
      );
    }
  } finally {
    isReconciling = false;
  }

  return stats;
}

type Outcome = 'recovered' | 'failed' | 'skipped';

async function reconcileOne(projectId: string): Promise<Outcome> {
  // Fetch fresh state — might have changed between listProjects() and now.
  const { getProject } = await import('./orchestrator');
  const project = await getProject(projectId);
  if (!project) return 'skipped';
  if (!STUCK_STATES.includes(project.status)) return 'skipped';

  const gcpProject =
    (project.config?.gcpProject as string | undefined) ||
    process.env.GCP_PROJECT ||
    '';
  const gcpRegion =
    (project.config?.gcpRegion as string | undefined) ||
    process.env.GCP_REGION ||
    'asia-east1';

  if (!gcpProject) {
    console.warn(`[Reconciler]   ${project.name}: no GCP project configured, skipping`);
    return 'skipped';
  }

  const deployments = await getDeploymentsByProject(projectId);
  const latestDeploy = deployments[0];

  if (!latestDeploy) {
    console.warn(`[Reconciler]   ${project.name}: no deployment record, marking failed`);
    await safeTransition(projectId, 'failed', {
      reason: 'reconciler: no deployment record for stuck project',
    });
    return 'failed';
  }

  // If no cloudRunUrl yet, the deploy never actually ran — mark failed.
  if (!latestDeploy.cloudRunUrl) {
    console.warn(`[Reconciler]   ${project.name}: deployment has no cloudRunUrl, marking failed`);
    await safeTransition(projectId, 'failed', {
      reason: 'reconciler: deployment record exists but no cloudRunUrl',
    });
    return 'failed';
  }

  // Verify the Cloud Run service actually exists and is ready.
  const serviceName = latestDeploy.cloudRunService;
  if (!serviceName) {
    console.warn(`[Reconciler]   ${project.name}: no cloudRunService in deployment, marking failed`);
    await safeTransition(projectId, 'failed', {
      reason: 'reconciler: no cloudRunService name',
    });
    return 'failed';
  }

  const serviceReady = await isCloudRunServiceReady(gcpProject, gcpRegion, serviceName);
  if (!serviceReady) {
    console.warn(`[Reconciler]   ${project.name}: Cloud Run service ${serviceName} not ready, marking failed`);
    await safeTransition(projectId, 'failed', {
      reason: `reconciler: Cloud Run service ${serviceName} not ready`,
    });
    return 'failed';
  }

  console.log(`[Reconciler]   ${project.name}: service is ready, fast-forwarding from ${project.status}`);

  // Walk the state machine forward.
  // deploying → deployed
  let currentStatus = project.status;
  if (currentStatus === 'deploying') {
    const ok = await safeTransition(projectId, 'deployed', { reason: 'reconciler: service confirmed ready' });
    if (!ok) return 'skipped';
    currentStatus = 'deployed';
  }

  // deployed → ssl_provisioning
  if (currentStatus === 'deployed') {
    const ok = await safeTransition(projectId, 'ssl_provisioning', { reason: 'reconciler: resume' });
    if (!ok) return 'skipped';
    currentStatus = 'ssl_provisioning';
  }

  // ssl_provisioning → canary_check
  if (currentStatus === 'ssl_provisioning') {
    const ok = await safeTransition(projectId, 'canary_check', { reason: 'reconciler: resume' });
    if (!ok) return 'skipped';
    currentStatus = 'canary_check';
  }

  // Run canary check on the Cloud Run URL (always accessible with identity token).
  console.log(`[Reconciler]   ${project.name}: running canary check on ${latestDeploy.cloudRunUrl}`);
  const canaryResult = await runCanaryChecks(latestDeploy.cloudRunUrl, {
    checks: 3,
    intervalMs: 3000,
  });

  await updateDeployment(latestDeploy.id, {
    canaryResults: canaryResult,
    healthStatus: canaryResult.passed ? 'healthy' : 'unhealthy',
  });

  // canary_check → live (always; canary is advisory, same as deploy-worker logic)
  const liveUrl = latestDeploy.customDomain
    ? `https://${latestDeploy.customDomain}`
    : latestDeploy.cloudRunUrl;

  const ok = await safeTransition(projectId, 'live', {
    reason: 'reconciler: resume complete',
    serviceUrl: liveUrl,
    cloudRunUrl: latestDeploy.cloudRunUrl,
    canaryPassed: canaryResult.passed,
  });
  if (!ok) return 'skipped';

  console.log(`[Reconciler]   ${project.name}: ✓ LIVE at ${liveUrl} (canary=${canaryResult.passed ? 'passed' : 'failed'})`);
  return 'recovered';
}

async function isCloudRunServiceReady(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string
): Promise<boolean> {
  try {
    const url = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;
    const res = await gcpFetch(url);
    if (!res.ok) return false;
    const svc = (await res.json()) as {
      terminalCondition?: { state?: string; type?: string };
      uri?: string;
    };
    // Cloud Run v2 API: terminalCondition.state === 'CONDITION_SUCCEEDED' means Ready
    return svc.terminalCondition?.state === 'CONDITION_SUCCEEDED';
  } catch (err) {
    console.warn(`[Reconciler]   isCloudRunServiceReady error: ${(err as Error).message}`);
    return false;
  }
}

async function safeTransition(
  projectId: string,
  to: ProjectStatus,
  metadata: Record<string, unknown>
): Promise<boolean> {
  try {
    await transitionProject(projectId, to, 'reconciler', metadata);
    return true;
  } catch (err) {
    console.warn(
      `[Reconciler]   transition to ${to} failed: ${(err as Error).message}`
    );
    return false;
  }
}

export type SplitOutcome =
  | 'no-split'        // Cloud Run live revision matches DB published deployment
  | 'split-detected'  // mismatch detected, but auto-fix not safe (e.g. Cloud Run revision unknown to DB)
  | 'split-reconciled'// mismatch detected, DB updated to match Cloud Run truth
  | 'skipped';        // not enough info (no revision, no GCP config, etc.)

/**
 * Discriminated outcome of the PURE split analysis. Caller (the IO
 * orchestrator) maps these into log writes + publishDeployment calls.
 *
 * We separate analysis from IO so the decision logic — which is where bugs
 * actually live — is testable without mocking pg + the GCP REST client. The
 * orchestrator below just: read state, call analyze, dispatch on the verdict.
 */
export type SplitVerdict =
  | { kind: 'skipped'; reason: string }
  | { kind: 'no-split'; revision: string }
  | {
      kind: 'split-unknown-revision';
      dbPublishedDeploymentId: string;
      dbPublishedRevision: string;
      cloudRunRevision: string;
      cloudRunService: string;
    }
  | {
      kind: 'split-known-revision';
      dbPublishedDeploymentId: string;
      dbPublishedRevision: string;
      dbPublishedVersion: number;
      cloudRunDeploymentId: string;
      cloudRunRevision: string;
      cloudRunVersion: number;
      cloudRunService: string;
    };

/**
 * Pure split-analysis function. Inputs: project metadata, all deployments
 * for that project, the revision currently serving 100% on Cloud Run (or
 * null if traffic is split / Cloud Run was unreachable).
 *
 * No DB calls, no network. Easy to unit-test.
 */
export function analyzePublishSplit(
  project: Pick<Project, 'id' | 'name' | 'config'>,
  deployments: Deployment[],
  liveRevision: string | null,
): SplitVerdict {
  const gcpProject =
    (project.config?.gcpProject as string | undefined) ||
    process.env.GCP_PROJECT ||
    '';
  if (!gcpProject) return { kind: 'skipped', reason: 'no GCP project configured' };

  if (deployments.length === 0) {
    return { kind: 'skipped', reason: 'no deployments' };
  }

  const dbPublished = deployments.find((d) => d.isPublished);
  if (!dbPublished) {
    return { kind: 'skipped', reason: 'no published deployment in DB' };
  }
  if (!dbPublished.cloudRunService) {
    return { kind: 'skipped', reason: 'published deployment has no cloudRunService' };
  }
  if (!dbPublished.revisionName) {
    return { kind: 'skipped', reason: 'published deployment has no revisionName' };
  }

  if (liveRevision === null) {
    // Cloud Run unreachable, or traffic is split mid-rollout. Wait it out.
    return { kind: 'skipped', reason: 'Cloud Run live revision unknown (unreachable or traffic split)' };
  }

  if (liveRevision === dbPublished.revisionName) {
    return { kind: 'no-split', revision: liveRevision };
  }

  // SPLIT. Is the Cloud-Run-serving revision known to DB?
  const cloudRunDeployment = deployments.find((d) => d.revisionName === liveRevision);

  if (!cloudRunDeployment) {
    return {
      kind: 'split-unknown-revision',
      dbPublishedDeploymentId: dbPublished.id,
      dbPublishedRevision: dbPublished.revisionName,
      cloudRunRevision: liveRevision,
      cloudRunService: dbPublished.cloudRunService,
    };
  }

  return {
    kind: 'split-known-revision',
    dbPublishedDeploymentId: dbPublished.id,
    dbPublishedRevision: dbPublished.revisionName,
    dbPublishedVersion: dbPublished.version,
    cloudRunDeploymentId: cloudRunDeployment.id,
    cloudRunRevision: liveRevision,
    cloudRunVersion: cloudRunDeployment.version,
    cloudRunService: dbPublished.cloudRunService,
  };
}

/**
 * Detect Cloud-Run/DB publish split for a single live project, and auto-fix
 * the DB to match Cloud Run truth when safe.
 *
 * Why Cloud Run is the source of truth here:
 *   The split state arises when GCP traffic switched but the DB write failed
 *   (round 9). What users actually hit is whatever Cloud Run is serving — the
 *   DB just needs to catch up. We only auto-fix when Cloud Run's live revision
 *   maps to a known deployment in our DB; if Cloud Run is serving a revision
 *   we don't know about (someone deployed via gcloud manually, etc.), we log
 *   loudly and bail, because writing the wrong published_deployment_id would
 *   make things worse.
 *
 * The decision logic lives in `analyzePublishSplit` (pure). This function is
 * just the IO + side-effect adapter.
 */
export async function detectAndReconcilePublishSplit(
  project: Project
): Promise<SplitOutcome> {
  const gcpProject =
    (project.config?.gcpProject as string | undefined) ||
    process.env.GCP_PROJECT ||
    '';
  const gcpRegion =
    (project.config?.gcpRegion as string | undefined) ||
    process.env.GCP_REGION ||
    'asia-east1';
  if (!gcpProject) return 'skipped';

  const deployments = await getDeploymentsByProject(project.id);

  // Look up Cloud Run live revision (only if we have a service name to look up).
  const dbPublished = deployments.find((d) => d.isPublished);
  let liveRevision: string | null = null;
  if (dbPublished?.cloudRunService) {
    const traffic = await getServiceLiveTraffic(
      gcpProject,
      gcpRegion,
      dbPublished.cloudRunService,
    );
    liveRevision = traffic?.liveRevision ?? null;
  }

  const verdict = analyzePublishSplit(project, deployments, liveRevision);

  switch (verdict.kind) {
    case 'skipped':
    case 'no-split':
      return verdict.kind === 'no-split' ? 'no-split' : 'skipped';

    case 'split-unknown-revision':
      console.error(
        `[Reconciler] [CRITICAL] publish_split_unknown_revision project=${project.name} ` +
          `service=${verdict.cloudRunService} ` +
          `cloudRunRevision=${verdict.cloudRunRevision} ` +
          `dbPublishedRevision=${verdict.dbPublishedRevision} ` +
          `dbPublishedDeploymentId=${verdict.dbPublishedDeploymentId} ` +
          `— Cloud Run revision is not present in our deployments table; manual reconcile required`,
      );
      return 'split-detected';

    case 'split-known-revision':
      console.error(
        `[Reconciler] [CRITICAL] publish_split_detected project=${project.name} ` +
          `service=${verdict.cloudRunService} ` +
          `cloudRunRevision=${verdict.cloudRunRevision} (deployment=${verdict.cloudRunDeploymentId}, v${verdict.cloudRunVersion}) ` +
          `dbPublishedRevision=${verdict.dbPublishedRevision} (deployment=${verdict.dbPublishedDeploymentId}, v${verdict.dbPublishedVersion}) ` +
          `— auto-reconciling DB to match Cloud Run`,
      );
      try {
        await publishDeployment(project.id, verdict.cloudRunDeploymentId);
        console.log(
          `[Reconciler]   ${project.name}: split reconciled (DB now points at deployment ${verdict.cloudRunDeploymentId} / v${verdict.cloudRunVersion})`,
        );
        return 'split-reconciled';
      } catch (err) {
        console.error(
          `[Reconciler] [CRITICAL] publish_split_reconcile_failed project=${project.name} ` +
            `targetDeploymentId=${verdict.cloudRunDeploymentId} error=${(err as Error).message} ` +
            `— DB still inconsistent with Cloud Run, will retry next cycle`,
        );
        return 'split-detected';
      }
  }
}
