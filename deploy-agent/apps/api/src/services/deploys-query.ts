/**
 * Round 34 — Pure helper for the deployments LIST endpoint (RBAC scope filter).
 *
 *   buildListDeploysSql(scope) → { text, values }
 *
 * Closes the IDOR gap on GET /api/deploys (3rd of the round-31 P0 punch list).
 * Same Pattern A as projects-query.ts and reviews-query.ts:
 *
 *   - 'all'    → no owner predicate (admin / anonymous-permissive legacy)
 *   - 'owner'  → WHERE p.owner_id = $1
 *   - 'denied' → WHERE FALSE   (defensive zero-row, never reaches normally)
 *
 * Deployments are project-owned via deployments.project_id → projects.id.
 * The existing route already JOINs projects p, so we just add a WHERE
 * clause and a parameter. No new JOINs needed.
 *
 * scope filter goes in WHERE (not in JOIN ON) because:
 *   - keeps JOIN purely structural ("how to connect tables")
 *   - keeps WHERE as the access-control surface ("which rows you may see")
 *   - postgres optimizer treats them equivalently for INNER JOIN, but the
 *     code reads more cleanly with concerns separated.
 *
 * scopeForRequest() is reused from projects-query.ts — every list endpoint
 * derives scope the same way, so duplicating that logic would invite drift.
 *
 * Limit hard-coded to 50 here (mirrors the original route). Pagination is
 * a separate concern — when we add it (round 35+), we'll switch to a
 * ValidatedDeploysQuery + parser like reviews-query did in round 30b.
 */

import type { ListProjectsScope } from './projects-query.js';

export function buildListDeploysSql(scope: ListProjectsScope = { kind: 'all' }): {
  text: string;
  values: unknown[];
} {
  switch (scope.kind) {
    case 'all':
      return {
        text: `SELECT d.*, p.name as project_name, p.slug as project_slug
               FROM deployments d
               JOIN projects p ON d.project_id = p.id
               ORDER BY d.created_at DESC
               LIMIT 50`,
        values: [],
      };
    case 'owner':
      return {
        text: `SELECT d.*, p.name as project_name, p.slug as project_slug
               FROM deployments d
               JOIN projects p ON d.project_id = p.id
               WHERE p.owner_id = $1
               ORDER BY d.created_at DESC
               LIMIT 50`,
        values: [scope.ownerId],
      };
    case 'denied':
      return {
        text: `SELECT d.*, p.name as project_name, p.slug as project_slug
               FROM deployments d
               JOIN projects p ON d.project_id = p.id
               WHERE FALSE
               ORDER BY d.created_at DESC
               LIMIT 50`,
        values: [],
      };
  }
}
