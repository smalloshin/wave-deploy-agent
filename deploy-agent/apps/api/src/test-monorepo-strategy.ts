/**
 * R60 (2026-05-07): tests for monorepo-strategy decider
 *
 * Zero-dep — `node:assert/strict` only. Run via:
 *   bash scripts/sweep-zero-dep-tests.sh
 *
 * Locks all 5 branches + edge cases:
 *   - flat (root has Dockerfile)
 *   - flat (root has package.json, auto-gen will run)
 *   - honest-monorepo (frontend/ + backend/, only backend has Dockerfile)
 *   - multi-service (2+ subdirs each have Dockerfile)
 *   - auto-gen-flat (no Dockerfile, no package.json)
 *
 * Plus regression guards:
 *   - subdirCount=2 + 0 with Dockerfile → auto-gen-flat (not honest-monorepo)
 *   - subdirCount=1 + 1 with Dockerfile → auto-gen-flat (R44f single-wrapper case;
 *     wrapper descent should have happened upstream)
 *   - root.hasDockerfile beats root.hasPackageJson (flat wins, no auto-gen)
 *   - reference identity: result is a fresh object each call (no shared state)
 */

import { strict as assert } from 'node:assert';

import {
  selectMonorepoStrategy,
  type DirEntry,
  type RootInfo,
} from './services/monorepo-strategy';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const dir = (name: string, hasDockerfile = false): DirEntry => ({
  name,
  isDir: true,
  hasDockerfile,
});

const file = (name: string): DirEntry => ({
  name,
  isDir: false,
  hasDockerfile: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — flat (root has Dockerfile)
// ─────────────────────────────────────────────────────────────────────────────

test('R1: root has Dockerfile + only files → flat', () => {
  const root: RootInfo = {
    hasDockerfile: true,
    hasPackageJson: false,
    entries: [file('main.py'), file('requirements.txt')],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'flat');
  if (result.kind === 'flat') {
    assert.equal(result.dockerfilePath, 'Dockerfile');
  }
});

test('R1: root has Dockerfile + has subdirs with Dockerfile → still flat (root wins)', () => {
  const root: RootInfo = {
    hasDockerfile: true,
    hasPackageJson: false,
    entries: [dir('subapp', true), dir('other', true)],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'flat');
});

test('R1: root has Dockerfile beats hasPackageJson', () => {
  const root: RootInfo = {
    hasDockerfile: true,
    hasPackageJson: true,
    entries: [],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'flat');
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — multi-service (≥2 subdirs each have Dockerfile)
// ─────────────────────────────────────────────────────────────────────────────

test('R2: 2 subdirs each have Dockerfile → multi-service', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('frontend', true), dir('backend', true)],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'multi-service');
  if (result.kind === 'multi-service') {
    assert.deepEqual(result.servicesWithDockerfile, ['frontend', 'backend']);
  }
});

test('R2: 3 subdirs all with Dockerfile → multi-service', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [
      dir('web', true),
      dir('api', true),
      dir('worker', true),
      file('README.md'),
    ],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'multi-service');
  if (result.kind === 'multi-service') {
    assert.deepEqual(result.servicesWithDockerfile, ['web', 'api', 'worker']);
  }
});

test('R2: multi-service preserves subdir order', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('zzz-last', true), dir('aaa-first', true)],
  };
  const result = selectMonorepoStrategy(root);
  if (result.kind === 'multi-service') {
    // Order from input preserved (caller controls sort).
    assert.deepEqual(result.servicesWithDockerfile, ['zzz-last', 'aaa-first']);
  } else {
    assert.fail('expected multi-service');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — auto-gen-flat when root has package.json but no Dockerfile
// ─────────────────────────────────────────────────────────────────────────────

test('R3: root has package.json, no Dockerfile → auto-gen-flat', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: true,
    entries: [file('package.json'), file('vite.config.ts'), dir('src')],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'auto-gen-flat');
  if (result.kind === 'auto-gen-flat') {
    assert.equal(result.dockerfilePath, 'Dockerfile');
  }
});

test('R3: root has package.json + a subdir w/ Dockerfile → still auto-gen-flat (package.json wins)', () => {
  // package.json at root signals single-project — even if a subdir has a
  // stale Dockerfile from some other tool, we generate a fresh one at root.
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: true,
    entries: [dir('docker-stuff', true), file('package.json')],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'auto-gen-flat');
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — honest-monorepo (rfp-agent canonical case)
// ─────────────────────────────────────────────────────────────────────────────

test('R4 canonical: frontend/ + backend/, only backend has Dockerfile → honest-monorepo', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('frontend', false), dir('backend', true)],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'honest-monorepo');
  if (result.kind === 'honest-monorepo') {
    assert.equal(result.dockerfilePath, 'backend/Dockerfile');
    assert.equal(result.subdirName, 'backend');
  }
});

test('R4: 3 subdirs (docs/ web/ api/), only api has Dockerfile → honest-monorepo points at api', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [
      dir('docs', false),
      dir('web', false),
      dir('api', true),
    ],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'honest-monorepo');
  if (result.kind === 'honest-monorepo') {
    assert.equal(result.dockerfilePath, 'api/Dockerfile');
    assert.equal(result.subdirName, 'api');
  }
});

test('R4: dirs + scattered root files → still honest-monorepo when criteria met', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [
      dir('frontend', false),
      dir('backend', true),
      file('.gitignore'),
      file('README.md'),
      file('cloudbuild.yaml'),
    ],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'honest-monorepo');
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — auto-gen-flat fallback
// ─────────────────────────────────────────────────────────────────────────────

test('R5: empty root → auto-gen-flat', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'auto-gen-flat');
});

test('R5: root has only files (no Dockerfile, no package.json) → auto-gen-flat', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [file('main.py'), file('requirements.txt')],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'auto-gen-flat');
});

test('R5 regression: 2 subdirs but 0 with Dockerfile → auto-gen-flat (not honest-monorepo)', () => {
  // honest-monorepo requires EXACTLY 1 subdir with Dockerfile. Zero falls through.
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('frontend', false), dir('backend', false)],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'auto-gen-flat');
});

test('R5 regression: 1 subdir with Dockerfile → auto-gen-flat (R44f wrapper descent runs upstream)', () => {
  // Single-subdir cases are R44f's job (descendIntoWrapperDir runs BEFORE
  // this decider). If we see a single subdir here, it means R44f opted not
  // to descend (e.g. there were also files at root), so we don't try to
  // descend either. Auto-gen at root.
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('app', true), file('README.md')],
  };
  const result = selectMonorepoStrategy(root);
  assert.equal(result.kind, 'auto-gen-flat');
});

// ─────────────────────────────────────────────────────────────────────────────
// Defensive / wire-contract
// ─────────────────────────────────────────────────────────────────────────────

test('reference: each call returns a fresh object', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('frontend', false), dir('backend', true)],
  };
  const r1 = selectMonorepoStrategy(root);
  const r2 = selectMonorepoStrategy(root);
  // Different references — caller can mutate without affecting future calls.
  assert.notEqual(r1, r2);
  assert.deepEqual(r1, r2);
});

test('honest-monorepo dockerfilePath uses forward slash even on Windows-y names', () => {
  const root: RootInfo = {
    hasDockerfile: false,
    hasPackageJson: false,
    entries: [dir('apps', false), dir('services', true)],
  };
  const result = selectMonorepoStrategy(root);
  if (result.kind === 'honest-monorepo') {
    // No backslashes — Cloud Build runs on Linux, must use POSIX paths.
    assert.equal(result.dockerfilePath.includes('\\'), false);
    assert.equal(result.dockerfilePath, 'services/Dockerfile');
  } else {
    assert.fail('expected honest-monorepo');
  }
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
