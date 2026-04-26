/**
 * Pure-function tests for pronoun-context-verdict.ts (Round 26 Item #3).
 *
 * Covers ONLY the pure mergeContextEntries helper. fetchPronounContext
 * does Discord I/O and is left untested at this layer (would need a Discord
 * channel mock).
 *
 * Run via: bun src/test-pronoun-context-verdict.ts
 */

import { mergeContextEntries } from './pronoun-context-verdict.js';
import type { ContextEntry } from './untrusted-history-verdict.js';

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

// 1. empty + empty → empty
(() => {
  const out = mergeContextEntries([], []);
  check('empty + empty → empty array', out.length === 0, `len=${out.length}`);
})();

// 2. history-only entries → just those
(() => {
  const history: ContextEntry[] = [
    { role: 'user', content: 'h1', authorId: 'u1' },
    { role: 'user', content: 'h2', authorId: 'u1' },
  ];
  const out = mergeContextEntries(history, []);
  check('history-only: length=2', out.length === 2, `len=${out.length}`);
  check('history-only: contents preserved',
    out[0].content === 'h1' && out[1].content === 'h2',
    `got [${out.map((e) => e.content).join(',')}]`);
})();

// 3. memory-only entries → just those
(() => {
  const memory: ContextEntry[] = [
    { role: 'user', content: 'm1', authorId: 'u1' },
    { role: 'assistant', content: 'm2' },
  ];
  const out = mergeContextEntries([], memory);
  check('memory-only: length=2', out.length === 2, `len=${out.length}`);
  check('memory-only: contents preserved',
    out[0].content === 'm1' && out[1].content === 'm2',
    `got [${out.map((e) => e.content).join(',')}]`);
})();

// 4. duplicate detection: same content + role → deduped (history dropped, memory kept)
(() => {
  const history: ContextEntry[] = [
    { role: 'user', content: 'same', authorId: 'u1', timestamp: '2026-01-01T00:00:00Z' },
  ];
  const memory: ContextEntry[] = [
    { role: 'user', content: 'same', authorId: 'u1', timestamp: '2026-02-02T00:00:00Z' },
  ];
  const out = mergeContextEntries(history, memory);
  check('duplicate (same role+content): length=1', out.length === 1, `len=${out.length}`);
  check('duplicate: memory entry kept (timestamp 2026-02-02)',
    out[0].timestamp === '2026-02-02T00:00:00Z',
    `got ts=${out[0].timestamp}`);
})();

// 5. dedupe is by role+content only (NOT timestamp): different timestamp same content → still deduped
(() => {
  const history: ContextEntry[] = [
    { role: 'user', content: 'X', authorId: 'u1', timestamp: 'T1' },
  ];
  const memory: ContextEntry[] = [
    { role: 'user', content: 'X', authorId: 'u1', timestamp: 'T2' },
  ];
  const out = mergeContextEntries(history, memory);
  check('different timestamps but same role+content → still deduped',
    out.length === 1, `len=${out.length}`);
})();

// 6. different role same content → NOT deduped
(() => {
  const history: ContextEntry[] = [{ role: 'user', content: 'X', authorId: 'u1' }];
  const memory: ContextEntry[] = [{ role: 'assistant', content: 'X' }];
  const out = mergeContextEntries(history, memory);
  check('different role same content → both kept (length=2)',
    out.length === 2, `len=${out.length}`);
})();

// 7. in-memory takes precedence on conflict: history entry skipped
(() => {
  const history: ContextEntry[] = [
    { role: 'user', content: 'foo', authorId: 'u1', timestamp: 'history-ts' },
  ];
  const memory: ContextEntry[] = [
    { role: 'user', content: 'foo', authorId: 'u1', timestamp: 'memory-ts' },
  ];
  const out = mergeContextEntries(history, memory);
  check('memory wins on conflict: only memory entry remains',
    out.length === 1 && out[0].timestamp === 'memory-ts',
    `len=${out.length} ts=${out[0]?.timestamp}`);
})();

// 8. ordering: history first, then memory (per impl: history-skipped-claimed, then memory appended)
(() => {
  const history: ContextEntry[] = [
    { role: 'user', content: 'h1', authorId: 'u1' },
    { role: 'user', content: 'h2', authorId: 'u1' },
  ];
  const memory: ContextEntry[] = [
    { role: 'user', content: 'm1', authorId: 'u1' },
    { role: 'user', content: 'm2', authorId: 'u1' },
  ];
  const out = mergeContextEntries(history, memory);
  check('order: history first then memory',
    out.length === 4 &&
    out[0].content === 'h1' &&
    out[1].content === 'h2' &&
    out[2].content === 'm1' &&
    out[3].content === 'm2',
    `got [${out.map((e) => e.content).join(',')}]`);
})();

// 9. merge of 5 + 5 with no overlap → 10
(() => {
  const history: ContextEntry[] = Array.from({ length: 5 }, (_, i) => ({
    role: 'user' as const,
    content: `h${i}`,
    authorId: 'u1',
  }));
  const memory: ContextEntry[] = Array.from({ length: 5 }, (_, i) => ({
    role: 'user' as const,
    content: `m${i}`,
    authorId: 'u1',
  }));
  const out = mergeContextEntries(history, memory);
  check('5 + 5 no overlap → 10 entries', out.length === 10, `len=${out.length}`);
})();

// 10. merge of 5 + 5 with full overlap → 5
(() => {
  const same: ContextEntry[] = Array.from({ length: 5 }, (_, i) => ({
    role: 'user' as const,
    content: `dup${i}`,
    authorId: 'u1',
  }));
  const out = mergeContextEntries(same, same.map((e) => ({ ...e, timestamp: 'memory' })));
  check('5 + 5 full overlap → 5 entries (memory wins)',
    out.length === 5, `len=${out.length}`);
  check('5 + 5 full overlap: all entries are memory variant (have timestamp=memory)',
    out.every((e) => e.timestamp === 'memory'),
    `timestamps: ${out.map((e) => e.timestamp).join(',')}`);
})();

// 11. partial overlap (3 dup of 5)
(() => {
  const history: ContextEntry[] = [
    { role: 'user', content: 'a', authorId: 'u1' },
    { role: 'user', content: 'b', authorId: 'u1' },
    { role: 'user', content: 'c', authorId: 'u1' },
    { role: 'user', content: 'd', authorId: 'u1' },
    { role: 'user', content: 'e', authorId: 'u1' },
  ];
  const memory: ContextEntry[] = [
    { role: 'user', content: 'c', authorId: 'u1' },
    { role: 'user', content: 'd', authorId: 'u1' },
    { role: 'user', content: 'f', authorId: 'u1' },
  ];
  const out = mergeContextEntries(history, memory);
  // history: a, b, e survive (c, d skipped); memory: c, d, f appended
  // total = 6
  check('partial overlap 5+3 with 2 dup → 6 entries', out.length === 6, `len=${out.length}`);
  const contents = out.map((e) => e.content);
  check('partial overlap order: a, b, e (history) then c, d, f (memory)',
    contents.join(',') === 'a,b,e,c,d,f',
    `got [${contents.join(',')}]`);
})();

// 12. inputs not mutated (purity)
(() => {
  const history: ContextEntry[] = [{ role: 'user', content: 'h', authorId: 'u1' }];
  const memory: ContextEntry[] = [{ role: 'user', content: 'm', authorId: 'u1' }];
  const histCopy = JSON.stringify(history);
  const memCopy = JSON.stringify(memory);
  mergeContextEntries(history, memory);
  check('inputs not mutated: history unchanged',
    JSON.stringify(history) === histCopy, 'history mutated');
  check('inputs not mutated: memory unchanged',
    JSON.stringify(memory) === memCopy, 'memory mutated');
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
