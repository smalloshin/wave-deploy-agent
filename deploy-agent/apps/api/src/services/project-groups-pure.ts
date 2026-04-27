/**
 * Round 32 — Pure helpers extracted from routes/project-groups.ts so the
 * RBAC scope-filter behavior (round 31 follow-through) is testable in
 * isolation. Zero deps: no fastify, no DB, no env.
 *
 *   filterProjectsByGroupId(projects, groupId) → ProjectWithResources[]
 *     The JS-side filter that GET /api/project-groups/:groupId applies AFTER
 *     listProjects(scope) has already done the SQL-layer owner filter. Pulling
 *     it out lets us assert the IDOR-relevant property: filterProjectsByGroupId
 *     NEVER re-introduces rows that scope-filtering already removed (it can
 *     only narrow further, never widen). That's the round-31 ADR contract.
 *
 *   groupProjects(projects) → ProjectGroup[]
 *     Pure aggregation: bucket projects by `config.projectGroup ?? id`,
 *     compute per-group counts (live/stopped/failed), pick group name + sort
 *     order. Moved here verbatim from routes/project-groups.ts:122-161.
 *
 * Why a separate file from projects-query.ts? Because projects-query is about
 * "what SQL do we run for the projects list" and these helpers are about
 * "what do we do with the rows after they come back, specifically for the
 * groups view." Different layer (SQL composer vs. presentation aggregator),
 * different reuse story. A future GraphQL or CLI groups view would import
 * these too — and would NOT want to import the SQL-text composer.
 */

import type { Project, ProjectWithResources, ProjectGroup } from '@deploy-agent/shared';

// ─── filterProjectsByGroupId ─────────────────────────────────────────────

/**
 * Match a project to a group id. A project matches if EITHER:
 *   - its `config.projectGroup` field equals the groupId (multi-service group)
 *   - its own `id` equals the groupId (single-service group; the group id IS
 *     the project id when no projectGroup field is set)
 *
 * This matches the route handler's filter at routes/project-groups.ts:177
 * verbatim.
 *
 * IDOR property: this function PRESERVES the input row set's monotonicity.
 * It can only ever return a SUBSET of `projects`. So if `projects` came in
 * already scope-filtered (admin → all rows; viewer → only rows where
 * owner_id === viewer.id), the output is also scope-correct. There's no
 * code path where a viewer's filtered list of projects gets widened back
 * out to include another user's project via the groupId match.
 */
export function filterProjectsByGroupId<T extends Pick<Project, 'id' | 'config'>>(
  projects: T[],
  groupId: string,
): T[] {
  return projects.filter(
    (p) => (p.config?.projectGroup as string | undefined) === groupId || p.id === groupId,
  );
}

// ─── groupProjects ───────────────────────────────────────────────────────

/**
 * Bucket projects into groups (by `config.projectGroup ?? id`), sort each
 * group's services (by `serviceRole` then name), compute per-group counts,
 * pick group name + timestamps, sort groups by recency.
 *
 * Pulled verbatim from routes/project-groups.ts:122-161 so we can assert:
 *   - bucketing is correct (no Cartesian product, no duplicate rows)
 *   - filtering happens UPSTREAM of grouping (viewer never sees a group
 *     constructed from another user's projects)
 *   - per-group counts correctly reflect the scope-filtered subset
 *
 * Pure: no DB, no fastify, no env, no I/O. Same input → same output.
 */
export function groupProjects(projects: ProjectWithResources[]): ProjectGroup[] {
  const groups = new Map<string, ProjectWithResources[]>();

  for (const p of projects) {
    const gid = (p.config?.projectGroup as string) ?? p.id;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid)!.push(p);
  }

  const out: ProjectGroup[] = [];
  for (const [gid, services] of groups.entries()) {
    // Sort services: backend first (deploy order), then alphabetical.
    services.sort((a, b) => {
      const ra = (a.config?.serviceRole as string) ?? 'z';
      const rb = (b.config?.serviceRole as string) ?? 'z';
      if (ra !== rb) return ra.localeCompare(rb);
      return a.name.localeCompare(b.name);
    });

    const groupName =
      (services[0]?.config?.groupName as string) ?? services[0]?.name ?? gid;
    const createdAt = services.reduce<Date>(
      (acc, s) => (s.createdAt < acc ? s.createdAt : acc),
      services[0].createdAt,
    );
    const updatedAt = services.reduce<Date>(
      (acc, s) => (s.updatedAt > acc ? s.updatedAt : acc),
      services[0].updatedAt,
    );

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

  // Most recently updated groups first.
  out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return out;
}
