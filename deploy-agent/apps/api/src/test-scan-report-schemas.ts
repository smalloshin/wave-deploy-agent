/**
 * Tests: parseFindings / parseAutoFixes from schemas/scan-report.ts
 *
 * What this proves:
 *   - Valid items are passed through untouched
 *   - Malformed items are dropped (not throwing) with a warn log
 *   - Mixed-validity arrays return only the valid subset
 *   - severity/action enum drift (lowercased, abbreviated, missing) is rejected
 *   - Missing required fields rejected; missing optional fields tolerated
 *   - Empty input arrays handled cleanly
 *
 * Why this matters: orchestrator.ts:rowToScanReport reads findings from DB JSON
 * columns. Before zod validation, any drift (LLM output, schema migration,
 * partial UPSERT) propagated undetected to the UI. Now drift drops the bad row
 * with a server log; the rest of the report still renders.
 *
 * Run: tsx src/test-scan-report-schemas.ts
 */

import assert from 'node:assert/strict';
import { parseFindings, parseAutoFixes } from './schemas/scan-report.js';

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

// ─── Capture console.warn so test output isn't polluted ─────────
const originalWarn = console.warn;
const warnMessages: string[] = [];
console.warn = (msg: unknown) => {
  if (typeof msg === 'string') warnMessages.push(msg);
};
function clearWarns() {
  warnMessages.length = 0;
}

console.log('\n=== parseFindings unit tests ===\n');

const validFinding = {
  id: 'semgrep-0',
  tool: 'semgrep' as const,
  category: 'injection',
  severity: 'high' as const,
  title: 'SQL injection risk',
  description: 'User input flows into raw query',
  filePath: 'src/api/users.ts',
  lineStart: 42,
  lineEnd: 42,
  action: 'auto_fix' as const,
};

test('valid finding passes through untouched', () => {
  clearWarns();
  const result = parseFindings([validFinding], 'test');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], validFinding);
  assert.equal(warnMessages.length, 0, 'should not warn on valid input');
});

test('empty array returns empty array', () => {
  clearWarns();
  const result = parseFindings([], 'test');
  assert.deepEqual(result, []);
  assert.equal(warnMessages.length, 0);
});

test('finding with missing severity is dropped + warned', () => {
  clearWarns();
  const broken = { ...validFinding } as Record<string, unknown>;
  delete broken.severity;
  const result = parseFindings([broken], 'test');
  assert.equal(result.length, 0, 'invalid finding should be dropped');
  assert.equal(warnMessages.length, 1, 'should emit one warn line');
  assert.ok(warnMessages[0].includes('severity'),
    `warn should name the bad field; got: ${warnMessages[0]}`);
});

test('finding with WARNING (uppercase) severity is dropped (drift detection)', () => {
  // mapSemgrepSeverity normalizes 'WARNING' → 'high' before INSERT, so this
  // should never happen for fresh rows. But OLD rows or LLM rows might leak
  // raw values. Schema rejects them so the UI doesn't render `severity: 'WARNING'`.
  clearWarns();
  const broken = { ...validFinding, severity: 'WARNING' };
  const result = parseFindings([broken], 'test');
  assert.equal(result.length, 0);
  assert.equal(warnMessages.length, 1);
});

test('finding with bogus tool value is dropped', () => {
  clearWarns();
  const broken = { ...validFinding, tool: 'snyk' };
  const result = parseFindings([broken], 'test');
  assert.equal(result.length, 0);
  assert.equal(warnMessages.length, 1);
});

test('finding with NaN lineStart is dropped (would crash UI math)', () => {
  clearWarns();
  const broken = { ...validFinding, lineStart: NaN };
  const result = parseFindings([broken], 'test');
  assert.equal(result.length, 0,
    'NaN must be rejected — z.number().finite() catches it');
});

test('finding with optional `fix` field present is accepted', () => {
  clearWarns();
  const withFix = {
    ...validFinding,
    fix: {
      applied: true,
      diff: '@@ -1 +1 @@',
      explanation: 'Replaced raw SQL with parameterised query',
      verificationPassed: true,
    },
  };
  const result = parseFindings([withFix], 'test');
  assert.equal(result.length, 1);
  assert.equal(result[0].fix?.applied, true);
});

test('mixed valid + invalid: only valid pass, count of warns matches drops', () => {
  clearWarns();
  const broken1 = { ...validFinding, severity: 'super-bad' };
  const broken2 = { ...validFinding, lineEnd: 'forty-two' };
  const result = parseFindings(
    [validFinding, broken1, validFinding, broken2, validFinding],
    'test',
  );
  assert.equal(result.length, 3, 'three valid items survive');
  assert.equal(warnMessages.length, 2, 'two drops → two warns');
});

test('non-object input (string, number, null) is dropped', () => {
  clearWarns();
  const result = parseFindings(
    ['just a string', 42, null, undefined, validFinding] as unknown[],
    'test',
  );
  assert.equal(result.length, 1, 'only the valid object survives');
  assert.equal(warnMessages.length, 4);
});

test('context label appears in warn message (helps grep)', () => {
  clearWarns();
  parseFindings([{ wrong: true }], 'my-context-label');
  assert.ok(warnMessages[0].includes('my-context-label'),
    `warn should include context; got: ${warnMessages[0]}`);
});

console.log('\n=== parseAutoFixes unit tests ===\n');

test('valid AutoFixRecord (only required field) passes', () => {
  clearWarns();
  const valid = { explanation: 'Replaced foo with bar' };
  const result = parseAutoFixes([valid], 'test');
  assert.equal(result.length, 1);
  assert.equal(result[0].explanation, 'Replaced foo with bar');
});

test('valid AutoFixRecord with all optional fields passes', () => {
  clearWarns();
  const valid = {
    findingId: 'semgrep-3',
    filePath: 'src/foo.ts',
    originalCode: 'const x = userInput;',
    fixedCode: 'const x = sanitize(userInput);',
    explanation: 'Sanitize untrusted input',
    applied: true,
    diff: '@@ ...',
  };
  const result = parseAutoFixes([valid], 'test');
  assert.equal(result.length, 1);
  assert.equal(result[0].findingId, 'semgrep-3');
});

test('AutoFixRecord missing explanation is dropped', () => {
  clearWarns();
  const broken = { findingId: 'foo', applied: true };
  const result = parseAutoFixes([broken], 'test');
  assert.equal(result.length, 0);
  assert.equal(warnMessages.length, 1);
  assert.ok(warnMessages[0].includes('explanation'));
});

test('AutoFixRecord with non-string explanation is dropped', () => {
  clearWarns();
  const broken = { explanation: 42 };
  const result = parseAutoFixes([broken], 'test');
  assert.equal(result.length, 0);
});

test('mixed valid + invalid auto-fixes: valid subset returned', () => {
  clearWarns();
  const valid = { explanation: 'good' };
  const broken = { findingId: 'no-explanation' };
  const result = parseAutoFixes([valid, broken, valid], 'test');
  assert.equal(result.length, 2);
});

// ─── restore ───
console.warn = originalWarn;

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
