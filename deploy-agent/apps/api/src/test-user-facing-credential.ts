/**
 * R64 (2026-05-11): tests for `isUserFacingCredential` classifier in
 * env-detector.ts.
 *
 * Pure function — name in, bool out. Locks down the broader pattern that
 * triggers `user_facing_weak_replaced` warning + auto-gen-then-reveal flow.
 *
 * Zero-dep — `node:assert/strict` only.
 */

import { strict as assert } from 'node:assert';

import { isUserFacingCredential } from './services/env-detector';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing strict patterns (kept for backwards compat — should still match)
// ─────────────────────────────────────────────────────────────────────────────

test('strict pattern: AUTH_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('AUTH_PASSWORD'), true);
});

test('strict pattern: ADMIN_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('ADMIN_PASSWORD'), true);
});

test('strict pattern: bare PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('PASSWORD'), true);
});

test('strict pattern: bare USERNAME → user-facing', () => {
  assert.equal(isUserFacingCredential('USERNAME'), true);
});

test('strict pattern: AUTH_EMAIL → user-facing', () => {
  assert.equal(isUserFacingCredential('AUTH_EMAIL'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// R64 expanded patterns — canonical case + new prefixes
// ─────────────────────────────────────────────────────────────────────────────

test('R64 canonical: SYSTEM_PASSWORD → user-facing (legal-flow-20260505)', () => {
  assert.equal(isUserFacingCredential('SYSTEM_PASSWORD'), true);
});

test('R64 expanded: LOGIN_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('LOGIN_PASSWORD'), true);
});

test('R64 expanded: APP_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('APP_PASSWORD'), true);
});

test('R64 expanded: MASTER_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('MASTER_PASSWORD'), true);
});

test('R64 expanded: ROOT_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('ROOT_PASSWORD'), true);
});

test('R64 expanded: SHARED_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('SHARED_PASSWORD'), true);
});

test('R64 expanded: GUEST_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('GUEST_PASSWORD'), true);
});

test('R64 expanded: DEMO_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('DEMO_PASSWORD'), true);
});

test('R64 expanded: TEST_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('TEST_PASSWORD'), true);
});

test('R64 expanded: SUPER_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('SUPER_PASSWORD'), true);
});

test('R64 expanded: ACCOUNT_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('ACCOUNT_PASSWORD'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// USER prefix — careful, must distinguish USER_PASSWORD vs USERNAME_PASSWORD
// ─────────────────────────────────────────────────────────────────────────────

test('R64 expanded: USER_PASSWORD → user-facing', () => {
  assert.equal(isUserFacingCredential('USER_PASSWORD'), true);
});

test('R64 expanded: USER_PIN → user-facing', () => {
  assert.equal(isUserFacingCredential('USER_PIN'), true);
});

test('R64 expanded: USER_PASSPHRASE → user-facing', () => {
  assert.equal(isUserFacingCredential('USER_PASSPHRASE'), true);
});

test('R64 case-insensitive: system_password (lowercase) → user-facing', () => {
  // Real-world .env files use lowercase or mixed-case keys sometimes;
  // upper-case normalization in the classifier handles this.
  assert.equal(isUserFacingCredential('system_password'), true);
});

test('R64 case-insensitive: System_Password (PascalCase) → user-facing', () => {
  assert.equal(isUserFacingCredential('System_Password'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// PIN / PASSPHRASE generic suffix patterns
// ─────────────────────────────────────────────────────────────────────────────

test('PIN suffix: VAULT_PIN → user-facing', () => {
  assert.equal(isUserFacingCredential('VAULT_PIN'), true);
});

test('PIN suffix: BACKUP_PIN → user-facing', () => {
  assert.equal(isUserFacingCredential('BACKUP_PIN'), true);
});

test('PASSPHRASE suffix: KEYSTORE_PASSPHRASE → user-facing', () => {
  assert.equal(isUserFacingCredential('KEYSTORE_PASSPHRASE'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Negatives — machine secrets, NOT user-facing
// ─────────────────────────────────────────────────────────────────────────────

test('NEGATIVE: JWT_SECRET → NOT user-facing (machine-only signing key)', () => {
  assert.equal(isUserFacingCredential('JWT_SECRET'), false);
});

test('NEGATIVE: SESSION_SECRET → NOT user-facing (machine session signing)', () => {
  assert.equal(isUserFacingCredential('SESSION_SECRET'), false);
});

test('NEGATIVE: NEXTAUTH_SECRET → NOT user-facing', () => {
  assert.equal(isUserFacingCredential('NEXTAUTH_SECRET'), false);
});

test('NEGATIVE: ENCRYPTION_KEY → NOT user-facing', () => {
  assert.equal(isUserFacingCredential('ENCRYPTION_KEY'), false);
});

test('NEGATIVE: API_KEY → NOT user-facing (machine credential to third party)', () => {
  assert.equal(isUserFacingCredential('API_KEY'), false);
});

test('NEGATIVE: GEMINI_API_KEY → NOT user-facing', () => {
  assert.equal(isUserFacingCredential('GEMINI_API_KEY'), false);
});

test('NEGATIVE: STRIPE_SECRET_KEY → NOT user-facing', () => {
  assert.equal(isUserFacingCredential('STRIPE_SECRET_KEY'), false);
});

test('NEGATIVE: DATABASE_URL → NOT user-facing (it contains a password but it is a connection string)', () => {
  assert.equal(isUserFacingCredential('DATABASE_URL'), false);
});

test('NEGATIVE: GOOGLE_PRIVATE_KEY → NOT user-facing', () => {
  assert.equal(isUserFacingCredential('GOOGLE_PRIVATE_KEY'), false);
});

test('NEGATIVE: CSRF_SECRET → NOT user-facing', () => {
  assert.equal(isUserFacingCredential('CSRF_SECRET'), false);
});

test('NEGATIVE: CLIENT_SECRET → NOT user-facing (OAuth client secret)', () => {
  assert.equal(isUserFacingCredential('CLIENT_SECRET'), false);
});

test('NEGATIVE: REFRESH_TOKEN → NOT user-facing (machine-managed token)', () => {
  assert.equal(isUserFacingCredential('REFRESH_TOKEN'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge / defensive
// ─────────────────────────────────────────────────────────────────────────────

test('empty string → false', () => {
  assert.equal(isUserFacingCredential(''), false);
});

test('random key WITHOUT password marker → false', () => {
  assert.equal(isUserFacingCredential('LOG_LEVEL'), false);
  assert.equal(isUserFacingCredential('NODE_ENV'), false);
  assert.equal(isUserFacingCredential('PORT'), false);
});

test('PASSWORD substring but unrelated word boundary → false', () => {
  // "PASSWORDLESS_TOKEN" is a flow name, not a user-facing password.
  // Our pattern requires word-boundary match (suffix or full match), so it
  // should NOT match. If this changes, callers might generate weak-warning
  // false positives.
  assert.equal(isUserFacingCredential('PASSWORDLESS_TOKEN'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`✗ ${t.name}`);
    console.error(`  ${(err as Error).message}`);
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
