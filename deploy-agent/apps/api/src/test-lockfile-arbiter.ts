/**
 * Tests: lockfile-arbiter
 *
 * Why this matters:
 *   - Real failure (luca-web): Vite + TS project, only `package-lock.json`
 *     present, but the dev environment was pnpm. Detector picked npm,
 *     Dockerfile ran `npm ci`, `tsc -b` crashed because the bin shims
 *     pnpm laid down didn't match the npm install layout.
 *   - The old detector was a brittle if/else chain. This arbiter centralises
 *     PM-decision logic with confidence + warnings so the pipeline can:
 *       1. log a clear reason for its choice
 *       2. surface stale-lockfile warnings to the user
 *       3. let dockerfile-gen relax `npm ci` → `npm install` for low-confidence
 *
 * What we lock in:
 *   - corepack `package.json#packageManager` is highest-priority signal
 *   - `pnpm-workspace.yaml` is a strong pnpm signal even with stale npm lock
 *   - multi-lockfile conflicts decided by mtime, with stale-file warnings
 *   - single lockfile → medium confidence
 *   - no lockfile → npm/low/no-reproducibility warning
 *   - declared-PM mismatch with present lockfile → warning
 *   - malformed package.json → fall through, don't throw, warn
 *   - bun.lock + bun.lockb together (both bun) → no warning
 *
 * Run: bun run src/test-lockfile-arbiter.ts (or npx tsx)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arbitrateLockfile } from './services/lockfile-arbiter.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lockfile-arbiter-'));
}

function rm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Touch a file, optionally with mtime offset (ms before now). Older mtime →
 * larger offset.
 */
function writeWithMtime(filePath: string, content: string, offsetMs = 0): void {
  fs.writeFileSync(filePath, content);
  if (offsetMs !== 0) {
    const now = Date.now();
    const target = new Date(now - offsetMs);
    fs.utimesSync(filePath, target, target);
  }
}

console.log('\n=== lockfile-arbiter unit tests ===\n');

// ─── Defensive cases ──────────────────────────────────────────

test('defensive: nonexistent dir → npm/low, no warnings', () => {
  const fake = path.join(os.tmpdir(), `lockfile-arbiter-nonexistent-${Date.now()}`);
  const v = arbitrateLockfile(fake);
  assert.equal(v.packageManager, 'npm');
  assert.equal(v.confidence, 'low');
  assert.deepEqual(v.warnings, []);
});

test('defensive: empty dir → npm/low + no-lockfile warning', () => {
  const dir = makeTempProject();
  try {
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'npm');
    assert.equal(v.confidence, 'low');
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /no lockfile present/);
    assert.match(v.reason, /no lockfile/);
  } finally { rm(dir); }
});

test('defensive: malformed package.json + no lockfile → npm/low + JSON warning + no-lockfile warning', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), 'this is not json {{{');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'npm');
    assert.equal(v.confidence, 'low');
    // First warning should be the JSON warning, then the no-lockfile warning
    assert.match(v.warnings[0], /package\.json is not valid JSON/);
    assert.equal(v.warnings.length, 2);
  } finally { rm(dir); }
});

test('defensive: malformed package.json + pnpm-lock present → falls through to lockfile decision + JSON warning', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), 'broken json');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.match(v.warnings[0], /package\.json is not valid JSON/);
  } finally { rm(dir); }
});

test('defensive: empty packageManager string in package.json → ignored, falls through', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: '' }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.match(v.reason, /pnpm-lock\.yaml/);
  } finally { rm(dir); }
});

test('defensive: package.json that is an array (weird but valid JSON) → no PM declared, fall through', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(['not', 'an', 'object']));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'npm');
    assert.equal(v.confidence, 'medium');
  } finally { rm(dir); }
});

// ─── Single lockfile (medium confidence) ──────────────────────

test('single lockfile: package-lock.json only → npm/medium', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'npm');
    assert.equal(v.confidence, 'medium');
    assert.deepEqual(v.warnings, []);
    assert.match(v.reason, /package-lock\.json/);
  } finally { rm(dir); }
});

test('single lockfile: pnpm-lock.yaml only → pnpm/medium', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'medium');
    assert.deepEqual(v.warnings, []);
  } finally { rm(dir); }
});

test('single lockfile: yarn.lock only → yarn/medium', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'yarn');
    assert.equal(v.confidence, 'medium');
  } finally { rm(dir); }
});

test('single lockfile: bun.lock (text) only → bun/medium', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'bun.lock'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'bun');
    assert.equal(v.confidence, 'medium');
  } finally { rm(dir); }
});

test('single lockfile: bun.lockb (binary) only → bun/medium', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'bun');
    assert.equal(v.confidence, 'medium');
  } finally { rm(dir); }
});

// ─── Both bun lockfiles (no warning expected) ─────────────────

test('bun.lock + bun.lockb (different mtimes) → bun, no warning', () => {
  const dir = makeTempProject();
  try {
    // bun.lock newer, bun.lockb older
    writeWithMtime(path.join(dir, 'bun.lockb'), '', 60_000);
    writeWithMtime(path.join(dir, 'bun.lock'), '', 0);
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'bun');
    assert.deepEqual(v.warnings, []);
  } finally { rm(dir); }
});

// ─── Multi-PM lockfile conflict (decided by mtime) ────────────

test('conflict: pnpm-lock newer than package-lock → pnpm/high + stale warning', () => {
  const dir = makeTempProject();
  try {
    writeWithMtime(path.join(dir, 'package-lock.json'), '{}', 86_400_000); // 1 day old
    writeWithMtime(path.join(dir, 'pnpm-lock.yaml'), '', 0); // newer
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /stale package-lock\.json/);
  } finally { rm(dir); }
});

test('conflict: package-lock newer than pnpm-lock → npm/high + stale pnpm warning (awkward but rule)', () => {
  const dir = makeTempProject();
  try {
    writeWithMtime(path.join(dir, 'pnpm-lock.yaml'), '', 86_400_000); // older
    writeWithMtime(path.join(dir, 'package-lock.json'), '{}', 0); // newer
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'npm');
    assert.equal(v.confidence, 'high');
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /stale pnpm-lock\.yaml/);
  } finally { rm(dir); }
});

test('conflict: yarn-lock + package-lock, yarn newer → yarn/high + warn package-lock', () => {
  const dir = makeTempProject();
  try {
    writeWithMtime(path.join(dir, 'package-lock.json'), '{}', 60_000);
    writeWithMtime(path.join(dir, 'yarn.lock'), '', 0);
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'yarn');
    assert.equal(v.confidence, 'high');
    assert.match(v.warnings.join('\n'), /stale package-lock\.json/);
  } finally { rm(dir); }
});

test('conflict: three different PMs, pnpm newest → pnpm/high + 2 warnings', () => {
  const dir = makeTempProject();
  try {
    writeWithMtime(path.join(dir, 'package-lock.json'), '{}', 200_000);
    writeWithMtime(path.join(dir, 'yarn.lock'), '', 100_000);
    writeWithMtime(path.join(dir, 'pnpm-lock.yaml'), '', 0);
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    assert.equal(v.warnings.length, 2);
    assert.match(v.warnings.join('\n'), /stale yarn\.lock/);
    assert.match(v.warnings.join('\n'), /stale package-lock\.json/);
  } finally { rm(dir); }
});

test('conflict: warning includes ISO date', () => {
  const dir = makeTempProject();
  try {
    writeWithMtime(path.join(dir, 'package-lock.json'), '{}', 86_400_000);
    writeWithMtime(path.join(dir, 'pnpm-lock.yaml'), '', 0);
    const v = arbitrateLockfile(dir);
    // Warning should contain a YYYY-MM-DD date
    assert.match(v.warnings[0], /\d{4}-\d{2}-\d{2}/);
  } finally { rm(dir); }
});

// ─── packageManager field (corepack) — high confidence ────────

test('declared: package.json#packageManager: pnpm@8.15.0 → pnpm/high', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@8.15.0',
    }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    assert.match(v.reason, /package\.json#packageManager declares pnpm/);
    assert.deepEqual(v.warnings, []);
  } finally { rm(dir); }
});

test('declared: bun@1.1.0 with bun.lock → bun/high, no warning', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'bun@1.1.0',
    }));
    fs.writeFileSync(path.join(dir, 'bun.lock'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'bun');
    assert.equal(v.confidence, 'high');
    assert.deepEqual(v.warnings, []);
  } finally { rm(dir); }
});

test('declared: yarn@4.0.0 with yarn.lock → yarn/high', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'yarn@4.0.0',
    }));
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'yarn');
    assert.equal(v.confidence, 'high');
  } finally { rm(dir); }
});

test('declared: npm@10.0.0 with package-lock → npm/high', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.0.0',
    }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'npm');
    assert.equal(v.confidence, 'high');
  } finally { rm(dir); }
});

test('declared: pnpm@8.15.0 + only package-lock.json → pnpm/high + critical warning', () => {
  // The luca-web scenario: dev declared pnpm, but only npm lockfile commited
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@8.15.0',
    }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /declares pnpm but only/);
    assert.match(v.warnings[0], /commit pnpm-lock\.yaml/);
  } finally { rm(dir); }
});

test('declared: yarn@4 + only package-lock.json → yarn/high + mismatch warning', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'yarn@4.0.0',
    }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'yarn');
    assert.equal(v.confidence, 'high');
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /declares yarn but lockfile/);
  } finally { rm(dir); }
});

test('declared: pnpm + matching pnpm-lock + extra package-lock → still pnpm, no mismatch warning (declared wins)', () => {
  // Edge case: declared PM matches one of the present lockfiles. The declared
  // PM beats the conflict check — we trust packageManager over file presence.
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@8.15.0',
    }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    // No mismatch warning — pnpm IS in the present set
    assert.deepEqual(v.warnings, []);
  } finally { rm(dir); }
});

test('declared: declared without @version (e.g. "pnpm") → still parses', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm',
    }));
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
  } finally { rm(dir); }
});

test('declared: garbage packageManager value → ignored, fall through', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'i-am-not-a-pm@9.9.9',
    }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const v = arbitrateLockfile(dir);
    // Fall through to lockfile detection
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'medium');
  } finally { rm(dir); }
});

// ─── pnpm-workspace.yaml signal ───────────────────────────────

test('workspace: pnpm-workspace.yaml present, no lockfile → pnpm/high, no warning', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    assert.match(v.reason, /pnpm-workspace\.yaml/);
    assert.deepEqual(v.warnings, []);
  } finally { rm(dir); }
});

test('workspace: pnpm-workspace.yml (alternate ext) → pnpm/high', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yml'), 'packages: []');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
  } finally { rm(dir); }
});

test('workspace: pnpm-workspace.yaml + stale package-lock.json → pnpm/high + warning', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.equal(v.confidence, 'high');
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /stale package-lock\.json/);
    assert.match(v.warnings[0], /pnpm workspace/);
  } finally { rm(dir); }
});

// ─── Priority order verification ──────────────────────────────

test('priority: packageManager > pnpm-workspace > lockfiles', () => {
  // declared yarn, but workspace.yaml says pnpm — declared wins
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'yarn@4.0.0',
    }));
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'yarn');
    assert.equal(v.confidence, 'high');
    assert.match(v.reason, /packageManager declares yarn/);
  } finally { rm(dir); }
});

test('priority: pnpm-workspace > lockfile mtime', () => {
  // Workspace says pnpm; package-lock.json is newer mtime; workspace wins
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []');
    writeWithMtime(path.join(dir, 'pnpm-lock.yaml'), '', 86_400_000);
    writeWithMtime(path.join(dir, 'package-lock.json'), '{}', 0); // newer
    const v = arbitrateLockfile(dir);
    assert.equal(v.packageManager, 'pnpm');
    assert.match(v.reason, /pnpm-workspace/);
  } finally { rm(dir); }
});

// ─── Result shape contract ────────────────────────────────────

test('shape: result always has packageManager, confidence, reason, warnings', () => {
  const dir = makeTempProject();
  try {
    const v = arbitrateLockfile(dir);
    assert.ok(typeof v.packageManager === 'string');
    assert.ok(['high', 'medium', 'low'].includes(v.confidence));
    assert.ok(typeof v.reason === 'string' && v.reason.length > 0);
    assert.ok(Array.isArray(v.warnings));
  } finally { rm(dir); }
});

test('shape: warnings is always an array (never undefined)', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const v = arbitrateLockfile(dir);
    assert.ok(Array.isArray(v.warnings));
  } finally { rm(dir); }
});

// ─── final report ─────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
