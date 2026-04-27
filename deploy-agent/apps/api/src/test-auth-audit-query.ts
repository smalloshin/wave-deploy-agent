// Round 28b — Tests for auth-audit-query pure helpers.
//
// Mirror of test-discord-audit-query.ts. Closing the symmetry so that
// the auth_audit_log read path has the same test rigor (parser verdict,
// SQL composer, security regression) as its sibling.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  parseAuthAuditQuery,
  buildAuthAuditListSql,
  buildAuthAuditCountSql,
} from './services/auth-audit-query.js';

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

const SAMPLE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SAMPLE_UUID_2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ─── parser: defaults & happy path ─────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({});
  assert(v.kind === 'valid', 'empty input → valid (defaults applied)');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 50, 'default limit = 50');
    assertEq(v.query.offset, 0, 'default offset = 0');
    assertEq(v.query.action, undefined, 'default action = undefined');
    assertEq(v.query.userId, undefined, 'default userId = undefined');
    assertEq(v.query.ipAddress, undefined, 'default ipAddress = undefined');
  }
})();

(() => {
  const v = parseAuthAuditQuery(undefined);
  assert(v.kind === 'valid', 'undefined input → valid (treated as {})');
})();

(() => {
  const v = parseAuthAuditQuery(null);
  assert(v.kind === 'valid', 'null input → valid (treated as {})');
})();

// ─── parser: limit & offset ────────────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({ limit: '25', offset: '50' });
  assert(v.kind === 'valid', 'string-numeric limit/offset coerce to number');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 25, 'limit "25" → 25');
    assertEq(v.query.offset, 50, 'offset "50" → 50');
  }
})();

(() => {
  const v = parseAuthAuditQuery({ limit: 200 });
  assert(v.kind === 'valid', 'limit at upper bound 200 valid');
})();

(() => {
  const v = parseAuthAuditQuery({ limit: 201 });
  assert(v.kind === 'invalid', 'limit 201 → invalid (>200)');
})();

(() => {
  const v = parseAuthAuditQuery({ limit: 0 });
  assert(v.kind === 'invalid', 'limit 0 → invalid (<1)');
})();

(() => {
  const v = parseAuthAuditQuery({ limit: -1 });
  assert(v.kind === 'invalid', 'limit -1 → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ limit: 'abc' });
  assert(v.kind === 'invalid', 'limit "abc" → invalid (NaN coerce)');
})();

(() => {
  const v = parseAuthAuditQuery({ offset: -1 });
  assert(v.kind === 'invalid', 'offset -1 → invalid');
})();

// ─── parser: action regex ──────────────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({ action: 'login' });
  assert(v.kind === 'valid', 'action "login" → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'login_failed' });
  assert(v.kind === 'valid', 'action "login_failed" → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'permission_denied' });
  assert(v.kind === 'valid', 'action "permission_denied" → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'Login' });
  assert(v.kind === 'invalid', 'action "Login" (uppercase) → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'login-failed' });
  assert(v.kind === 'invalid', 'action "login-failed" (hyphen) → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'login123' });
  assert(v.kind === 'invalid', 'action "login123" (digits) → invalid (consistency with discord-audit)');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'a'.repeat(51) });
  assert(v.kind === 'invalid', 'action 51 chars → invalid (column max 50)');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'a'.repeat(50) });
  assert(v.kind === 'valid', 'action exactly 50 chars → valid (boundary)');
})();

// ─── parser: userId UUID ───────────────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({ userId: SAMPLE_UUID });
  assert(v.kind === 'valid', 'valid UUID → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ userId: SAMPLE_UUID.toUpperCase() });
  assert(v.kind === 'valid', 'uppercase UUID → valid (case-insensitive regex)');
})();

(() => {
  const v = parseAuthAuditQuery({ userId: 'not-a-uuid' });
  assert(v.kind === 'invalid', 'userId "not-a-uuid" → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ userId: '550e8400-e29b-41d4-a716' });
  assert(v.kind === 'invalid', 'userId truncated → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ userId: '550e8400e29b41d4a716446655440000' });
  assert(v.kind === 'invalid', 'userId without dashes → invalid');
})();

(() => {
  // SQL injection attempt — single quote should be filtered by regex
  const v = parseAuthAuditQuery({ userId: "'; DROP TABLE users;--" });
  assert(v.kind === 'invalid', "userId SQL injection string → invalid (regex bound)");
})();

// ─── parser: ipAddress ─────────────────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({ ipAddress: '192.168.1.1' });
  assert(v.kind === 'valid', 'ipAddress IPv4 → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: '2001:db8::1' });
  assert(v.kind === 'valid', 'ipAddress IPv6 short → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: 'fe80::1234:5678:9abc:def0' });
  assert(v.kind === 'valid', 'ipAddress IPv6 long → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: 'evil.com' });
  assert(v.kind === 'invalid', 'ipAddress with letters→ invalid (no g-z chars)');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: "'; DROP TABLE--" });
  assert(v.kind === 'invalid', "ipAddress SQL injection → invalid");
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: 'a' });
  assert(v.kind === 'invalid', 'ipAddress 1 char → invalid (min 2)');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: '0'.repeat(46) });
  assert(v.kind === 'invalid', 'ipAddress 46 chars → invalid (max 45)');
})();

// ─── parser: ISO date second-pass ──────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({ since: '2026-01-01T00:00:00Z' });
  assert(v.kind === 'valid', 'since valid ISO → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ since: 'garbage' });
  assert(v.kind === 'invalid', 'since "garbage" → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ since: '2026-13-99' });
  assert(v.kind === 'invalid', 'since "2026-13-99" (impossible date) → invalid');
})();

(() => {
  const v = parseAuthAuditQuery({ until: '2026-12-31T23:59:59Z' });
  assert(v.kind === 'valid', 'until valid ISO → valid');
})();

(() => {
  const v = parseAuthAuditQuery({ since: '', until: '' });
  assert(v.kind === 'valid', 'empty since/until → treated as missing (form UX)');
  if (v.kind === 'valid') {
    assertEq(v.query.sinceIso, undefined, 'empty since → undefined');
    assertEq(v.query.untilIso, undefined, 'empty until → undefined');
  }
})();

(() => {
  const v = parseAuthAuditQuery({
    since: '2026-12-31T23:59:59Z',
    until: '2026-01-01T00:00:00Z',
  });
  assert(v.kind === 'invalid', 'since > until → invalid (no silent empty)');
})();

(() => {
  const v = parseAuthAuditQuery({
    since: '2026-01-01T00:00:00Z',
    until: '2026-01-01T00:00:00Z',
  });
  assert(v.kind === 'valid', 'since == until → valid (boundary)');
})();

// ─── parser: extra unknown keys stripped ───────────────────────────────

(() => {
  const v = parseAuthAuditQuery({ malicious: '<script>', limit: 10 });
  assert(v.kind === 'valid', 'unknown key stripped, limit applied');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 10, 'limit 10 applied');
    assertEq((v.query as unknown as Record<string, unknown>).malicious, undefined, 'malicious key not present');
  }
})();

// ─── parser: combined valid filter ─────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({
    limit: 25,
    offset: 100,
    action: 'login_failed',
    userId: SAMPLE_UUID,
    ipAddress: '10.0.0.1',
    since: '2026-01-01T00:00:00Z',
    until: '2026-12-31T23:59:59Z',
  });
  assert(v.kind === 'valid', 'all filters together → valid');
  if (v.kind === 'valid') {
    assertEq(v.query.action, 'login_failed', 'action passed through');
    assertEq(v.query.userId, SAMPLE_UUID, 'userId passed through');
    assertEq(v.query.ipAddress, '10.0.0.1', 'ipAddress passed through');
    assertEq(v.query.sinceIso, '2026-01-01T00:00:00Z', 'sinceIso passed through');
    assertEq(v.query.untilIso, '2026-12-31T23:59:59Z', 'untilIso passed through');
  }
})();

// ─── buildAuthAuditListSql ─────────────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({});
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(!sql.text.includes('WHERE'), 'no filter → no WHERE clause');
  assert(sql.text.includes('LIMIT $1 OFFSET $2'), 'LIMIT/OFFSET parameter numbering for empty filter');
  assertEq(sql.values, [50, 0], 'values = [limit, offset] when no filter');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'login' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('al.action = $1'), 'action → al.action = $1');
  assert(sql.text.includes('LIMIT $2 OFFSET $3'), 'LIMIT/OFFSET shifted to $2/$3');
  assertEq(sql.values, ['login', 50, 0], 'values include action then limit/offset');
})();

(() => {
  const v = parseAuthAuditQuery({ userId: SAMPLE_UUID });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('al.user_id = $1'), 'userId → al.user_id = $1');
  assertEq(sql.values, [SAMPLE_UUID, 50, 0], 'values include userId');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: '10.0.0.1' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('al.ip_address = $1::inet'), 'ipAddress → INET cast');
  assertEq(sql.values, ['10.0.0.1', 50, 0], 'values include ipAddress');
})();

(() => {
  const v = parseAuthAuditQuery({ since: '2026-01-01T00:00:00Z' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('al.created_at >= $1'), 'since → created_at >= $1');
  assertEq(sql.values, ['2026-01-01T00:00:00Z', 50, 0], 'values include since iso');
})();

(() => {
  const v = parseAuthAuditQuery({ until: '2026-12-31T23:59:59Z' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('al.created_at <= $1'), 'until → created_at <= $1');
})();

(() => {
  const v = parseAuthAuditQuery({
    action: 'login',
    userId: SAMPLE_UUID,
    ipAddress: '10.0.0.1',
    since: '2026-01-01T00:00:00Z',
    until: '2026-12-31T23:59:59Z',
    limit: 10,
    offset: 5,
  });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  // Five filters → $1..$5, then LIMIT $6 OFFSET $7
  assert(sql.text.includes('al.action = $1'), 'multi-filter $1 = action');
  assert(sql.text.includes('al.user_id = $2'), 'multi-filter $2 = userId');
  assert(sql.text.includes('al.ip_address = $3::inet'), 'multi-filter $3 = ipAddress');
  assert(sql.text.includes('al.created_at >= $4'), 'multi-filter $4 = since');
  assert(sql.text.includes('al.created_at <= $5'), 'multi-filter $5 = until');
  assert(sql.text.includes('LIMIT $6 OFFSET $7'), 'LIMIT/OFFSET shift to $6/$7');
  assert(sql.text.includes('AND'), 'multi-filter joins with AND');
  assertEq(sql.values.length, 7, 'values length = 5 filters + limit + offset');
})();

(() => {
  const v = parseAuthAuditQuery({});
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('LEFT JOIN users u ON u.id = al.user_id'),
    'list SQL joins users table for email');
})();

(() => {
  const v = parseAuthAuditQuery({});
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(sql.text.includes('ORDER BY al.created_at DESC'),
    'list SQL orders by created_at DESC');
})();

// ─── buildAuthAuditCountSql ────────────────────────────────────────────

(() => {
  const v = parseAuthAuditQuery({});
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditCountSql(v.query);
  assert(sql.text.includes('COUNT(*)::int'), 'count SQL uses COUNT(*)::int');
  assert(!sql.text.includes('LIMIT'), 'count SQL does not include LIMIT');
  assert(!sql.text.includes('OFFSET'), 'count SQL does not include OFFSET');
  assertEq(sql.values, [], 'count SQL with no filter → empty values');
})();

(() => {
  const v = parseAuthAuditQuery({ action: 'login' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditCountSql(v.query);
  assertEq(sql.values, ['login'], 'count SQL with one filter → one value');
  assert(sql.text.includes('al.action = $1'), 'count SQL where clause matches');
})();

// ─── Security regression: filter values never appear in SQL text ───────

(() => {
  const v = parseAuthAuditQuery({ action: 'login' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(!sql.text.includes("'login'") && !sql.text.includes('"login"'),
    'security: action value not embedded as literal in SQL text');
})();

(() => {
  const v = parseAuthAuditQuery({ userId: SAMPLE_UUID_2 });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(!sql.text.includes(SAMPLE_UUID_2),
    'security: userId value not embedded in SQL text');
})();

(() => {
  const v = parseAuthAuditQuery({ ipAddress: '10.0.0.99' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(!sql.text.includes('10.0.0.99'),
    'security: ipAddress value not embedded in SQL text');
})();

(() => {
  const v = parseAuthAuditQuery({ since: '2026-01-01T00:00:00Z' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildAuthAuditListSql(v.query);
  assert(!sql.text.includes('2026-01-01T00:00:00Z'),
    'security: since iso not embedded in SQL text');
})();

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
