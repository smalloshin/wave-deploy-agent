/**
 * Build-log poller — incrementally reads Cloud Build's GCS log file.
 *
 * Cloud Build streams build output to:
 *   gs://{project_num}_cloudbuild/log-{build_id}.txt
 * It's an append-only object updated every few seconds. We poll its size,
 * fetch only the new bytes via Range request, and yield them as chunks.
 *
 * Public API:
 *   - pollBuildLog(opts): async generator of `BuildLogChunk` items.
 *     Caller should `for await (const chunk of pollBuildLog(...))` and break
 *     out when build is terminal (we don't know "done" from inside the GCS
 *     poller — the caller decides via stage events).
 *
 * Kill-criteria from the spike:
 *   - p95 lag > 3s → don't claim "live"
 *   - GCS missing > 30s after build:started → mark as not-yet-available
 *
 * The poller is stateless across calls; each call walks one build's log
 * from offset 0 forward. For SSE replay, the consumer keeps a ring buffer.
 */

import { getAccessToken } from './gcp-auth';
import { safeBytes } from '../utils/safe-number.js';

export interface BuildLogChunk {
  build_id: string;
  bytes_offset: number;       // start byte of this chunk in the source object
  text: string;               // UTF-8 text payload
  gcs_updated_iso: string;    // GCS object's updated timestamp
  observed_lag_ms: number;    // wall-clock - gcs_updated
}

export interface PollOptions {
  buildId: string;
  /**
   * GCS bucket holding the build log. deploy-agent writes Cloud Build logs to
   * `gs://${gcpProject}_cloudbuild/log-{build_id}.txt` via the `logsBucket`
   * field in the Cloud Build request, so callers should pass that value here.
   * (The default Google-managed bucket uses project NUMBER instead, but we
   * don't use that path because our SA can't read it.)
   */
  bucket: string;
  pollIntervalMs?: number;    // default 1500
  abortSignal?: AbortSignal;  // caller cancels via signal
  /**
   * Maximum poll attempts before giving up if object is not yet present.
   * Default: 20 (~30s). Cloud Build typically creates the log within seconds
   * of the build starting.
   */
  maxMissingPolls?: number;
}

interface ObjectMeta {
  size: number;
  updated: string;
  exists: boolean;
}

async function statObject(bucket: string, object: string, token: string): Promise<ObjectMeta> {
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (r.status === 404) return { size: 0, updated: '', exists: false };
  if (!r.ok) throw new Error(`stat ${object} failed: ${r.status}`);
  const j = (await r.json()) as { size: string; updated: string };
  // GCS returns size as a string-encoded int. safeBytes guards against a
  // malformed payload making `meta.size` NaN, which would silently freeze the
  // poll loop (NaN > offset is always false → no chunks ever yielded).
  return { size: safeBytes(j.size), updated: j.updated, exists: true };
}

async function fetchRange(bucket: string, object: string, token: string, start: number): Promise<string> {
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: `bytes=${start}-`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 416) return '';
  if (!r.ok && r.status !== 206 && r.status !== 200) {
    throw new Error(`range fetch ${object} failed: ${r.status}`);
  }
  return await r.text();
}

export async function* pollBuildLog(opts: PollOptions): AsyncGenerator<BuildLogChunk> {
  const interval = opts.pollIntervalMs ?? 1500;
  const maxMissing = opts.maxMissingPolls ?? 20;
  const bucket = opts.bucket;
  const object = `log-${opts.buildId}.txt`;

  let offset = 0;
  let missingPolls = 0;

  while (!opts.abortSignal?.aborted) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      throw new Error(`build-log-poller: ${(err as Error).message}`);
    }

    let meta: ObjectMeta;
    try {
      meta = await statObject(bucket, object, token);
    } catch (err) {
      // Transient — back off and retry.
      console.warn(`[build-log-poller] stat error: ${(err as Error).message}`);
      await sleep(interval, opts.abortSignal);
      continue;
    }

    if (!meta.exists) {
      missingPolls++;
      if (missingPolls > maxMissing) {
        throw new Error(`build-log-poller: object ${bucket}/${object} not present after ${maxMissing} polls`);
      }
      await sleep(interval, opts.abortSignal);
      continue;
    }
    missingPolls = 0;

    if (meta.size > offset) {
      let text: string;
      try {
        text = await fetchRange(bucket, object, token, offset);
      } catch (err) {
        console.warn(`[build-log-poller] range fetch error: ${(err as Error).message}`);
        await sleep(interval, opts.abortSignal);
        continue;
      }
      const lagMs = Date.now() - new Date(meta.updated).getTime();
      yield {
        build_id: opts.buildId,
        bytes_offset: offset,
        text,
        gcs_updated_iso: meta.updated,
        observed_lag_ms: lagMs,
      };
      offset = meta.size;
    }

    await sleep(interval, opts.abortSignal);
  }
}

/**
 * One-shot fetch of a complete build log (post-mortem path).
 * Use this when the build is already terminal and you want the whole log
 * in one shot (no streaming). Returns null if the object doesn't exist.
 */
export async function fetchBuildLogOnce(buildId: string, bucket: string): Promise<{
  text: string;
  size: number;
  updated: string;
} | null> {
  const object = `log-${buildId}.txt`;
  const token = await getAccessToken();
  const meta = await statObject(bucket, object, token);
  if (!meta.exists) return null;
  const text = await fetchRange(bucket, object, token, 0);
  return { text, size: meta.size, updated: meta.updated };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
