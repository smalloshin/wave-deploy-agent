/**
 * Pure-function tests for discord-audit-mapper.ts (Round 26 Item #8).
 * Run via: bun src/test-discord-audit-mapper.ts
 */

import {
  sanitizeToolInput,
  sanitizeResultText,
} from './services/discord-audit-mapper.js';

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

// ═══ sanitizeToolInput ═══

// 1. empty object → empty object
(() => {
  const out = sanitizeToolInput({});
  check('empty object → empty object', Object.keys(out).length === 0,
    `keys: ${Object.keys(out).join(',')}`);
})();

// 2. plain non-secret kv preserved
(() => {
  const out = sanitizeToolInput({ project: 'foo' });
  check('{ project: "foo" } unchanged', out.project === 'foo', `got: ${out.project}`);
})();

// 3. password key → value redacted
(() => {
  const out = sanitizeToolInput({ password: 'hunter2' });
  check('password key → "***"', out.password === '***', `got: ${out.password}`);
})();

// 4. apiKey: 'da_k_xxx' → key match wins → '***'
(() => {
  const out = sanitizeToolInput({ apiKey: 'da_k_xxx' });
  check('apiKey value → "***" (key match wins over value match)',
    out.apiKey === '***', `got: ${out.apiKey}`);
})();

// 5. token key with da_k_ value → key match wins
(() => {
  const out = sanitizeToolInput({ token: 'da_k_abc123' });
  check('token: da_k_abc123 → "***" (key match)',
    out.token === '***', `got: ${out.token}`);
})();

// 6. random key with da_k_ value → value-only sanitize
(() => {
  const out = sanitizeToolInput({ random: 'da_k_abc123' });
  check('random: da_k_abc123 → "da_k_***" (value match only)',
    out.random === 'da_k_***', `got: ${out.random}`);
})();

// 7. random key with bcrypt value → value-only sanitize
(() => {
  const out = sanitizeToolInput({ random: '$2b$10$abc' });
  check('random: $2b$10$abc → "$2***" (bcrypt value match)',
    out.random === '$2***', `got: ${out.random}`);
})();

// 8. nested: { a: { password: 'x' } } → { a: { password: '***' } }
(() => {
  const out = sanitizeToolInput({ a: { password: 'x' } });
  const a = out.a as Record<string, unknown>;
  check('nested password redacted', a.password === '***', `got: ${a.password}`);
})();

// 9. depth cap: 6 levels deep → inner becomes '[max-depth-exceeded]'
(() => {
  const out = sanitizeToolInput({
    L1: { L2: { L3: { L4: { L5: { leaf: 'X' } } } } },
  });
  // Walk down: at depth 5 inside L5, the value `{ leaf: 'X' }` is an object
  // and depth >= MAX_RECURSE_DEPTH (5), so it gets replaced.
  const l1 = out.L1 as Record<string, unknown>;
  const l2 = l1.L2 as Record<string, unknown>;
  const l3 = l2.L3 as Record<string, unknown>;
  const l4 = l3.L4 as Record<string, unknown>;
  const l5 = l4.L5;
  check('depth cap: deeply nested object → "[max-depth-exceeded]"',
    l5 === '[max-depth-exceeded]',
    `got: ${typeof l5 === 'object' ? JSON.stringify(l5) : String(l5)}`);
})();

// 10. depth-safe: 4 levels deep → fully sanitized
(() => {
  const out = sanitizeToolInput({
    L1: { L2: { L3: { L4: { leaf: 'X' } } } },
  });
  const l1 = out.L1 as Record<string, unknown>;
  const l2 = l1.L2 as Record<string, unknown>;
  const l3 = l2.L3 as Record<string, unknown>;
  const l4 = l3.L4 as Record<string, unknown>;
  check('4 levels deep: leaf preserved (within depth cap)',
    l4.leaf === 'X', `got: ${JSON.stringify(l4)}`);
})();

// 11. long string truncation: 600-char string → 500 chars + '…'
(() => {
  const long = 'a'.repeat(600);
  const out = sanitizeToolInput({ note: long });
  const noteValue = out.note as string;
  check('600-char string truncated to 500 chars + ellipsis',
    noteValue.length === 501 && noteValue.endsWith('…'),
    `len=${noteValue.length} endsWith='${noteValue.slice(-1)}'`);
})();

// 12. exactly 500 chars → not truncated
(() => {
  const exact = 'b'.repeat(500);
  const out = sanitizeToolInput({ note: exact });
  check('500-char string preserved (boundary)',
    out.note === exact, `len=${(out.note as string).length}`);
})();

// 13. number value preserved
(() => {
  const out = sanitizeToolInput({ count: 42 });
  check('number value preserved', out.count === 42, `got: ${out.count}`);
})();

// 14. null value preserved
(() => {
  const out = sanitizeToolInput({ x: null });
  check('null value preserved', out.x === null, `got: ${out.x}`);
})();

// 15. array value sanitized recursively
(() => {
  const out = sanitizeToolInput({ items: ['da_k_abc', 'plain'] });
  const items = out.items as unknown[];
  check('array length preserved', items.length === 2, `len=${items.length}`);
  check('array[0] (da_k_*) sanitized to da_k_***',
    items[0] === 'da_k_***', `got: ${items[0]}`);
  check('array[1] (plain) preserved',
    items[1] === 'plain', `got: ${items[1]}`);
})();

// 16. case-insensitive key match: PASSWORD
(() => {
  const out = sanitizeToolInput({ PASSWORD: 'x' });
  check('PASSWORD (uppercase) → redacted', out.PASSWORD === '***', `got: ${out.PASSWORD}`);
})();

// 17. case-insensitive key match: Password
(() => {
  const out = sanitizeToolInput({ Password: 'x' });
  check('Password (capitalized) → redacted', out.Password === '***', `got: ${out.Password}`);
})();

// 18. secret_key
(() => {
  const out = sanitizeToolInput({ secret_key: 'x' });
  check('secret_key → redacted', out.secret_key === '***', `got: ${out.secret_key}`);
})();

// 19. privateKey
(() => {
  const out = sanitizeToolInput({ privateKey: 'x' });
  check('privateKey → redacted', out.privateKey === '***', `got: ${out.privateKey}`);
})();

// 20. api-key (with hyphen)
(() => {
  const out = sanitizeToolInput({ 'api-key': 'x' });
  check('api-key → redacted', out['api-key'] === '***', `got: ${out['api-key']}`);
})();

// 21. credentials (matches /credential/i)
(() => {
  const out = sanitizeToolInput({ credentials: 'x' });
  check('credentials → redacted', out.credentials === '***', `got: ${out.credentials}`);
})();

// 22. boolean preserved
(() => {
  const out = sanitizeToolInput({ enabled: true });
  check('boolean preserved', out.enabled === true, `got: ${out.enabled}`);
})();

// ═══ sanitizeResultText ═══

// 23. normal short string unchanged
(() => {
  const out = sanitizeResultText('hello world');
  check('short text unchanged', out === 'hello world', `got: ${out}`);
})();

// 24. 2500-char string → 2000 + '…[truncated]'
(() => {
  const big = 'x'.repeat(2500);
  const out = sanitizeResultText(big);
  check('2500-char text truncated to 2000 + suffix',
    out.length === 2000 + '…[truncated]'.length && out.endsWith('…[truncated]'),
    `len=${out.length}`);
})();

// 25. da_k_xyz inside text → replaced
(() => {
  const out = sanitizeResultText('Got token da_k_xyz123 in result');
  check('da_k_xyz inside text → da_k_*** replacement',
    out === 'Got token da_k_*** in result', `got: ${out}`);
})();

// 26. multiple da_k_ tokens replaced
(() => {
  const out = sanitizeResultText('da_k_abc and da_k_xyz123');
  check('multiple da_k_* tokens all replaced',
    out === 'da_k_*** and da_k_***', `got: ${out}`);
})();

// 27. bcrypt-looking blob inside text → $2***
(() => {
  // Need 50+ trailing chars per regex.
  const bcrypt = '$2b$10$' + 'a'.repeat(60);
  const out = sanitizeResultText(`hash: ${bcrypt}`);
  check('bcrypt blob inside text → $2*** replacement',
    out === 'hash: $2***', `got: ${out}`);
})();

// 28. empty string → empty string
(() => {
  const out = sanitizeResultText('');
  check('empty string → empty', out === '', `got: "${out}"`);
})();

// 29. exactly 2000 chars → not truncated
(() => {
  const exact = 'y'.repeat(2000);
  const out = sanitizeResultText(exact);
  check('2000-char text preserved (boundary)',
    out === exact, `len=${out.length}`);
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
