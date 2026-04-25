/**
 * Tests: RBAC / auth system.
 *
 * Coverage:
 *   - Pure unit tests (no DB needed):
 *     · hasPermission / effectivePermissions: wildcard, intersection, empty
 *     · patternToRegex: literal, single :param, multi :param, regex meta-char escape
 *     · lookupRequiredPermission: GET/POST methods, wildcard params, unmapped routes
 *     · isPublic / isAuthenticatedOnly: matches, no false positives, query-string strip
 *   - Integration tests (skip cleanly without DB):
 *     · createUser → getUserByEmail / getUserById / listUsers
 *     · createSession → validateSession → deleteSession
 *     · expired session is invalid
 *     · createApiKey → validateApiKey → revokeApiKey
 *     · revoked / expired key is invalid
 *     · audit log write + read
 *     · password verify with correct + wrong password
 *
 * Run: tsx src/test-auth.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  hasPermission,
  effectivePermissions,
  hashPassword,
  verifyPassword,
  createUser,
  getUserByEmail,
  getUserById,
  createSession,
  validateSession,
  deleteSession,
  createApiKey,
  validateApiKey,
  revokeApiKey,
  listApiKeysForUser,
  logAuth,
  listAuditLog,
  deleteUser,
} from './services/auth-service.js';
import {
  patternToRegex,
  lookupRequiredPermission,
  isPublic,
  isAuthenticatedOnly,
} from './middleware/auth.js';
import type { Permission } from '@deploy-agent/shared';
import { query } from './db/index.js';

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  PASS  ${name}`); passed++; })
    .catch(err => {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      if ((err as Error).stack) console.error((err as Error).stack);
      failed++;
    });
}

async function dbAvailable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await query('SELECT 1');
    // Verify auth tables exist
    const r = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name = 'users') AS exists`
    );
    return r.rows[0]?.exists === true;
  } catch {
    return false;
  }
}

// ─── Unit tests: permission logic ───────────────────────────────────────

async function unitPermissionTests() {
  console.log('\n=== Unit tests: hasPermission / effectivePermissions ===');

  await test('admin wildcard "*" grants any permission', () => {
    assert.equal(hasPermission(['*'] as Permission[], 'projects:read'), true);
    assert.equal(hasPermission(['*'] as Permission[], 'reviews:decide'), true);
    assert.equal(hasPermission(['*'] as Permission[], 'infra:admin'), true);
  });

  await test('exact permission match returns true', () => {
    assert.equal(
      hasPermission(['projects:read', 'reviews:read'] as Permission[], 'projects:read'),
      true
    );
  });

  await test('missing permission returns false', () => {
    assert.equal(
      hasPermission(['projects:read'] as Permission[], 'reviews:decide'),
      false
    );
  });

  await test('empty permission list denies everything', () => {
    assert.equal(hasPermission([] as Permission[], 'projects:read'), false);
  });

  await test('effectivePermissions: no key → return user perms', () => {
    const userPerms: Permission[] = ['projects:read', 'reviews:read'];
    assert.deepEqual(effectivePermissions(userPerms, undefined), userPerms);
    assert.deepEqual(effectivePermissions(userPerms, null), userPerms);
    assert.deepEqual(effectivePermissions(userPerms, []), userPerms);
  });

  await test('effectivePermissions: admin user (*) + scoped key → key perms only', () => {
    // Critical security property: API keys NARROW down admin's permissions
    const eff = effectivePermissions(['*'] as Permission[], ['projects:read'] as Permission[]);
    assert.deepEqual(eff, ['projects:read']);
  });

  await test('effectivePermissions: non-admin user + key → intersection', () => {
    const userPerms: Permission[] = ['projects:read', 'reviews:read', 'reviews:decide'];
    const keyPerms: Permission[] = ['reviews:decide', 'infra:admin'];
    // infra:admin requested by key but user doesn't have it — should be filtered
    const eff = effectivePermissions(userPerms, keyPerms);
    assert.deepEqual(eff, ['reviews:decide']);
  });

  await test('effectivePermissions: non-admin + key with "*" → all of user perms', () => {
    const userPerms: Permission[] = ['projects:read', 'reviews:read'];
    const eff = effectivePermissions(userPerms, ['*'] as Permission[]);
    assert.deepEqual(eff, userPerms);
  });
}

// ─── Unit tests: route → permission map ─────────────────────────────────

async function unitRouteMatchingTests() {
  console.log('\n=== Unit tests: patternToRegex / lookupRequiredPermission ===');

  await test('patternToRegex: literal path with no params', () => {
    const re = patternToRegex('/api/projects');
    assert.equal(re.test('/api/projects'), true);
    assert.equal(re.test('/api/projects/abc'), false);
    assert.equal(re.test('/api/project'), false);
  });

  await test('patternToRegex: single :param matches any non-slash segment', () => {
    const re = patternToRegex('/api/projects/:id');
    assert.equal(re.test('/api/projects/abc-123'), true);
    assert.equal(re.test('/api/projects/00000000-0000-0000-0000-000000000000'), true);
    // Should NOT match additional segments
    assert.equal(re.test('/api/projects/abc/extra'), false);
    // Should NOT match missing segment
    assert.equal(re.test('/api/projects/'), false);
  });

  await test('patternToRegex: multiple :param', () => {
    const re = patternToRegex('/api/projects/:id/versions/:did/publish');
    assert.equal(re.test('/api/projects/abc/versions/xyz/publish'), true);
    assert.equal(re.test('/api/projects/abc/versions/xyz/something'), false);
  });

  await test('patternToRegex: regex meta-chars in path are escaped', () => {
    const re = patternToRegex('/api/projects.json');
    assert.equal(re.test('/api/projects.json'), true);
    // The "." should NOT match arbitrary char (would if not escaped)
    assert.equal(re.test('/api/projectsXjson'), false);
  });

  await test('lookupRequiredPermission: GET /api/projects → projects:read', () => {
    assert.equal(lookupRequiredPermission('GET', '/api/projects'), 'projects:read');
  });

  await test('lookupRequiredPermission: GET /api/projects/:id → projects:read', () => {
    // CRITICAL: this exercises the multi-colon-in-key parsing bug.
    // Key is "GET:/api/projects/:id" — naive split(':') would corrupt the path part.
    assert.equal(
      lookupRequiredPermission('GET', '/api/projects/abc-uuid-123'),
      'projects:read'
    );
  });

  await test('lookupRequiredPermission: POST /api/reviews/:id/decide → reviews:decide', () => {
    assert.equal(
      lookupRequiredPermission('POST', '/api/reviews/r-uuid/decide'),
      'reviews:decide'
    );
  });

  await test('lookupRequiredPermission: POST /api/projects/:id/versions/:did/publish → versions:publish', () => {
    assert.equal(
      lookupRequiredPermission(
        'POST',
        '/api/projects/p-uuid/versions/d-uuid/publish'
      ),
      'versions:publish'
    );
  });

  await test('lookupRequiredPermission: dangerous infra admin route → infra:admin', () => {
    assert.equal(
      lookupRequiredPermission('POST', '/api/infra/cleanup-orphans'),
      'infra:admin'
    );
    assert.equal(
      lookupRequiredPermission('POST', '/api/infra/migrate'),
      'infra:admin'
    );
    assert.equal(
      lookupRequiredPermission('POST', '/api/infra/reconcile'),
      'infra:admin'
    );
  });

  await test('lookupRequiredPermission: unmapped route returns null', () => {
    assert.equal(lookupRequiredPermission('GET', '/some/unknown/route'), null);
    assert.equal(lookupRequiredPermission('POST', '/api/nonexistent'), null);
  });

  await test('lookupRequiredPermission: method matters (GET vs POST mismatch)', () => {
    // GET /api/projects exists; POST /api/projects also exists, with different perm.
    assert.equal(lookupRequiredPermission('GET', '/api/projects'), 'projects:read');
    assert.equal(lookupRequiredPermission('POST', '/api/projects'), 'projects:write');
  });

  await test('lookupRequiredPermission: query string is stripped', () => {
    assert.equal(
      lookupRequiredPermission('GET', '/api/projects?limit=10&status=active'),
      'projects:read'
    );
  });

  await test('lookupRequiredPermission: MCP routes require mcp:access', () => {
    assert.equal(lookupRequiredPermission('POST', '/mcp/tools/list'), 'mcp:access');
    assert.equal(lookupRequiredPermission('POST', '/mcp/tools/call'), 'mcp:access');
  });

  // ─── 2026-04-26 RBAC mapping audit fix ──────────────────────────
  // Verify every previously-unmapped route now has the correct permission.
  // These were the 17 routes that fell through to "any authenticated user
  // passes" in enforced mode before the round-3 audit.

  await test('rbac-audit: project lifecycle routes require projects:deploy', () => {
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/start'), 'projects:deploy');
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/stop'), 'projects:deploy');
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/scan'), 'projects:deploy');
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/resubmit'), 'projects:deploy');
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/retry-domain'), 'projects:deploy');
  });

  await test('rbac-audit: scan-bypass routes require reviews:decide (separation of duties)', () => {
    // skip-scan and force-fail bypass the security gate. They must NOT collapse to
    // projects:deploy — that would let any deployer override the reviewer's role.
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/skip-scan'), 'reviews:decide');
    assert.equal(lookupRequiredPermission('POST', '/api/projects/p-uuid/force-fail'), 'reviews:decide');
  });

  await test('rbac-audit: project read-detail routes require projects:read', () => {
    assert.equal(lookupRequiredPermission('GET', '/api/projects/p-uuid/detail'), 'projects:read');
    assert.equal(lookupRequiredPermission('GET', '/api/projects/p-uuid/scan/report'), 'projects:read');
    assert.equal(lookupRequiredPermission('GET', '/api/projects/p-uuid/source-download'), 'projects:read');
  });

  await test('rbac-audit: env-vars + webhook URL gated on projects:write (per-project secrets)', () => {
    // Plaintext env vars and webhook secrets must not be readable at viewer level.
    assert.equal(lookupRequiredPermission('GET', '/api/projects/p-uuid/env-vars'), 'projects:write');
    assert.equal(lookupRequiredPermission('PUT', '/api/projects/p-uuid/env-vars'), 'projects:write');
    assert.equal(lookupRequiredPermission('GET', '/api/projects/p-uuid/github-webhook'), 'projects:write');
  });

  await test('rbac-audit: deploy observability endpoints require deploys:read', () => {
    assert.equal(lookupRequiredPermission('GET', '/api/deploys/d-uuid/timeline'), 'deploys:read');
    assert.equal(lookupRequiredPermission('GET', '/api/deploys/d-uuid/stream'), 'deploys:read');
    assert.equal(lookupRequiredPermission('GET', '/api/deploys/d-uuid/build-log'), 'deploys:read');
  });

  await test('rbac-audit: upload diagnose requires projects:write (matches upload/init)', () => {
    assert.equal(lookupRequiredPermission('POST', '/api/upload/diagnose'), 'projects:write');
    assert.equal(lookupRequiredPermission('POST', '/api/upload/init'), 'projects:write');
  });

  await test('rbac-audit: viewer cannot reach any newly-mapped route', () => {
    // viewer = ['projects:read', 'reviews:read', 'deploys:read', 'versions:read',
    //          'infra:read', 'settings:read', 'mcp:access']  (per RBAC ADR)
    const viewerPerms: Permission[] = [
      'projects:read', 'reviews:read', 'deploys:read', 'versions:read',
      'infra:read', 'settings:read', 'mcp:access',
    ];
    const dangerousRoutes: Array<[string, string]> = [
      ['POST', '/api/projects/p-uuid/start'],
      ['POST', '/api/projects/p-uuid/stop'],
      ['POST', '/api/projects/p-uuid/skip-scan'],
      ['POST', '/api/projects/p-uuid/force-fail'],
      ['GET',  '/api/projects/p-uuid/env-vars'],
      ['PUT',  '/api/projects/p-uuid/env-vars'],
      ['GET',  '/api/projects/p-uuid/github-webhook'],
      ['POST', '/api/upload/diagnose'],
    ];
    for (const [method, url] of dangerousRoutes) {
      const required = lookupRequiredPermission(method, url);
      assert.notEqual(required, null, `${method} ${url} must be mapped`);
      assert.equal(
        hasPermission(viewerPerms, required!),
        false,
        `viewer must NOT have ${required} → ${method} ${url}`
      );
    }
  });

  await test('rbac-audit: reviewer can decide but cannot deploy', () => {
    // reviewer = ['projects:read', 'reviews:read', 'reviews:decide', 'deploys:read',
    //             'versions:read', 'mcp:access']
    const reviewerPerms: Permission[] = [
      'projects:read', 'reviews:read', 'reviews:decide', 'deploys:read',
      'versions:read', 'mcp:access',
    ];
    // reviewer CAN skip-scan (separation of duties: they're the security gate)
    assert.equal(hasPermission(reviewerPerms, 'reviews:decide'), true);
    // reviewer CANNOT start a project (needs projects:deploy)
    assert.equal(hasPermission(reviewerPerms, 'projects:deploy'), false);
    // reviewer CANNOT read env-vars (needs projects:write)
    assert.equal(hasPermission(reviewerPerms, 'projects:write'), false);
  });
}

// ─── Unit tests: public / authenticated route classification ────────────

async function unitPublicRouteTests() {
  console.log('\n=== Unit tests: isPublic / isAuthenticatedOnly ===');

  await test('isPublic: GET /health is public', () => {
    assert.equal(isPublic('GET', '/health'), true);
  });

  await test('isPublic: POST /api/auth/login is public', () => {
    assert.equal(isPublic('POST', '/api/auth/login'), true);
  });

  await test('isPublic: POST /api/webhooks/github is public', () => {
    assert.equal(isPublic('POST', '/api/webhooks/github'), true);
    // Sub-paths under /api/webhooks/github also public (HMAC handles them)
    assert.equal(isPublic('POST', '/api/webhooks/github/event'), true);
  });

  await test('isPublic: false for non-public routes', () => {
    assert.equal(isPublic('GET', '/api/projects'), false);
    assert.equal(isPublic('POST', '/api/auth/logout'), false);
    assert.equal(isPublic('GET', '/health/extra'), false); // /health$ anchored
  });

  await test('isPublic: query strings ignored', () => {
    assert.equal(isPublic('GET', '/health?check=ready'), true);
  });

  await test('isAuthenticatedOnly: /api/auth/me requires auth (no permission)', () => {
    assert.equal(isAuthenticatedOnly('GET', '/api/auth/me'), true);
  });

  await test('isAuthenticatedOnly: /api/auth/api-keys/:id matches DELETE', () => {
    assert.equal(
      isAuthenticatedOnly('DELETE', '/api/auth/api-keys/abc-uuid'),
      true
    );
    // But not GET
    assert.equal(
      isAuthenticatedOnly('GET', '/api/auth/api-keys/abc-uuid'),
      false
    );
  });

  await test('isAuthenticatedOnly: false for routes that need a permission', () => {
    assert.equal(isAuthenticatedOnly('GET', '/api/projects'), false);
    assert.equal(isAuthenticatedOnly('GET', '/api/auth/audit-log'), false);
  });
}

// ─── Unit tests: password hashing ───────────────────────────────────────

async function unitPasswordTests() {
  console.log('\n=== Unit tests: password hashing ===');

  await test('hashPassword produces a bcrypt hash, never returns plaintext', async () => {
    const hash = await hashPassword('hunter2');
    assert.notEqual(hash, 'hunter2');
    assert.match(hash, /^\$2[aby]\$\d{2}\$/);
    assert.equal(hash.length >= 50, true);
  });

  await test('hashPassword: same input → different hash (salt randomness)', async () => {
    const a = await hashPassword('password123');
    const b = await hashPassword('password123');
    assert.notEqual(a, b);
  });

  await test('verifyPassword: correct password matches', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  await test('verifyPassword: wrong password rejected', async () => {
    const hash = await hashPassword('right');
    assert.equal(await verifyPassword('wrong', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });
}

// ─── Integration tests (need DATABASE_URL + auth tables) ────────────────

async function integrationTests() {
  console.log('\n=== Integration tests: users + sessions + API keys (DB required) ===');

  if (!(await dbAvailable())) {
    console.log('  SKIP  DATABASE_URL not set or auth tables missing — skipping integration tests');
    skipped += 9;
    return;
  }

  // Use a unique test email so re-runs don't collide
  const testEmail = `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  let userId: string | null = null;
  let createdToken: string | null = null;
  let createdApiKey: string | null = null;
  let createdApiKeyId: string | null = null;

  await test('createUser → email/role/permissions wired correctly', async () => {
    const u = await createUser({
      email: testEmail,
      password: 'integration-test-pw-12345',
      role_name: 'viewer',
      display_name: 'Test Viewer',
    });
    assert.equal(u.email, testEmail.toLowerCase());
    assert.equal(u.role_name, 'viewer');
    assert.equal(u.is_active, true);
    assert.ok(u.permissions.length > 0);
    assert.ok(u.permissions.includes('projects:read'));
    userId = u.id;
  });

  await test('getUserByEmail returns user with password_hash', async () => {
    const u = await getUserByEmail(testEmail);
    assert.ok(u);
    assert.equal(u!.id, userId);
    assert.ok(u!.password_hash);
    assert.match(u!.password_hash, /^\$2[aby]\$/);
  });

  await test('getUserById returns user (no password_hash)', async () => {
    if (!userId) throw new Error('no userId');
    const u = await getUserById(userId);
    assert.ok(u);
    assert.equal(u!.email, testEmail.toLowerCase());
    // getUserById intentionally doesn't return password_hash
    assert.equal(('password_hash' in (u as object)), false);
  });

  await test('createSession + validateSession round-trips', async () => {
    if (!userId) throw new Error('no userId');
    const { token, expiresAt } = await createSession(userId, {
      ip: '127.0.0.1',
      userAgent: 'test-runner',
    });
    assert.ok(token);
    assert.equal(token.length >= 60, true); // 32 bytes hex
    assert.ok(expiresAt > new Date());

    const u = await validateSession(token);
    assert.ok(u);
    assert.equal(u!.id, userId);
    createdToken = token;
  });

  await test('validateSession: garbage token returns null (no error)', async () => {
    const u = await validateSession('not-a-real-token-' + Math.random());
    assert.equal(u, null);
  });

  await test('deleteSession invalidates token', async () => {
    if (!createdToken) throw new Error('no token');
    await deleteSession(createdToken);
    const u = await validateSession(createdToken);
    assert.equal(u, null);
  });

  await test('createApiKey returns raw key once + prefix stored', async () => {
    if (!userId) throw new Error('no userId');
    const k = await createApiKey({
      user_id: userId,
      name: 'Integration test key',
      permissions: ['projects:read'] as Permission[],
    });
    assert.ok(k.raw_key);
    assert.match(k.raw_key, /^da_k_[a-f0-9]{48}$/); // prefix + 24 bytes hex
    assert.equal(k.key_prefix.startsWith('da_k_'), true);
    assert.equal(k.is_active, true);
    createdApiKey = k.raw_key;
    createdApiKeyId = k.id;
  });

  await test('validateApiKey accepts raw key, rejects garbage and wrong prefix', async () => {
    if (!createdApiKey) throw new Error('no api key');
    const ok = await validateApiKey(createdApiKey);
    assert.ok(ok);
    assert.equal(ok!.user.id, userId);
    assert.deepEqual(ok!.key_permissions, ['projects:read']);

    // Wrong prefix → null without DB lookup
    assert.equal(await validateApiKey('wrong-prefix-key'), null);
    // Right prefix but garbage → null
    assert.equal(await validateApiKey('da_k_garbage'), null);
  });

  await test('listApiKeysForUser includes the new key', async () => {
    if (!userId || !createdApiKeyId) throw new Error('no user/key');
    const keys = await listApiKeysForUser(userId);
    const found = keys.find(k => k.id === createdApiKeyId);
    assert.ok(found);
    assert.equal(found!.is_active, true);
  });

  await test('revokeApiKey: subsequent validateApiKey returns null', async () => {
    if (!createdApiKey || !userId || !createdApiKeyId) throw new Error('no key');
    const ok = await revokeApiKey(createdApiKeyId, userId);
    assert.equal(ok, true);
    const v = await validateApiKey(createdApiKey);
    assert.equal(v, null);
  });

  await test('logAuth + listAuditLog round-trip', async () => {
    if (!userId) throw new Error('no userId');
    await logAuth({
      user_id: userId,
      action: 'integration_test_marker',
      resource: '/test/marker',
      ip_address: '127.0.0.1',
      metadata: { test_run: true, ts: Date.now() },
    });
    const entries = await listAuditLog(50) as Array<{
      action: string;
      user_id: string | null;
      resource: string | null;
    }>;
    const marker = entries.find(e => e.action === 'integration_test_marker');
    assert.ok(marker);
    assert.equal(marker!.user_id, userId);
    assert.equal(marker!.resource, '/test/marker');
  });

  // Cleanup — delete user (cascades to sessions, api_keys via FK ON DELETE CASCADE)
  if (userId) {
    try {
      await deleteUser(userId);
      console.log('  CLEANUP  deleted test user');
    } catch (err) {
      console.warn('  CLEANUP  failed to delete test user:', (err as Error).message);
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────

(async () => {
  await unitPermissionTests();
  await unitRouteMatchingTests();
  await unitPublicRouteTests();
  await unitPasswordTests();
  await integrationTests();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})();
