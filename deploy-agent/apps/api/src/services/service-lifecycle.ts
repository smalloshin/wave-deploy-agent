// Service lifecycle — stop / start individual Cloud Run services without a full rebuild.
//
// GCP convention: there is no explicit "pause" for Cloud Run. To truly release
// resources (and stop any minimum-instance billing), we delete the service.
// "Start" redeploys from the cached Artifact Registry image so we skip the build.

import {
  getProject,
  getDeploymentsByProject,
  updateDeployment,
  transitionProject,
  updateProjectConfig,
} from './orchestrator';
import { deleteService, deployToCloudRun, getServiceImage, getServiceEnvVars } from './deploy-engine';
import {
  buildStopVerdict,
  verdictToLifecycleResult,
  type DeleteOutcome,
  type DbWriteOutcome,
  type TransitionOutcome,
} from './stop-verdict';

export interface LifecycleResult {
  success: boolean;
  message: string;
  serviceName?: string;
  serviceUrl?: string;
}

/**
 * Round 13: rewritten to be honest about partial failures.
 *
 * Pre-round-13:
 *   await deleteService(...);                    // returned void; errors swallowed
 *   await updateDeployment(...);                 // ran even if GCP delete failed
 *   try { await transitionProject(...); } catch {} // swallowed every error class
 *
 *   Result: when GCP DELETE returned 5xx, function continued to write
 *   `cloudRunUrl=''` to DB while service was actually still alive (or in
 *   unknown state). When DB write threw, service was gone but DB row
 *   still claimed live — round-10 reconciler couldn't auto-fix because
 *   there was nothing alive to inspect.
 *
 * Post-round-13:
 *   - deleteService returns DeleteServiceResult; we honor delete.ok
 *   - if GCP DELETE failed (and not 404), short-circuit; do NOT touch DB
 *   - both DB writes wrapped in narrow try/catch that captures result
 *   - buildStopVerdict (pure) classifies the (delete, db, transition)
 *     outcomes into one of six verdict kinds with the right log level
 *   - critical verdicts log [CRITICAL] for grep-ability; partial states
 *     are surfaced to operator via the LifecycleResult message
 */
export async function stopProjectService(projectId: string, triggeredBy = 'user'): Promise<LifecycleResult> {
  const project = await getProject(projectId);
  if (!project) return { success: false, message: 'Project not found' };

  const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
  const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';
  if (!gcpProject) return { success: false, message: 'GCP_PROJECT not configured' };

  const deployments = await getDeploymentsByProject(projectId);
  const active = deployments.find((d) => d.cloudRunService);
  if (!active?.cloudRunService) {
    return { success: false, message: 'No active Cloud Run service to stop' };
  }

  // Snapshot image + envVars BEFORE deletion so /start can restore them.
  const snapshotPatch: Record<string, unknown> = {};
  try {
    if (!project.config?.lastDeployedImage) {
      const liveImg = await getServiceImage(gcpProject, gcpRegion, active.cloudRunService);
      if (liveImg) snapshotPatch.lastDeployedImage = liveImg;
    }
    const existingEnvVars = (project.config?.envVars as Record<string, string> | undefined) ?? {};
    if (Object.keys(existingEnvVars).length === 0) {
      const liveEnv = await getServiceEnvVars(gcpProject, gcpRegion, active.cloudRunService);
      if (Object.keys(liveEnv).length > 0) snapshotPatch.envVars = liveEnv;
    }
    if (Object.keys(snapshotPatch).length > 0) {
      await updateProjectConfig(projectId, { ...(project.config ?? {}), ...snapshotPatch });
    }
  } catch (err) {
    console.warn(`[stop] Failed to snapshot image/env for ${active.cloudRunService}:`, err);
  }

  // Step 1: GCP delete. Honor the structured result.
  const deleteRaw = await deleteService(gcpProject, gcpRegion, active.cloudRunService);
  const deleteOutcome: DeleteOutcome = {
    ok: deleteRaw.ok,
    alreadyGone: deleteRaw.alreadyGone,
    error: deleteRaw.error,
  };

  // If GCP delete failed (and wasn't already-gone), STOP. Don't touch DB.
  // Writing cloudRunUrl='' to a DB row whose service is still alive is
  // exactly the lying-state bug we're fixing.
  let dbOutcome: DbWriteOutcome | null = null;
  let transitionOutcome: TransitionOutcome | null = null;

  if (deleteOutcome.ok) {
    // Step 2: DB updateDeployment. Capture failure as outcome, not throw.
    try {
      await updateDeployment(active.id, { cloudRunUrl: '', healthStatus: 'unknown' });
      dbOutcome = { ok: true, error: null };
    } catch (err) {
      dbOutcome = { ok: false, error: (err as Error).message };
    }

    // Step 3: transitionProject. Only attempt if DB write succeeded.
    if (dbOutcome.ok) {
      try {
        await transitionProject(projectId, 'stopped', triggeredBy, {
          action: 'stop',
          service: active.cloudRunService,
        });
        transitionOutcome = { ok: true, errorName: null, error: null };
      } catch (err) {
        const e = err as Error;
        transitionOutcome = { ok: false, errorName: e.name, error: e.message };
      }
    }
  }

  const verdict = buildStopVerdict({
    serviceName: active.cloudRunService,
    delete: deleteOutcome,
    db: dbOutcome,
    transition: transitionOutcome,
  });

  // Log according to verdict's severity.
  switch (verdict.logLevel) {
    case 'critical':
      console.error(`[Lifecycle] [CRITICAL] ${verdict.kind}: ${verdict.message}`);
      break;
    case 'warn':
      console.warn(`[Lifecycle] ${verdict.kind}: ${verdict.message}`);
      break;
    case 'info':
      console.log(`[Lifecycle] ${verdict.kind}: ${verdict.message}`);
      break;
  }

  return verdictToLifecycleResult(verdict);
}

export async function startProjectService(projectId: string, triggeredBy = 'user'): Promise<LifecycleResult> {
  const project = await getProject(projectId);
  if (!project) return { success: false, message: 'Project not found' };

  const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
  const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';
  if (!gcpProject) return { success: false, message: 'GCP_PROJECT not configured' };

  let imageUri = project.config?.lastDeployedImage as string | undefined;
  const deployments = await getDeploymentsByProject(projectId);
  const latest = deployments[0];

  // Fallback: if we never cached the image, try reading it from the live
  // Cloud Run service. (For projects deployed before lastDeployedImage existed.)
  if (!imageUri && latest?.cloudRunService) {
    const live = await getServiceImage(gcpProject, gcpRegion, latest.cloudRunService);
    if (live) imageUri = live;
  }

  if (!imageUri) {
    return { success: false, message: 'No cached image — redeploy via /resubmit instead' };
  }

  // Prefer env vars from the live service (single source of truth), fall back to config.
  let envVars = (project.config?.envVars as Record<string, string>) ?? {};
  if (latest?.cloudRunService) {
    try {
      const live = await getServiceEnvVars(gcpProject, gcpRegion, latest.cloudRunService);
      if (Object.keys(live).length > 0) envVars = { ...envVars, ...live };
    } catch { /* keep DB values */ }
  }
  const port = (project.config?.detectedPort as number) ?? 8080;
  const needsVpcEgress = Object.prototype.hasOwnProperty.call(envVars, 'REDIS_URL');

  const result = await deployToCloudRun({
    projectSlug: project.slug,
    gcpProject,
    gcpRegion,
    imageName: project.slug,
    imageTag: 'restart',
    envVars,
    memory: '512Mi',
    cpu: '1',
    minInstances: 0,
    maxInstances: 10,
    allowUnauthenticated: (project.config?.allowUnauthenticated as boolean) ?? true,
    port,
    vpcEgress: needsVpcEgress ? {
      network: process.env.VPC_EGRESS_NETWORK ?? 'default',
      subnet: process.env.VPC_EGRESS_SUBNET ?? 'default',
      egress: 'PRIVATE_RANGES_ONLY',
    } : undefined,
  }, imageUri);

  if (!result.success) {
    return { success: false, message: `Restart failed: ${result.error}` };
  }

  if (latest) {
    await updateDeployment(latest.id, {
      cloudRunService: result.serviceName,
      cloudRunUrl: result.serviceUrl ?? undefined,
      healthStatus: 'healthy',
      deployedAt: new Date(),
    });
  }

  await updateProjectConfig(projectId, { ...(project.config ?? {}), lastDeployedImage: imageUri });

  try {
    await transitionProject(projectId, 'live', triggeredBy, { action: 'start', image: imageUri });
  } catch { /* ignore */ }

  return {
    success: true,
    message: `Restarted ${result.serviceName}`,
    serviceName: result.serviceName,
    serviceUrl: result.serviceUrl ?? undefined,
  };
}
