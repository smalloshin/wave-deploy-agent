// Round 44d (2026-04-28) — Wire-contract lock for `services/archive-normalizer.ts`.
//
// Target: 1 exported function (zero deps; only node:fs / node:path / node:os).
//   - normalizeExtractedPaths(extractDir) → NormalizeResult
//
// Used in:
//   - apps/api/src/routes/projects.ts (submit-gcs flow, after unzip)
//   - apps/api/src/routes/projects.ts (multipart upload flow, after unzip)
//
// Lockdown rationale:
//   - This helper is the ONLY thing standing between Linux/Alpine BusyBox
//     unzip's "preserve backslash as literal filename" behavior and our
//     project-detector returning `language: 'unknown'`. If it regresses
//     silently, every Windows-zipped upload falls back to "Unsupported
//     language" and the user sees a confusing error.
//   - Path traversal guard is a security boundary. A malicious zip with
//     `..\..\..\etc\passwd` as filename must be REJECTED, not extracted
//     to /etc/passwd. Lock that the guard rejects (counter increments to
//     `blocked`) instead of renaming.
//   - Collision behavior: if extract dir ALREADY has both `legal_flow\foo`
//     AND `legal_flow/foo` (extreme edge — only happens if zip itself was
//     malformed), the rename must NOT clobber. Lock that we increment
//     `collisions` and leave both files in place.
//   - Idempotent: calling twice on the same dir must not double-count or
//     destroy files. Lock by running the function twice and verifying
//     second call returns renamed: 0.
//   - No-op when no backslash entries: must not touch dir, must return
//     all-zero counts. Lock to prevent future "always sweep all files"
//     regressions that would slow down clean uploads.
//
// Strategy: real fs operations against `os.tmpdir()/archive-normalizer-test-<ts>/`.
// Each test block creates its own subdir, runs the helper, asserts state,
// cleans up. Zero-dep — no DB, no network, no fastify.
//
// Output format: `=== N passed, M failed ===` so sweep-zero-dep-tests.sh
// (Format A regex) parses the summary. Exit 1 on any failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeExtractedPaths } from './services/archive-normalizer.js';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(
    ok,
    name,
    ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Make a fresh temp dir for one test block. Returns the path.
 */
function mkTmp(label: string): string {
  const dir = path.join(
    os.tmpdir(),
    `archive-normalizer-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 1: BusyBox-style backslash filenames are renamed into subdirs ────
{
  const dir = mkTmp('backslash-basic');
  try {
    // Simulate Linux/BusyBox unzip output: literal `\` in filenames at root.
    fs.writeFileSync(path.join(dir, 'legal_flow\\package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, 'legal_flow\\.env'), 'KEY=val');
    fs.writeFileSync(path.join(dir, 'legal_flow\\src\\index.ts'), 'export {};');

    const res = await normalizeExtractedPaths(dir);

    assertEq(res.renamed, 3, 'backslash-basic: renamed count = 3');
    assertEq(res.collisions, 0, 'backslash-basic: no collisions');
    assertEq(res.blocked, 0, 'backslash-basic: no traversal blocks');
    assert(
      fs.existsSync(path.join(dir, 'legal_flow', 'package.json')),
      'backslash-basic: legal_flow/package.json now exists',
    );
    assert(
      fs.existsSync(path.join(dir, 'legal_flow', '.env')),
      'backslash-basic: legal_flow/.env now exists',
    );
    assert(
      fs.existsSync(path.join(dir, 'legal_flow', 'src', 'index.ts')),
      'backslash-basic: nested legal_flow/src/index.ts created with intermediate dir',
    );
    // Original literal-backslash filenames must be gone (renamed away)
    assert(
      !fs.existsSync(path.join(dir, 'legal_flow\\package.json')),
      'backslash-basic: original literal-backslash filename removed',
    );
    // Detector contract: directory listing now has `legal_flow` subdir
    // (this is what enables the single-subdir descend at projects.ts:631)
    const rootEntries = fs.readdirSync(dir);
    assert(
      rootEntries.includes('legal_flow') &&
        fs.statSync(path.join(dir, 'legal_flow')).isDirectory(),
      'backslash-basic: root contains legal_flow as a directory',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 2: No-op when no backslash entries (clean Linux/Mac zip) ────────
{
  const dir = mkTmp('clean-zip');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};');

    const res = await normalizeExtractedPaths(dir);

    assertEq(res.renamed, 0, 'clean-zip: renamed = 0');
    assertEq(res.collisions, 0, 'clean-zip: collisions = 0');
    assertEq(res.blocked, 0, 'clean-zip: blocked = 0');
    assertEq(res.scanned, 2, 'clean-zip: scanned root entries (package.json + src)');
    // Files untouched
    assert(
      fs.existsSync(path.join(dir, 'package.json')),
      'clean-zip: package.json still at root',
    );
    assert(
      fs.existsSync(path.join(dir, 'src', 'index.ts')),
      'clean-zip: src/index.ts untouched',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 3: Path traversal guard rejects ..\..\etc\passwd ─────────────────
{
  const dir = mkTmp('traversal');
  try {
    // Adversarial: filename with backslash that, after normalization, would
    // escape extractDir. Must be BLOCKED, not renamed.
    fs.writeFileSync(path.join(dir, '..\\..\\etc\\passwd'), 'pwned');
    fs.writeFileSync(path.join(dir, 'legit\\file.txt'), 'ok');

    const res = await normalizeExtractedPaths(dir);

    // legit\file.txt should rename successfully
    // ..\..\etc\passwd should be blocked
    assertEq(res.blocked, 1, 'traversal: 1 file blocked');
    assertEq(res.renamed, 1, 'traversal: 1 legit file still renamed');
    assert(
      fs.existsSync(path.join(dir, 'legit', 'file.txt')),
      'traversal: legit file landed in correct subdir',
    );
    // The bad file is NOT created above extractDir
    const parentDir = path.dirname(dir);
    assert(
      !fs.existsSync(path.join(parentDir, '..', 'etc', 'passwd')),
      'traversal: did NOT escape to parent /etc/passwd',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 4: Collision guard — don't clobber existing target ──────────────
{
  const dir = mkTmp('collision');
  try {
    // Pre-existing target (simulates a malformed zip that has BOTH
    // `legal_flow/foo` (already a dir+file) AND `legal_flow\foo` (literal)).
    fs.mkdirSync(path.join(dir, 'legal_flow'));
    fs.writeFileSync(path.join(dir, 'legal_flow', 'foo'), 'EXISTING');
    // Now add the literal-backslash duplicate
    fs.writeFileSync(path.join(dir, 'legal_flow\\foo'), 'BACKSLASH');

    const res = await normalizeExtractedPaths(dir);

    assertEq(res.collisions, 1, 'collision: 1 collision recorded');
    assertEq(res.renamed, 0, 'collision: 0 renames (the only candidate collided)');
    // Original target untouched
    assertEq(
      fs.readFileSync(path.join(dir, 'legal_flow', 'foo'), 'utf-8'),
      'EXISTING',
      'collision: pre-existing target file content preserved (not clobbered)',
    );
    // Backslash-literal source still there (we leave it; cleanup is the
    // pipeline's problem, not this helper's)
    assert(
      fs.existsSync(path.join(dir, 'legal_flow\\foo')),
      'collision: backslash-literal source left in place after skip',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 5: Idempotent — second call is no-op ────────────────────────────
{
  const dir = mkTmp('idempotent');
  try {
    fs.writeFileSync(path.join(dir, 'a\\b.txt'), 'data');

    const first = await normalizeExtractedPaths(dir);
    const second = await normalizeExtractedPaths(dir);

    assertEq(first.renamed, 1, 'idempotent: first call renamed 1');
    assertEq(second.renamed, 0, 'idempotent: second call renamed 0 (no work)');
    assertEq(second.collisions, 0, 'idempotent: second call no collisions');
    // The file is still where it should be
    assert(
      fs.existsSync(path.join(dir, 'a', 'b.txt')),
      'idempotent: a/b.txt still in place after 2 calls',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 6: Samples array — first 5 only, ordered ────────────────────────
{
  const dir = mkTmp('samples');
  try {
    // Create 7 backslash files; expect samples to capture only first 5
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(path.join(dir, `pkg\\file${i}.txt`), `${i}`);
    }

    const res = await normalizeExtractedPaths(dir);

    assertEq(res.renamed, 7, 'samples: all 7 renamed');
    assertEq(res.samples.length, 5, 'samples: exactly 5 samples captured (cap)');
    // Each sample has from + to with backslash → forward slash transform
    for (const s of res.samples) {
      assert(
        s.from.includes('\\') && s.to.includes('/') && !s.to.includes('\\'),
        `samples: sample shape from=${s.from} to=${s.to}`,
      );
    }
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 7: Empty / nonexistent dir — graceful, no throw ─────────────────
{
  const dir = mkTmp('empty');
  try {
    const res = await normalizeExtractedPaths(dir);
    assertEq(res.scanned, 0, 'empty: scanned = 0');
    assertEq(res.renamed, 0, 'empty: renamed = 0');
  } finally {
    rmTmp(dir);
  }

  // Also test fully nonexistent path
  const ghost = path.join(os.tmpdir(), `archive-normalizer-ghost-${Date.now()}`);
  const res = await normalizeExtractedPaths(ghost);
  assertEq(res.scanned, 0, 'nonexistent: scanned = 0 (no throw)');
  assertEq(res.renamed, 0, 'nonexistent: renamed = 0 (no throw)');
}

// ─── Test 8: Directories with backslash names are SKIPPED (out of scope) ──
{
  const dir = mkTmp('backslash-dir');
  try {
    // A directory itself named `legal_flow\src` (theoretical, unobserved)
    fs.mkdirSync(path.join(dir, 'legal_flow\\src'));
    fs.writeFileSync(path.join(dir, 'legal_flow\\src', 'inner.ts'), 'x');

    const res = await normalizeExtractedPaths(dir);

    assertEq(res.renamed, 0, 'backslash-dir: directories not renamed (only files)');
    // Original entry preserved (no false rename)
    assert(
      fs.existsSync(path.join(dir, 'legal_flow\\src')),
      'backslash-dir: original backslash-named directory preserved',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 9: Mixed root — backslash files + clean files coexist ──────────
{
  const dir = mkTmp('mixed');
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# clean');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'legal_flow\\index.ts'), 'export {};');
    fs.writeFileSync(path.join(dir, 'legal_flow\\package.json'), '{}');

    const res = await normalizeExtractedPaths(dir);

    assertEq(res.renamed, 2, 'mixed: only 2 backslash files renamed');
    // Clean root files still at root, untouched
    assert(
      fs.existsSync(path.join(dir, 'README.md')),
      'mixed: README.md preserved at root',
    );
    assert(
      fs.existsSync(path.join(dir, 'package.json')),
      'mixed: root package.json preserved (NOT clobbered by legal_flow/package.json)',
    );
    // Renamed files in subdir
    assert(
      fs.existsSync(path.join(dir, 'legal_flow', 'index.ts')),
      'mixed: legal_flow/index.ts created',
    );
    assert(
      fs.existsSync(path.join(dir, 'legal_flow', 'package.json')),
      'mixed: legal_flow/package.json created',
    );
  } finally {
    rmTmp(dir);
  }
}

// ─── Test 10: Result shape contract (typed fields, no extras) ─────────────
{
  const dir = mkTmp('shape');
  try {
    const res = await normalizeExtractedPaths(dir);
    const keys = Object.keys(res).sort();
    assertEq(
      keys,
      ['blocked', 'collisions', 'renamed', 'samples', 'scanned'],
      'shape: result has exactly { scanned, renamed, collisions, blocked, samples }',
    );
    assert(typeof res.scanned === 'number', 'shape: scanned is number');
    assert(typeof res.renamed === 'number', 'shape: renamed is number');
    assert(typeof res.collisions === 'number', 'shape: collisions is number');
    assert(typeof res.blocked === 'number', 'shape: blocked is number');
    assert(Array.isArray(res.samples), 'shape: samples is array');
  } finally {
    rmTmp(dir);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
