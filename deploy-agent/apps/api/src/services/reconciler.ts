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
} from './orchestrator';
import { runCanaryChecks } from './canary-monitor';
import { gcpFetch } from './gcp-auth';
import type { ProjectStatus } from '@deploy-agent/shared';

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
}> {
  if (isReconciling) {
    return { scanned: 0, recovered: 0, failed: 0, skipped: 0 };
  }
  isReconciling = true;

  const stats = { scanned: 0, recovered: 0, failed: 0, skipped: 0 };

  try {
    const projects = await listProjects();
    const now = Date.now();

    const stuck = projects.filter((p) => {
      if (!STUCK_STATES.includes(p.status)) return false;
      const age = now - new Date(p.updatedAt).getTime();
      return age >= STALE_THRESHOLD_MS;
    });

    if (stuck.length === 0) {
      return stats;
    }

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

    console.log(
      `[Reconciler] done — scanned=${stats.scanned} recovered=${stats.recovered} failed=${stats.failed} skipped=${stats.skipped}`
    );
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
