/**
 * Round 31 — Pure helpers for the projects LIST endpoint (RBAC scope filter).
 *
 * Closes the IDOR gap left by round 25's RBAC Phase 1: per-resource
 * owner-or-admin gates were added to MUTATING routes (POST/DELETE) but the
 * LIST endpoint `GET /api/projects` was unfiltered — every authenticated
 * user could read every project's slug, owner, status, and config. That's
 * OWASP A01:2021 Broken Access Control on a security-positioned product
 * — the single most embarrassing failure mode for "secure deploy agent."
 *
 *   scopeForRequest(auth, mode) → ListProjectsScope
 *   buildListProjectsSql(scope) → { text, values }
 *
 * Scope kinds:
 *   - 'all'    → SELECT * FROM projects ORDER BY created_at DESC
 *                (admin user, OR anonymous in permissive mode for legacy compat)
 *   - 'owner'  → ... WHERE owner_id = $1
 *                (any authenticated non-admin user — sees only their own)
 *   - 'denied' → ... WHERE FALSE
 *                (defensive: anonymous in enforced mode somehow reached handler)
 *
 * Why a 'denied' kind that returns zero rows instead of throwing? The
 * normal path is for the auth middleware to reject anonymous-in-enforced
 * BEFORE reaching the handler. If we ever reach this code path with that
 * combination, returning empty is the safest default: never leak data, never
 * 500 a normally-OK request. Logged in audit log via the route handler.
 *
 * Both helpers are pure: no DB, no fastify, no env. listProjects() in
 * orchestrator.ts wraps buildListProjectsSql() with the actual query()
 * call. Easy to unit-test, easy to reuse from CLI / GraphQL / MCP.
 *
 * Backwards compat: existing internal callers of listProjects() (deploy-worker,
 * infra route, project-groups, mcp) get the unchanged "see all" behavior
 * because the orchestrator's listProjects() defaults to { kind: 'all' }
 * when called without a scope.
 *
 * Industry alignment: this matches OWASP ASVS V8 (Data Protection) and
 * OWASP API Top 10 #1 (Broken Object Level Authorization). The "filter at
 * query time, not in app code" principle prevents the common bug where a
 * developer forgets to filter and accidentally returns ALL rows then tries
 * to filter in a .filter() afterwards (which wastes DB I/O AND leaks the
 * count via timing channels).
 */

import type { AuthContext } from '../middleware/auth.js';

// ─── Types ───────────────────────────────────────────────────────────────

export type ListProjectsScope =
  | { kind: 'all' }
  | { kind: 'owner'; ownerId: string }
  | { kind: 'denied' };

export type AuthMode = 'permissive' | 'enforced';

// ─── scopeForRequest ─────────────────────────────────────────────────────

/**
 * Derive the list scope from an auth context.
 *
 *   admin          → { kind: 'all' }
 *   non-admin user → { kind: 'owner', ownerId: user.id }
 *   anonymous + permissive → { kind: 'all' } (legacy bot/dashboard compat)
 *   anonymous + enforced   → { kind: 'denied' } (defensive — middleware should have rejected)
 *
 * Fail closed: anything we can't classify safely returns 'denied' rather
 * than 'all'. e.g. a user with empty role_name is treated as non-admin.
 */
export function scopeForRequest(auth: AuthContext, mode: AuthMode): ListProjectsScope {
  const u = auth.user;

  if (!u) {
    // Anonymous request. In permissive mode, preserve legacy behavior so
    // the round-25 transition window doesn't break callers. In enforced
    // mode this should never reach the handler; fail closed.
    return mode === 'permissive' ? { kind: 'all' } : { kind: 'denied' };
  }

  // Authenticated. Admin = full visibility. Anything else = own only.
  // Non-admin users (reviewer, viewer, custom) only ever see their own
  // projects. role_name === '' is a defensive case (treat as non-admin).
  if (u.role_name === 'admin') {
    return { kind: 'all' };
  }
  return { kind: 'owner', ownerId: u.id };
}

// ─── buildListProjectsSql ────────────────────────────────────────────────

/**
 * Compose the SQL for listing projects under the given scope. Pure function:
 * no DB, no side effects. Returns parameterized SQL ready for query().
 */
export function buildListProjectsSql(scope: ListProjectsScope): {
  text: string;
  values: unknown[];
} {
  switch (scope.kind) {
    case 'all':
      return {
        text: 'SELECT * FROM projects ORDER BY created_at DESC',
        values: [],
      };
    case 'owner':
      return {
        text: 'SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC',
        values: [scope.ownerId],
      };
    case 'denied':
      // WHERE FALSE returns zero rows. Postgres optimizer short-circuits;
      // no table scan. ORDER BY preserved for shape consistency (some
      // clients may rely on stable result shape).
      return {
        text: 'SELECT * FROM projects WHERE FALSE ORDER BY created_at DESC',
        values: [],
      };
  }
}
