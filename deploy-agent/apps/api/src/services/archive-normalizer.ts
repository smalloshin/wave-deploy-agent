/**
 * Round 44d (2026-04-28): archive-normalizer
 *
 * Windows-created zip files store paths with backslash separators
 * (`legal_flow\package.json`). Different unzip implementations handle this
 * differently:
 *
 *   - macOS Info-ZIP unzip: auto-converts `\` → `/`, creates real dirs
 *   - Linux Info-ZIP unzip: prints "appears to use backslashes as path
 *     separators" warning, but on some builds STILL preserves backslash as
 *     a literal filename character
 *   - Alpine BusyBox unzip (used in our Cloud Run image via
 *     `apk add --no-cache python3 py3-pip ...` — note: unzip comes implicitly
 *     via BusyBox applet, NOT Info-ZIP): preserves `\` literally
 *
 * Symptom: extractDir contains files like `legal_flow\package.json`,
 * `legal_flow\.env`, etc. — single flat layer with backslash-laden filenames.
 * project-detector.ts uses `path.basename(...)` to build a Set of root-level
 * markers; on Linux `path.basename('legal_flow\\package.json')` returns the
 * full string (Linux POSIX has no concept of `\` as separator), so
 * `fileNames.has('package.json')` is false and detection returns
 * `language: 'unknown'`.
 *
 * Fix: after every unzip step, walk extractDir and for each entry whose name
 * contains `\`, rename it into the correct subdirectory structure (creating
 * intermediate dirs as needed). After normalization, the layout matches what
 * a unix-native zip would have produced, and downstream code (single-subdir
 * descent at routes/projects.ts:631-638, project-detector.ts) works
 * unchanged.
 *
 * Idempotent + safe-by-default:
 *   - If unzip already converted backslashes → no entries match → no-op
 *   - If two normalized paths collide (e.g. `a\b` and `a/b` both exist) →
 *     skip the rename, log to result.collisions, leave source in place
 *   - Path traversal guard: rejects normalized paths that escape extractDir
 *     after `path.resolve` (defense against `..\..\etc\passwd` filenames)
 *
 * Round 44f (2026-04-30): adds two extra helpers used by pipeline-worker
 * after the GCS-source re-extract path (which previously skipped the
 * normalize + wrapper-dir descent entirely on Cloud Run revision change,
 * leaving fixed.tgz with both backslash root entries AND a `legal_flow/`
 * subdir). The two new helpers are:
 *
 *   - descendIntoWrapperDir(extractDir): if the directory contains exactly
 *     one subdirectory AND that subdir has a project marker
 *     (package.json / Dockerfile / requirements.txt / go.mod / pom.xml /
 *     Cargo.toml / build.gradle / Gemfile / composer.json), return the
 *     subdir path. Otherwise return extractDir. Mirrors the inline logic
 *     at routes/projects.ts:647-654 and routes/versioning.ts:213.
 *
 *   - sanitizeRelativePath(input, opts): pure-string helper for sanitizing
 *     LLM-emitted file paths before `path.join(projectDir, ...)`. Converts
 *     backslashes to forward slashes, strips leading slashes / drive letters
 *     / `./`, and rejects any path segment matching `..`. Optional
 *     `wrapperDirName` option strips a leading `<wrapper>/` prefix when the
 *     LLM echoes the wrapper-dir back at us.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface NormalizeResult {
  /** Total entries scanned at root level. */
  scanned: number;
  /** Entries with backslash in their basename that were renamed. */
  renamed: number;
  /** Entries skipped due to collision with an existing normalized path. */
  collisions: number;
  /** Entries skipped due to path traversal attempt. */
  blocked: number;
  /** Sample of original→normalized rename pairs (first 5, for logging). */
  samples: Array<{ from: string; to: string }>;
}

/**
 * Sweep `extractDir` once; rename any direct child whose name contains a
 * backslash into a proper subdirectory layout.
 *
 * The function inspects ONLY direct children of extractDir (the layer where
 * Linux unzip dumps backslash-laden filenames). It does not recurse — if
 * deeper levels also contain backslashes (rare, only happens with nested
 * Windows zips), call again on the resulting subdir.
 */
export async function normalizeExtractedPaths(extractDir: string): Promise<NormalizeResult> {
  const result: NormalizeResult = {
    scanned: 0,
    renamed: 0,
    collisions: 0,
    blocked: 0,
    samples: [],
  };

  let entries: string[];
  try {
    entries = fs.readdirSync(extractDir);
  } catch {
    return result;
  }

  result.scanned = entries.length;
  const resolvedRoot = path.resolve(extractDir);

  for (const entry of entries) {
    if (!entry.includes('\\')) continue;

    const oldPath = path.join(extractDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(oldPath);
    } catch {
      continue;
    }

    // Only normalize files. (Backslash-named directories are theoretically
    // possible but unobserved in the wild; treat them as out-of-scope.)
    if (!stat.isFile()) continue;

    const normalized = entry.replace(/\\/g, '/');
    const newPath = path.join(extractDir, normalized);

    // Path traversal guard: ensure newPath is still inside extractDir
    const resolvedNew = path.resolve(newPath);
    if (!resolvedNew.startsWith(resolvedRoot + path.sep) && resolvedNew !== resolvedRoot) {
      result.blocked += 1;
      continue;
    }

    // Collision guard: don't clobber an existing file at the target
    if (fs.existsSync(newPath)) {
      result.collisions += 1;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(oldPath, newPath);
      result.renamed += 1;
      if (result.samples.length < 5) {
        result.samples.push({ from: entry, to: normalized });
      }
    } catch {
      // If rename fails (e.g. cross-device — shouldn't happen since both
      // paths are under same extractDir, but be defensive), leave the file
      // in place. Don't fail the whole pipeline over a normalization edge
      // case.
      continue;
    }
  }

  return result;
}

/**
 * Project markers used to detect a real project root vs a generic directory.
 * If a single subdir contains any of these, it's almost certainly the
 * intended project root and we should descend into it.
 */
const PROJECT_MARKERS = [
  'package.json',
  'Dockerfile',
  'requirements.txt',
  'go.mod',
  'pom.xml',
  'Cargo.toml',
  'build.gradle',
  'Gemfile',
  'composer.json',
];

/**
 * If `extractDir` contains exactly one (visible) subdirectory AND that subdir
 * has a project marker, return the subdir's path. Otherwise return
 * `extractDir` unchanged.
 *
 * Mirrors the inline logic that already exists at:
 *   - apps/api/src/routes/projects.ts:647-654 (submit-gcs path)
 *   - apps/api/src/routes/versioning.ts:213    (new-version path)
 *
 * Hidden entries (`.git`, `.DS_Store`, `__MACOSX`) are ignored when counting
 * children — these don't disqualify the wrapper-dir heuristic.
 *
 * The function is a pure path resolver: it does not move or rename anything.
 * Caller decides what to do with the returned path (typically: reassign
 * `projectDir = descendIntoWrapperDir(projectDir)` after extraction).
 */
export function descendIntoWrapperDir(extractDir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch {
    return extractDir;
  }

  // Filter out hidden entries and OS junk that don't affect wrapper-detection
  const visible = entries.filter(
    (e) => !e.name.startsWith('.') && e.name !== '__MACOSX',
  );

  if (visible.length !== 1) return extractDir;
  if (!visible[0].isDirectory()) return extractDir;

  const candidate = path.join(extractDir, visible[0].name);
  const hasMarker = PROJECT_MARKERS.some((m) =>
    fs.existsSync(path.join(candidate, m)),
  );

  return hasMarker ? candidate : extractDir;
}

/**
 * Sanitize a relative path emitted by an LLM (or any untrusted source) before
 * `path.join(projectDir, ...)`. Pure-string, no filesystem access.
 *
 * Transforms applied (in order):
 *   1. Backslashes → forward slashes (handles `legal_flow\src\app.ts`)
 *   2. Strip Windows drive letter prefix (`C:/...` → `...`)
 *   3. Strip leading `/` (turn absolute paths into relative)
 *   4. Strip leading `./` repetitions
 *   5. If `options.wrapperDirName` is set, strip that prefix when present
 *      (handles the case where the LLM echoes the wrapper-dir back at us:
 *      e.g. emits `legal_flow/src/app.ts` when we want `src/app.ts`)
 *
 * Rejects (returns `null`) if the resulting path:
 *   - Is empty
 *   - Contains any `..` segment (path traversal attempt)
 *   - Contains any `.` segment (suspicious)
 *   - Contains any empty segment (e.g. `a//b`)
 *
 * Returns the sanitized path string on success, or `null` on rejection.
 * Callers should treat `null` as "skip this fix entirely; don't fall back
 * to using the raw input".
 */
export function sanitizeRelativePath(
  input: string,
  options?: { wrapperDirName?: string },
): string | null {
  if (!input || typeof input !== 'string') return null;

  let s = input.trim();
  if (!s) return null;

  // 1. Backslash → forward slash
  s = s.replace(/\\/g, '/');

  // 2. Strip Windows drive letter (C:/, D:/, etc.)
  s = s.replace(/^[a-zA-Z]:\//, '');

  // 3. Strip leading slashes
  s = s.replace(/^\/+/, '');

  // 4. Strip leading `./` repetitions
  while (s.startsWith('./')) {
    s = s.slice(2);
  }

  // 5. Strip wrapper-dir prefix if requested
  if (options?.wrapperDirName) {
    const prefix = options.wrapperDirName + '/';
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
    } else if (s === options.wrapperDirName) {
      // Path is *exactly* the wrapper-dir name — nothing left to address
      return null;
    }
  }

  if (!s) return null;

  // Validate every segment
  const segments = s.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }

  return s;
}
