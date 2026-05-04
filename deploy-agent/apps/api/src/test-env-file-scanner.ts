/**
 * Tests: env-file-scanner (R55)
 *
 * Why this matters:
 *   R49 false-positive fix. luca-v2-20260504-luca-optimizer-kb canonical:
 *   user committed `.env` with `GEMINI_API_KEY=AIzaSy...`, R49 didn't read
 *   it, blocked at Step 2.7 with "missing required env var GEMINI_API_KEY".
 *   Frustrating UX: I literally have it in source, why are you blocking?
 *
 * What we lock in:
 *   - parseEnvFileContent: comments, blanks, quoted values, export prefix,
 *     inline `#` comment stripping (only on unquoted values), invalid
 *     identifiers rejected
 *   - scanEnvFiles: reads .env / .env.local / .env.production / .env.staging
 *     / .env.development; SKIPS .env.example / .env.sample / .env.template
 *     / .env.dist / .env.test / .env.tpl (template files have placeholder
 *     values, not user-provided)
 *   - detectRealSecret: true positives (sk-..., AIza..., EAA..., GOCSPX-,
 *     ghp_..., long hex), true negatives (placeholders like your-key-here,
 *     <replace>, ${VAR}, xxx, true/false, port numbers)
 *   - Defensive: missing dir, malformed file, oversize file, binary garbage
 *     → returns empty result, never throws
 *
 * Run: bun run src/test-env-file-scanner.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnvFileContent,
  scanEnvFiles,
  detectRealSecret,
} from './services/env-file-scanner';

let passed = 0;
let failed = 0;
const tempDirs: string[] = [];

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

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-file-scanner-test-'));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('\n=== env-file-scanner unit tests ===\n');

// ─── parseEnvFileContent ────────────────────────────────────

test('parses simple KEY=VALUE pairs', () => {
  const m = parseEnvFileContent('FOO=bar\nBAZ=qux');
  assert.equal(m.get('FOO'), 'bar');
  assert.equal(m.get('BAZ'), 'qux');
  assert.equal(m.size, 2);
});

test('skips blank lines and # comments', () => {
  const m = parseEnvFileContent('# hello\n\nFOO=bar\n# trailing comment\n');
  assert.equal(m.size, 1);
  assert.equal(m.get('FOO'), 'bar');
});

test('handles export PREFIX (bash-style env file)', () => {
  const m = parseEnvFileContent('export FOO=bar\nexport BAZ=qux');
  assert.equal(m.get('FOO'), 'bar');
  assert.equal(m.get('BAZ'), 'qux');
});

test('strips surrounding double quotes from values', () => {
  const m = parseEnvFileContent('FOO="hello world"');
  assert.equal(m.get('FOO'), 'hello world');
});

test('strips surrounding single quotes from values', () => {
  const m = parseEnvFileContent("FOO='hello world'");
  assert.equal(m.get('FOO'), 'hello world');
});

test('trims trailing inline # comment on UNQUOTED values', () => {
  const m = parseEnvFileContent('FOO=bar # this is a comment');
  assert.equal(m.get('FOO'), 'bar');
});

test('does NOT strip # inside QUOTED values', () => {
  const m = parseEnvFileContent('FOO="value with # inside"');
  assert.equal(m.get('FOO'), 'value with # inside');
});

test('rejects invalid identifiers (numeric prefix, dashes, etc)', () => {
  const m = parseEnvFileContent('1FOO=bar\nFOO-BAR=qux\nFOO BAR=baz\n=value');
  assert.equal(m.size, 0);
});

test('accepts underscore + alphanumeric identifiers', () => {
  const m = parseEnvFileContent('_FOO=a\nFOO_BAR_2=b\nA1=c');
  assert.equal(m.size, 3);
});

test('handles empty values', () => {
  const m = parseEnvFileContent('FOO=\nBAR=  ');
  assert.equal(m.get('FOO'), '');
  assert.equal(m.get('BAR'), '');
});

test('handles values containing = sign', () => {
  const m = parseEnvFileContent('CONNECTION_STRING=key=value;other=thing');
  assert.equal(m.get('CONNECTION_STRING'), 'key=value;other=thing');
});

test('non-string input → empty Map, no throw', () => {
  // @ts-expect-error testing defensive guard
  const m = parseEnvFileContent(null);
  assert.equal(m.size, 0);
});

test('CRLF line endings (Windows-style)', () => {
  const m = parseEnvFileContent('FOO=bar\r\nBAR=baz\r\n');
  assert.equal(m.get('FOO'), 'bar');
  assert.equal(m.get('BAR'), 'baz');
});

// ─── detectRealSecret ────────────────────────────────────

test('OpenAI sk-svcacct- key → real secret', () => {
  const r = detectRealSecret('sk-svcacct-OhzTMp5vBf3oVKxNS7Rg8ZcNGwzBRVHdkxECZo6_nIcXuDv0');
  assert.match(r ?? '', /OpenAI service account/);
});

test('OpenAI sk- key → real secret', () => {
  assert.ok(detectRealSecret('sk-abc123def456ghi789jkl012mno'));
});

test('Anthropic sk-ant- key → real secret', () => {
  assert.match(
    detectRealSecret('sk-ant-abc123def456ghi789jkl012mno') ?? '',
    /Anthropic/,
  );
});

test('Google AIza key → real secret', () => {
  assert.match(
    detectRealSecret('AIzaSyCXUnYqWGCzpMHmv6mZDPmz8iCViRPpvUk') ?? '',
    /Google API key/,
  );
});

test('Meta EAA token → real secret', () => {
  assert.match(
    detectRealSecret('EAAMyof4K2FcBRPRceXiZCRZB8X1gZBUCXDwZBWlsbAc2qRAtTvB20rtbvav4553Ed4GZA9V1Mm0o3ahy8') ?? '',
    /Meta.*Facebook/,
  );
});

test('Google OAuth GOCSPX- → real secret', () => {
  assert.match(
    detectRealSecret('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') ?? '',
    /Google OAuth/,
  );
});

test('long hex string → real secret', () => {
  assert.match(
    detectRealSecret('f89964c7491f16e2abfdfcd447c2879ec04ec413c2e0247c29e1d9f6930c2008') ?? '',
    /hex/,
  );
});

test('GitHub ghp_ token → real secret', () => {
  assert.match(
    detectRealSecret('ghp_abc123def456ghi789jkl012mno345pqr678') ?? '',
    /GitHub/,
  );
});

test('placeholder "your-api-key" → NOT a secret', () => {
  assert.equal(detectRealSecret('your-api-key'), null);
  assert.equal(detectRealSecret('your_secret'), null);
  assert.equal(detectRealSecret('YOUR-KEY-HERE'), null);
});

test('placeholder "<replace>" → NOT a secret', () => {
  assert.equal(detectRealSecret('<replace-me>'), null);
  assert.equal(detectRealSecret('<your-api-key>'), null);
});

test('placeholder "xxx" / "TODO" → NOT a secret', () => {
  assert.equal(detectRealSecret('xxx'), null);
  assert.equal(detectRealSecret('xxxxxx'), null);
  assert.equal(detectRealSecret('TODO'), null);
  assert.equal(detectRealSecret('change-me'), null);
});

test('${VAR} reference → NOT a secret', () => {
  assert.equal(detectRealSecret('${SOME_VAR}'), null);
});

test('boolean / null sentinels → NOT a secret', () => {
  assert.equal(detectRealSecret('true'), null);
  assert.equal(detectRealSecret('false'), null);
  assert.equal(detectRealSecret('null'), null);
  assert.equal(detectRealSecret('NONE'), null);
});

test('pure number (port) → NOT a secret', () => {
  assert.equal(detectRealSecret('3000'), null);
  assert.equal(detectRealSecret('5432'), null);
});

test('short value → NOT a secret', () => {
  assert.equal(detectRealSecret('abc'), null);
  assert.equal(detectRealSecret('short'), null);
});

test('empty / non-string → NOT a secret, no throw', () => {
  assert.equal(detectRealSecret(''), null);
  // @ts-expect-error testing defensive guard
  assert.equal(detectRealSecret(null), null);
  // @ts-expect-error testing defensive guard
  assert.equal(detectRealSecret(undefined), null);
});

test('quoted real-looking value still detected (strips quotes first)', () => {
  // .env file: FOO="sk-real-token-123..."
  assert.ok(detectRealSecret('"sk-real-token-abc123def456ghi789jkl"'));
});

// ─── scanEnvFiles ────────────────────────────────────

test('reads .env at project root', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, '.env'), 'FOO=bar\nBAZ=qux');
  const r = scanEnvFiles(dir);
  assert.deepEqual([...r.keys].sort(), ['BAZ', 'FOO']);
  assert.deepEqual(r.filesRead, ['.env']);
  assert.equal(r.realSecretsDetected.length, 0);
});

test('reads multiple env files and merges keys', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, '.env'), 'A=1');
  writeFileSync(join(dir, '.env.production'), 'B=2');
  writeFileSync(join(dir, '.env.local'), 'C=3');
  const r = scanEnvFiles(dir);
  assert.deepEqual([...r.keys].sort(), ['A', 'B', 'C']);
  assert.equal(r.filesRead.length, 3);
});

test('SKIPS .env.example (template, not real values)', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, '.env.example'), 'API_KEY=your-key-here');
  const r = scanEnvFiles(dir);
  assert.equal(r.keys.size, 0, 'should not include keys from .env.example');
  assert.deepEqual(r.filesRead, []);
});

test('SKIPS .env.sample / .env.template / .env.dist / .env.test / .env.tpl', () => {
  const dir = makeTempProject();
  for (const skip of ['.env.sample', '.env.template', '.env.dist', '.env.test', '.env.tpl']) {
    writeFileSync(join(dir, skip), 'KEY=val');
  }
  const r = scanEnvFiles(dir);
  assert.equal(r.keys.size, 0);
  assert.deepEqual(r.filesRead, []);
});

test('mixes read+skip files correctly', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, '.env'), 'REAL=value');
  writeFileSync(join(dir, '.env.example'), 'TEMPLATE=placeholder');
  const r = scanEnvFiles(dir);
  assert.deepEqual([...r.keys], ['REAL']);
  assert.deepEqual(r.filesRead, ['.env']);
});

test('canonical luca case: .env with GEMINI_API_KEY → key extracted + flagged as real secret', () => {
  const dir = makeTempProject();
  writeFileSync(
    join(dir, '.env'),
    `# Luca Backend .env
PORT=3002
JWT_SECRET=f89964c7491f16e2abfdfcd447c2879ec04ec413c2e0247c29e1d9f6930c2008
OPENAI_API_KEY=sk-svcacct-OhzTMp5vBf3oVKxNS7Rg8ZcNGwzBRVHdkxECZo6_nIcXuDv0
GEMINI_API_KEY=AIzaSyCXUnYqWGCzpMHmv6mZDPmz8iCViRPpvUk`,
  );
  const r = scanEnvFiles(dir);
  assert.ok(r.keys.has('GEMINI_API_KEY'), 'GEMINI_API_KEY must be extracted');
  assert.ok(r.keys.has('JWT_SECRET'));
  assert.ok(r.keys.has('OPENAI_API_KEY'));
  assert.ok(r.keys.has('PORT'));
  // 3 of those values are real secrets — should be flagged
  const flaggedNames = r.realSecretsDetected.map((s) => s.key).sort();
  assert.deepEqual(flaggedNames, ['GEMINI_API_KEY', 'JWT_SECRET', 'OPENAI_API_KEY']);
  // PORT (3002) is NOT a secret
  assert.ok(!flaggedNames.includes('PORT'));
});

test('non-existent dir → empty result, no throw', () => {
  const r = scanEnvFiles('/nonexistent/path/abc123');
  assert.equal(r.keys.size, 0);
  assert.deepEqual(r.filesRead, []);
});

test('empty dir → empty result, no throw', () => {
  const dir = makeTempProject();
  const r = scanEnvFiles(dir);
  assert.equal(r.keys.size, 0);
  assert.deepEqual(r.filesRead, []);
});

test('empty .env file → no keys, no error', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, '.env'), '');
  const r = scanEnvFiles(dir);
  assert.equal(r.keys.size, 0);
  // empty parse → file not in filesRead
  assert.deepEqual(r.filesRead, []);
});

test('oversize .env (>100KB) is skipped', () => {
  const dir = makeTempProject();
  const huge = `BIG=${'x'.repeat(200_000)}`;
  writeFileSync(join(dir, '.env'), huge);
  const r = scanEnvFiles(dir);
  assert.equal(r.keys.size, 0);
});

test('subdirectories with .env are NOT scanned (root-only)', () => {
  const dir = makeTempProject();
  mkdirSync(join(dir, 'subdir'));
  writeFileSync(join(dir, 'subdir', '.env'), 'NESTED=value');
  const r = scanEnvFiles(dir);
  assert.equal(r.keys.size, 0, 'should not recurse');
});

test('non-string projectDir → empty result', () => {
  // @ts-expect-error testing defensive guard
  assert.equal(scanEnvFiles(null).keys.size, 0);
  // @ts-expect-error testing defensive guard
  assert.equal(scanEnvFiles(undefined).keys.size, 0);
  assert.equal(scanEnvFiles('').keys.size, 0);
});

test('placeholder values do NOT trigger secret warning', () => {
  const dir = makeTempProject();
  writeFileSync(
    join(dir, '.env'),
    `OPENAI_API_KEY=your-openai-key
DATABASE_URL=<your-db-url>
JWT_SECRET=change-me`,
  );
  const r = scanEnvFiles(dir);
  assert.equal(r.realSecretsDetected.length, 0, 'placeholders should not flag');
  assert.equal(r.keys.size, 3, 'keys still extracted');
});

cleanup();
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
