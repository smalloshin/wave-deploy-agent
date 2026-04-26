// Round 27 — Tests for discord-audit-cleanup pure helpers.
//
// We only test `clampRetentionDays` here. `cleanupDiscordAudit`,
// `runDiscordAuditCleanupOnce`, `startDiscordAuditCleanup` all touch the DB
// and/or setInterval — those are integration-level (start with the live
// Postgres test seam used by test-auth-cleanup.ts) and are skipped from the
// zero-dep sweep.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import { clampRetentionDays } from './services/discord-audit-cleanup.js';

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

// ─── Happy path ───────────────────────────────────────────────────────

assertEq(clampRetentionDays(180, 180), 180, 'clamp: 180 → 180');
assertEq(clampRetentionDays(7, 180), 7, 'clamp: 7 (lower bound) → 7');
assertEq(clampRetentionDays(3650, 180), 3650, 'clamp: 3650 (upper bound) → 3650');
assertEq(clampRetentionDays(365, 180), 365, 'clamp: 365 → 365');

// ─── Below-floor coercion ─────────────────────────────────────────────

assertEq(clampRetentionDays(0, 180), 7, 'clamp: 0 → floor 7');
assertEq(clampRetentionDays(1, 180), 7, 'clamp: 1 → floor 7');
assertEq(clampRetentionDays(6, 180), 7, 'clamp: 6 → floor 7');
assertEq(clampRetentionDays(-100, 180), 7, 'clamp: -100 → floor 7');

// ─── Above-ceiling coercion ───────────────────────────────────────────

assertEq(clampRetentionDays(3651, 180), 3650, 'clamp: 3651 → ceil 3650');
assertEq(clampRetentionDays(99999, 180), 3650, 'clamp: 99999 → ceil 3650');
assertEq(clampRetentionDays(Number.MAX_SAFE_INTEGER, 180), 3650, 'clamp: MAX_SAFE_INTEGER → ceil 3650');

// ─── Decimal truncation ───────────────────────────────────────────────

assertEq(clampRetentionDays(7.9, 180), 7, 'clamp: 7.9 truncates to 7');
assertEq(clampRetentionDays(180.5, 180), 180, 'clamp: 180.5 truncates to 180');
assertEq(clampRetentionDays(6.9, 180), 7, 'clamp: 6.9 truncates to 6 then floors to 7');
assertEq(clampRetentionDays(3650.1, 180), 3650, 'clamp: 3650.1 truncates to 3650');

// ─── Bad input → defaultDays then clamp ──────────────────────────────

assertEq(clampRetentionDays('garbage', 180), 180, 'clamp: garbage string → default 180');
assertEq(clampRetentionDays(null, 180), 180, 'clamp: null → default 180');
assertEq(clampRetentionDays(undefined, 180), 180, 'clamp: undefined → default 180');
assertEq(clampRetentionDays({}, 180), 180, 'clamp: object → default 180');
assertEq(clampRetentionDays([], 180), 180, 'clamp: array → default 180');
assertEq(clampRetentionDays(NaN, 180), 180, 'clamp: NaN → default 180');
assertEq(clampRetentionDays(Infinity, 180), 180, 'clamp: Infinity → default 180');
assertEq(clampRetentionDays(-Infinity, 180), 180, 'clamp: -Infinity → default 180');

// ─── String numerics (env vars are strings) ───────────────────────────

assertEq(clampRetentionDays('30', 180), 30, 'clamp: "30" → 30 (env var pattern)');
assertEq(clampRetentionDays('180', 180), 180, 'clamp: "180" → 180');
assertEq(clampRetentionDays('5', 180), 7, 'clamp: "5" → floor 7');
assertEq(clampRetentionDays('99999', 180), 3650, 'clamp: "99999" → ceil 3650');
assertEq(clampRetentionDays('  ', 180), 180, 'clamp: whitespace string → default 180');

// ─── Default-default = 180 (no second arg) ────────────────────────────

assertEq(clampRetentionDays('garbage'), 180, 'clamp: default arg is 180');
assertEq(clampRetentionDays(null), 180, 'clamp: null + default arg → 180');
assertEq(clampRetentionDays(60), 60, 'clamp: 60 with default 180 unchanged');

// ─── Custom default value respected ──────────────────────────────────

assertEq(clampRetentionDays(null, 90), 90, 'clamp: custom default 90');
assertEq(clampRetentionDays('garbage', 30), 30, 'clamp: custom default 30');
assertEq(clampRetentionDays(undefined, 365), 365, 'clamp: custom default 365');

// ─── Default itself gets clamped ──────────────────────────────────────
// If the operator passes a default outside the range, what should happen?
// Note: per impl, defaultDays is only used as fallback inside safeNumber; the
// truncated value still goes through the [7, 3650] clamp. So a default of 5
// would clamp UP to 7.
assertEq(clampRetentionDays(null, 5), 7, 'clamp: silly default 5 still floored to 7');
assertEq(clampRetentionDays(null, 5000), 3650, 'clamp: silly default 5000 still ceiled to 3650');

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
