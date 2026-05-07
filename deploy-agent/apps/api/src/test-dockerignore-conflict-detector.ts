/**
 * R61 (2026-05-07): tests for dockerignore-conflict-detector
 *
 * Zero-dep — `node:assert/strict` only. Run via:
 *   bash scripts/sweep-zero-dep-tests.sh
 *
 * Locks behavior for the legal-flow-20260505 canonical case + glob edges +
 * negation re-include + COPY parsing variants.
 */

import { strict as assert } from 'node:assert';

import { detectDockerignoreConflicts } from './services/dockerignore-conflict-detector';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical: legal-flow-20260505 (.env*.local excluded, COPY .env.local fails)
// ─────────────────────────────────────────────────────────────────────────────

test('canonical legal-flow: .env*.local excludes .env.local AND Dockerfile COPYs it', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'node_modules\n.env*.local\n*.log',
    dockerfile: 'FROM node:22\nCOPY .env .env\nCOPY .env.local .env.local\nCMD ["node", "server.js"]',
  });
  assert.equal(conflicts.length, 1, 'should report exactly 1 conflict');
  assert.equal(conflicts[0]?.copySource, '.env.local');
  assert.equal(conflicts[0]?.excludingPattern, '.env*.local');
  assert.equal(conflicts[0]?.lineNumber, 3);
  // .env (no .local suffix) should NOT match .env*.local (the * doesn't make
  // .local optional — it requires the .local suffix).
});

test('canonical legal-flow .env (no suffix) does NOT match .env*.local', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '.env*.local',
    dockerfile: 'COPY .env .env\nCOPY frontend ./frontend',
  });
  assert.equal(conflicts.length, 0, '.env should not match .env*.local pattern');
});

// ─────────────────────────────────────────────────────────────────────────────
// Glob: * matches but not /
// ─────────────────────────────────────────────────────────────────────────────

test('* matches any non-slash chars (.env*.local matches .env.local and .env.production.local)', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '.env*.local',
    dockerfile: 'COPY .env.local /\nCOPY .env.production.local /',
  });
  assert.equal(conflicts.length, 2);
});

test('* does NOT match across path separators', () => {
  // Pattern `frontend/*.json` should match `frontend/package.json` but NOT
  // `frontend/sub/package.json` (the * is non-greedy w.r.t. `/`).
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'frontend/*.json',
    dockerfile: 'COPY frontend/package.json /tmp\nCOPY frontend/sub/package.json /tmp',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.copySource, 'frontend/package.json');
});

test('** matches across path separators', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '**/secrets.json',
    dockerfile: 'COPY secrets.json /\nCOPY frontend/secrets.json /\nCOPY a/b/c/secrets.json /',
  });
  // ** at start = match anywhere. All three should match.
  assert.equal(conflicts.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Comments + blank lines
// ─────────────────────────────────────────────────────────────────────────────

test('comments and blank lines are skipped', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '# comment\n\nnode_modules\n# .env.local  (note: this comment looks like a pattern but is comment)\n',
    dockerfile: 'COPY .env.local /\nCOPY node_modules /tmp/cache',
  });
  // Only `node_modules` is an active pattern; .env.local is in a comment.
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.copySource, 'node_modules');
});

// ─────────────────────────────────────────────────────────────────────────────
// Negation: re-include with !
// ─────────────────────────────────────────────────────────────────────────────

test('negation: ! re-includes a previously excluded file', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '*.log\n!important.log',
    dockerfile: 'COPY important.log /\nCOPY debug.log /',
  });
  // important.log is re-included → no conflict. debug.log stays excluded.
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.copySource, 'debug.log');
});

test('negation order matters: re-include then re-exclude', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '*.log\n!important.log\nimportant.log',
    dockerfile: 'COPY important.log /',
  });
  // Last rule (`important.log` plain exclude) wins.
  assert.equal(conflicts.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Dockerfile parsing: --from, --chown, ADD, quotes
// ─────────────────────────────────────────────────────────────────────────────

test('COPY --from=<stage> is ignored (multi-stage artifact, no dockerignore impact)', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'dist',
    dockerfile: 'COPY --from=builder /app/dist /usr/share/nginx/html',
  });
  assert.equal(conflicts.length, 0);
});

test('COPY --chown=user:group flag is stripped before parsing srcs', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '.next',
    dockerfile: 'COPY --chown=nextjs:nodejs .next/standalone ./',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.copySource, '.next/standalone');
});

test('ADD instruction is also checked (same dockerignore semantics)', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'secret.tar',
    dockerfile: 'ADD secret.tar /opt/',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.copySource, 'secret.tar');
});

test('ADD with URL bypasses dockerignore (URL fetch does not use context)', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'something',
    dockerfile: 'ADD https://example.com/file.tgz /tmp/',
  });
  assert.equal(conflicts.length, 0);
});

test('Quoted COPY srcs are handled', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '.env',
    dockerfile: 'COPY ".env" "."',
  });
  assert.equal(conflicts.length, 1);
});

test('multiple srcs in one COPY: each is checked independently', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'secrets.json',
    dockerfile: 'COPY package.json secrets.json README.md /app/',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.copySource, 'secrets.json');
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('empty .dockerignore returns no conflicts', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '',
    dockerfile: 'COPY anything /',
  });
  assert.equal(conflicts.length, 0);
});

test('whitespace-only .dockerignore returns no conflicts', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '   \n\n   \n',
    dockerfile: 'COPY foo /',
  });
  assert.equal(conflicts.length, 0);
});

test('Dockerfile without COPY/ADD lines returns no conflicts', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'node_modules\n.env',
    dockerfile: 'FROM node:22\nWORKDIR /app\nRUN npm install\nCMD ["node"]',
  });
  assert.equal(conflicts.length, 0);
});

test('COPY . . (dot src) is ignored — too coarse to evaluate', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'node_modules\n.env',
    dockerfile: 'COPY . .',
  });
  // We don't expand `.` to "every file in context" — too noisy. Skip.
  assert.equal(conflicts.length, 0);
});

test('directory pattern with trailing slash', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'logs/',
    dockerfile: 'COPY logs /tmp/cache\nCOPY logs/error.log /tmp/',
  });
  // `logs/` matches both the directory itself and anything below it.
  assert.equal(conflicts.length, 2);
});

test('case-sensitive matching (matches Linux/Cloud Build behavior)', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: '.env',
    dockerfile: 'COPY .ENV /',
  });
  // .ENV !== .env on Linux (which is what Cloud Build runs on).
  assert.equal(conflicts.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────────────

test('conflict reports lineNumber 1-based + full original line', () => {
  const conflicts = detectDockerignoreConflicts({
    dockerignore: 'secret',
    dockerfile: 'FROM node:22\n\n\nCOPY secret /',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.lineNumber, 4); // line 4, 1-based
  assert.equal(conflicts[0]?.copyLine, 'COPY secret /');
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`✗ ${t.name}`);
    console.error(`  ${(err as Error).message}`);
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
