/**
 * Dockerfile generation input sanitizers.
 *
 * Why this file exists:
 * `apps/api/src/services/dockerfile-gen.ts` interpolates user-controlled values
 * (`d.entrypoint` from package.json#main, `d.port` from various detector
 * heuristics) directly into a Dockerfile string. A vibe-coded project
 * uploaded by a user could contain a `package.json` like:
 *
 *   { "main": "index.js\"]\nUSER root\nCMD [\"/bin/sh" }
 *
 * Without sanitization, the resulting Dockerfile would be:
 *
 *   CMD ["node", "index.js"]
 *   USER root
 *   CMD ["/bin/sh"]
 *
 * The injected `USER root` runs the build as root and the second CMD
 * overwrites the first, giving the uploaded project a shell with elevated
 * privilege at deploy time. Cloud Build sandboxes the build, but the
 * principle of wave-deploy-agent — "security gate for vibe-coded projects"
 * — is violated if the project can rewrite the deploy pipeline that's
 * supposed to be checking it.
 *
 * The sanitizers in this module:
 *   - `sanitizeEntrypoint` accepts a small allowlist of POSIX path chars
 *     and rejects anything that could break out of `CMD ["node", "..."]`
 *   - `sanitizePort` wraps `safeParsePort` with a Cloud Run-friendly default
 *
 * Both are pure functions: zero side effects, no I/O, no globals. The tests
 * in `test-dockerfile-gen.ts` lock down the security invariants
 * (no newlines, no quote escape, no command substitution) as regression traps.
 */

import { safeParsePort } from '../utils/safe-number.js';

/**
 * POSIX-style path allowlist for entrypoints.
 *
 * Allows: letters, digits, `_`, `-`, `.`, `/`, `@`, `+`
 *
 * Rejects (silently → fallback):
 *   - control chars (newline, tab, NUL, etc.) — could split Dockerfile lines
 *   - double quote `"` — escapes JSON-array CMD form
 *   - backslash `\` — JSON escape, opens injection
 *   - backtick `` ` `` — shell command substitution
 *   - dollar `$` — `${var}` and `$()` expansion
 *   - whitespace (other than the no-internal-spaces rule below)
 *
 * Length cap: 200 chars (path components in real package.json#main rarely
 * exceed this; longer suggests adversarial input or a packing tool that
 * shouldn't be in production).
 */
const ENTRYPOINT_ALLOW_REGEX = /^[A-Za-z0-9_\-./@+]+$/;
const ENTRYPOINT_MAX_LEN = 200;

export function sanitizeEntrypoint(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  if (trimmed.length > ENTRYPOINT_MAX_LEN) return fallback;
  if (!ENTRYPOINT_ALLOW_REGEX.test(trimmed)) return fallback;
  // Reject leading slash (would point outside /app), reject `..` segments
  if (trimmed.startsWith('/')) return fallback;
  if (trimmed.split('/').some((seg) => seg === '..')) return fallback;
  return trimmed;
}

/**
 * Parse a port for Dockerfile interpolation.
 *
 * Returns the fallback (default 8080, Cloud Run's default port) when the
 * input is non-numeric, out of range, or non-integer.
 *
 * Why a non-null wrapper around `safeParsePort`: Dockerfile templates need
 * a number to interpolate; a `null` would render as the string `"null"` and
 * break `EXPOSE`. We pick 8080 as the fallback because Cloud Run's default
 * `PORT` env is 8080 and the nginx/static template ships listening on 80,
 * but the language-specific dockerfile templates always set ENV PORT and
 * the runtime app reads from $PORT, so the EXPOSE value mostly affects
 * documentation and Cloud Run health-check probing.
 */
export function sanitizePort(value: unknown, fallback = 8080): number {
  const parsed = safeParsePort(value);
  if (parsed === null) return fallback;
  return parsed;
}
