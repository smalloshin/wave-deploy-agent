/**
 * Pure-function tests for discord-allowlist-verdict.ts (Round 26 Item #1).
 *
 * Zero external test runner. Run via: bun src/test-discord-allowlist-verdict.ts
 * Output: PASS/FAIL per test, then === N passed, M failed === summary.
 * Exit code 1 if any fail.
 */

import { checkAllowlist } from './discord-allowlist-verdict.js';

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

// 1. Empty allowlist → allowed-empty-allowlist
(() => {
  const v = checkAllowlist({ discordUserId: '123', allowlist: [] });
  check('empty allowlist returns allowed-empty-allowlist',
    v.kind === 'allowed-empty-allowlist',
    `got ${v.kind}`);
})();

// 2. Empty allowlist with empty userId
(() => {
  const v = checkAllowlist({ discordUserId: '', allowlist: [] });
  check('empty allowlist + empty userId returns allowed-empty-allowlist',
    v.kind === 'allowed-empty-allowlist',
    `got ${v.kind}`);
})();

// 3. id in single-entry allowlist
(() => {
  const v = checkAllowlist({ discordUserId: '111', allowlist: ['111'] });
  check('id in single-entry allowlist returns allowed',
    v.kind === 'allowed',
    `got ${v.kind}`);
})();

// 4. id NOT in single-entry allowlist
(() => {
  const v = checkAllowlist({ discordUserId: '222', allowlist: ['111'] });
  check('id NOT in single-entry allowlist returns denied-not-on-allowlist',
    v.kind === 'denied-not-on-allowlist',
    `got ${v.kind}`);
})();

// 5. id in multi-entry allowlist
(() => {
  const v = checkAllowlist({ discordUserId: '333', allowlist: ['111', '222', '333', '444'] });
  check('id in multi-entry allowlist returns allowed',
    v.kind === 'allowed',
    `got ${v.kind}`);
})();

// 6. id NOT in multi-entry allowlist
(() => {
  const v = checkAllowlist({ discordUserId: '999', allowlist: ['111', '222', '333'] });
  check('id NOT in multi-entry allowlist returns denied-not-on-allowlist',
    v.kind === 'denied-not-on-allowlist',
    `got ${v.kind}`);
})();

// 7. Whitespace in user id (exact compare — no trim) → no match
(() => {
  const v = checkAllowlist({ discordUserId: ' 111', allowlist: ['111'] });
  check('whitespace-prefixed userId is NOT trimmed (exact compare) → denied',
    v.kind === 'denied-not-on-allowlist',
    `got ${v.kind} (expected denied because exact-compare semantics)`);
})();

// 8. Empty userId vs populated allowlist
(() => {
  const v = checkAllowlist({ discordUserId: '', allowlist: ['111'] });
  check('empty userId vs populated allowlist returns denied-not-on-allowlist',
    v.kind === 'denied-not-on-allowlist',
    `got ${v.kind}`);
})();

// 9. Duplicate ids in allowlist still match correctly
(() => {
  const v = checkAllowlist({ discordUserId: '111', allowlist: ['111', '111', '111'] });
  check('duplicate ids in allowlist still match',
    v.kind === 'allowed',
    `got ${v.kind}`);
})();

// 10. Numeric-string parity (Discord ids are numeric strings — case is N/A,
// but verify exact-string semantics: a leading-zero variant should NOT match)
(() => {
  const v = checkAllowlist({ discordUserId: '0123', allowlist: ['123'] });
  check('exact-string match: "0123" != "123" (no numeric coercion)',
    v.kind === 'denied-not-on-allowlist',
    `got ${v.kind}`);
})();

// 11. Returned shape has only kind property (discriminated union purity check)
(() => {
  const v = checkAllowlist({ discordUserId: '111', allowlist: ['111'] });
  const keys = Object.keys(v);
  check('verdict shape has exactly one key (kind)',
    keys.length === 1 && keys[0] === 'kind',
    `keys: ${keys.join(',')}`);
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
