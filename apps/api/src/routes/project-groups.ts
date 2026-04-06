// Project Groups — aggregated view of related services + their resources.
//
// A "group" is either a monorepo upload (N services sharing config.projectGroup)
// or a single-service upload (1 service, group = its own id).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listProjects,
  getProject,
  getDeploymentsByProject,
} from '../services/orchestrator';
import { query } from '../db/index';
import { stopProjectService, startProjectService } from '../services/service-lifecycle';
import { deleteService, deleteDomainMapping, deleteContainerImage } from '../services/deploy-engine';
import { deleteCname } from '../services/dns-manager';
import { deleteProjectFromDb } from '../services/orchestrator';
import type { Project, ProjectResource, ProjectWithResources, ProjectGroup } from '@deploy-agent/shared';

async function enrichProjectWithResources(project: Project): Promise<ProjectWithResources> {
  const deployments = await getDeploymentsByProject(project.id);
  const activeDep = deployments.find((d) => d.cloudRunService) ?? deployments[0] ?? null;

  const resources: ProjectResource[] = [];

  // Cloud Run service
  if (activeDep?.cloudRunService) {
    resources.push({
      kind: 'cloud_run',
      label: `Cloud Run: ${activeDep.cloudRunService}`,
      detail: activeDep.cloudRunUrl ?? undefined,
      reference: activeDep.cloudRunService,
      removable: true,
    });
  }

  // Custom domain
  if (activeDep?.customDomain) {
    resources.push({
      kind: 'custom_domain',
      label: activeDep.customDomain,
      detail: activeDep.sslStatus ?? undefined,
      reference: activeDep.customDomain,
      removable: true,
    });
  }

  // Redis allocation (shared Redis DB index)
  try {
    const redisRow = await query(
      'SELECT db_index, key_prefix FROM project_redis_allocations WHERE project_id = $1',
      [project.id],
    );
    if (redisRow.rows.length > 0) {
      const r = redisRow.rows[0];
      resources.push({
        kind: 'redis_db',
        label: `Redis db${r.db_index}`,
        detail: `prefix=${r.key_prefix}`,
        reference: `db${r.db_index}`,
        removable: true,
      });
    }
  } catch { /* table may not exist yet */ }

  // Postgres DB allocation (per-project logical DB)
  try {
    const dbRow = await query(
      'SELECT db_name FROM project_db_allocations WHERE project_id = $1',
      [project.id],
    );
    if (dbRow.rows.length > 0) {
      resources.push({
        kind: 'postgres_db',
        label: `Postgres: ${dbRow.rows[0].db_name}`,
        detail: 'Cloud SQL (shared instance)',
        reference: dbRow.rows[0].db_name,
        removable: true,
      });
    }
  } catch { /* table may not exist */ }

  // GCS source tarball
  const gcsUri = project.config?.gcsSourceUri as string | undefined;
  if (gcsUri) {
    resources.push({
      kind: 'gcs_source',
      label: 'Source archive',
      detail: gcsUri.replace(/^gs:\/\//, ''),
      reference: gcsUri,
      removable: false,
    });
  }

  return {
    ...project,
    resources,
    latestDeployment: activeDep ? {
      cloudRunService: activeDep.cloudRunService,
      cloudRunUrl: activeDep.cloudRunUrl,
      customDomain: activeDep.customDomain,
      deployedAt: activeDep.deployedAt,
    } : null,
  };
}

function groupProjects(projects: ProjectWithResources[]): ProjectGroup[] {
  const groups = new Map<string, ProjectWithResources[]>();

  for (const p of projects) {
    const gid = (p.config?.projectGroup as string) ?? p.id;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid)!.push(p);
  }

  const out: ProjectGroup[] = [];
  for (const [gid, services] of groups.entries()) {
    // Sort services: backend first (deploy order), then alphabetical
    services.sort((a, b) => {
      const ra = (a.config?.serviceRole as string) ?? 'z';
      const rb = (b.config?.serviceRole as string) ?? 'z';
      if (ra !== rb) return ra.localeCompare(rb);
      return a.name.localeCompare(b.name);
    });

    const groupName = (services[0]?.config?.groupName as string) ?? services[0]?.name ?? gid;
    const createdAt = services.reduce<Date>((acc, s) => (s.createdAt < acc ? s.createdAt : acc), services[0].createdAt);
    const updatedAt = services.reduce<Date>((acc, s) => (s.updatedAt > acc ? s.updatedAt : acc), services[0].updatedAt);

    out.push({
      groupId: gid,
      groupName,
      createdAt,
      updatedAt,
      serviceCount: services.length,
      liveCount: services.filter((s) => s.status === 'live').length,
      stoppedCount: services.filter((s) => s.status === 'stopped').length,
      failedCount: services.filter((s) => s.status === 'failed').length,
      services,
    });
  }

  // Most recently updated groups first
  out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return out;
}

export async function projectGroupRoutes(app: FastifyInstance) {
  // List all groups with services + resources
  app.get('/api/project-groups', async () => {
    const projects = await listProjects();
    const enriched = await Promise.all(projects.map(enrichProjectWithResources));
    const groups = groupProjects(enriched);
    return { groups };
  });

  // Get a single group
  app.get<{ Params: { groupId: string } }>('/api/project-groups/:groupId', async (request, reply) => {
    const projects = await listProjects();
    const enriched = await Promise.all(
      projects
        .filter((p) => (p.config?.projectGroup as string) === request.params.groupId || p.id === request.params.groupId)
        .map(enrichProjectWithResources),
    );
    if (enriched.length === 0) return reply.status(404).send({ error: 'Group not found' });
    const [group] = groupProjects(enriched);
    return { group };
  });

  // Bulk action on a group
  const actionSchema = z.object({
    action: z.enum(['stop', 'start', 'delete']),
    serviceIds: z.array(z.string()).optional(),
  });

  app.post<{ Params: { groupId: string } }>(
    '/api/project-groups/:groupId/actions',
    async (request, reply) => {
      const body = actionSchema.parse(request.body);
      const projects = await listProjects();
      const members = projects.filter((p) =>
        (p.config?.projectGroup as string) === request.params.groupId || p.id === request.params.groupId,
      );
      if (members.length === 0) return reply.status(404).send({ error: 'Group not found' });

      const targets = body.serviceIds
        ? members.filter((p) => body.serviceIds!.includes(p.id))
        : members;

      const results: Array<{ serviceId: string; name: string; success: boolean; message: string }> = [];

      for (const p of targets) {
        try {
          if (body.action === 'stop') {
            const r = await stopProjectService(p.id, 'bulk-group-action');
            results.push({ serviceId: p.id, name: p.name, success: r.success, message: r.message });
          } else if (body.action === 'start') {
            const r = await startProjectService(p.id, 'bulk-group-action');
            results.push({ serviceId: p.id, name: p.name, success: r.success, message: r.message });
          } else if (body.action === 'delete') {
            const teardownLog = await teardownSingleProject(p.id);
            results.push({ serviceId: p.id, name: p.name, success: true, message: `Deleted (${teardownLog.length} resources cleaned)` });
          }
        } catch (err) {
          results.push({ serviceId: p.id, name: p.name, success: false, message: (err as Error).message });
        }
      }

      return { action: body.action, results };
    },
  );
}

// Internal: full teardown of a single project (mirrors DELETE /api/projects/:id)
async function teardownSingleProject(projectId: string): Promise<Array<{ step: string; status: string }>> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
  const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';
  const log: Array<{ step: string; status: string }> = [];

  const deployments = await getDeploymentsByProject(projectId);
  for (const d of deployments) {
    if (d.cloudRunService && gcpProject) {
      try { await deleteService(gcpProject, gcpRegion, d.cloudRunService); log.push({ step: `Deleted ${d.cloudRunService}`, status: 'ok' }); }
      catch (err) { log.push({ step: `Delete ${d.cloudRunService}`, status: `error: ${(err as Error).message}` }); }
    }
    if (d.customDomain && gcpProject) {
      try { await deleteDomainMapping(gcpProject, gcpRegion, d.customDomain); log.push({ step: `Domain mapping ${d.customDomain}`, status: 'ok' }); }
      catch (err) { log.push({ step: `Domain ${d.customDomain}`, status: `error: ${(err as Error).message}` }); }

      const cfToken = process.env.CLOUDFLARE_TOKEN || '';
      const cfZoneId = process.env.CLOUDFLARE_ZONE_ID || '';
      const cfZoneName = process.env.CLOUDFLARE_ZONE_NAME || '';
      if (cfToken && cfZoneId && cfZoneName) {
        const subdomain = d.customDomain.replace(`.${cfZoneName}`, '');
        try { await deleteCname({ cloudflareToken: cfToken, zoneId: cfZoneId, subdomain, zoneName: cfZoneName }); log.push({ step: `DNS ${d.customDomain}`, status: 'ok' }); }
        catch (err) { log.push({ step: `DNS ${d.customDomain}`, status: `error: ${(err as Error).message}` }); }
      }
    }
  }

  if (gcpProject && gcpRegion) {
    try { await deleteContainerImage(gcpProject, gcpRegion, project.slug); log.push({ step: `Image ${project.slug}`, status: 'ok' }); }
    catch (err) { log.push({ step: `Image ${project.slug}`, status: `error: ${(err as Error).message}` }); }
  }

  await deleteProjectFromDb(projectId);
  log.push({ step: 'DB records', status: 'ok' });
  return log;
}
