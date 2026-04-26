// Round 27 — Chunked GCS resumable uploader.
//
// Why this exists:
//   The original uploader did `xhr.send(file)` with the entire file (up to
//   500 MB+). Any blip — Wi-Fi hiccup, Firefox tab focus loss, a 60-second
//   stall on a flaky 4G connection — drops the whole upload and surfaces
//   `network_error` to the user. They have to start the 426 MB upload from
//   byte 0. That's a real production failure (legal_flow_build.zip on
//   Firefox 149/macOS, 2026-04-26).
//
// The fix uses GCS's resumable upload protocol. The server already initiates
// a resumable session via POST and hands the client a session URI. We slice
// the file into 8 MiB chunks and PUT each chunk with a Content-Range header.
// On failure of any single chunk we:
//   1. Back off exponentially (1s, 2s, 4s, 8s, 16s, capped at 30s).
//   2. Query session status (PUT with `Content-Range: bytes */<total>` and
//      empty body) to discover what GCS actually persisted. GCS replies 308
//      with `Range: bytes=0-N` indicating bytes 0..N inclusive received.
//   3. Resume from the next byte.
//
// References:
//   - https://cloud.google.com/storage/docs/performing-resumable-uploads
//   - https://cloud.google.com/storage/docs/json_api/v1/how-tos/resumable-upload
//
// Status code semantics (per GCS docs):
//   200/201 → upload complete
//   308     → chunk accepted, more expected. Range header tells us where.
//   404/410 → session expired or invalidated. Caller must POST init again.
//   401/403 → auth failure (rare with session URI; may indicate bucket policy issue).
//   408/429/5xx → retryable
//   anything else → fatal
//
// Chunk size:
//   GCS requires multiples of 256 KiB (262144 bytes) for non-final chunks.
//   We use 8 MiB (32 × 256 KiB) which balances retry granularity vs HTTP
//   overhead on slow connections.

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
const DEFAULT_MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;

export interface ResumableUploadOpts {
  /** GCS resumable session URI (from POST /api/upload/init). */
  sessionUri: string;
  /** File or Blob to upload. */
  file: Blob;
  /** Content-Type to advertise on each chunk PUT. */
  contentType: string;
  /** Bytes per chunk. Must be a multiple of 262144 (256 KiB). Default 8 MiB. */
  chunkSize?: number;
  /** Max retries per chunk before bailing out. Default 5. */
  maxRetriesPerChunk?: number;
  /** Called with (uploadedBytes, totalBytes) on every progress event. */
  onProgress?: (loaded: number, total: number) => void;
  /** Called whenever a fresh XMLHttpRequest is created. Use to wire xhrRef for cancel. */
  onXhrCreated?: (xhr: XMLHttpRequest) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** Override sleep for tests (avoid real timer waits). */
  sleep?: (ms: number) => Promise<void>;
}

export type ResumableUploadFailure =
  | { kind: 'network_error'; chunkStart: number; chunkEnd: number; attempts: number; lastError?: string }
  | { kind: 'gcs_timeout'; chunkStart: number; chunkEnd: number; attempts: number }
  | { kind: 'gcs_auth_failed'; status: number; body: string }
  | { kind: 'session_expired'; status: number; body: string }
  | { kind: 'gcs_http_error'; status: number; body: string; chunkStart: number; chunkEnd: number }
  | { kind: 'aborted' };

export type ResumableUploadResult =
  | { ok: true; bytesUploaded: number }
  | { ok: false; failure: ResumableUploadFailure };

// ─── Pure helpers (exported for testing) ─────────────────────────────────

/**
 * Compute the byte range for the next chunk, given how much has been uploaded.
 * Returns inclusive [start, end] suitable for Content-Range and Blob.slice(start, end+1).
 */
export function computeChunkRange(
  uploadedBytes: number,
  totalBytes: number,
  chunkSize: number,
): { start: number; end: number } {
  const start = uploadedBytes;
  const end = Math.min(uploadedBytes + chunkSize, totalBytes) - 1;
  return { start, end };
}

/** Build the Content-Range header value for a chunk PUT. */
export function formatContentRange(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}

/** Build the Content-Range header value for a status query (empty PUT). */
export function formatStatusQueryRange(total: number): string {
  return `bytes */${total}`;
}

/**
 * Parse the GCS Range response header (e.g. `bytes=0-26214399`) and return
 * the next byte offset to upload. Returns 0 when no header / unparseable.
 *
 * GCS semantics: "Range: bytes=0-N" means bytes 0..N inclusive received,
 * so the next chunk starts at N+1.
 */
export function parseRangeHeader(rangeHeader: string | null | undefined): number {
  if (!rangeHeader) return 0;
  const match = rangeHeader.match(/bytes=(\d+)-(\d+)/);
  if (!match) return 0;
  return Number.parseInt(match[2], 10) + 1;
}

export type StatusVerdict =
  | 'success'         // 200/201 — upload finished
  | 'progress'        // 308 — chunk accepted, more expected
  | 'session_expired' // 404/410 — caller must reinit
  | 'auth_failed'     // 401/403 — bucket policy / token issue
  | 'retryable'       // 408/429/5xx — back off and try again
  | 'fatal';          // everything else (mostly 4xx)

export function classifyStatus(status: number): StatusVerdict {
  if (status === 200 || status === 201) return 'success';
  if (status === 308) return 'progress';
  if (status === 404 || status === 410) return 'session_expired';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return 'retryable';
  return 'fatal';
}

/** Exponential backoff: attempt 0 → 1s, 1 → 2s, 2 → 4s, 3 → 8s, 4 → 16s, then capped at 30s. */
export function backoffMs(attempt: number): number {
  if (attempt < 0) return 0;
  const ms = 1000 * Math.pow(2, attempt);
  return Math.min(ms, MAX_BACKOFF_MS);
}

// ─── XHR helpers ─────────────────────────────────────────────────────────

interface ChunkResponse {
  status: number;
  rangeHeader: string | null;
  body: string;
}

/** PUT a chunk (or empty body for status-query) and resolve with status + headers. */
function putChunkXhr(opts: {
  sessionUri: string;
  body: Blob | null;
  contentType?: string;
  contentRange: string;
  signal?: AbortSignal;
  onXhrCreated?: (xhr: XMLHttpRequest) => void;
  onProgress?: (loadedThisChunk: number) => void;
}): Promise<ChunkResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    opts.onXhrCreated?.(xhr);
    xhr.open('PUT', opts.sessionUri, true);
    if (opts.contentType && opts.body) {
      xhr.setRequestHeader('Content-Type', opts.contentType);
    }
    xhr.setRequestHeader('Content-Range', opts.contentRange);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded);
    };
    xhr.onload = () => {
      resolve({
        status: xhr.status,
        rangeHeader: xhr.getResponseHeader('Range'),
        body: typeof xhr.responseText === 'string' ? xhr.responseText.slice(0, 500) : '',
      });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.onabort = () => reject(new Error('aborted'));

    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
      } else {
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
    }

    xhr.send(opts.body);
  });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Main entry ──────────────────────────────────────────────────────────

/**
 * Upload a file to GCS using the resumable-upload protocol.
 * Slices the file into chunks, PUTs each chunk, retries on failure with
 * exponential backoff + status query.
 *
 * The `sessionUri` must be a fresh GCS resumable session URI (from
 * POST /api/upload/init). Sessions are valid for ~7 days.
 */
export async function uploadResumable(opts: ResumableUploadOpts): Promise<ResumableUploadResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxRetries = opts.maxRetriesPerChunk ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  const total = opts.file.size;

  if (opts.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } };

  // Edge: zero-byte file. GCS still wants a final PUT to close the session.
  if (total === 0) {
    try {
      const resp = await putChunkXhr({
        sessionUri: opts.sessionUri,
        body: null,
        contentRange: 'bytes */0',
        signal: opts.signal,
        onXhrCreated: opts.onXhrCreated,
      });
      const v = classifyStatus(resp.status);
      if (v === 'success') return { ok: true, bytesUploaded: 0 };
      if (v === 'session_expired')
        return { ok: false, failure: { kind: 'session_expired', status: resp.status, body: resp.body } };
      return { ok: false, failure: { kind: 'gcs_http_error', status: resp.status, body: resp.body, chunkStart: 0, chunkEnd: 0 } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'aborted') return { ok: false, failure: { kind: 'aborted' } };
      return { ok: false, failure: { kind: 'network_error', chunkStart: 0, chunkEnd: 0, attempts: 1, lastError: msg } };
    }
  }

  let uploaded = 0;

  while (uploaded < total) {
    if (opts.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } };

    const { start, end } = computeChunkRange(uploaded, total, chunkSize);
    const blob = opts.file.slice(start, end + 1);

    let attempt = 0;
    let lastErr: string | undefined;
    let advanced = false;

    while (!advanced) {
      if (opts.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } };

      // Try to PUT the current chunk.
      let resp: ChunkResponse | undefined;
      let putErr: string | undefined;
      try {
        resp = await putChunkXhr({
          sessionUri: opts.sessionUri,
          body: blob,
          contentType: opts.contentType,
          contentRange: formatContentRange(start, end, total),
          signal: opts.signal,
          onXhrCreated: opts.onXhrCreated,
          onProgress: (loadedThisChunk) => {
            opts.onProgress?.(uploaded + loadedThisChunk, total);
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'aborted') return { ok: false, failure: { kind: 'aborted' } };
        putErr = msg;
        lastErr = msg;
      }

      // Handle the PUT response (if any).
      if (resp) {
        const v = classifyStatus(resp.status);
        if (v === 'success') {
          opts.onProgress?.(total, total);
          return { ok: true, bytesUploaded: total };
        }
        if (v === 'progress') {
          const next = parseRangeHeader(resp.rangeHeader);
          uploaded = next > uploaded ? next : end + 1;
          advanced = true;
          break;
        }
        if (v === 'session_expired') {
          return { ok: false, failure: { kind: 'session_expired', status: resp.status, body: resp.body } };
        }
        if (v === 'auth_failed') {
          return { ok: false, failure: { kind: 'gcs_auth_failed', status: resp.status, body: resp.body } };
        }
        if (v === 'fatal') {
          return {
            ok: false,
            failure: { kind: 'gcs_http_error', status: resp.status, body: resp.body, chunkStart: start, chunkEnd: end },
          };
        }
        // retryable: fall through to backoff + retry
        lastErr = `HTTP ${resp.status}`;
      }

      // Either the PUT threw, or it returned a retryable status.
      attempt++;
      if (attempt > maxRetries) {
        if (putErr === 'timeout') {
          return { ok: false, failure: { kind: 'gcs_timeout', chunkStart: start, chunkEnd: end, attempts: attempt } };
        }
        return {
          ok: false,
          failure: { kind: 'network_error', chunkStart: start, chunkEnd: end, attempts: attempt, lastError: lastErr },
        };
      }
      await sleep(backoffMs(attempt - 1));

      // After backoff, query session status. GCS may have persisted some/all
      // of the chunk before the connection died — no point re-uploading what
      // it already has.
      try {
        const qr = await putChunkXhr({
          sessionUri: opts.sessionUri,
          body: null,
          contentRange: formatStatusQueryRange(total),
          signal: opts.signal,
          onXhrCreated: opts.onXhrCreated,
        });
        const qv = classifyStatus(qr.status);
        if (qv === 'success') {
          opts.onProgress?.(total, total);
          return { ok: true, bytesUploaded: total };
        }
        if (qv === 'progress') {
          const next = parseRangeHeader(qr.rangeHeader);
          if (next > uploaded) {
            uploaded = next;
            advanced = true;
            break; // outer loop re-slices from new offset
          }
          // GCS confirms it has the same offset; retry the same chunk.
          continue;
        }
        if (qv === 'session_expired') {
          return { ok: false, failure: { kind: 'session_expired', status: qr.status, body: qr.body } };
        }
        if (qv === 'auth_failed') {
          return { ok: false, failure: { kind: 'gcs_auth_failed', status: qr.status, body: qr.body } };
        }
        // Fatal/unexpected on status query: keep retrying the chunk; we'll bail at maxRetries.
      } catch {
        // Status query also failed — no info, keep retrying the chunk.
      }
    }
  }

  opts.onProgress?.(total, total);
  return { ok: true, bytesUploaded: total };
}
