/**
 * Pure-function tests for name-confirm-verdict.ts (Round 26 Item #6).
 * Run via: bun src/test-name-confirm-verdict.ts
 */

import { verifyNameMatch } from './name-confirm-verdict.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, reason = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.error(`FAIL: ${name}: ${reason}`);
  }
}

// 1. exact match → match
(() => {
  const v = verifyNameMatch('foo', 'foo');
  check('exact match → match', v.kind === 'match', `got ${v.kind}`);
})();

// 2. mismatch → mismatch
(() => {
  const v = verifyNameMatch('foo', 'bar');
  check('mismatch → mismatch', v.kind === 'mismatch', `got ${v.kind}`);
})();

// 3. empty typed → empty
(() => {
  const v = verifyNameMatch('', 'foo');
  check('empty typed → empty', v.kind === 'empty', `got ${v.kind}`);
})();

// 4. whitespace-only typed → empty
(() => {
  const v = verifyNameMatch('   ', 'foo');
  check('whitespace-only typed → empty (trim)', v.kind === 'empty', `got ${v.kind}`);
})();

// 5. leading/trailing whitespace on typed → trimmed → match
(() => {
  const v = verifyNameMatch('  foo  ', 'foo');
  check('leading/trailing whitespace trims to match',
    v.kind === 'match', `got ${v.kind}`);
})();

// 6. case sensitivity: 'Foo' vs 'foo' → mismatch
(() => {
  const v = verifyNameMatch('Foo', 'foo');
  check('case-sensitive: "Foo" vs "foo" → mismatch',
    v.kind === 'mismatch', `got ${v.kind}`);
})();

// 7. empty expected (defensive): typed non-empty → mismatch
(() => {
  const v = verifyNameMatch('foo', '');
  check('empty expected, non-empty typed → mismatch',
    v.kind === 'mismatch', `got ${v.kind}`);
})();

// 7b. both empty → empty (typed is empty, return empty before comparing)
(() => {
  const v = verifyNameMatch('', '');
  check('both empty → empty (typed wins the order check)',
    v.kind === 'empty', `got ${v.kind}`);
})();

// 8. special chars in slug
(() => {
  const v = verifyNameMatch('foo-bar_baz', 'foo-bar_baz');
  check('special chars (- _) in slug → match',
    v.kind === 'match', `got ${v.kind}`);
})();

// 9. unicode/CJK in slug
(() => {
  const v = verifyNameMatch('專案', '專案');
  check('CJK chars match → match', v.kind === 'match', `got ${v.kind}`);
})();

// 10. very long names that match
(() => {
  const longName = 'a'.repeat(500);
  const v = verifyNameMatch(longName, longName);
  check('very long name matches → match', v.kind === 'match', `got ${v.kind}`);
})();

// 11. very long names that mismatch by one char
(() => {
  const a = 'a'.repeat(500);
  const b = 'a'.repeat(499) + 'b';
  const v = verifyNameMatch(a, b);
  check('long names differing by 1 char → mismatch',
    v.kind === 'mismatch', `got ${v.kind}`);
})();

// 12. tab-only typed → empty
(() => {
  const v = verifyNameMatch('\t\t\n', 'foo');
  check('tab+newline-only typed → empty',
    v.kind === 'empty', `got ${v.kind}`);
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
