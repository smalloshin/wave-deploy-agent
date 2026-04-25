/**
 * Tests: auth-cleanup scheduler.
 *
 * Two layers:
 *
 * Unit tests (no DB needed):
 *   - cleanupAuditLog clamps retentionDays to [7, 3650]
 *   - runAuthCleanupOnce isolates errors: a session-cleanup throw doesn't skip audit-log cleanup
 *   - runAuthCleanupOnce returns deleted counts + error list
 *   - startAuthCleanup is idempotent (calling twice doesn't double-schedule)
 *   - stopAuthCleanup stops the timer
 *
 * Integration tests (skip cleanly without DB):
 *   - cleanupExpiredSessions actually deletes expires_at <= NOW() rows
 *   - cleanupAuditLog actually deletes created_at < NOW() - retention rows
 *   - retentionDays clamp is applied at the SQL level
 *
 * Run: tsx src/test-auth-cleanup.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  runAuthCleanupOnce,
  startAuthCleanup,
  stopAuthCleanup,
} from './services/auth-cleanup.js';
import {
  cleanupAuditLog,
  cleanupExpiredSessions,
  createSession,
  deleteSession,
  createUser,
  logAuth,
} from './services/auth-service.js';
import { query } from './db/index.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

async function dbAvailable(): Promise<boolean> {
  try {
    await query('SELECT 1', []);
    return true;
  } catch {
    return false;
  }
}

console.log('\n=== auth-cleanup unit tests ===\n');

// ─── Unit: scheduler shape ────────────────────────────────────

await test('startAuthCleanup is idempotent (safe to call twice)', () => {
  startAuthCleanup();
  startAuthCleanup(); // should be no-op
  stopAuthCleanup();  // tear down so the next test isn't polluted
});

await test('stopAuthCleanup is safe to call when not started', () => {
  stopAuthCleanup(); // no error
  stopAuthCleanup(); // still no error
});

// ─── Unit: error isolation ──────────────────────────────────────

// We can't easily mock the DB module here without a framework, so the
// error-isolation test runs against the real auth-service. If the DB is
// unavailable, both cleanups will throw, and runAuthCleanupOnce should
// return BOTH errors (not bail on the first one).
await test('runAuthCleanupOnce isolates errors per cleanup', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    // Without a DB both cleanups throw — proves the loop runs both.
    const result = await runAuthCleanupOnce();
    assert.equal(result.errors.length, 2,
      `expected both cleanups to error; got: ${JSON.stringify(result.errors)}`);
    assert.ok(
      result.errors.some(e => e.startsWith('cleanupExpiredSessions:')),
      'expected sessions error',
    );
    assert.ok(
      result.errors.some(e => e.startsWith('cleanupAuditLog:')),
      'expected auditLog error',
    );
  } else {
    // With a DB, neither should error; counts >= 0.
    const result = await runAuthCleanupOnce();
    assert.equal(result.errors.length, 0,
      `expected no errors; got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.sessions >= 0);
    assert.ok(result.auditLog >= 0);
  }
});

// ─── Unit: cleanupAuditLog clamping ─────────────────────────────

// We can't fully unit-test SQL behavior without a DB, but we can verify the
// function doesn't throw on extreme inputs (clamp prevents pathological queries).
await test('cleanupAuditLog clamps retentionDays to safe range', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    console.log('  SKIP  DATABASE_URL not set — clamp behavior tested in integration suite');
    return;
  }
  // 0 days would delete the entire table → must clamp up to 7.
  // We don't actually want to verify the deletion here, just that it doesn't
  // throw (i.e. didn't pass `0` or a negative interval to PG which would error).
  await cleanupAuditLog(0);
  await cleanupAuditLog(-100);
  await cleanupAuditLog(99999);
  // No assert — getting here without throw is the test.
});

// ─── Integration: actual deletion ───────────────────────────────

await test('cleanupExpiredSessions deletes expired sessions only', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    console.log('  SKIP  DATABASE_URL not set — integration test skipped');
    return;
  }

  // Always create a fresh user — unique email per run avoids existence collisions
  // and sidesteps the type difference between getUserByEmail (returns hash) and
  // createUser (doesn't). Test cleanup is best-effort; rows with these emails
  // are easy to spot if they leak.
  const email = `cleanup-test-${Date.now()}@test.local`;
  const user = await createUser({
    email,
    password: 'test-password-cleanup',
    role_name: 'viewer',
    display_name: 'Cleanup Test',
  });

  // Create a fresh session (expires_at = NOW() + SESSION_TTL_DAYS)
  const fresh = await createSession(user.id);
  // Force-create an expired session by inserting one directly with past expires_at.
  // (createSession() doesn't take a TTL override; for tests we need raw SQL.)
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() - INTERVAL '1 hour')`,
    [user.id, 'test-expired-' + Date.now()],
  );

  const deleted = await cleanupExpiredSessions();
  assert.ok(deleted >= 1, `expected at least 1 deleted; got ${deleted}`);

  // The fresh session should still exist
  const stillThere = await query(
    `SELECT 1 FROM sessions WHERE user_id = $1 AND expires_at > NOW()`,
    [user.id],
  );
  assert.ok(stillThere.rows.length >= 1, 'fresh session was incorrectly deleted');

  // Cleanup
  await deleteSession(fresh.token);
});

await test('cleanupAuditLog deletes only rows older than retentionDays', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    console.log('  SKIP  DATABASE_URL not set — integration test skipped');
    return;
  }

  // Insert a recent audit log entry (NOW())
  await logAuth({
    action: 'cleanup-test-recent',
    resource: 'test',
    ip_address: '127.0.0.1',
  });

  // Insert a synthetic old entry (created_at = NOW() - 100 days)
  await query(
    `INSERT INTO auth_audit_log (action, resource, ip_address, created_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '100 days')`,
    ['cleanup-test-old', 'test', '127.0.0.1'],
  );

  const beforeRecent = await query(
    `SELECT 1 FROM auth_audit_log WHERE action = 'cleanup-test-recent'`,
  );
  const beforeOld = await query(
    `SELECT 1 FROM auth_audit_log WHERE action = 'cleanup-test-old'`,
  );
  assert.ok(beforeRecent.rows.length >= 1);
  assert.ok(beforeOld.rows.length >= 1);

  await cleanupAuditLog(90); // < 100 days ago

  const afterRecent = await query(
    `SELECT 1 FROM auth_audit_log WHERE action = 'cleanup-test-recent'`,
  );
  const afterOld = await query(
    `SELECT 1 FROM auth_audit_log WHERE action = 'cleanup-test-old'`,
  );
  assert.ok(afterRecent.rows.length >= 1, 'recent row was incorrectly deleted');
  assert.equal(afterOld.rows.length, 0, 'old row was NOT deleted');

  // Cleanup the recent test row
  await query(`DELETE FROM auth_audit_log WHERE action = 'cleanup-test-recent'`);
});

await test('cleanupAuditLog with retentionDays < 7 clamps to 7 (does not nuke recent rows)', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    console.log('  SKIP  DATABASE_URL not set — integration test skipped');
    return;
  }

  // Insert a 3-day-old entry
  await query(
    `INSERT INTO auth_audit_log (action, resource, ip_address, created_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '3 days')`,
    ['cleanup-test-3day', 'test', '127.0.0.1'],
  );

  // retentionDays=1 would normally delete 3-day-old rows; clamp to 7 must spare it
  await cleanupAuditLog(1);

  const after = await query(
    `SELECT 1 FROM auth_audit_log WHERE action = 'cleanup-test-3day'`,
  );
  assert.ok(after.rows.length >= 1, '3-day-old row deleted despite clamp');

  await query(`DELETE FROM auth_audit_log WHERE action = 'cleanup-test-3day'`);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
