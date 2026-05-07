/**
 * R61 (2026-05-07): Detect `COPY <src>` references in a Dockerfile that
 * .dockerignore excludes from the build context. Pre-build warning so users
 * don't waste 4 minutes of Cloud Build time discovering the contradiction
 * (legal-flow-20260505 canonical: `.dockerignore` had `.env*.local` AND
 * Dockerfile had `COPY .env.local .env.local`).
 *
 * Pure function — no filesystem, no DB, no time. Caller materializes the
 * two file strings.
 *
 * Outputs warnings, NOT blocks. The user owns the conflict — pipeline just
 * surfaces it in scan_report so the dashboard can show it before Cloud Build
 * runs. (Cloud Build's failure path also catches this via LLM diagnosis,
 * but pre-build catch is 5 min faster.)
 *
 * Glob support (subset of dockerignore syntax):
 *   - `*` matches any chars except `/`
 *   - `**` matches any chars including `/`
 *   - `?` matches single char except `/`
 *   - `.` and other regex specials are escaped
 *   - `!pattern` re-includes (last matching rule wins)
 *   - Trailing `/` matches a directory and anything below
 *   - Comment lines (`#`) and blank lines are ignored
 *
 * Out of scope (v1):
 *   - Path-rooted patterns (`/foo` vs `foo`) — both treated as root-level
 *   - Char classes (`[a-z]`) — not commonly used in .dockerignore
 *   - `COPY --from=stage` lines — those are already-built artifacts, no
 *     dockerignore impact
 */

export interface DockerignoreConflict {
  /** The offending Dockerfile line (full original text). */
  copyLine: string;
  /** 1-based line number in the Dockerfile. */
  lineNumber: number;
  /** The COPY src path that's excluded (e.g. ".env.local"). */
  copySource: string;
  /** The .dockerignore pattern that's excluding it (e.g. ".env*.local"). */
  excludingPattern: string;
}

export interface DetectConflictsInput {
  /** Full Dockerfile text. */
  dockerfile: string;
  /** Full .dockerignore text (or empty when none present). */
  dockerignore: string;
}

export function detectDockerignoreConflicts(
  input: DetectConflictsInput,
): DockerignoreConflict[] {
  const patterns = parseDockerignore(input.dockerignore);
  if (patterns.length === 0) return [];

  const copies = parseDockerfileCopySources(input.dockerfile);
  const conflicts: DockerignoreConflict[] = [];

  for (const c of copies) {
    const verdict = isExcluded(c.src, patterns);
    if (verdict.excluded) {
      conflicts.push({
        copyLine: c.fullLine,
        lineNumber: c.lineNumber,
        copySource: c.src,
        excludingPattern: verdict.matchedPattern,
      });
    }
  }

  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedPattern {
  /** Original pattern text (after stripping `!` and `/` prefix). */
  raw: string;
  /** True when the pattern is a re-include rule (`!pattern`). */
  isNegated: boolean;
  /** Compiled regex matching candidate paths. */
  regex: RegExp;
}

function parseDockerignore(text: string): ParsedPattern[] {
  const patterns: ParsedPattern[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    let isNegated = false;
    let pattern = line;
    if (pattern.startsWith('!')) {
      isNegated = true;
      pattern = pattern.slice(1);
    }
    // Strip leading `/` — we treat all patterns as build-context-root-relative.
    if (pattern.startsWith('/')) pattern = pattern.slice(1);

    if (pattern === '') continue;

    patterns.push({ raw: pattern, isNegated, regex: globToRegex(pattern) });
  }
  return patterns;
}

interface CopySource {
  /** Full original Dockerfile line. */
  fullLine: string;
  /** 1-based line number. */
  lineNumber: number;
  /** The single src path being COPYed (we emit one entry per src arg). */
  src: string;
}

function parseDockerfileCopySources(text: string): CopySource[] {
  const out: CopySource[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const stripped = raw.trim();
    // Match COPY or ADD (case-insensitive). Skip lines that use --from=<stage>
    // (those copy from a build stage, not from the source context — dockerignore
    // doesn't apply).
    const m = /^(?:COPY|ADD)\s+(.+)$/i.exec(stripped);
    if (!m) continue;

    const argsText = m[1] ?? '';
    if (/--from=\S+/.test(argsText)) continue;

    // Strip flags like `--chown=foo:bar` from the start.
    const args = argsText.split(/\s+/).filter((tok) => !tok.startsWith('--'));
    // Last arg is destination. Everything before is sources.
    if (args.length < 2) continue;
    const sources = args.slice(0, -1);

    for (let s of sources) {
      // Strip surrounding quotes if any.
      if (
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))
      ) {
        s = s.slice(1, -1);
      }
      // Skip URLs (ADD supports them but they bypass dockerignore).
      if (/^https?:\/\//.test(s)) continue;
      // Skip empty / dot-only.
      if (s === '' || s === '.' || s === './') continue;

      out.push({ fullLine: raw, lineNumber: i + 1, src: s });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: matching
// ─────────────────────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  // Trailing `/` makes the directory-descent suffix explicit but in either
  // case we accept descendants — a non-slash pattern still excludes its
  // children when it names a directory (gitignore semantics, which Docker
  // follows). Always emit `(?:/.*)?` so `.next` matches both `.next` and
  // `.next/standalone`.
  let g = glob;
  if (g.endsWith('/')) {
    g = g.slice(0, -1);
  }
  const dirSuffix = '(?:/.*)?';

  // Special prefix: `**/` at the start means "zero or more directory
  // segments". Standard gitignore behavior — `**/file` matches `file` at
  // root AND `dir/file` AND `a/b/file`. Without this, a leading `**` would
  // require at least one path component.
  let prefix = '';
  if (g.startsWith('**/')) {
    prefix = '(?:.*\\/)?';
    g = g.slice(3);
  }

  let regex = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? '';
    if (c === '*') {
      // `**` → match any chars including `/`. `*` → match any chars except `/`.
      if (g[i + 1] === '*') {
        regex += '.*';
        i++; // skip second *
      } else {
        regex += '[^/]*';
      }
    } else if (c === '?') {
      regex += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }

  return new RegExp('^' + prefix + regex + dirSuffix + '$');
}

function isExcluded(
  path: string,
  patterns: ParsedPattern[],
): { excluded: boolean; matchedPattern: string } {
  // Last matching rule wins (dockerignore semantics, like .gitignore).
  let lastExclude: string | null = null;
  let lastInclude: string | null = null;

  for (const p of patterns) {
    if (p.regex.test(path)) {
      if (p.isNegated) {
        lastInclude = p.raw;
      } else {
        lastExclude = p.raw;
      }
    }
  }

  // Determine final state: which one came last in the file (excluded vs
  // re-included). `parseDockerignore` preserves order; the loop above keeps
  // the latest match. Since both vars track "last seen", compare by which
  // one was set. If both set, we need to know which appeared later — use
  // an order-aware sweep.
  let finalExcluded = false;
  let finalPattern = '';
  for (const p of patterns) {
    if (p.regex.test(path)) {
      finalExcluded = !p.isNegated;
      finalPattern = p.raw;
    }
  }

  // Suppress unused warnings; they exist for future expansion.
  void lastExclude;
  void lastInclude;

  return { excluded: finalExcluded, matchedPattern: finalPattern };
}
