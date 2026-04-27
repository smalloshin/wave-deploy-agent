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
import { releaseProjectRedis } from '../services/redis-provisioner';
import {
  buildTeardownVerdict,
  outcomeToLogEntry,
  type TeardownStepOutcome,
  type TeardownVerdict,
} from '../services/teardown-verdict';
import {
  buildAccessVerdict,
  logAccessVerdict,
  isGranted,
  type AccessCheckInput,
} from '../services/access-denied-verdict';
import { scopeForRequest, type AuthMode } from '../services/projects-query';
import { groupProjects, filterProjectsByGroupId } from '../services/project-groups-pure';
import type { Project, ProjectResource, ProjectWithResources } from '@deploy-agent/shared';

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
      healthStatus: activeDep.healthStatus,
      sslStatus: activeDep.sslStatus,
    } : null,
  };
}

// `groupProjects` extracted to services/project-groups-pure.ts in round 32 so
// it's testable in isolation alongside the RBAC scope-filter contract.

export async function projectGroupRoutes(app: FastifyInstance) {
  // Round 32 — RBAC scope-filter on the groups view (OWASP A01:2021 IDOR).
  //
  // Both GET handlers below derive a scope from `request.auth` and pass it
  // to `listProjects(scope)`. The SQL filter happens at the projects query
  // layer; `filterProjectsByGroupId` and `groupProjects` then aggregate the
  // already-filtered rows. This means a viewer never sees a group built from
  // another user's projects (the rows are gone before they reach
  // `enrichProjectWithResources`, which also avoids wasted GCP API calls).
  //
  // Round 25 RBAC fixed mutating routes; round 31 fixed `GET /api/projects`;
  // round 32 closes the silent regression where this side-door GET handler
  // was still calling `listProjects()` with no scope and leaking everything.
  //
  // Reference: brain/decisions/2026-04-27-rbac-scope-list-pattern.md
  const authMode = (process.env.AUTH_MODE === 'enforced' ? 'enforced' : 'permissive') as AuthMode;

  // List all groups with services + resources (scope-filtered)
  app.get('/api/project-groups', async (request) => {
    const scope = scopeForRequest(request.auth, authMode);
    const projects = await listProjects(scope);
    const enriched = await Promise.all(projects.map(enrichProjectWithResources));
    const groups = groupProjects(enriched);
    return { groups };
  });

  // Get a single group (scope-filtered before the groupId match)
  app.get<{ Params: { groupId: string } }>('/api/project-groups/:groupId', async (request, reply) => {
    const scope = scopeForRequest(request.auth, authMode);
    const projects = await listProjects(scope);
    const enriched = await Promise.all(
      filterProjectsByGroupId(projects, request.params.groupId).map(enrichProjectWithResources),
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

      // RBAC Phase 1: bulk action refuses the WHOLE batch if any target is
      // not owned by the actor (and the actor isn't admin). This matches the
      // single-resource contract — bulk is not a privilege-escalation surface.
      // Compute verdicts for every target up front, then short-circuit if any
      // deny. We don't use requireOwnerOrAdmin() because it sends a reply per
      // call; here we want a single consolidated 403 with rejectedIds[].
      const mode = (process.env.AUTH_MODE ?? 'permissive') as 'permissive' | 'enforced';
      const auth = request.auth;
      const rejected: Array<{ serviceId: string; name: string; reason: string }> = [];
      for (const p of targets) {
        const v = buildAccessVerdict({
          mode,
          via: auth.via,
          actorUserId: auth.user?.id ?? null,
          actorEmail: auth.user?.email ?? null,
          actorRoleName: auth.user?.role_name ?? null,
          resourceOwnerId: p.ownerId,
          resourceId: p.id,
          resourceKind: 'project',
          action: `group_${body.action}`,
        } satisfies AccessCheckInput);
        logAccessVerdict(v);
        if (!isGranted(v)) {
          rejected.push({
            serviceId: p.id,
            name: p.name,
            reason: v.kind === 'denied-anonymous' ? 'auth_required' : 'not_owner',
          });
        }
      }
      if (rejected.length > 0) {
        // Mirror single-route shape: 401 if any anonymous in enforced mode, else 403.
        const status = rejected.some((r) => r.reason === 'auth_required') ? 401 : 403;
        return reply.status(status).send({
          error: status === 401 ? 'auth_required' : 'not_owner',
          message:
            `Bulk ${body.action} refused: ${rejected.length} of ${targets.length} target service(s) ` +
            `are not owned by the caller. Bulk actions require ownership of every target (or admin). ` +
            `Resubmit with serviceIds[] limited to your owned services.`,
          groupId: request.params.groupId,
          action: body.action,
          rejected,
        });
      }

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
            // Round 15: teardownSingleProject now returns the verdict so the
            // bulk-action caller honors orphan-detection. If a service can't
            // be cleaned in GCP, we report it as a failure for that service
            // and keep its DB row (audit trail) intact.
            const { verdict, teardownLog } = await teardownSingleProject(p.id);
            if (verdict.kind === 'partial-orphans') {
              const orphanList = verdict.orphans.map((o) => `${o.kind}=${o.reference}`).join(', ');
              results.push({
                serviceId: p.id,
                name: p.name,
                success: false,
                message: `Partial cleanup: ${verdict.orphans.length} orphan(s) [${orphanList}]. DB row preserved; manual cleanup required.`,
              });
            } else {
              results.push({
                serviceId: p.id,
                name: p.name,
                success: true,
                message: `Deleted (${teardownLog.length} resources cleaned)`,
              });
            }
          }
        } catch (err) {
          results.push({ serviceId: p.id, name: p.name, success: false, message: (err as Error).message });
        }
      }

      return { action: body.action, results };
    },
  );
}

// Internal: full teardown of a single project (mirrors DELETE /api/projects/:id).
//
// Round 15: returns the verdict so the bulk-action route honors orphan
// detection — same safety as DELETE /api/projects/:id. If any GCP step
// fails, the DB row is NOT deleted (audit trail preserved). The caller
// decides how to surface the partial result.
async function teardownSingleProject(
  projectId: string,
): Promise<{ verdict: TeardownVerdict; teardownLog: Array<{ step: string; status: 'ok' | 'error'; error?: string }> }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
  const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';
  const outcomes: TeardownStepOutcome[] = [];

  const deployments = await getDeploymentsByProject(projectId);
  for (const d of deployments) {
    if (d.cloudRunService && gcpProject) {
      const delRes = await deleteService(gcpProject, gcpRegion, d.cloudRunService);
      outcomes.push({
        kind: 'cloud_run_service',
        reference: d.cloudRunService,
        ok: delRes.ok,
        alreadyGone: delRes.alreadyGone,
        error: delRes.error,
      });
    }
    if (d.customDomain && gcpProject) {
      try {
        await deleteDomainMapping(gcpProject, gcpRegion, d.customDomain);
        outcomes.push({ kind: 'domain_mapping', reference: d.customDomain, ok: true, error: null });
      } catch (err) {
        outcomes.push({ kind: 'domain_mapping', reference: d.customDomain, ok: false, error: (err as Error).message });
      }

      const cfToken = process.env.CLOUDFLARE_TOKEN || '';
      const cfZoneId = process.env.CLOUDFLARE_ZONE_ID || '';
      const cfZoneName = process.env.CLOUDFLARE_ZONE_NAME || '';
      if (cfToken && cfZoneId && cfZoneName) {
        const subdomain = d.customDomain.replace(`.${cfZoneName}`, '');
        try {
          const result = await deleteCname({ cloudflareToken: cfToken, zoneId: cfZoneId, subdomain, zoneName: cfZoneName });
          outcomes.push({
            kind: 'cloudflare_dns',
            reference: d.customDomain,
            ok: result.success,
            error: result.error ?? null,
          });
        } catch (err) {
          outcomes.push({ kind: 'cloudflare_dns', reference: d.customDomain, ok: false, error: (err as Error).message });
        }
      }
    }
  }

  if (gcpProject && gcpRegion) {
    try {
      await deleteContainerImage(gcpProject, gcpRegion, project.slug);
      outcomes.push({ kind: 'container_image', reference: project.slug, ok: true, error: null });
    } catch (err) {
      outcomes.push({ kind: 'container_image', reference: project.slug, ok: false, error: (err as Error).message });
    }
  }

  try {
    await releaseProjectRedis(projectId);
    outcomes.push({ kind: 'redis_allocation', reference: projectId, ok: true, error: null });
  } catch (err) {
    outcomes.push({ kind: 'redis_allocation', reference: projectId, ok: false, error: (err as Error).message });
  }

  const verdict = buildTeardownVerdict(outcomes);
  const teardownLog = outcomes.map(outcomeToLogEntry);

  if (verdict.kind === 'partial-orphans') {
    // Refuse DB delete — same contract as the single-project route.
    console.error(
      `[CRITICAL][teardown-bulk] project ${project.name} (${projectId}) has ${verdict.orphans.length} orphan(s); DB row preserved. Orphans: ${verdict.orphans.map((o) => `${o.kind}=${o.reference}(${o.error})`).join('; ')}`,
    );
    return { verdict, teardownLog };
  }

  await deleteProjectFromDb(projectId);
  teardownLog.push({ step: 'Delete database records', status: 'ok' });
  return { verdict, teardownLog };
}
