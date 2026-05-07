/**
 * R62 (2026-05-07): shared archive-extraction helper.
 *
 * `submit-gcs` and `new-version` both download a user-supplied archive
 * from GCS and extract it. Pre-R62 they had different format support:
 * submit-gcs accepted .zip / .tar.gz / .tgz / .tar but new-version was
 * tar.gz only. The wavenetdeveloper-rfp-agent v2 resubmit failed because
 * the user uploaded a .zip and `tar xzf` didn't grok it
 * ("gzip: stdin has more than one entry").
 *
 * This helper centralises format detection + the matching `unzip` /
 * `tar` invocation so both routes stay in sync. Pure-ish: pure on its
 * inputs (archive path + extract dir + filename), only side-effect is
 * the actual extraction.
 *
 * Supported formats:
 *   - `.zip`         → `unzip -q -o`
 *   - `.tar.gz`      → `tar -xzf`
 *   - `.tgz`         → `tar -xzf`
 *   - `.tar`         → `tar -xf`
 *
 * Anything else returns `{ ok: false, code: 'unsupported_format' }`
 * with the offending extension in the error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ARCHIVE_TIMEOUT_MS = 600_000;
export const ARCHIVE_MAX_BUFFER = 100 * 1024 * 1024;

export type ArchiveFormat = 'zip' | 'tar.gz' | 'tar';

export type ExtractResult =
  | { ok: true; format: ArchiveFormat }
  | { ok: false; code: 'unsupported_format'; extension: string }
  | { ok: false; code: 'extract_failed'; format: ArchiveFormat; error: string }
  | { ok: false; code: 'extract_buffer_overflow'; format: ArchiveFormat; error: string };

/**
 * Identify the archive format from a filename. Pure helper — exported
 * so callers can pre-validate before downloading from GCS.
 *
 * Returns `null` when the extension is unrecognised so the caller can
 * surface a precise error to the user.
 */
export function detectArchiveFormat(fileName: string): ArchiveFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

/**
 * Extract `archivePath` into `extractDir`. Both must already exist on disk.
 * Caller owns the lifecycle of both paths (creation + cleanup).
 *
 * Returns a discriminated result so the caller can map to the appropriate
 * UploadFailureCode for their route. Never throws — any subprocess error
 * becomes `extract_failed` with the captured message.
 */
export async function extractArchive(
  archivePath: string,
  extractDir: string,
  fileName: string,
): Promise<ExtractResult> {
  const format = detectArchiveFormat(fileName);
  if (format === null) {
    const ext = fileName.includes('.')
      ? fileName.slice(fileName.lastIndexOf('.'))
      : 'unknown';
    return { ok: false, code: 'unsupported_format', extension: ext };
  }

  try {
    if (format === 'zip') {
      await execFileAsync(
        'unzip',
        ['-q', '-o', archivePath, '-d', extractDir],
        { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER },
      );
    } else if (format === 'tar.gz') {
      await execFileAsync(
        'tar',
        ['-xzf', archivePath, '-C', extractDir],
        { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER },
      );
    } else {
      // tar
      await execFileAsync(
        'tar',
        ['-xf', archivePath, '-C', extractDir],
        { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER },
      );
    }
    return { ok: true, format };
  } catch (err) {
    const msg = (err as Error).message;
    const isBufferOverflow = msg.toLowerCase().includes('maxbuffer');
    return {
      ok: isBufferOverflow ? false : false,
      code: isBufferOverflow ? 'extract_buffer_overflow' : 'extract_failed',
      format,
      error: msg,
    };
  }
}
