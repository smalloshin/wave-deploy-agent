/**
 * Tests: safeParseJson from scanner.ts
 *
 * What this proves:
 *   - Valid JSON parses normally
 *   - Garbage input returns null (does NOT throw)
 *   - Truncated JSON returns null (the maxBuffer-overflow case)
 *   - Empty string returns null (subprocess wrote nothing, e.g. silent crash)
 *   - Non-JSON noise (OOM message, banner, binary blob) returns null
 *   - The error log includes a stdout preview for debugging
 *   - The tool label appears in the log so we know which scanner failed
 *
 * Why this matters: before this change, `JSON.parse(stdout)` was unguarded for
 * the trivy happy path (scanner.ts:72) and the semgrep happy path (line 27).
 * A non-JSON stdout from either tool produced an uncaught SyntaxError →
 * unhandledRejection → pod restart → project stuck in 'scanning'. The fix
 * lets scan return empty findings on parse failure so the security review
 * still proceeds.
 *
 * Run: tsx src/test-scanner-safe-parse.ts
 */

import assert from 'node:assert/strict';
import { safeParseJson } from './services/scanner.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    // Write FAIL output directly to stderr (NOT console.error) — we mock
    // console.error below to capture safeParseJson's logs and don't want
    // failures to be swallowed.
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${(err as Error).message}\n`);
    failed++;
  }
}

// ─── Capture console.error to assert on safeParseJson's log lines ───
const originalError = console.error;
const errMessages: string[] = [];
console.error = (msg: unknown) => {
  if (typeof msg === 'string') errMessages.push(msg);
};
function clearErrs() {
  errMessages.length = 0;
}

console.log('\n=== safeParseJson unit tests ===\n');

test('valid JSON object parses normally + no error log', () => {
  clearErrs();
  const result = safeParseJson('{"results": [{"id": 1}]}', 'semgrep');
  assert.deepEqual(result, { results: [{ id: 1 }] });
  assert.equal(errMessages.length, 0);
});

test('valid empty JSON object parses to {}', () => {
  clearErrs();
  const result = safeParseJson('{}', 'trivy');
  assert.deepEqual(result, {});
  assert.equal(errMessages.length, 0);
});

test('garbage input returns null (does NOT throw)', () => {
  clearErrs();
  const result = safeParseJson('not json at all', 'semgrep');
  assert.equal(result, null);
  assert.equal(errMessages.length, 1, 'should log one error line');
});

test('empty string returns null (silent crash case)', () => {
  clearErrs();
  const result = safeParseJson('', 'trivy');
  assert.equal(result, null);
  assert.equal(errMessages.length, 1);
});

test('truncated JSON returns null (maxBuffer overflow case)', () => {
  // Real-world: trivy writing 60MB of JSON, hitting the 50MB maxBuffer cap
  // mid-object. Result is a half-written JSON string that JSON.parse rejects.
  clearErrs();
  const truncated = '{"Results": [{"Target": "package.json", "Vuln';
  const result = safeParseJson(truncated, 'trivy');
  assert.equal(result, null);
});

test('OOM-style stderr leak returns null', () => {
  // Real-world: trivy runs out of memory, dumps a Go panic stack to stdout.
  clearErrs();
  const oom = `runtime: out of memory: cannot allocate 1048576-byte block (137363456 in use)
fatal error: out of memory

goroutine 1 [running]:
runtime.throw({0x2, 0x42})
	/usr/local/go/src/runtime/panic.go:1198 +0x71`;
  const result = safeParseJson(oom, 'trivy');
  assert.equal(result, null);
});

test('binary noise returns null', () => {
  clearErrs();
  // Simulating a partial binary blob mixed with text
  const binaryish = '\x00\x01\x02\x03 something \xff\xfe';
  const result = safeParseJson(binaryish, 'trivy');
  assert.equal(result, null);
});

test('error log includes the tool label (helps grep production logs)', () => {
  clearErrs();
  safeParseJson('garbage', 'semgrep');
  assert.equal(errMessages.length, 1);
  assert.ok(errMessages[0].includes('[semgrep]'),
    `error should include tool label; got: ${errMessages[0]}`);
});

test('error log includes stdout preview (first 200 chars, whitespace collapsed)', () => {
  clearErrs();
  const longGarbage = 'no\n\n  json   here\t' + 'x'.repeat(500);
  safeParseJson(longGarbage, 'trivy');
  assert.ok(errMessages[0].includes('preview:'),
    'error should label the preview section');
  // Whitespace should be collapsed to single spaces
  assert.ok(!errMessages[0].includes('\n\n'),
    'preview should not have raw newlines');
});

test('valid JSON array parses normally', () => {
  clearErrs();
  const result = safeParseJson('[1,2,3]', 'semgrep');
  assert.deepEqual(result, [1, 2, 3]);
});

test('null literal parses to null (NOT an error case — explicit null)', () => {
  clearErrs();
  const result = safeParseJson('null', 'trivy');
  assert.equal(result, null);
  // We DO get null back, but the caller should treat that as "valid empty"
  // not "parse failed". The error log distinguishes — no log here.
  assert.equal(errMessages.length, 0,
    'JSON null is valid; should not log error');
});

// ─── restore ───
console.error = originalError;

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
