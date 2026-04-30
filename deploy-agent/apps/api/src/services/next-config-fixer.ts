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

export interface StrictnessFlipResult {
  /** True if the AI fix flips a true→false strictness flag we want to keep ON */
  isFlip: boolean;
  /** Which key triggered the flag (`ignoreBuildErrors` / `ignoreDuringBuilds`) */
  key?: 'ignoreBuildErrors' | 'ignoreDuringBuilds';
}

const STRICTNESS_KEYS: ReadonlyArray<'ignoreBuildErrors' | 'ignoreDuringBuilds'> = [
  'ignoreBuildErrors',
  'ignoreDuringBuilds',
];

/**
 * Detect whether an AI auto-fix is trying to flip a "skip checks" flag from
 * true to false. Pure function: input → output, no I/O.
 *
 * Why we block this:
 *   - The user's project compiles only because `ignoreBuildErrors: true`
 *     hides genuine type errors, or `ignoreDuringBuilds: true` hides genuine
 *     eslint errors. The LLM sees these flags and thinks "best practice = false".
 *   - Flipping to false without ALSO fixing every underlying error kills the
 *     build. The LLM's threat-model context doesn't include the full type-check
 *     output, so it cannot fix the real errors.
 *   - On a vibe-coded project these flags are intentional. Treat the flip as
 *     a warning, not an auto-apply.
 *
 * Detection is conservative — both halves must match in the same fix:
 *   - originalCode contains `<key>: true` (any whitespace)
 *   - fixedCode    contains `<key>: false` (any whitespace)
 * If either side is missing the key, we don't classify as a flip.
 */
export function isStrictnessFlip(
  originalCode: string,
  fixedCode: string,
): StrictnessFlipResult {
  if (typeof originalCode !== 'string' || typeof fixedCode !== 'string') {
    return { isFlip: false };
  }
  for (const key of STRICTNESS_KEYS) {
    const truePattern = new RegExp(`\\b${key}\\s*:\\s*true\\b`);
    const falsePattern = new RegExp(`\\b${key}\\s*:\\s*false\\b`);
    if (truePattern.test(originalCode) && falsePattern.test(fixedCode)) {
      return { isFlip: true, key };
    }
  }
  return { isFlip: false };
}

// ───────────────────── R44h-2: Next major version detection ─────────────────

/**
 * Read `package.json#dependencies.next` (or devDependencies), parse the major
 * version. Returns null if package.json missing, malformed, or `next` not
 * present.
 *
 * Examples:
 *   "^16.0.0"   → 16
 *   "~15.4.2"   → 15
 *   "16"        → 16
 *   "latest"    → null
 *   undefined   → null
 *
 * I/O: reads one file. Errors swallowed; null on any failure.
 */
export function detectNextMajorVersion(projectDir: string): number | null {
  const pkgPath = path.join(projectDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>;
  const raw = (deps['next'] ?? devDeps['next']) as string | undefined;
  if (typeof raw !== 'string') return null;
  return parseMajorVersion(raw);
}

/**
 * Parse a semver-ish range string and return the major number, or null.
 * Pure helper, exported for tests.
 *
 * Handles: ^16.0.0, ~15.4.2, 16.0.0, 16, >=15.0.0, 15.x, 15 || 16
 *   - Picks the FIRST integer it can find
 *   - Strips leading non-digit prefix (^, ~, >=, =, v)
 *   - Stops at first non-digit
 *   - Returns null on tags ("latest", "canary", "next"), empty, or no digits
 */
export function parseMajorVersion(spec: string): number | null {
  if (typeof spec !== 'string') return null;
  // Strip leading whitespace + range operators
  const trimmed = spec.trim();
  if (!trimmed) return null;
  // Reject pure-tag versions (no digits at all)
  if (!/\d/.test(trimmed)) return null;
  // Find first run of digits
  const m = trimmed.match(/(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ───────────────────── R44h-2: Strip deprecated `eslint` field ──────────────

export interface StripEslintResult {
  /** Whether content changed */
  changed: boolean;
  /** New file content (== input if unchanged) */
  next: string;
  /** Human-readable reason */
  reason: string;
}

/**
 * Strip the deprecated top-level `eslint: { … }` block from a Next.js config
 * file (next.config.ts / .js / .mjs).
 *
 * Pure function: string in, string out. Idempotent — re-running on stripped
 * content returns changed=false. If no eslint key found, changed=false.
 *
 * Approach: find `eslint` key at object-property position, find the colon,
 * find the opening brace `{`, walk balanced braces (respecting strings and
 * comments) to find the matching close, then consume optional trailing comma
 * and the line's terminating newline.
 *
 * Conservative: only strips when value starts with `{` (object literal).
 * Won't touch `eslint: someExternalConst` or `eslint,` (shorthand). Won't
 * touch `eslint` keys nested inside other objects (e.g. inside an
 * `experimental: { eslint: ... }` — though Next never had such a thing).
 */
export function stripEslintFromNextConfig(content: string): StripEslintResult {
  if (typeof content !== 'string') {
    return { changed: false, next: '', reason: 'invalid input' };
  }

  // Find `eslint` followed by `:` at top level of an object literal.
  // We look for the LAST occurrence in case the file has multiple — but
  // realistically there's only one. Top-level detection: the char before
  // the key (skipping whitespace/newlines) should be `{` or `,` or
  // start-of-line at file root.
  const keyPattern = /(^|[\s,{])eslint(\s*):/gm;

  let match: RegExpExecArray | null;
  // Iterate matches; first one whose value is `{ … }` wins.
  while ((match = keyPattern.exec(content)) !== null) {
    const colonEnd = match.index + match[0].length;
    // Skip whitespace after the colon
    let i = colonEnd;
    while (i < content.length && /\s/.test(content[i])) i++;
    if (content[i] !== '{') {
      // Not an object literal — could be `eslint: someVar`. Don't touch.
      continue;
    }
    // Walk balanced braces from i, respecting strings + line comments.
    const closeIdx = findMatchingBrace(content, i);
    if (closeIdx === -1) {
      return {
        changed: false,
        next: content,
        reason: 'eslint block found but braces unbalanced — refusing to edit',
      };
    }

    // Determine the start of the property — back up to include the leading
    // whitespace/indent on the same line, so we delete the entire line(s)
    // cleanly without leaving stray indent.
    // Find the start of `eslint`:
    const eslintKeyStart = match.index + (match[1] ? match[1].length : 0);
    // Walk back from eslintKeyStart over spaces/tabs to the line start.
    let lineStart = eslintKeyStart;
    while (lineStart > 0 && (content[lineStart - 1] === ' ' || content[lineStart - 1] === '\t')) {
      lineStart--;
    }

    // After the closing brace, consume optional `,` and trailing whitespace
    // up to and including the newline.
    let after = closeIdx + 1;
    if (content[after] === ',') after++;
    // Consume spaces/tabs after the comma
    while (after < content.length && (content[after] === ' ' || content[after] === '\t')) after++;
    // Consume one newline (CRLF or LF) so we don't leave a blank line behind
    if (content[after] === '\r') after++;
    if (content[after] === '\n') after++;

    const before = content.slice(0, lineStart);
    const rest = content.slice(after);
    const next = before + rest;
    return {
      changed: true,
      next,
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
    // Strings
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
        // Template literal `${...}` interpolation — skip naively by tracking
        // braces inside (good enough for next.config.ts which won't have
        // weird template literals at top level).
        if (quote === '`' && content[i] === '$' && content[i + 1] === '{') {
          let interpDepth = 1;
          i += 2;
          while (i < content.length && interpDepth > 0) {
            if (content[i] === '{') interpDepth++;
            else if (content[i] === '}') interpDepth--;
            i++;
          }
          continue;
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
