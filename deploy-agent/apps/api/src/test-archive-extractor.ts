/**
 * R62 (2026-05-07): tests for archive-extractor
 *
 * Covers detectArchiveFormat (pure) + extractArchive (filesystem-touching
 * but uses tmpdir). Both routes (submit-gcs + new-version) depend on this
 * helper so wire-contract here keeps them in sync.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  detectArchiveFormat,
  extractArchive,
} from './services/archive-extractor';

const execFileAsync = promisify(execFile);

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'archive-extractor-test-'));
  tempDirs.push(d);
  return d;
}
function cleanup() {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// detectArchiveFormat (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('detectArchiveFormat: .zip → zip', () => {
  assert.equal(detectArchiveFormat('foo.zip'), 'zip');
  assert.equal(detectArchiveFormat('FOO.ZIP'), 'zip');
});

test('detectArchiveFormat: .tar.gz → tar.gz', () => {
  assert.equal(detectArchiveFormat('source.tar.gz'), 'tar.gz');
  assert.equal(detectArchiveFormat('SOURCE.TAR.GZ'), 'tar.gz');
});

test('detectArchiveFormat: .tgz → tar.gz', () => {
  assert.equal(detectArchiveFormat('snap.tgz'), 'tar.gz');
});

test('detectArchiveFormat: .tar → tar', () => {
  assert.equal(detectArchiveFormat('plain.tar'), 'tar');
});

test('detectArchiveFormat: unknown extension → null', () => {
  assert.equal(detectArchiveFormat('foo.7z'), null);
  assert.equal(detectArchiveFormat('foo.rar'), null);
  assert.equal(detectArchiveFormat('foo'), null);
  assert.equal(detectArchiveFormat(''), null);
});

test('detectArchiveFormat: case-insensitive', () => {
  assert.equal(detectArchiveFormat('Foo.ZiP'), 'zip');
  assert.equal(detectArchiveFormat('Source.Tar.Gz'), 'tar.gz');
});

// ─────────────────────────────────────────────────────────────────────────────
// extractArchive (round-trip with real tar/unzip)
// ─────────────────────────────────────────────────────────────────────────────

async function makeTarGz(workDir: string, files: Array<{ name: string; content: string }>): Promise<string> {
  const stage = join(workDir, 'stage');
  mkdirSync(stage, { recursive: true });
  for (const f of files) {
    writeFileSync(join(stage, f.name), f.content);
  }
  const out = join(workDir, 'archive.tar.gz');
  await execFileAsync('tar', ['-czf', out, '-C', stage, '.']);
  return out;
}

async function makeZip(workDir: string, files: Array<{ name: string; content: string }>): Promise<string> {
  const stage = join(workDir, 'stage');
  mkdirSync(stage, { recursive: true });
  for (const f of files) {
    writeFileSync(join(stage, f.name), f.content);
  }
  const out = join(workDir, 'archive.zip');
  // `zip -r out.zip .` from inside stage dir; -q for quiet
  await execFileAsync('zip', ['-q', '-r', out, '.'], { cwd: stage });
  return out;
}

async function makeTar(workDir: string, files: Array<{ name: string; content: string }>): Promise<string> {
  const stage = join(workDir, 'stage');
  mkdirSync(stage, { recursive: true });
  for (const f of files) {
    writeFileSync(join(stage, f.name), f.content);
  }
  const out = join(workDir, 'archive.tar');
  await execFileAsync('tar', ['-cf', out, '-C', stage, '.']);
  return out;
}

test('extractArchive: tar.gz round-trip extracts all entries', async () => {
  const workDir = makeTempDir();
  const archive = await makeTarGz(workDir, [
    { name: 'a.txt', content: 'aaa' },
    { name: 'b.txt', content: 'bbb' },
  ]);
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(archive, extractDir, 'archive.tar.gz');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.format, 'tar.gz');
  const entries = readdirSync(extractDir).sort();
  assert.deepEqual(entries, ['a.txt', 'b.txt']);
});

test('extractArchive: .tgz alias works same as .tar.gz', async () => {
  const workDir = makeTempDir();
  const archive = await makeTarGz(workDir, [{ name: 'x.txt', content: 'x' }]);
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  // Pretend it's named with .tgz
  const r = await extractArchive(archive, extractDir, 'archive.tgz');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.format, 'tar.gz');
  assert.deepEqual(readdirSync(extractDir), ['x.txt']);
});

test('extractArchive: zip round-trip — the case versioning.ts pre-R62 missed', async () => {
  const workDir = makeTempDir();
  const archive = await makeZip(workDir, [
    { name: 'index.html', content: '<html></html>' },
    { name: 'main.py', content: 'print("hi")' },
  ]);
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(archive, extractDir, 'archive.zip');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.format, 'zip');
  const entries = readdirSync(extractDir).sort();
  assert.deepEqual(entries, ['index.html', 'main.py']);
});

test('extractArchive: plain .tar (uncompressed) round-trip', async () => {
  const workDir = makeTempDir();
  const archive = await makeTar(workDir, [{ name: 'plain.txt', content: 'p' }]);
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(archive, extractDir, 'archive.tar');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.format, 'tar');
  assert.deepEqual(readdirSync(extractDir), ['plain.txt']);
});

test('extractArchive: unknown extension returns unsupported_format', async () => {
  const workDir = makeTempDir();
  // Make some random file (not a real archive) just so the path exists.
  writeFileSync(join(workDir, 'foo.7z'), 'not an archive');
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(join(workDir, 'foo.7z'), extractDir, 'foo.7z');
  assert.equal(r.ok, false);
  if (!r.ok && r.code === 'unsupported_format') {
    assert.equal(r.extension, '.7z');
  } else {
    assert.fail(`expected unsupported_format, got ${JSON.stringify(r)}`);
  }
});

test('extractArchive: extension dispatch is case-insensitive', async () => {
  const workDir = makeTempDir();
  const archive = await makeTarGz(workDir, [{ name: 'y.txt', content: 'y' }]);
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(archive, extractDir, 'ARCHIVE.TAR.GZ');
  assert.equal(r.ok, true);
});

test('extractArchive: corrupt tar.gz returns extract_failed (no throw)', async () => {
  const workDir = makeTempDir();
  // Plain text file with .tar.gz extension — tar will reject.
  const fakePath = join(workDir, 'fake.tar.gz');
  writeFileSync(fakePath, 'not a real archive');
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(fakePath, extractDir, 'fake.tar.gz');
  assert.equal(r.ok, false);
  if (!r.ok && r.code === 'extract_failed') {
    assert.equal(r.format, 'tar.gz');
    assert.ok(r.error.length > 0);
  } else {
    assert.fail(`expected extract_failed, got ${JSON.stringify(r)}`);
  }
});

test('extractArchive: missing file returns extract_failed (no throw)', async () => {
  const workDir = makeTempDir();
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  const r = await extractArchive(
    join(workDir, 'does-not-exist.tar.gz'),
    extractDir,
    'does-not-exist.tar.gz',
  );
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    const result = t.fn();
    if (result instanceof Promise) await result;
    passed++;
  } catch (err) {
    failed++;
    console.error(`✗ ${t.name}`);
    console.error(`  ${(err as Error).message}`);
  }
}

cleanup();
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
