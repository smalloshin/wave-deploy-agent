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

export interface LifecycleResult {
  success: boolean;
  message: string;
  serviceName?: string;
  serviceUrl?: string;
}

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

  await deleteService(gcpProject, gcpRegion, active.cloudRunService);
  await updateDeployment(active.id, { cloudRunUrl: '', healthStatus: 'unknown' });

  try {
    await transitionProject(projectId, 'stopped', triggeredBy, { action: 'stop', service: active.cloudRunService });
  } catch {
    // Swallow invalid transitions so "stop" from any state still removes the service.
  }

  return {
    success: true,
    message: `Stopped ${active.cloudRunService} (image kept in Artifact Registry for restart)`,
    serviceName: active.cloudRunService,
  };
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
