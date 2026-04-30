/**
 * Next config fixer (R44h)
 *
 * Two defenses bolted on after R44g shipped and legal-flow's redeploy still
 * failed:
 *
 *   1. AI fix step keeps wanting to flip `ignoreBuildErrors: true → false`
 *      and `ignoreDuringBuilds: true → false`. The LLM thinks "skipping
 *      safety checks is bad practice" and patches it. But the user already
 *      had those flags ON because the project DOES have type/eslint
 *      errors — flipping them just exposes the latent errors and the
 *      build dies in tsc/eslint.
 *
 *   2. Next.js 16 dropped the `eslint` key from `NextConfig`. Vibe-coded
 *      projects (legal-flow being canonical) still ship a stale
 *      `eslint: { ignoreDuringBuilds: true }` block which Next 16 errors on
 *      with `'eslint' does not exist in type 'NextConfig'`. We auto-strip
 *      it when Next major ≥ 16.
 *
 * Both functions are pure (string in, string out / regex check). Only
 * `detectNextMajorVersion` does I/O (reads package.json).
 */

import fs from 'node:fs';
import path from 'node:path';

// ───────────────────── R44h-1: Strictness flip guard ─────────────────────

export const STRICTNESS_KEYS = ['ignoreBuildErrors', 'ignoreDuringBuilds'] as const;
export type StrictnessKey = typeof STRICTNESS_KEYS[number];

export interface StrictnessFlipResult {
  isFlip: boolean;
  key?: StrictnessKey;
}

/**
 * Patterns precompiled at module load — `isStrictnessFlip` runs once per LLM
 * auto-fix in the deploy hot path (~20×/run). Avoids re-compiling 4 regexes
 * per call.
 */
const STRICTNESS_PATTERNS: ReadonlyArray<{
  key: StrictnessKey;
  truePat: RegExp;
  falsePat: RegExp;
}> = STRICTNESS_KEYS.map((key) => ({
  key,
  truePat: new RegExp(`\\b${key}\\s*:\\s*true\\b`),
  falsePat: new RegExp(`\\b${key}\\s*:\\s*false\\b`),
}));

/**
 * Why we block these flips: the user's project compiles only because
 * `ignoreBuildErrors: true` hides genuine type errors (or `ignoreDuringBuilds:
 * true` hides genuine eslint errors). The LLM sees the flags as "best
 * practice = false" but doesn't have the full type-check output — flipping
 * exposes the latent errors and kills the build. On vibe-coded projects
 * these flags are intentional.
 *
 * Detection is conservative — both halves must match: originalCode contains
 * `<key>: true`, fixedCode contains `<key>: false`. Either missing → not a
 * flip.
 */
export function isStrictnessFlip(
  originalCode: string,
  fixedCode: string,
): StrictnessFlipResult {
  if (typeof originalCode !== 'string' || typeof fixedCode !== 'string') {
    return { isFlip: false };
  }
  for (const { key, truePat, falsePat } of STRICTNESS_PATTERNS) {
    if (truePat.test(originalCode) && falsePat.test(fixedCode)) {
      return { isFlip: true, key };
    }
  }
  return { isFlip: false };
}

// ───────────────────── R44h-2: Next major version detection ─────────────────

/**
 * Candidate config filenames Next looks for, in resolution order. Exported so
 * other steps can iterate without redeclaring the triplet (already open-coded
 * in `routes/projects.ts` and `source-reader.ts`).
 */
export const NEXT_CONFIG_FILES = ['next.config.ts', 'next.config.js', 'next.config.mjs'] as const;

/**
 * Read `package.json#dependencies.next` (or devDependencies), parse the major
 * version. Returns null on missing / malformed / no `next` dep / tag-only
 * version (`latest`, `canary`).
 */
export function detectNextMajorVersion(projectDir: string): number | null {
  const pkg = safeReadJson(path.join(projectDir, 'package.json'));
  if (!pkg) return null;
  const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>;
  const raw = (deps['next'] ?? devDeps['next']) as string | undefined;
  if (typeof raw !== 'string') return null;
  return parseMajorVersion(raw);
}

/**
 * Parse a semver-ish range string and return the major number, or null.
 * Picks the first integer in the spec, stripping leading operators/prefixes
 * (`^`, `~`, `>=`, `v`). Returns null on tags ("latest", "canary"), empty,
 * or no digits.
 */
export function parseMajorVersion(spec: string): number | null {
  if (typeof spec !== 'string') return null;
  const m = spec.trim().match(/(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ───────────────────── R44h-2: Strip deprecated `eslint` field ──────────────

export interface StripEslintResult {
  changed: boolean;
  next: string;
  reason: string;
}

/**
 * Strip the deprecated top-level `eslint: { … }` block from a Next.js config
 * file (next.config.ts / .js / .mjs).
 *
 * Pure + idempotent. Conservative: only strips when value starts with `{`,
 * so `eslint: someExternalConst` and `eslint,` shorthand are left alone.
 * Iterates regex matches because the first hit might be a non-object value;
 * realistically configs have at most one eslint key.
 */
export function stripEslintFromNextConfig(content: string): StripEslintResult {
  if (typeof content !== 'string') {
    return { changed: false, next: '', reason: 'invalid input' };
  }

  // Top-level detection: char before the key must be `{`, `,`, or whitespace.
  const keyPattern = /(^|[\s,{])eslint(\s*):/gm;

  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(content)) !== null) {
    const colonEnd = match.index + match[0].length;
    let i = colonEnd;
    while (i < content.length && /\s/.test(content[i])) i++;
    if (content[i] !== '{') continue; // `eslint: someVar` — leave it.

    const closeIdx = findMatchingBrace(content, i);
    if (closeIdx === -1) {
      return {
        changed: false,
        next: content,
        reason: 'eslint block found but braces unbalanced — refusing to edit',
      };
    }

    // Back up over leading indent so we delete the whole line cleanly.
    const eslintKeyStart = match.index + (match[1] ? match[1].length : 0);
    let lineStart = eslintKeyStart;
    while (lineStart > 0 && (content[lineStart - 1] === ' ' || content[lineStart - 1] === '\t')) {
      lineStart--;
    }

    // Consume trailing `,`, spaces/tabs, and one newline (CRLF or LF).
    let after = closeIdx + 1;
    if (content[after] === ',') after++;
    while (after < content.length && (content[after] === ' ' || content[after] === '\t')) after++;
    if (content[after] === '\r') after++;
    if (content[after] === '\n') after++;

    return {
      changed: true,
      next: content.slice(0, lineStart) + content.slice(after),
      reason: `stripped deprecated eslint block (${closeIdx - eslintKeyStart + 1} chars)`,
    };
  }

  return {
    changed: false,
    next: content,
    reason: 'no eslint object literal found in config',
  };
}

/**
 * Walk balanced braces from position `openIdx` (which must point at `{`).
 * Respects:
 *   - Single-quote / double-quote / backtick strings (with backslash escapes)
 *   - Line comments `// …` to end of line
 *   - Block comments `/* … *​/`
 * Returns index of matching `}`, or -1 if unbalanced or input invalid.
 *
 * Exported for tests.
 */
export function findMatchingBrace(content: string, openIdx: number): number {
  if (typeof content !== 'string' || content[openIdx] !== '{') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < content.length) {
    const ch = content[i];
    // Comments
    if (ch === '/' && content[i + 1] === '/') {
      // Line comment until \n
      i += 2;
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      // Block comment until */
      i += 2;
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Strings — skip `{`/`}` inside since this loop only counts unquoted braces.
    // Template-literal `${...}` interpolation isn't unwound; next.config files
    // don't put braces in template strings, and a real one would also need
    // matched braces to compile, so the count stays balanced either way.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < content.length) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Braces
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Read + parse JSON, swallowing any error. Mirrors `prisma-fixer.ts` so the
 * two services have a consistent shape for tolerant config reads.
 */
function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
