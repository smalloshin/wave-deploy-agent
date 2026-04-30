/**
 * Tests: prisma-fixer (R44g)
 *
 * Why this matters:
 *   - Vibe-coded Next.js + Prisma projects fail at `next build` if prisma
 *     generate hasn't run. The user's Dockerfile usually doesn't include it.
 *   - wave-deploy-agent preserves user Dockerfiles, so we patch them.
 *   - This patcher is on the deploy hot path — a bug here breaks every Prisma
 *     project. Zero-dep tests keep this airtight.
 *
 * What we lock in:
 *   - detectPrismaSignals correctly reports each signal in isolation
 *   - isPrismaProject returns true if ANY signal is positive
 *   - patchDockerfileForPrisma:
 *     * idempotency (skip if prisma generate already present)
 *     * injects before npm/yarn/pnpm/bun/next build patterns
 *     * preserves leading whitespace
 *     * leaves all other lines untouched
 *     * rejects unsafe placeholder (newline/quote injection guard)
 *     * returns changed=false when no build line found
 *
 * Run: bun run src/test-prisma-fixer.ts (or npx tsx)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectPrismaSignals,
  isPrismaProject,
  patchDockerfileForPrisma,
} from './services/prisma-fixer.js';

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

// Per-test temp dir to keep tests independent.
function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-fixer-'));
}

function rm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n=== prisma-fixer unit tests ===\n');

// ─── detectPrismaSignals ──────────────────────────────────────

test('detect: empty dir → all signals false', () => {
  const dir = makeTempProject();
  try {
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, false);
    assert.equal(s.hasPrismaSchema, false);
    assert.equal(s.hasPrismaConfig, false);
  } finally { rm(dir); }
});

test('detect: package.json with @prisma/client in deps → hasPrismaInDeps', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@prisma/client': '^6.0.0' },
    }));
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, true);
    assert.equal(s.hasPrismaSchema, false);
    assert.equal(s.hasPrismaConfig, false);
  } finally { rm(dir); }
});

test('detect: package.json with @prisma/client in devDependencies → hasPrismaInDeps', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { '@prisma/client': '^6.0.0' },
    }));
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, true);
  } finally { rm(dir); }
});

test('detect: package.json with prisma CLI in devDependencies → hasPrismaInDeps', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { 'prisma': '^6.0.0' },
    }));
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, true);
  } finally { rm(dir); }
});

test('detect: package.json without prisma → hasPrismaInDeps false', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'react': '^18.0.0' },
    }));
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, false);
  } finally { rm(dir); }
});

test('detect: malformed package.json → hasPrismaInDeps false (no throw)', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), 'not json {{{');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, false);
  } finally { rm(dir); }
});

test('detect: prisma/schema.prisma → hasPrismaSchema', () => {
  const dir = makeTempProject();
  try {
    fs.mkdirSync(path.join(dir, 'prisma'));
    fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" url = env("DATABASE_URL") }');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaSchema, true);
  } finally { rm(dir); }
});

test('detect: schema.prisma at root → hasPrismaSchema', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'schema.prisma'), 'datasource db {}');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaSchema, true);
  } finally { rm(dir); }
});

test('detect: prisma.config.ts → hasPrismaConfig', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'prisma.config.ts'), 'export default {}');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaConfig, true);
  } finally { rm(dir); }
});

test('detect: prisma.config.js → hasPrismaConfig', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'prisma.config.js'), 'module.exports = {}');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaConfig, true);
  } finally { rm(dir); }
});

test('detect: prisma.config.mjs → hasPrismaConfig', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'prisma.config.mjs'), 'export default {}');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaConfig, true);
  } finally { rm(dir); }
});

test('detect: directory named schema.prisma (not file) → hasPrismaSchema false', () => {
  const dir = makeTempProject();
  try {
    fs.mkdirSync(path.join(dir, 'schema.prisma'));
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaSchema, false);
  } finally { rm(dir); }
});

test('detect: all three signals positive simultaneously', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@prisma/client': '^6.0.0' },
    }));
    fs.mkdirSync(path.join(dir, 'prisma'));
    fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), '');
    fs.writeFileSync(path.join(dir, 'prisma.config.ts'), '');
    const s = detectPrismaSignals(dir);
    assert.equal(s.hasPrismaInDeps, true);
    assert.equal(s.hasPrismaSchema, true);
    assert.equal(s.hasPrismaConfig, true);
  } finally { rm(dir); }
});

test('detect: nonexistent dir → all signals false (no throw)', () => {
  // Use a path that doesn't exist
  const fake = path.join(os.tmpdir(), `prisma-fixer-nonexistent-${Date.now()}`);
  const s = detectPrismaSignals(fake);
  assert.equal(s.hasPrismaInDeps, false);
  assert.equal(s.hasPrismaSchema, false);
  assert.equal(s.hasPrismaConfig, false);
});

// ─── isPrismaProject ──────────────────────────────────────────

test('isPrismaProject: all false → false', () => {
  assert.equal(isPrismaProject({ hasPrismaInDeps: false, hasPrismaSchema: false, hasPrismaConfig: false }), false);
});

test('isPrismaProject: only hasPrismaInDeps → true', () => {
  assert.equal(isPrismaProject({ hasPrismaInDeps: true, hasPrismaSchema: false, hasPrismaConfig: false }), true);
});

test('isPrismaProject: only hasPrismaSchema → true', () => {
  assert.equal(isPrismaProject({ hasPrismaInDeps: false, hasPrismaSchema: true, hasPrismaConfig: false }), true);
});

test('isPrismaProject: only hasPrismaConfig → true', () => {
  assert.equal(isPrismaProject({ hasPrismaInDeps: false, hasPrismaSchema: false, hasPrismaConfig: true }), true);
});

test('isPrismaProject: all true → true', () => {
  assert.equal(isPrismaProject({ hasPrismaInDeps: true, hasPrismaSchema: true, hasPrismaConfig: true }), true);
});

// ─── patchDockerfileForPrisma: happy paths ────────────────────

test('patch: typical Next.js Dockerfile → injects before npm run build', () => {
  const input = [
    'FROM node:20-alpine AS base',
    'FROM base AS deps',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'FROM base AS builder',
    'WORKDIR /app',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY . .',
    'RUN npm run build',
    'FROM base AS runner',
    'CMD ["node", "server.js"]',
  ].join('\n');

  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  assert.match(result.next, /RUN DATABASE_URL="file:\/tmp\/prisma-build-placeholder\.db" npx prisma generate\nRUN npm run build/);
  // Other lines preserved
  assert.match(result.next, /FROM node:20-alpine AS base/);
  assert.match(result.next, /CMD \["node", "server\.js"\]/);
});

test('patch: yarn build → injects', () => {
  const input = 'FROM node:20\nRUN yarn build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  assert.match(result.next, /RUN DATABASE_URL=.+npx prisma generate\nRUN yarn build/);
});

test('patch: yarn run build → injects', () => {
  const input = 'FROM node:20\nRUN yarn run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

test('patch: pnpm build → injects', () => {
  const input = 'FROM node:20\nRUN pnpm build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

test('patch: pnpm run build → injects', () => {
  const input = 'FROM node:20\nRUN pnpm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

test('patch: bun run build → injects', () => {
  const input = 'FROM oven/bun:1\nRUN bun run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

test('patch: npx next build → injects', () => {
  const input = 'FROM node:20\nRUN npx next build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

test('patch: bare next build → injects', () => {
  const input = 'FROM node:20\nRUN next build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

test('patch: build with extra args (npm run build && echo done) → injects before', () => {
  const input = 'FROM node:20\nRUN npm run build && echo done\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  assert.match(result.next, /RUN DATABASE_URL=.+npx prisma generate\nRUN npm run build && echo done/);
});

test('patch: leading whitespace preserved', () => {
  const input = 'FROM node:20\n    RUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  // Indented build → indented prisma generate
  assert.match(result.next, /\n    RUN DATABASE_URL=.+\n    RUN npm run build/);
});

test('patch: tab-indented build → tab-indented prisma generate', () => {
  const input = 'FROM node:20\n\tRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  assert.match(result.next, /\t+RUN DATABASE_URL=.+\n\tRUN npm run build/);
});

test('patch: case insensitive (run vs RUN)', () => {
  // Dockerfile spec is case-insensitive on instructions
  const input = 'FROM node:20\nrun npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
});

// ─── patchDockerfileForPrisma: idempotency ────────────────────

test('idempotent: prisma generate already present → no change', () => {
  const input = [
    'FROM node:20',
    'RUN npx prisma generate',
    'RUN npm run build',
  ].join('\n');
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
  assert.equal(result.next, input);
  assert.match(result.reason, /already runs prisma generate/);
});

test('idempotent: prisma generate with different invocation (yarn prisma generate)', () => {
  const input = 'FROM node:20\nRUN yarn prisma generate\nRUN yarn build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

test('idempotent: prisma generate with bun', () => {
  const input = 'FROM node:20\nRUN bun prisma generate\nRUN bun run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

test('idempotent: PRISMA GENERATE (uppercase) — case insensitive', () => {
  const input = 'FROM node:20\nRUN PRISMA GENERATE\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

test('idempotent: prisma generate as part of && chain → still detected', () => {
  const input = 'FROM node:20\nRUN npx prisma generate && npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

// ─── patchDockerfileForPrisma: no build line ──────────────────

test('no build: empty Dockerfile → no change', () => {
  const result = patchDockerfileForPrisma('');
  assert.equal(result.changed, false);
  assert.equal(result.next, '');
});

test('no build: only FROM/CMD → no change', () => {
  const input = 'FROM node:20\nCMD ["node", "server.js"]\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
  assert.match(result.reason, /no build step found/);
});

test('no build: RUN npm install (not build) → no change', () => {
  const input = 'FROM node:20\nRUN npm install\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

test('no build: RUN npm test → no change', () => {
  const input = 'FROM node:20\nRUN npm test\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

test('no build: comment with "npm run build" → no change', () => {
  const input = 'FROM node:20\n# RUN npm run build\nCMD ["node"]\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, false);
});

// ─── patchDockerfileForPrisma: only first build patched ───────

test('multiple builds: only first is preceded by prisma generate', () => {
  const input = [
    'FROM node:20 AS builder',
    'RUN npm run build',
    'FROM node:20 AS another',
    'RUN npm run build',
  ].join('\n');
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  // Count prisma generate occurrences — should be exactly 1
  const matches = result.next.match(/prisma generate/gi) ?? [];
  assert.equal(matches.length, 1);
});

// ─── patchDockerfileForPrisma: custom placeholder ─────────────

test('custom placeholder: respects databaseUrlPlaceholder option', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input, {
    databaseUrlPlaceholder: 'postgresql://placeholder@localhost/db',
  });
  assert.equal(result.changed, true);
  assert.match(result.next, /DATABASE_URL="postgresql:\/\/placeholder@localhost\/db"/);
});

test('custom placeholder: rejects newline in placeholder (injection guard)', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input, {
    databaseUrlPlaceholder: 'file:/tmp/db\nRUN cat /etc/passwd',
  });
  assert.equal(result.changed, false);
  assert.match(result.reason, /unsafe DATABASE_URL placeholder/);
});

test('custom placeholder: rejects double-quote in placeholder (injection guard)', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input, {
    databaseUrlPlaceholder: 'file:/tmp/x" && rm -rf /',
  });
  assert.equal(result.changed, false);
});

test('custom placeholder: rejects carriage return', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input, {
    databaseUrlPlaceholder: 'file:/tmp/db\rEXTRA',
  });
  assert.equal(result.changed, false);
});

// ─── patchDockerfileForPrisma: input validation ───────────────

test('input: non-string content → changed=false', () => {
  // @ts-expect-error -- testing runtime guard
  const result = patchDockerfileForPrisma(undefined);
  assert.equal(result.changed, false);
});

test('input: null content → changed=false', () => {
  // @ts-expect-error -- testing runtime guard
  const result = patchDockerfileForPrisma(null);
  assert.equal(result.changed, false);
});

// ─── patchDockerfileForPrisma: line preservation ──────────────

test('preservation: every original line still present and in order', () => {
  const lines = [
    'FROM node:20 AS deps',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'FROM node:20 AS builder',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY . .',
    'RUN npm run build',
    'FROM node:20',
    'CMD ["node", "server.js"]',
  ];
  const input = lines.join('\n');
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  // Every original line appears in the output, in the original order
  const outputLines = result.next.split('\n');
  let cursor = 0;
  for (const orig of lines) {
    const idx = outputLines.indexOf(orig, cursor);
    assert.notEqual(idx, -1, `original line missing or out of order: ${orig}`);
    cursor = idx + 1;
  }
});

test('preservation: prisma generate inserted exactly one line before build', () => {
  const input = 'FROM node:20\nCOPY . .\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  const outLines = result.next.split('\n');
  const prismaIdx = outLines.findIndex((l) => /prisma generate/.test(l));
  const buildIdx = outLines.findIndex((l) => /npm run build/.test(l));
  assert.equal(buildIdx - prismaIdx, 1);
});

test('preservation: trailing newline preserved', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.next.endsWith('\n'), true);
});

test('preservation: no trailing newline preserved', () => {
  const input = 'FROM node:20\nRUN npm run build';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.next.endsWith('\n'), false);
});

test('preservation: CRLF line endings — handled gracefully', () => {
  // We split on '\n' so CRLF becomes '\r' suffix on each line. The patch
  // should still find the build line; the CR stays in the line.
  const input = 'FROM node:20\r\nRUN npm run build\r\n';
  const result = patchDockerfileForPrisma(input);
  assert.equal(result.changed, true);
  // Output should contain both lines
  assert.match(result.next, /prisma generate/);
  assert.match(result.next, /RUN npm run build/);
});

// ─── patchDockerfileForPrisma: line content check ─────────────

test('output line: contains npx prisma generate', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.match(result.next, /npx prisma generate/);
});

test('output line: DATABASE_URL is quoted (prevents shell expansion of URL chars)', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  // Should be DATABASE_URL="..."
  assert.match(result.next, /DATABASE_URL="[^"]+"/);
});

test('output line: starts with RUN (uppercase, Dockerfile convention)', () => {
  const input = 'FROM node:20\nRUN npm run build\n';
  const result = patchDockerfileForPrisma(input);
  assert.match(result.next, /^RUN DATABASE_URL=/m);
});

// ─── final report ─────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
