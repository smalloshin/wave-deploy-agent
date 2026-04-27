/**
 * Pure-function tests for permission-check.ts (Round 38).
 *
 * This is the single source of truth for RBAC predicates used by both
 * apps/api middleware and apps/web auth context. If these tests pass,
 * server gating and client gating cannot diverge silently.
 *
 * Run via: bun packages/shared/src/test-permission-check.ts
 */

import {
  hasPermission,
  effectivePermissions,
  checkUserPermission,
} from './permission-check.js';
import type { Permission } from './auth-types.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, reason = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.error(`FAIL: ${name}: ${reason}`);
  }
}

const ALL: Permission[] = ['*'];
const VIEWER_PERMS: Permission[] = [
  'projects:read', 'reviews:read', 'deploys:read',
  'versions:read', 'infra:read', 'settings:read',
];
const REVIEWER_PERMS: Permission[] = [
  'projects:read', 'reviews:read', 'reviews:decide',
  'deploys:read', 'versions:read', 'mcp:access',
];

// ─── hasPermission: wildcard ────────────────────────────────────────

(() => {
  check('admin "*" grants projects:read', hasPermission(ALL, 'projects:read'));
})();

(() => {
  check('admin "*" grants reviews:decide', hasPermission(ALL, 'reviews:decide'));
})();

(() => {
  check('admin "*" grants infra:admin', hasPermission(ALL, 'infra:admin'));
})();

(() => {
  check('admin "*" grants users:manage', hasPermission(ALL, 'users:manage'));
})();

// ─── hasPermission: specific membership ─────────────────────────────

(() => {
  check('viewer has projects:read', hasPermission(VIEWER_PERMS, 'projects:read'));
})();

(() => {
  check('viewer denied reviews:decide', !hasPermission(VIEWER_PERMS, 'reviews:decide'));
})();

(() => {
  check('viewer denied projects:write', !hasPermission(VIEWER_PERMS, 'projects:write'));
})();

(() => {
  check('viewer denied infra:admin', !hasPermission(VIEWER_PERMS, 'infra:admin'));
})();

(() => {
  check('reviewer has reviews:decide', hasPermission(REVIEWER_PERMS, 'reviews:decide'));
})();

(() => {
  check('reviewer denied projects:write', !hasPermission(REVIEWER_PERMS, 'projects:write'));
})();

(() => {
  check('reviewer denied users:manage', !hasPermission(REVIEWER_PERMS, 'users:manage'));
})();

// ─── hasPermission: empty perms always denies ───────────────────────

(() => {
  check('empty perms denies projects:read', !hasPermission([], 'projects:read'));
})();

(() => {
  check('empty perms denies reviews:read', !hasPermission([], 'reviews:read'));
})();

// ─── hasPermission: wildcard alone vs other membership ──────────────

(() => {
  // Confirm "*" is treated as wildcard, not a literal permission named "*"
  // i.e. ['projects:read'] does NOT grant '*' as a permission check.
  // (Edge case: required is itself "*", which would be a bug in the caller,
  // but the predicate is well-defined: only true if perms includes "*".)
  check('perms without "*" but with required="*" → denied',
    !hasPermission(['projects:read'] as Permission[], '*'));
})();

(() => {
  check('perms with both "*" and specific perm → grant any',
    hasPermission(['*', 'projects:read'] as Permission[], 'reviews:decide'));
})();

// ─── effectivePermissions: no key (server-side path) ────────────────

(() => {
  const eff = effectivePermissions(VIEWER_PERMS, undefined);
  check('no key (undefined) → user perms unchanged',
    JSON.stringify(eff) === JSON.stringify(VIEWER_PERMS),
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  const eff = effectivePermissions(VIEWER_PERMS, null);
  check('no key (null) → user perms unchanged',
    JSON.stringify(eff) === JSON.stringify(VIEWER_PERMS));
})();

(() => {
  const eff = effectivePermissions(VIEWER_PERMS, []);
  check('no key (empty array) → user perms unchanged',
    JSON.stringify(eff) === JSON.stringify(VIEWER_PERMS));
})();

// ─── effectivePermissions: admin user + scoped key (key narrows) ────

(() => {
  const eff = effectivePermissions(ALL, ['projects:read'] as Permission[]);
  check('admin + scoped key → key perms only (admin narrowed)',
    JSON.stringify(eff) === JSON.stringify(['projects:read']),
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  // Admin user + key that grants "*" → still just key perms (which is "*")
  const eff = effectivePermissions(ALL, ['*'] as Permission[]);
  check('admin + admin-key → key perms ("*" only)',
    JSON.stringify(eff) === JSON.stringify(['*']));
})();

// ─── effectivePermissions: non-admin + scoped key (intersection) ────

(() => {
  // Viewer + key allowing reviews:decide → reviews:decide NOT in viewer perms,
  // intersection result must NOT include reviews:decide (key cannot ESCALATE).
  const eff = effectivePermissions(
    VIEWER_PERMS,
    ['reviews:decide'] as Permission[],
  );
  check('non-admin + key with extra perm → key cannot escalate beyond user',
    !eff.includes('reviews:decide'),
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  // Viewer + key allowing projects:read → intersection has projects:read
  const eff = effectivePermissions(
    VIEWER_PERMS,
    ['projects:read'] as Permission[],
  );
  check('non-admin + key with subset → intersection',
    eff.length === 1 && eff[0] === 'projects:read',
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  // Viewer + key with multiple perms, only some overlap
  const eff = effectivePermissions(
    VIEWER_PERMS,
    ['projects:read', 'reviews:read', 'reviews:decide'] as Permission[],
  );
  check('non-admin + key partial overlap → only overlap kept',
    eff.length === 2 && eff.includes('projects:read') && eff.includes('reviews:read'),
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  // Non-admin user + key with "*" → all of user perms (key allows everything)
  const eff = effectivePermissions(VIEWER_PERMS, ['*'] as Permission[]);
  check('non-admin + key "*" → all user perms',
    eff.length === VIEWER_PERMS.length,
    `got ${JSON.stringify(eff)}`);
})();

// ─── effectivePermissions: privilege escalation regression tests ────

(() => {
  // Critical: empty user perms + admin key → should produce empty (key is
  // ALLOW list intersected with user; empty user means nothing to allow).
  const eff = effectivePermissions([], ['*'] as Permission[]);
  check('SECURITY: empty user + admin key → still empty (no escalation)',
    eff.length === 0,
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  // Empty user + scoped key → still empty
  const eff = effectivePermissions([], ['projects:read'] as Permission[]);
  check('SECURITY: empty user + scoped key → empty',
    eff.length === 0,
    `got ${JSON.stringify(eff)}`);
})();

(() => {
  // Reviewer (not admin) + key claiming admin-only perms → none granted
  const eff = effectivePermissions(REVIEWER_PERMS, ['users:manage', 'infra:admin'] as Permission[]);
  check('SECURITY: reviewer + admin-perm key → escalation blocked',
    eff.length === 0,
    `got ${JSON.stringify(eff)}`);
})();

// ─── checkUserPermission: null user always denies ───────────────────

(() => {
  check('null user → denied', !checkUserPermission(null, 'projects:read'));
})();

(() => {
  check('undefined user → denied', !checkUserPermission(undefined, 'projects:read'));
})();

// ─── checkUserPermission: with user object ──────────────────────────

(() => {
  const user = { permissions: VIEWER_PERMS };
  check('viewer user has projects:read', checkUserPermission(user, 'projects:read'));
})();

(() => {
  const user = { permissions: VIEWER_PERMS };
  check('viewer user denied reviews:decide',
    !checkUserPermission(user, 'reviews:decide'));
})();

(() => {
  const user = { permissions: ALL };
  check('admin user grants any permission',
    checkUserPermission(user, 'users:manage') &&
    checkUserPermission(user, 'infra:admin') &&
    checkUserPermission(user, 'reviews:decide'));
})();

(() => {
  const user = { permissions: [] as Permission[] };
  check('user with empty perms denies any',
    !checkUserPermission(user, 'projects:read'));
})();

// ─── Function purity: no mutation of inputs ─────────────────────────

(() => {
  const perms: Permission[] = ['projects:read', 'reviews:read'];
  const before = JSON.stringify(perms);
  hasPermission(perms, 'projects:read');
  hasPermission(perms, 'reviews:decide');
  check('hasPermission does not mutate input perms',
    JSON.stringify(perms) === before);
})();

(() => {
  const userPerms: Permission[] = [...VIEWER_PERMS];
  const keyPerms: Permission[] = ['projects:read'];
  const beforeUser = JSON.stringify(userPerms);
  const beforeKey = JSON.stringify(keyPerms);
  effectivePermissions(userPerms, keyPerms);
  check('effectivePermissions does not mutate userPerms',
    JSON.stringify(userPerms) === beforeUser);
  check('effectivePermissions does not mutate keyPerms',
    JSON.stringify(keyPerms) === beforeKey);
})();

(() => {
  const user = { permissions: [...VIEWER_PERMS] };
  const before = JSON.stringify(user.permissions);
  checkUserPermission(user, 'projects:read');
  checkUserPermission(user, 'reviews:decide');
  check('checkUserPermission does not mutate user.permissions',
    JSON.stringify(user.permissions) === before);
})();

// ─── Server/client parity contract markers ──────────────────────────

(() => {
  // The server's hasPermission and the web's hasPermission MUST agree
  // for every (perms, required) pair. Any divergence = security regression.
  // These tests pin the predicate at the shared layer so both consumers
  // see identical results.
  const cases: Array<{ perms: Permission[]; req: Permission; expect: boolean }> = [
    { perms: ALL, req: 'projects:read', expect: true },
    { perms: ALL, req: 'users:manage', expect: true },
    { perms: VIEWER_PERMS, req: 'projects:read', expect: true },
    { perms: VIEWER_PERMS, req: 'reviews:decide', expect: false },
    { perms: REVIEWER_PERMS, req: 'reviews:decide', expect: true },
    { perms: REVIEWER_PERMS, req: 'projects:write', expect: false },
    { perms: [], req: 'projects:read', expect: false },
  ];
  let allMatch = true;
  for (const c of cases) {
    if (hasPermission(c.perms, c.req) !== c.expect) {
      allMatch = false;
      console.error(`  parity miss: perms=${JSON.stringify(c.perms)} req=${c.req} expect=${c.expect}`);
    }
  }
  check(`server/client parity contract: ${cases.length} pinned cases`, allMatch);
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
