/**
 * Tests: next-config-fixer (R44h)
 *
 * Two defenses being tested here:
 *
 *   1. isStrictnessFlip — block AI auto-fixes that flip
 *      ignoreBuildErrors / ignoreDuringBuilds from true → false. The LLM
 *      doesn't have full type-check context, so flipping these flags ON
 *      vibe-coded projects breaks the build.
 *
 *   2. detectNextMajorVersion + stripEslintFromNextConfig — when Next ≥ 16,
 *      the deprecated `eslint:` block in next.config.ts errors at type-check.
 *      Strip it as defense-in-depth. Pure string transform.
 *
 * Both functions are on the deploy hot path. A regression here either
 * silently kills user builds or silently lets the AI do dangerous things.
 * Lock the wire-shape with zero-dep tests.
 *
 * Run: bun run src/test-next-config-fixer.ts (or npx tsx)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isStrictnessFlip,
  detectNextMajorVersion,
  parseMajorVersion,
  stripEslintFromNextConfig,
  findMatchingBrace,
} from './services/next-config-fixer.js';

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

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'next-cfg-fixer-'));
}

function rm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n=== next-config-fixer unit tests ===\n');

// ─── isStrictnessFlip: ignoreBuildErrors ──────────────────────

test('flip: ignoreBuildErrors true → false detected', () => {
  const r = isStrictnessFlip(
    'typescript: { ignoreBuildErrors: true }',
    'typescript: { ignoreBuildErrors: false }',
  );
  assert.equal(r.isFlip, true);
  assert.equal(r.key, 'ignoreBuildErrors');
});

test('flip: ignoreBuildErrors with extra whitespace detected', () => {
  const r = isStrictnessFlip(
    'ignoreBuildErrors :   true',
    'ignoreBuildErrors:false',
  );
  assert.equal(r.isFlip, true);
  assert.equal(r.key, 'ignoreBuildErrors');
});

test('no flip: ignoreBuildErrors false → false (idempotent)', () => {
  const r = isStrictnessFlip(
    'ignoreBuildErrors: false',
    'ignoreBuildErrors: false',
  );
  assert.equal(r.isFlip, false);
});

test('no flip: ignoreBuildErrors true → true', () => {
  const r = isStrictnessFlip(
    'ignoreBuildErrors: true',
    'ignoreBuildErrors: true',
  );
  assert.equal(r.isFlip, false);
});

test('no flip: ignoreBuildErrors not present', () => {
  const r = isStrictnessFlip(
    'somethingElse: true',
    'somethingElse: false',
  );
  assert.equal(r.isFlip, false);
});

// ─── isStrictnessFlip: ignoreDuringBuilds ─────────────────────

test('flip: ignoreDuringBuilds true → false detected', () => {
  const r = isStrictnessFlip(
    'eslint: { ignoreDuringBuilds: true }',
    'eslint: { ignoreDuringBuilds: false }',
  );
  assert.equal(r.isFlip, true);
  assert.equal(r.key, 'ignoreDuringBuilds');
});

test('flip: ignoreDuringBuilds across multiline blocks', () => {
  const r = isStrictnessFlip(
    'eslint: {\n  ignoreDuringBuilds: true,\n}',
    'eslint: {\n  ignoreDuringBuilds: false,\n}',
  );
  assert.equal(r.isFlip, true);
});

test('no flip: ignoreDuringBuilds false → true (reverse direction)', () => {
  // We only block true→false. Going false→true is benign (turn ON the bypass).
  const r = isStrictnessFlip(
    'ignoreDuringBuilds: false',
    'ignoreDuringBuilds: true',
  );
  assert.equal(r.isFlip, false);
});

// ─── isStrictnessFlip: input validation ───────────────────────

test('isStrictnessFlip: non-string original returns false', () => {
  const r = isStrictnessFlip(undefined as unknown as string, 'ignoreBuildErrors: false');
  assert.equal(r.isFlip, false);
});

test('isStrictnessFlip: non-string fixed returns false', () => {
  const r = isStrictnessFlip('ignoreBuildErrors: true', null as unknown as string);
  assert.equal(r.isFlip, false);
});

test('isStrictnessFlip: empty strings return false', () => {
  const r = isStrictnessFlip('', '');
  assert.equal(r.isFlip, false);
});

test('isStrictnessFlip: realistic fix shape (whole config block)', () => {
  const original = `const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};`;
  const fixed = original.replace('ignoreBuildErrors: true', 'ignoreBuildErrors: false');
  const r = isStrictnessFlip(original, fixed);
  assert.equal(r.isFlip, true);
  assert.equal(r.key, 'ignoreBuildErrors');
});

test('isStrictnessFlip: only matches whole word (ignoreBuildErrorsExtra not flagged)', () => {
  // Word-boundary check: a longer key shouldn't trip the regex.
  const r = isStrictnessFlip(
    'someIgnoreBuildErrorsExtra: true',
    'someIgnoreBuildErrorsExtra: false',
  );
  assert.equal(r.isFlip, false);
});

// ─── isStrictnessFlip: precedence + multiple matches ──────────

test('flip: ignoreBuildErrors flagged before ignoreDuringBuilds when both flip', () => {
  // STRICTNESS_KEYS iterates ignoreBuildErrors first.
  const r = isStrictnessFlip(
    'a: { ignoreBuildErrors: true }, b: { ignoreDuringBuilds: true }',
    'a: { ignoreBuildErrors: false }, b: { ignoreDuringBuilds: false }',
  );
  assert.equal(r.isFlip, true);
  assert.equal(r.key, 'ignoreBuildErrors');
});

// ─── parseMajorVersion ────────────────────────────────────────

test('parseMajorVersion: "^16.0.0" → 16', () => {
  assert.equal(parseMajorVersion('^16.0.0'), 16);
});

test('parseMajorVersion: "~15.4.2" → 15', () => {
  assert.equal(parseMajorVersion('~15.4.2'), 15);
});

test('parseMajorVersion: "16.0.0" → 16', () => {
  assert.equal(parseMajorVersion('16.0.0'), 16);
});

test('parseMajorVersion: "16" → 16', () => {
  assert.equal(parseMajorVersion('16'), 16);
});

test('parseMajorVersion: ">=15.0.0" → 15', () => {
  assert.equal(parseMajorVersion('>=15.0.0'), 15);
});

test('parseMajorVersion: "v16.0.0" → 16', () => {
  assert.equal(parseMajorVersion('v16.0.0'), 16);
});

test('parseMajorVersion: "15.x" → 15', () => {
  assert.equal(parseMajorVersion('15.x'), 15);
});

test('parseMajorVersion: "latest" → null', () => {
  assert.equal(parseMajorVersion('latest'), null);
});

test('parseMajorVersion: "canary" → null', () => {
  assert.equal(parseMajorVersion('canary'), null);
});

test('parseMajorVersion: "" → null', () => {
  assert.equal(parseMajorVersion(''), null);
});

test('parseMajorVersion: "  ^16.0.0  " (leading whitespace) → 16', () => {
  assert.equal(parseMajorVersion('  ^16.0.0  '), 16);
});

test('parseMajorVersion: non-string → null', () => {
  assert.equal(parseMajorVersion(undefined as unknown as string), null);
});

test('parseMajorVersion: "0" → 0 (still parses as zero)', () => {
  assert.equal(parseMajorVersion('0'), 0);
});

// ─── detectNextMajorVersion: I/O integration ──────────────────

test('detectNextMajorVersion: reads from dependencies', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '^16.0.0' } }),
    );
    assert.equal(detectNextMajorVersion(dir), 16);
  } finally { rm(dir); }
});

test('detectNextMajorVersion: reads from devDependencies', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { next: '~15.0.0' } }),
    );
    assert.equal(detectNextMajorVersion(dir), 15);
  } finally { rm(dir); }
});

test('detectNextMajorVersion: dependencies wins over devDependencies', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^16.0.0' },
        devDependencies: { next: '^14.0.0' },
      }),
    );
    assert.equal(detectNextMajorVersion(dir), 16);
  } finally { rm(dir); }
});

test('detectNextMajorVersion: missing package.json → null', () => {
  const dir = makeTempProject();
  try {
    assert.equal(detectNextMajorVersion(dir), null);
  } finally { rm(dir); }
});

test('detectNextMajorVersion: malformed package.json → null', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{not valid json');
    assert.equal(detectNextMajorVersion(dir), null);
  } finally { rm(dir); }
});

test('detectNextMajorVersion: no next dep → null', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    );
    assert.equal(detectNextMajorVersion(dir), null);
  } finally { rm(dir); }
});

test('detectNextMajorVersion: tag version "next: latest" → null', () => {
  const dir = makeTempProject();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: 'latest' } }),
    );
    assert.equal(detectNextMajorVersion(dir), null);
  } finally { rm(dir); }
});

// ─── stripEslintFromNextConfig: legal-flow canonical case ─────

test('strip: legal-flow shape (eslint block at end with trailing comma)', () => {
  const input = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pdf-parse'],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  // Must NOT contain eslint anymore at any case
  assert.equal(/^\s*eslint\s*:/m.test(r.next), false);
  // Must still contain typescript block (we only touch eslint)
  assert.match(r.next, /typescript:\s*\{/);
  // Must still contain export default
  assert.match(r.next, /export default nextConfig/);
  // Output must be syntactically reasonable — no orphan opening brace from eslint
  // (line `eslint: {` must not survive)
  assert.equal(/eslint\s*:\s*\{/.test(r.next), false);
});

test('strip: idempotent (re-running on stripped content returns changed=false)', () => {
  const input = `const nextConfig: NextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
};`;
  const r1 = stripEslintFromNextConfig(input);
  assert.equal(r1.changed, true);
  const r2 = stripEslintFromNextConfig(r1.next);
  assert.equal(r2.changed, false);
});

test('strip: no eslint key returns changed=false', () => {
  const input = `const nextConfig: NextConfig = {
  output: 'standalone',
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, false);
  assert.equal(r.next, input);
});

test('strip: eslint as non-object value (e.g. external var) is left alone', () => {
  const input = `const eslintCfg = { ignoreDuringBuilds: true };
const nextConfig = {
  eslint: eslintCfg,
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, false);
});

test('strip: nested object inside eslint block (deeper {}) walks balanced braces', () => {
  const input = `const nextConfig = {
  eslint: {
    dirs: ['src', 'app'],
    rules: {
      'no-console': 'off',
    },
  },
  output: 'standalone',
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  // output: 'standalone' must survive
  assert.match(r.next, /output:\s*'standalone'/);
  // Inner `dirs:` must be gone (proves we stripped the whole block)
  assert.equal(/dirs:\s*\[/.test(r.next), false);
});

test('strip: handles eslint at start of object literal', () => {
  const input = `const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /output:\s*'standalone'/);
});

test('strip: handles eslint as ONLY property (with trailing newline)', () => {
  const input = `const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  // Must still produce valid object literal — no orphan eslint
  assert.equal(/eslint\s*:/.test(r.next), false);
});

test('strip: no trailing comma after eslint block', () => {
  const input = `const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  }
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  // output: 'standalone' must survive
  assert.match(r.next, /output:\s*'standalone'/);
});

test('strip: CRLF line endings preserved', () => {
  const input = 'const nextConfig = {\r\n  eslint: {\r\n    ignoreDuringBuilds: true,\r\n  },\r\n  output: "standalone",\r\n};\r\n';
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /output:\s*"standalone"/);
});

test('strip: eslint with single-quote string value containing braces (string-aware)', () => {
  const input = `const nextConfig = {
  eslint: {
    config: '{"foo":"bar"}',
  },
  output: 'standalone',
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /output:\s*'standalone'/);
});

test('strip: eslint with line comment inside (comment-aware)', () => {
  const input = `const nextConfig = {
  eslint: {
    // ignore everything during builds
    ignoreDuringBuilds: true,
  },
  output: 'standalone',
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /output:\s*'standalone'/);
});

test('strip: eslint with block comment inside', () => {
  const input = `const nextConfig = {
  eslint: {
    /* multi
       line */
    ignoreDuringBuilds: true,
  },
  output: 'standalone',
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /output:\s*'standalone'/);
});

test('strip: empty content returns changed=false', () => {
  const r = stripEslintFromNextConfig('');
  assert.equal(r.changed, false);
});

test('strip: non-string input returns changed=false', () => {
  const r = stripEslintFromNextConfig(undefined as unknown as string);
  assert.equal(r.changed, false);
});

test('strip: unbalanced braces returns changed=false (defensive)', () => {
  const input = `const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  // missing close brace`;
  const r = stripEslintFromNextConfig(input);
  // We refuse to edit when we can't find the matching brace.
  assert.equal(r.changed, false);
  assert.match(r.reason, /unbalanced/);
});

test('strip: preserves leading content before eslint block', () => {
  const input = `import type { NextConfig } from "next";

// Top-of-file comment
const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  // import + comment must survive
  assert.match(r.next, /import type \{ NextConfig \} from "next";/);
  assert.match(r.next, /\/\/ Top-of-file comment/);
});

test('strip: reason field describes the action', () => {
  const input = `const nextConfig = { eslint: { ignoreDuringBuilds: true } };`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  assert.match(r.reason, /stripped/i);
});

// ─── findMatchingBrace: low-level invariants ──────────────────

test('findMatchingBrace: simple {}', () => {
  const s = '{}';
  assert.equal(findMatchingBrace(s, 0), 1);
});

test('findMatchingBrace: nested {{{}}}', () => {
  const s = '{{{}}}';
  assert.equal(findMatchingBrace(s, 0), 5);
});

test('findMatchingBrace: ignores braces inside string', () => {
  const s = '{ "}": 1 }';
  // Outer {} are at 0 and 9
  assert.equal(findMatchingBrace(s, 0), 9);
});

test('findMatchingBrace: ignores braces inside line comment', () => {
  const s = '{\n // }\n}';
  assert.equal(findMatchingBrace(s, 0), 8);
});

test('findMatchingBrace: ignores braces inside block comment', () => {
  const s = '{ /* } */ }';
  assert.equal(findMatchingBrace(s, 0), 10);
});

test('findMatchingBrace: handles backslash-escaped quote', () => {
  const s = '{ "a\\"b": 1 }';
  // Length = 13, last } is at 12
  assert.equal(findMatchingBrace(s, 0), 12);
});

test('findMatchingBrace: returns -1 when input not pointing at {', () => {
  assert.equal(findMatchingBrace('hello', 0), -1);
});

test('findMatchingBrace: returns -1 when unbalanced', () => {
  assert.equal(findMatchingBrace('{', 0), -1);
});

test('findMatchingBrace: template literal interpolation respected', () => {
  const s = '{ x: `hello ${world}` }';
  // Outer { at 0, } at 22
  assert.equal(findMatchingBrace(s, 0), 22);
});

// ─── output content verification ──────────────────────────────

test('strip output: stripped content does not contain literal "eslint"', () => {
  const input = `const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};`;
  const r = stripEslintFromNextConfig(input);
  assert.equal(r.changed, true);
  // Token "eslint" should not appear at all (this config only had it once)
  assert.equal(/eslint/i.test(r.next), false);
});

test('strip output: typescript block fully preserved', () => {
  const input = `const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};`;
  const r = stripEslintFromNextConfig(input);
  assert.match(r.next, /typescript:\s*\{[\s\S]*ignoreBuildErrors:\s*true[\s\S]*\}/);
});

test('strip output: result is valid JS object syntax (no double commas, no orphan brace)', () => {
  const input = `const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  reactStrictMode: true,
};`;
  const r = stripEslintFromNextConfig(input);
  // No double commas
  assert.equal(/,\s*,/.test(r.next), false);
  // No orphan opening brace ({\s*\n  \},)
  assert.equal(/\{\s*\}\s*,?\s*\n/.test(r.next.replace(/const nextConfig = \{/, '')), false);
  // Both surviving keys present
  assert.match(r.next, /output:\s*'standalone'/);
  assert.match(r.next, /reactStrictMode:\s*true/);
});

// ─── final report ─────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
