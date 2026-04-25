/**
 * Tests: safe-number coercion helpers.
 *
 * These exist to enforce the contract documented in utils/safe-number.ts:
 *   - NaN never escapes the helper
 *   - empty / whitespace strings → fallback (not 0!)
 *   - clamp bounds inclusive, applied after fallback
 *   - safeBytes never returns negative
 *   - safeParsePort rejects out-of-range / non-integer
 *
 * Same class of bug as the 2026-04-25 split(':') route-key truncation: silent
 * coercion failures that pass type-check but produce wrong runtime values.
 * Make the boundary explicit, lock it down with tests.
 *
 * Run: tsx src/test-safe-number.ts
 */

import assert from 'node:assert/strict';
import { safeNumber, safePositiveInt, safeBytes, safeParsePort } from './utils/safe-number.js';

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

console.log('\n=== safe-number unit tests ===\n');

// ─── safeNumber ─────────────────────────────────────────────

test('safeNumber: number passthrough', () => {
  assert.equal(safeNumber(42, 0), 42);
  assert.equal(safeNumber(0, 99), 0);
  assert.equal(safeNumber(-7.5, 0), -7.5);
});

test('safeNumber: numeric string parsed', () => {
  assert.equal(safeNumber('42', 0), 42);
  assert.equal(safeNumber('  42  ', 0), 42);
  assert.equal(safeNumber('-3.14', 0), -3.14);
  assert.equal(safeNumber('1e3', 0), 1000);
});

test('safeNumber: bad strings → fallback', () => {
  assert.equal(safeNumber('abc', 99), 99);
  assert.equal(safeNumber('1.2.3', 99), 99);
  assert.equal(safeNumber('NaN', 99), 99);
});

test('safeNumber: empty / whitespace → fallback (not 0)', () => {
  assert.equal(safeNumber('', 99), 99);
  assert.equal(safeNumber('   ', 99), 99);
  assert.equal(safeNumber('\t\n', 99), 99);
});

test('safeNumber: NaN / Infinity → fallback', () => {
  assert.equal(safeNumber(NaN, 99), 99);
  assert.equal(safeNumber(Infinity, 99), 99);
  assert.equal(safeNumber(-Infinity, 99), 99);
});

test('safeNumber: null / undefined / object / boolean → fallback', () => {
  assert.equal(safeNumber(null, 99), 99);
  assert.equal(safeNumber(undefined, 99), 99);
  assert.equal(safeNumber({}, 99), 99);
  assert.equal(safeNumber([], 99), 99);
  assert.equal(safeNumber(true, 99), 99);
  assert.equal(safeNumber(false, 99), 99);
});

test('safeNumber: bigint coerced', () => {
  assert.equal(safeNumber(42n, 0), 42);
  assert.equal(safeNumber(0n, 99), 0);
});

test('safeNumber: clamp min', () => {
  assert.equal(safeNumber(5, 0, { min: 10 }), 10);
  assert.equal(safeNumber(15, 0, { min: 10 }), 15);
  assert.equal(safeNumber('bad', 5, { min: 10 }), 10); // fallback then clamped
});

test('safeNumber: clamp max', () => {
  assert.equal(safeNumber(50, 0, { max: 10 }), 10);
  assert.equal(safeNumber(5, 0, { max: 10 }), 5);
});

test('safeNumber: clamp both bounds', () => {
  assert.equal(safeNumber(5, 0, { min: 1, max: 10 }), 5);
  assert.equal(safeNumber(0, 0, { min: 1, max: 10 }), 1);
  assert.equal(safeNumber(99, 0, { min: 1, max: 10 }), 10);
});

// ─── safePositiveInt ────────────────────────────────────────

test('safePositiveInt: positive int passthrough', () => {
  assert.equal(safePositiveInt(42, 1), 42);
  assert.equal(safePositiveInt('42', 1), 42);
});

test('safePositiveInt: zero → fallback', () => {
  assert.equal(safePositiveInt(0, 7), 7);
  assert.equal(safePositiveInt('0', 7), 7);
});

test('safePositiveInt: negative → fallback', () => {
  assert.equal(safePositiveInt(-3, 7), 7);
  assert.equal(safePositiveInt('-3', 7), 7);
});

test('safePositiveInt: truncates toward zero', () => {
  assert.equal(safePositiveInt(3.9, 1), 3);
  assert.equal(safePositiveInt('3.9', 1), 3);
});

test('safePositiveInt: NaN / undefined / "abc" → fallback', () => {
  assert.equal(safePositiveInt('abc', 7), 7);
  assert.equal(safePositiveInt(undefined, 7), 7);
  assert.equal(safePositiveInt(NaN, 7), 7);
});

test('safePositiveInt: cap respects max', () => {
  assert.equal(safePositiveInt(5000, 100, { max: 1000 }), 1000);
  assert.equal(safePositiveInt('5000', 100, { max: 1000 }), 1000);
});

test('safePositiveInt: this is the routes/auth.ts:294 audit-log limit case', () => {
  // ?limit=abc — must not produce NaN
  assert.equal(safePositiveInt('abc', 100, { max: 1000 }), 100);
  // ?limit= (empty)
  assert.equal(safePositiveInt('', 100, { max: 1000 }), 100);
  // ?limit=0
  assert.equal(safePositiveInt('0', 100, { max: 1000 }), 100);
  // ?limit=99999 — must clamp
  assert.equal(safePositiveInt('99999', 100, { max: 1000 }), 1000);
  // valid
  assert.equal(safePositiveInt('250', 100, { max: 1000 }), 250);
});

// ─── safeBytes ──────────────────────────────────────────────

test('safeBytes: numeric string parsed', () => {
  assert.equal(safeBytes('1024'), 1024);
  assert.equal(safeBytes(1024), 1024);
});

test('safeBytes: undefined / null → 0 (not NaN)', () => {
  assert.equal(safeBytes(undefined), 0);
  assert.equal(safeBytes(null), 0);
});

test('safeBytes: bad string → 0', () => {
  assert.equal(safeBytes('abc'), 0);
  assert.equal(safeBytes(''), 0);
});

test('safeBytes: negative → 0', () => {
  assert.equal(safeBytes(-100), 0);
  assert.equal(safeBytes('-100'), 0);
});

test('safeBytes: this is the routes/infra.ts accumulator case', () => {
  // arr.reduce((s, x) => s + safeBytes(x.size), 0) must never become NaN
  const objs = [
    { size: '100' },
    { size: undefined },
    { size: 'corrupted' },
    { size: '50' },
  ];
  const total = objs.reduce((s, o) => s + safeBytes(o.size), 0);
  assert.equal(total, 150);
  assert.ok(Number.isFinite(total));
});

// ─── safeParsePort ──────────────────────────────────────────

test('safeParsePort: valid ports', () => {
  assert.equal(safeParsePort(80), 80);
  assert.equal(safeParsePort('80'), 80);
  assert.equal(safeParsePort('3000'), 3000);
  assert.equal(safeParsePort(65535), 65535);
  assert.equal(safeParsePort(1), 1);
});

test('safeParsePort: out-of-range → null', () => {
  assert.equal(safeParsePort(0), null);
  assert.equal(safeParsePort(-1), null);
  assert.equal(safeParsePort(65536), null);
  assert.equal(safeParsePort(99999999), null);
});

test('safeParsePort: non-integer → null', () => {
  assert.equal(safeParsePort(80.5), null);
  assert.equal(safeParsePort('80.5'), null);
});

test('safeParsePort: bad input → null', () => {
  assert.equal(safeParsePort('abc'), null);
  assert.equal(safeParsePort(undefined), null);
  assert.equal(safeParsePort(null), null);
  assert.equal(safeParsePort(''), null);
  assert.equal(safeParsePort(NaN), null);
});

test('safeParsePort: this is the Dockerfile EXPOSE case', () => {
  // Regex `(\d+)` always captures digits, but the captured int could be huge.
  // Old code: parseInt → assigns 99999999 → Cloud Run reject
  // New code: safeParsePort → null → caller falls back to default
  assert.equal(safeParsePort('99999999'), null);
  assert.equal(safeParsePort('3000'), 3000);
});

// ─── done ──────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
