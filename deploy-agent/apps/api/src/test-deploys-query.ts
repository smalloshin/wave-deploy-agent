// Round 34 — Tests for deploys-query pure helpers.
//
// Mirrors test-projects-query.ts and test-reviews-query.ts for the
// 3rd of the round-31 IDOR punch list. Every list endpoint gets the
// same shape: scopeForRequest verdict + buildXxxSql composer, with
// security-regression coverage so the next refactor can't reopen IDOR.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import { buildListDeploysSql } from './services/deploys-query.js';
import { scopeForRequest } from './services/projects-query.js';
import type { AuthContext } from './middleware/auth.js';

const ALICE_ID = '11111111-1111-1111-1111-111111111111';
const BOB_ID = '22222222-2222-2222-2222-222222222222';

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

// ─── scope=all (admin or anonymous-permissive) ─────────────────────────

(() => {
  const sql = buildListDeploysSql({ kind: 'all' });
  assert(!sql.text.includes('owner_id'), 'r34: scope=all omits owner_id filter');
  assert(!sql.text.includes('FALSE'), 'r34: scope=all does not use FALSE');
  assertEq(sql.values, [], 'r34: scope=all has no values');
})();

(() => {
  // Default scope (omitted) → all (legacy compat for internal callers)
  const sql = buildListDeploysSql();
  assert(!sql.text.includes('owner_id'), 'r34: default scope omits owner_id filter');
  assert(!sql.text.includes('FALSE'), 'r34: default scope is not denied');
  assertEq(sql.values, [], 'r34: default scope has no values');
})();

// ─── scope=owner ────────────────────────────────────────────────────────

(() => {
  const sql = buildListDeploysSql({ kind: 'owner', ownerId: ALICE_ID });
  assert(sql.text.includes('p.owner_id = $1'), 'r34: scope=owner adds p.owner_id predicate at $1');
  assertEq(sql.values, [ALICE_ID], 'r34: scope=owner values = [ownerId]');
})();

(() => {
  // Different owner → different value, same SQL shape
  const sql = buildListDeploysSql({ kind: 'owner', ownerId: BOB_ID });
  assert(sql.text.includes('p.owner_id = $1'), 'r34: scope=owner shape is owner-agnostic');
  assertEq(sql.values, [BOB_ID], 'r34: ownerId is the only value');
})();

// ─── scope=denied (defensive zero-row) ──────────────────────────────────

(() => {
  const sql = buildListDeploysSql({ kind: 'denied' });
  assert(sql.text.includes('FALSE'), 'r34: scope=denied uses WHERE FALSE');
  assertEq(sql.values, [], 'r34: scope=denied has no values');
  assert(!sql.text.includes('p.owner_id'), 'r34: scope=denied has no owner predicate (FALSE short-circuits)');
})();

// ─── JOIN + ORDER BY + LIMIT preserved across all scope kinds ──────────

(['all', 'denied'] as const).forEach((kind) => {
  const sql = kind === 'all'
    ? buildListDeploysSql({ kind: 'all' })
    : buildListDeploysSql({ kind: 'denied' });
  assert(sql.text.includes('JOIN projects p'), `r34: JOIN projects preserved (${kind})`);
  assert(sql.text.includes('ORDER BY d.created_at DESC'), `r34: ORDER BY preserved (${kind})`);
  assert(sql.text.includes('LIMIT 50'), `r34: LIMIT 50 preserved (${kind})`);
});

(() => {
  const sql = buildListDeploysSql({ kind: 'owner', ownerId: ALICE_ID });
  assert(sql.text.includes('JOIN projects p'), 'r34: JOIN projects preserved (owner)');
  assert(sql.text.includes('ORDER BY d.created_at DESC'), 'r34: ORDER BY preserved (owner)');
  assert(sql.text.includes('LIMIT 50'), 'r34: LIMIT 50 preserved (owner)');
})();

// ─── Security regression: ownerId is parameterized, never embedded ─────

(() => {
  const evil = "'; DROP TABLE deployments;--";
  const sql = buildListDeploysSql({ kind: 'owner', ownerId: evil });
  assert(!sql.text.includes(evil), 'r34 security: SQL-injection-shaped ownerId not embedded');
  assert(sql.values.includes(evil), 'r34 security: malicious value goes through pg parameter');
})();

(() => {
  const lookalikeUuid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const sql = buildListDeploysSql({ kind: 'owner', ownerId: lookalikeUuid });
  assert(!sql.text.includes(lookalikeUuid), 'r34 security: ownerId never embedded as SQL literal');
  assert(sql.values.includes(lookalikeUuid), 'r34 security: ownerId in pg params');
})();

// ─── IDOR contract: alice scope ≠ bob scope ────────────────────────────

(() => {
  const aliceSql = buildListDeploysSql({ kind: 'owner', ownerId: ALICE_ID });
  const bobSql = buildListDeploysSql({ kind: 'owner', ownerId: BOB_ID });
  assert(aliceSql.values.includes(ALICE_ID), 'r34 IDOR: alice scope contains alice ownerId');
  assert(!aliceSql.values.includes(BOB_ID), 'r34 IDOR: alice scope does NOT contain bob ownerId');
  assert(bobSql.values.includes(BOB_ID), 'r34 IDOR: bob scope contains bob ownerId');
  assert(!bobSql.values.includes(ALICE_ID), 'r34 IDOR: bob scope does NOT contain alice ownerId');
})();

// ─── Integration: scopeForRequest derives correct scope per role ───────

function fakeAuth(user: AuthContext['user']): AuthContext {
  return {
    user,
    permissions: [],
    via: user ? 'session' : 'anonymous',
  };
}

function fakeUser(id: string, role: string) {
  return {
    id,
    email: `${id}@example.com`,
    display_name: 'Test User' as string | null,
    role_id: 'role-id',
    role_name: role,
    permissions: [],
    is_active: true,
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

(() => {
  // Admin → scope=all → no owner predicate
  const auth = fakeAuth(fakeUser(ALICE_ID, 'admin'));
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'all' }, 'r34 E2E: admin → scope=all');
  const sql = buildListDeploysSql(scope);
  assert(!sql.text.includes('owner_id'), 'r34 E2E: admin SQL has no owner_id');
})();

(() => {
  // Viewer → scope=owner → only own deploys
  const auth = fakeAuth(fakeUser(ALICE_ID, 'viewer'));
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'owner', ownerId: ALICE_ID }, 'r34 E2E: viewer → scope=owner with own id');
  const sql = buildListDeploysSql(scope);
  assert(sql.text.includes('p.owner_id = $1'), 'r34 E2E: viewer SQL filters by p.owner_id');
  assert(sql.values.includes(ALICE_ID), 'r34 E2E: viewer SQL has own ownerId in params');
})();

(() => {
  // Reviewer → scope=owner (only admin sees all in current model)
  const auth = fakeAuth(fakeUser(ALICE_ID, 'reviewer'));
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'owner', ownerId: ALICE_ID }, 'r34 E2E: reviewer → scope=owner');
  const sql = buildListDeploysSql(scope);
  assert(sql.text.includes('p.owner_id = $1'), 'r34 E2E: reviewer SQL is owner-scoped');
})();

(() => {
  // Anonymous + permissive → scope=all (legacy compat for bot/dashboard pre-auth)
  const auth = fakeAuth(null);
  const scope = scopeForRequest(auth, 'permissive');
  assertEq(scope, { kind: 'all' }, 'r34 E2E: anonymous + permissive → scope=all');
})();

(() => {
  // Anonymous + enforced → scope=denied (defensive)
  const auth = fakeAuth(null);
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'denied' }, 'r34 E2E: anonymous + enforced → scope=denied');
  const sql = buildListDeploysSql(scope);
  assert(sql.text.includes('FALSE'), 'r34 E2E: anonymous-enforced SQL is zero-row');
})();

(() => {
  // Empty role_name (defensive: missing role) → treated as non-admin
  const auth = fakeAuth(fakeUser(ALICE_ID, ''));
  const scope = scopeForRequest(auth, 'enforced');
  assertEq(scope, { kind: 'owner', ownerId: ALICE_ID }, 'r34 E2E: empty role_name → owner (fail closed)');
})();

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
