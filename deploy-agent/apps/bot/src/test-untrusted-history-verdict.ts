/**
 * Pure-function tests for untrusted-history-verdict.ts (Round 26 Item #4).
 * Run via: bun src/test-untrusted-history-verdict.ts
 */

import {
  wrapUntrustedHistory,
  escapeXmlContent,
  escapeXmlAttr,
  type ContextEntry,
} from './untrusted-history-verdict.js';

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

const emptyAuthors = new Map<string, string>();

// 1. empty entries → empty wrapped + entryCount=0
(() => {
  const r = wrapUntrustedHistory([], { authorById: emptyAuthors });
  check('empty entries: wrapped is ""', r.wrapped === '', `got "${r.wrapped}"`);
  check('empty entries: entryCount=0', r.entryCount === 0, `got ${r.entryCount}`);
})();

// 2. one user entry → <untrusted_channel_history>...</untrusted_channel_history>
(() => {
  const entries: ContextEntry[] = [
    { role: 'user', content: 'hello', authorId: 'u1', timestamp: '2026-04-27T00:00:00.000Z' },
  ];
  const authors = new Map([['u1', 'alice']]);
  const r = wrapUntrustedHistory(entries, { authorById: authors });
  check('one user entry: wrapped contains <untrusted_channel_history>',
    r.wrapped.includes('<untrusted_channel_history'), `got: ${r.wrapped}`);
  check('one user entry: contains author name', r.wrapped.includes('alice'),
    `got: ${r.wrapped}`);
  check('one user entry: contains content', r.wrapped.includes('hello'),
    `got: ${r.wrapped}`);
  check('one user entry: contains timestamp', r.wrapped.includes('2026-04-27T00:00:00.000Z'),
    `got: ${r.wrapped}`);
  check('one user entry: entryCount=1', r.entryCount === 1, `got ${r.entryCount}`);
})();

// 3. one assistant entry → <assistant_turn>...</assistant_turn>
(() => {
  const entries: ContextEntry[] = [{ role: 'assistant', content: 'response' }];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('one assistant entry: wrapped is <assistant_turn>response</assistant_turn>',
    r.wrapped === '<assistant_turn>response</assistant_turn>',
    `got: ${r.wrapped}`);
  check('one assistant entry: entryCount=1', r.entryCount === 1, `got ${r.entryCount}`);
})();

// 4. mixed entries → correct ordering preserved
(() => {
  const entries: ContextEntry[] = [
    { role: 'user', content: 'q1', authorId: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2', authorId: 'u1' },
  ];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  const idxQ1 = r.wrapped.indexOf('q1');
  const idxA1 = r.wrapped.indexOf('a1');
  const idxQ2 = r.wrapped.indexOf('q2');
  check('mixed entries: ordering preserved (q1 < a1 < q2)',
    idxQ1 >= 0 && idxA1 > idxQ1 && idxQ2 > idxA1,
    `idxQ1=${idxQ1} idxA1=${idxA1} idxQ2=${idxQ2}`);
  check('mixed entries: entryCount=3', r.entryCount === 3, `got ${r.entryCount}`);
})();

// 5. XML escape: <script> in content
(() => {
  const entries: ContextEntry[] = [{ role: 'assistant', content: '<script>alert(1)</script>' }];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('content with <script> escaped → &lt;script&gt;',
    r.wrapped.includes('&lt;script&gt;') && !r.wrapped.includes('<script>'),
    `got: ${r.wrapped}`);
})();

// 6. XML escape: & in content
(() => {
  const r = wrapUntrustedHistory(
    [{ role: 'assistant', content: 'A & B' }],
    { authorById: emptyAuthors },
  );
  check('content with & escaped → &amp;',
    r.wrapped.includes('A &amp; B'), `got: ${r.wrapped}`);
})();

// 7. escapeXmlContent: " and ' are NOT escaped (only attr does that)
(() => {
  const out = escapeXmlContent(`he said "hi" and 'bye'`);
  check('escapeXmlContent does NOT escape " or \'',
    out === `he said "hi" and 'bye'`, `got: ${out}`);
})();

// 8. escapeXmlAttr: " and ' ARE escaped
(() => {
  const out = escapeXmlAttr(`"a"'b'`);
  check('escapeXmlAttr escapes " and \'',
    out === '&quot;a&quot;&apos;b&apos;', `got: ${out}`);
})();

// 9. author name with quotes → escaped in attr
(() => {
  const entries: ContextEntry[] = [
    { role: 'user', content: 'msg', authorId: 'u1' },
  ];
  const authors = new Map([['u1', `evil"name`]]);
  const r = wrapUntrustedHistory(entries, { authorById: authors });
  check('author name with " is escaped in attribute',
    r.wrapped.includes('author="evil&quot;name"'),
    `got: ${r.wrapped}`);
})();

// 10. missing author (no authorId, role=user) → falls back to "unknown"
(() => {
  const entries: ContextEntry[] = [{ role: 'user', content: 'orphan' }];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('user entry without authorId → author="unknown"',
    r.wrapped.includes('author="unknown"'), `got: ${r.wrapped}`);
})();

// 11. authorId not in map → falls back to raw id
(() => {
  const entries: ContextEntry[] = [
    { role: 'user', content: 'hi', authorId: 'u-unknown-99' },
  ];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('authorId missing from map → falls back to raw id',
    r.wrapped.includes('author="u-unknown-99"'), `got: ${r.wrapped}`);
})();

// 12. very long content (no truncation) — full content passes through, just escape
(() => {
  const longContent = 'x'.repeat(5000);
  const entries: ContextEntry[] = [{ role: 'assistant', content: longContent }];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('long content not truncated by wrapUntrustedHistory',
    r.wrapped.includes(longContent), 'long content was truncated');
})();

// 13. mixed quotes inside content — no escaping of " ' in content
(() => {
  const entries: ContextEntry[] = [
    { role: 'assistant', content: `says "hi" and 'bye'` },
  ];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('content with mixed quotes preserved (only <>& escaped)',
    r.wrapped.includes(`says "hi" and 'bye'`), `got: ${r.wrapped}`);
})();

// 14. entryCount matches input length (mixed roles)
(() => {
  const entries: ContextEntry[] = [
    { role: 'user', content: '1', authorId: 'u1' },
    { role: 'assistant', content: '2' },
    { role: 'user', content: '3', authorId: 'u1' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: '5', authorId: 'u1' },
  ];
  const r = wrapUntrustedHistory(entries, { authorById: emptyAuthors });
  check('entryCount matches input length (5)', r.entryCount === 5, `got ${r.entryCount}`);
})();

// 15. ampersand-escape order is correct (& must run BEFORE < and >)
(() => {
  // If & runs after < then "<" → "&lt;" → "&amp;lt;" (double-escape).
  const out = escapeXmlContent('<&>');
  check('escape order: <&> → &lt;&amp;&gt; (no double-escape)',
    out === '&lt;&amp;&gt;', `got: ${out}`);
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
