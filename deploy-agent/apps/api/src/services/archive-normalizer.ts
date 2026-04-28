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
