/**
 * Tests: settings-service (R45 — review gate toggle)
 *
 * The pipeline-worker reads `requireReview` from the settings table on
 * every run to decide whether to stop at review_pending or auto-approve.
 * If parseRuntimeSettings ever returns the wrong value (or throws), the
 * gate is silently broken — either auto-approving when it shouldn't or
 * stalling forever when the operator wanted speed.
 *
 * Locks the parser shape end-to-end:
 *   - missing row → defaults (requireReview=true, the safe direction)
 *   - boolean false / true → respected
 *   - non-boolean garbage → fall back to default (defensive)
 *   - JSON string round-trip (the column is JSONB but pg sometimes hands
 *     it back as a string in older drivers / edge configs)
 *   - malformed JSON string → defaults
 *
 * Run: bun run src/test-settings-service.ts
 */

import assert from 'node:assert/strict';
import { parseRuntimeSettings, RUNTIME_DEFAULTS } from './services/settings-service';

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

console.log('\n=== settings-service.parseRuntimeSettings ===\n');

test('undefined row → defaults (requireReview=true)', () => {
  assert.equal(parseRuntimeSettings(undefined).requireReview, true);
});

test('null row → defaults', () => {
  assert.equal(parseRuntimeSettings(null).requireReview, true);
});

test('empty object → defaults', () => {
  assert.equal(parseRuntimeSettings({}).requireReview, true);
});

test('object with requireReview=false → false', () => {
  assert.equal(parseRuntimeSettings({ requireReview: false }).requireReview, false);
});

test('object with requireReview=true → true', () => {
  assert.equal(parseRuntimeSettings({ requireReview: true }).requireReview, true);
});

test('non-boolean requireReview falls back to default', () => {
  // String "false" is a common foot-gun — treat as malformed and ignore.
  assert.equal(parseRuntimeSettings({ requireReview: 'false' }).requireReview, true);
  assert.equal(parseRuntimeSettings({ requireReview: 0 }).requireReview, true);
  assert.equal(parseRuntimeSettings({ requireReview: null }).requireReview, true);
});

test('JSON string with requireReview=false → false', () => {
  assert.equal(parseRuntimeSettings('{"requireReview":false}').requireReview, false);
});

test('malformed JSON string → defaults', () => {
  assert.equal(parseRuntimeSettings('{not-json').requireReview, true);
});

test('JSON string with unrelated keys → defaults', () => {
  assert.equal(parseRuntimeSettings('{"gcpProject":"foo"}').requireReview, true);
});

test('RUNTIME_DEFAULTS is true (safe direction — review-on by default)', () => {
  assert.equal(RUNTIME_DEFAULTS.requireReview, true);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
