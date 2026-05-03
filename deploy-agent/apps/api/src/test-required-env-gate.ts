/**
 * Tests: required-env-gate (R49)
 *
 * Why this matters:
 *   - decideEnvGate is the LAST gate before we burn Cloud Build minutes.
 *     A bug here either:
 *       - silently lets a deploy through that would have crashed at runtime
 *         (false-negative — costs Cloud Run timeout + user-visible failure)
 *       - blocks a deploy that would have worked (false-positive — operator
 *         is annoyed but no money lost)
 *     We bias hard toward false-positives.
 *   - The auto-gen WHITELIST is intentionally narrow. Any drift here can
 *     silently auto-generate a paired credential (e.g. STRIPE_SECRET_KEY)
 *     and break the integration with no error.
 *
 * What we lock in:
 *   - ok: no required+missing → ok
 *   - autoGenerateSecrets=false → block ALL missing (belt+suspenders)
 *   - whitelist hits: JWT_SECRET, NEXTAUTH_SECRET, SESSION_SECRET, *_SIGNING_KEY,
 *     *_ENCRYPTION_KEY, *_CSRF*SECRET → auto-gen
 *   - denylist hits: PASSWORD, *_API_KEY, *_ACCESS_TOKEN, *_CLIENT_SECRET,
 *     STRIPE_*, OPENAI_*, ANTHROPIC_*, GOOGLE_*, AWS_*, SUPABASE_*, DATABASE_URL,
 *     *_DSN, *_WEBHOOK* → block
 *   - mixed: ANY block-list entry forces ALL to block (block wins)
 *   - unknown semantics → block (we refuse to guess)
 *   - generated values are 64-char hex (32 random bytes)
 *   - case sensitivity: env var names normalize to upper for matching
 *
 * Helpers:
 *   - parseEnvVarKeys: extract Set<string> from string OR record format
 *   - mergeEnvVars: round-trip preserves shape
 *
 * Run: bun run src/test-required-env-gate.ts
 */

import assert from 'node:assert/strict';
import {
  decideEnvGate,
  parseEnvVarKeys,
  mergeEnvVars,
} from './services/required-env-gate.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

console.log('\n=== required-env-gate unit tests ===\n');

// ─── ok path ────────────────────────────────────────────────

test('ok: no refs at all → ok', () => {
  const v = decideEnvGate({
    refs: [],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'ok');
});

test('ok: refs present but all required=false → ok', () => {
  const v = decideEnvGate({
    refs: [
      { name: 'OPTIONAL_A', required: false, source: 'os.getenv' },
      { name: 'OPTIONAL_B', required: false, source: 'os.getenv' },
    ],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'ok');
});

test('ok: required ref provided by user → ok', () => {
  const v = decideEnvGate({
    refs: [{ name: 'JWT_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(['JWT_SECRET']),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'ok');
});

// ─── autoGenerateSecrets=false (kill switch) ─────────────────

test('autoGenerateSecrets=false: even whitelist names → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'JWT_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: false,
  });
  assert.equal(v.kind, 'block');
  if (v.kind !== 'block') throw new Error('unreachable');
  assert.equal(v.missingRequired.length, 1);
  assert.equal(v.missingRequired[0].name, 'JWT_SECRET');
  assert.match(v.missingRequired[0].reason, /auto-gen disabled/);
});

test('autoGenerateSecrets=false: deny-list names → block (clear reason)', () => {
  const v = decideEnvGate({
    refs: [{ name: 'STRIPE_SECRET_KEY', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: false,
  });
  assert.equal(v.kind, 'block');
});

// ─── auto-gen whitelist ─────────────────────────────────────

test('auto-gen: NEXTAUTH_SECRET → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'NEXTAUTH_SECRET', required: true, source: 'pydantic-settings' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
  if (v.kind !== 'auto-generated') throw new Error('unreachable');
  assert.deepEqual(v.names, ['NEXTAUTH_SECRET']);
  assert.equal(v.generated['NEXTAUTH_SECRET'].length, 64); // 32 bytes hex
  assert.match(v.generated['NEXTAUTH_SECRET'], /^[0-9a-f]{64}$/);
});

test('auto-gen: JWT_SECRET → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'JWT_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

test('auto-gen: LUCA_JWT_SECRET (canonical luca-optimizer-kb case) → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'LUCA_JWT_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

test('auto-gen: SESSION_SECRET → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'SESSION_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

test('auto-gen: COOKIE_SIGNING_KEY → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'COOKIE_SIGNING_KEY', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

test('auto-gen: FIELD_ENCRYPTION_KEY → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'FIELD_ENCRYPTION_KEY', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

test('auto-gen: CSRF_SECRET → generated', () => {
  const v = decideEnvGate({
    refs: [{ name: 'CSRF_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

// ─── deny-list (paired creds, never auto-gen) ────────────────

test('deny: STRIPE_SECRET_KEY → block (paired credential)', () => {
  const v = decideEnvGate({
    refs: [{ name: 'STRIPE_SECRET_KEY', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
  if (v.kind !== 'block') throw new Error('unreachable');
  assert.match(v.missingRequired[0].reason, /paired credential/);
});

test('deny: OPENAI_API_KEY → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'OPENAI_API_KEY', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
});

test('deny: DATABASE_URL → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'DATABASE_URL', required: true, source: 'pydantic-settings' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
});

test('deny: SENTRY_DSN → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'SENTRY_DSN', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
});

test('deny: POSTGRES_PASSWORD → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'POSTGRES_PASSWORD', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
});

test('deny: GITHUB_WEBHOOK_SECRET → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'GITHUB_WEBHOOK_SECRET', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
});

// ─── unknown → block ────────────────────────────────────────

test('unknown: random name without whitelist match → block', () => {
  const v = decideEnvGate({
    refs: [{ name: 'CUSTOM_FEATURE_FLAG', required: true, source: 'os.environ' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
  if (v.kind !== 'block') throw new Error('unreachable');
  assert.match(v.missingRequired[0].reason, /not in auto-gen whitelist/);
});

// ─── mixed: block wins ─────────────────────────────────────

test('mixed: one auto-gen + one deny-list → block (block wins)', () => {
  const v = decideEnvGate({
    refs: [
      { name: 'JWT_SECRET', required: true, source: 'os.environ' },
      { name: 'STRIPE_SECRET_KEY', required: true, source: 'os.environ' },
    ],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
  if (v.kind !== 'block') throw new Error('unreachable');
  // Only the deny-list one is in missingRequired (block-wins logic doesn't
  // auto-gen the whitelist one — operator should fix the unfix-able then retry).
  assert.equal(v.missingRequired.length, 1);
  assert.equal(v.missingRequired[0].name, 'STRIPE_SECRET_KEY');
});

test('mixed: unknown + auto-gen → block (block wins)', () => {
  const v = decideEnvGate({
    refs: [
      { name: 'JWT_SECRET', required: true, source: 'os.environ' },
      { name: 'WEIRD_CUSTOM_VAR', required: true, source: 'os.environ' },
    ],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
  if (v.kind !== 'block') throw new Error('unreachable');
  assert.equal(v.missingRequired.length, 1);
  assert.equal(v.missingRequired[0].name, 'WEIRD_CUSTOM_VAR');
});

// ─── case sensitivity ────────────────────────────────────────

test('case: lowercase jwt_secret in name still hits whitelist (uppercase match)', () => {
  // Env-var names are conventionally upper, but be defensive: refs from
  // python-env-extractor may give lowercase Pydantic field names if our
  // upcasing step ever has a bug. Match should be case-INSENSITIVE.
  const v = decideEnvGate({
    refs: [{ name: 'jwt_secret', required: true, source: 'pydantic-settings' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'auto-generated');
});

// ─── parseEnvVarKeys ─────────────────────────────────────────

test('parseEnvVarKeys: undefined → empty set', () => {
  assert.equal(parseEnvVarKeys(undefined).size, 0);
});

test('parseEnvVarKeys: null → empty set', () => {
  assert.equal(parseEnvVarKeys(null).size, 0);
});

test('parseEnvVarKeys: empty string → empty set', () => {
  assert.equal(parseEnvVarKeys('').size, 0);
});

test('parseEnvVarKeys: KEY=VALUE\\nKEY2=VALUE2 string → {KEY,KEY2}', () => {
  const keys = parseEnvVarKeys('KEY=value\nKEY2=value2');
  assert.ok(keys.has('KEY'));
  assert.ok(keys.has('KEY2'));
  assert.equal(keys.size, 2);
});

test('parseEnvVarKeys: skips comments and blanks', () => {
  const keys = parseEnvVarKeys('# comment\nKEY=value\n\nKEY2=value2\n#KEY3=value3');
  assert.equal(keys.size, 2);
  assert.ok(keys.has('KEY'));
  assert.ok(keys.has('KEY2'));
  assert.ok(!keys.has('KEY3'));
});

test('parseEnvVarKeys: record format → all keys', () => {
  const keys = parseEnvVarKeys({ A: '1', B: '2', C: '3' });
  assert.equal(keys.size, 3);
  assert.ok(keys.has('A'));
  assert.ok(keys.has('B'));
  assert.ok(keys.has('C'));
});

test('parseEnvVarKeys: handles CRLF line endings', () => {
  const keys = parseEnvVarKeys('A=1\r\nB=2\r\n');
  assert.equal(keys.size, 2);
});

// ─── mergeEnvVars ────────────────────────────────────────────

test('mergeEnvVars: record → record, new wins', () => {
  const merged = mergeEnvVars({ A: '1', B: '2' }, { B: 'new', C: '3' });
  assert.deepEqual(merged, { A: '1', B: 'new', C: '3' });
});

test('mergeEnvVars: string → string, new wins', () => {
  const merged = mergeEnvVars('A=1\nB=2', { B: 'new', C: '3' });
  assert.equal(typeof merged, 'string');
  const keys = parseEnvVarKeys(merged as string);
  assert.equal(keys.size, 3);
  assert.ok((merged as string).includes('B=new'));
  assert.ok((merged as string).includes('C=3'));
});

test('mergeEnvVars: undefined existing → record output', () => {
  const merged = mergeEnvVars(undefined, { A: '1' });
  assert.deepEqual(merged, { A: '1' });
});

test('mergeEnvVars: null existing → record output', () => {
  const merged = mergeEnvVars(null, { A: '1' });
  assert.deepEqual(merged, { A: '1' });
});

// ─── R52: Secret Manager source always blocks ────────────────────

test('R52: Secret Manager source ALWAYS blocks even when name matches whitelist', () => {
  // erp-jwt-secret matches *JWT*SECRET* (auto-gen whitelist) by name,
  // but its source is secret-manager — auto-gen would put value in env vars
  // which the app never reads. Always block.
  const v = decideEnvGate({
    refs: [{ name: 'erp-jwt-secret', required: true, source: 'secret-manager' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,  // even with auto-gen ON, secret-manager still blocks
  });
  assert.equal(v.kind, 'block');
  if (v.kind === 'block') {
    assert.equal(v.missingRequired.length, 1);
    assert.equal(v.missingRequired[0].name, 'erp-jwt-secret');
    assert.match(v.missingRequired[0].reason, /Secret Manager/);
    assert.match(v.missingRequired[0].hint, /gcloud secrets create/);
    assert.match(v.missingRequired[0].hint, /erp-jwt-secret/);
  }
});

test('R52: Secret Manager source name matching deny list ALSO blocks (with secret-manager hint, not deny hint)', () => {
  // STRIPE_SECRET_KEY matches both deny list AND happens to be in secret-manager source.
  // Secret-manager check fires FIRST, so user gets the actionable gcloud hint.
  const v = decideEnvGate({
    refs: [{ name: 'STRIPE_SECRET_KEY', required: true, source: 'secret-manager' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
  if (v.kind === 'block') {
    assert.match(v.missingRequired[0].hint, /gcloud secrets create/);
  }
});

test('R52: Secret Manager source mixed with os.environ → both reported', () => {
  const v = decideEnvGate({
    refs: [
      { name: 'erp-jwt-secret', required: true, source: 'secret-manager' },
      { name: 'STRIPE_SECRET_KEY', required: true, source: 'os.environ' },
    ],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: true,
  });
  assert.equal(v.kind, 'block');
  if (v.kind === 'block') {
    assert.equal(v.missingRequired.length, 2);
    const names = v.missingRequired.map((m) => m.name).sort();
    assert.deepEqual(names, ['STRIPE_SECRET_KEY', 'erp-jwt-secret']);
  }
});

test('R52: Secret Manager with autoGenerateSecrets=false also blocks (no regression)', () => {
  const v = decideEnvGate({
    refs: [{ name: 'JWT_SECRET', required: true, source: 'secret-manager' }],
    userProvidedKeys: new Set(),
    autoGenerateSecrets: false,
  });
  assert.equal(v.kind, 'block');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
