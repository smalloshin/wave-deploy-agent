// Round 31 — Tests for projects-query pure helpers (RBAC list filter / IDOR fix).
//
// Backstory: round 25 added RBAC Phase 1 with per-resource owner-or-admin
// gates on MUTATING routes (POST/DELETE/etc.). It silently left the
// `GET /api/projects` LIST endpoint unfiltered — every authenticated user
// sees every project's metadata (slug, owner, status, config). That's
// classic OWASP A01:2021 Broken Access Control on a security-positioned
// product. Round 31 closes the gap.
//
// Helper design follows the discord-audit-query / auth-audit-query /
// reviews-query playbook:
//   - `scopeForRequest(auth)` — pure verdict from auth context
//   - `buildListProjectsSql(scope)` — pure SQL composer with placeholders
// Both zero-dep, easy to test, easy to reuse from CLI / GraphQL / MCP.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  scopeForRequest,
  buildListProjectsSql,
  type ListProjectsScope,
} from './services/projects-query.js';
import type { AuthContext } from './middleware/auth.js';
import type { AuthUser, Permission } from '@deploy-agent/shared';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SAMPLE_USER_ID = '11111111-2222-3333-4444-555555555555';
const SAMPLE_USER_ID_2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fakeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: SAMPLE_USER_ID,
    email: 'test@example.com',
    display_name: 'Test',
    role_id: 'role-uuid',
    role_name: 'viewer',
    permissions: [] as Permission[],
    is_active: true,
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function fakeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: null,
    via: 'anonymous',
    permissions: [] as Permission[],
    ...overrides,
  };
}

// ─── scopeForRequest: admin sees all ───────────────────────────────────

(() => {
  const auth = fakeAuth({
    user: fakeUser({ role_name: 'admin' }),
    via: 'session',
  });
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'all' }, 'admin (enforced) → all');
})();

(() => {
  const auth = fakeAuth({
    user: fakeUser({ role_name: 'admin' }),
    via: 'api_key',
  });
  const scope = scopeForRequest(auth, 'permissive');
  assertEq(scope, { kind: 'all' }, 'admin (permissive) → all');
})();

// ─── scopeForRequest: non-admin authenticated user sees only own ───────

(() => {
  const auth = fakeAuth({
    user: fakeUser({ id: SAMPLE_USER_ID, role_name: 'viewer' }),
    via: 'session',
  });
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(
    scope,
    { kind: 'owner', ownerId: SAMPLE_USER_ID },
    'viewer (enforced) → owner-filtered to their own id',
  );
})();

(() => {
  const auth = fakeAuth({
    user: fakeUser({ id: SAMPLE_USER_ID, role_name: 'reviewer' }),
    via: 'session',
  });
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(
    scope,
    { kind: 'owner', ownerId: SAMPLE_USER_ID },
    'reviewer (enforced) → owner-filtered (reviewer is not admin)',
  );
})();

(() => {
  const auth = fakeAuth({
    user: fakeUser({ id: SAMPLE_USER_ID_2, role_name: 'viewer' }),
    via: 'api_key',
  });
  const scope = scopeForRequest(auth, 'permissive');
  assertEq(
    scope,
    { kind: 'owner', ownerId: SAMPLE_USER_ID_2 },
    'viewer-via-api-key (permissive) → owner-filtered',
  );
})();

// ─── scopeForRequest: anonymous in permissive mode → backwards-compat ──

(() => {
  // Permissive mode keeps existing bot/dashboard callers working without
  // breaking. Round 25 RBAC was rolled out as permissive-then-enforced
  // specifically to allow this transition. Anonymous in permissive sees
  // all (legacy behavior).
  const auth = fakeAuth({ user: null, via: 'anonymous' });
  const scope = scopeForRequest(auth, 'permissive');
  assertEq(scope, { kind: 'all' }, 'anonymous (permissive) → all (legacy compat)');
})();

// ─── scopeForRequest: anonymous in enforced mode → denied ──────────────

(() => {
  // In enforced mode the auth middleware rejects anonymous BEFORE the
  // handler runs. Defensive: if we somehow reach the handler with
  // anonymous + enforced, return a denied scope so the route handler
  // returns empty. Belt-and-suspenders against middleware regression.
  const auth = fakeAuth({ user: null, via: 'anonymous' });
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'denied' }, 'anonymous (enforced) → denied (defensive)');
})();

// ─── scopeForRequest: missing role_name treated as non-admin ───────────

(() => {
  // Defensive: if user object somehow lacks role_name, treat as non-admin
  // (fail closed). No legitimate user should ever lack role_name in our
  // schema, but bugs happen.
  const auth = fakeAuth({
    user: fakeUser({ id: SAMPLE_USER_ID, role_name: '' }),
    via: 'session',
  });
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(
    scope,
    { kind: 'owner', ownerId: SAMPLE_USER_ID },
    'empty role_name → owner (fail closed, not admin)',
  );
})();

// ─── buildListProjectsSql: kind=all → no WHERE ─────────────────────────

(() => {
  const sql = buildListProjectsSql({ kind: 'all' });
  assert(sql.text.includes('SELECT * FROM projects'), 'all: SELECT projects');
  assert(!sql.text.includes('WHERE'), 'all: no WHERE clause');
  assert(sql.text.includes('ORDER BY created_at DESC'), 'all: ORDER BY preserved');
  assertEq(sql.values, [], 'all: no values');
})();

// ─── buildListProjectsSql: kind=owner → WHERE owner_id = $1 ────────────

(() => {
  const sql = buildListProjectsSql({ kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(sql.text.includes('WHERE owner_id = $1'), 'owner: WHERE owner_id = $1');
  assert(sql.text.includes('ORDER BY created_at DESC'), 'owner: ORDER BY preserved');
  assertEq(sql.values, [SAMPLE_USER_ID], 'owner: single value passed');
})();

// ─── buildListProjectsSql: kind=denied → impossible WHERE ──────────────

(() => {
  // Denied scope must produce a query that returns ZERO rows even if
  // somehow executed. We use `WHERE FALSE` (or `WHERE 1=0`) — no values
  // needed, no risk of injection.
  const sql = buildListProjectsSql({ kind: 'denied' });
  assert(
    sql.text.includes('WHERE FALSE') || sql.text.includes('WHERE 1=0'),
    'denied: predicate that returns zero rows',
  );
  assertEq(sql.values, [], 'denied: no values');
})();

// ─── Security regression: ownerId never embedded in SQL text ───────────

(() => {
  const sql = buildListProjectsSql({ kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(
    !sql.text.includes(SAMPLE_USER_ID),
    'security: ownerId not embedded as literal in SQL text',
  );
})();

(() => {
  // Even a SQL-injection-shaped ownerId is safe because it's parameterized.
  // (Not that callers should ever pass this — but defense in depth.)
  const evil = "'; DROP TABLE projects;--";
  const sql = buildListProjectsSql({ kind: 'owner', ownerId: evil });
  assert(
    !sql.text.includes(evil),
    'security: SQL-injection-shaped ownerId not embedded',
  );
  assertEq(sql.values, [evil], 'security: malicious value goes through pg parameter, not SQL text');
})();

// ─── End-to-end: scope routes to correct SQL ───────────────────────────

(() => {
  // Admin path: scope=all → no WHERE
  const adminAuth = fakeAuth({
    user: fakeUser({ role_name: 'admin' }),
    via: 'session',
  });
  const adminSql = buildListProjectsSql(scopeForRequest(adminAuth, 'enforced'));
  assert(!adminSql.text.includes('WHERE'), 'e2e: admin → no WHERE clause');
})();

(() => {
  // Non-admin path: scope=owner → WHERE owner_id = $1 with their id
  const userAuth = fakeAuth({
    user: fakeUser({ id: SAMPLE_USER_ID_2, role_name: 'reviewer' }),
    via: 'session',
  });
  const userSql = buildListProjectsSql(scopeForRequest(userAuth, 'enforced'));
  assert(
    userSql.text.includes('WHERE owner_id = $1'),
    'e2e: non-admin → WHERE owner_id filter',
  );
  assertEq(
    userSql.values,
    [SAMPLE_USER_ID_2],
    'e2e: filter value matches the user id (NOT some other user)',
  );
})();

(() => {
  // The IDOR test: a non-admin viewer cannot see another user's projects
  // because their scope is locked to their own id. Even if the SQL composer
  // is given the wrong id, the parameterization makes injection impossible.
  // This test asserts the verdict shape, the mitigation that prevents the bug.
  const evil = fakeAuth({
    user: fakeUser({ id: SAMPLE_USER_ID, role_name: 'viewer' }),
    via: 'session',
  });
  const scope = scopeForRequest(evil, 'enforced') as ListProjectsScope & { kind: 'owner' };
  assertEq(scope.kind, 'owner', 'IDOR fix: viewer scope is owner-only');
  assertEq(
    scope.ownerId,
    SAMPLE_USER_ID,
    'IDOR fix: viewer can ONLY ever query their own ownerId, never another user\'s',
  );
})();

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
