// Round 27 — Tests for the resumable-upload helpers.
//
// Pure-function tests: chunk math, header formatting/parsing, status
// classification, exponential backoff. No XHR, no network, no real timers.
//
// Also includes a small integration suite that drives `uploadResumable`
// with a fake XHR transport so we can verify retry + status-query logic
// end-to-end.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  computeChunkRange,
  formatContentRange,
  formatStatusQueryRange,
  parseRangeHeader,
  classifyStatus,
  backoffMs,
  uploadResumable,
} from './resumable-upload.js';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── computeChunkRange ───────────────────────────────────────────────────

assertEq(computeChunkRange(0, 100, 30), { start: 0, end: 29 }, 'computeChunkRange: first chunk');
assertEq(computeChunkRange(30, 100, 30), { start: 30, end: 59 }, 'computeChunkRange: middle chunk');
assertEq(computeChunkRange(90, 100, 30), { start: 90, end: 99 }, 'computeChunkRange: last partial chunk');
assertEq(computeChunkRange(0, 30, 30), { start: 0, end: 29 }, 'computeChunkRange: exactly aligned single chunk');
assertEq(computeChunkRange(0, 1, 30), { start: 0, end: 0 }, 'computeChunkRange: 1-byte file');

// 426.5 MB file with 8 MiB chunks
const FILE_SIZE = 426_500_000;
const CHUNK = 8 * 1024 * 1024;
assertEq(
  computeChunkRange(0, FILE_SIZE, CHUNK),
  { start: 0, end: 8_388_607 },
  'computeChunkRange: 426 MB file, first chunk is 8 MiB',
);
// final partial chunk
const LAST_OFFSET = Math.floor(FILE_SIZE / CHUNK) * CHUNK;
const lastRange = computeChunkRange(LAST_OFFSET, FILE_SIZE, CHUNK);
assert(
  lastRange.start === LAST_OFFSET && lastRange.end === FILE_SIZE - 1,
  '426 MB file: final chunk ends at file size - 1',
);

// ─── formatContentRange / formatStatusQueryRange ─────────────────────────

assertEq(formatContentRange(0, 8388607, FILE_SIZE), `bytes 0-8388607/${FILE_SIZE}`, 'formatContentRange: first chunk');
assertEq(
  formatContentRange(LAST_OFFSET, FILE_SIZE - 1, FILE_SIZE),
  `bytes ${LAST_OFFSET}-${FILE_SIZE - 1}/${FILE_SIZE}`,
  'formatContentRange: final partial chunk',
);
assertEq(formatStatusQueryRange(FILE_SIZE), `bytes */${FILE_SIZE}`, 'formatStatusQueryRange: 426 MB');
assertEq(formatStatusQueryRange(0), 'bytes */0', 'formatStatusQueryRange: zero-byte file');

// ─── parseRangeHeader ────────────────────────────────────────────────────

assertEq(parseRangeHeader(null), 0, 'parseRangeHeader: null');
assertEq(parseRangeHeader(undefined), 0, 'parseRangeHeader: undefined');
assertEq(parseRangeHeader(''), 0, 'parseRangeHeader: empty string');
assertEq(parseRangeHeader('garbage'), 0, 'parseRangeHeader: unparseable');
assertEq(parseRangeHeader('bytes=0-26214399'), 26214400, 'parseRangeHeader: 25 MiB received → next byte at 26214400');
assertEq(parseRangeHeader('bytes=0-0'), 1, 'parseRangeHeader: bytes=0-0 → 1');
assertEq(parseRangeHeader('bytes=0-8388607'), 8388608, 'parseRangeHeader: first 8 MiB chunk → next is 8388608');

// ─── classifyStatus ──────────────────────────────────────────────────────

assertEq(classifyStatus(200), 'success', 'classifyStatus: 200');
assertEq(classifyStatus(201), 'success', 'classifyStatus: 201');
assertEq(classifyStatus(308), 'progress', 'classifyStatus: 308');
assertEq(classifyStatus(404), 'session_expired', 'classifyStatus: 404');
assertEq(classifyStatus(410), 'session_expired', 'classifyStatus: 410');
assertEq(classifyStatus(401), 'auth_failed', 'classifyStatus: 401');
assertEq(classifyStatus(403), 'auth_failed', 'classifyStatus: 403');
assertEq(classifyStatus(408), 'retryable', 'classifyStatus: 408');
assertEq(classifyStatus(429), 'retryable', 'classifyStatus: 429');
assertEq(classifyStatus(500), 'retryable', 'classifyStatus: 500');
assertEq(classifyStatus(502), 'retryable', 'classifyStatus: 502');
assertEq(classifyStatus(503), 'retryable', 'classifyStatus: 503');
assertEq(classifyStatus(504), 'retryable', 'classifyStatus: 504');
assertEq(classifyStatus(599), 'retryable', 'classifyStatus: 599 (edge of 5xx)');
assertEq(classifyStatus(400), 'fatal', 'classifyStatus: 400');
assertEq(classifyStatus(451), 'fatal', 'classifyStatus: 451');
assertEq(classifyStatus(0), 'fatal', 'classifyStatus: 0 (network failure surfaced as 0)');

// ─── backoffMs ───────────────────────────────────────────────────────────

assertEq(backoffMs(0), 1000, 'backoffMs: attempt 0 → 1s');
assertEq(backoffMs(1), 2000, 'backoffMs: attempt 1 → 2s');
assertEq(backoffMs(2), 4000, 'backoffMs: attempt 2 → 4s');
assertEq(backoffMs(3), 8000, 'backoffMs: attempt 3 → 8s');
assertEq(backoffMs(4), 16000, 'backoffMs: attempt 4 → 16s');
assertEq(backoffMs(5), 30000, 'backoffMs: attempt 5 capped at 30s');
assertEq(backoffMs(10), 30000, 'backoffMs: attempt 10 still 30s');
assertEq(backoffMs(-1), 0, 'backoffMs: negative attempt → 0');

// ─── Integration: uploadResumable with fake XHR ──────────────────────────

// Minimal Blob-like for the file. In Node/Bun, real Blob works fine.
function makeBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

// Fake XMLHttpRequest scriptable per request. The script is an array of
// responses; the i-th request consumes the i-th entry.
type FakeResponse =
  | { kind: 'ok'; status: number; rangeHeader?: string; body?: string }
  | { kind: 'network_error' }
  | { kind: 'timeout' };

interface FakeRequest {
  url: string;
  contentRange: string;
  contentType?: string;
  bodySize: number; // 0 for null body (status query)
}

class FakeXhrHarness {
  responses: FakeResponse[] = [];
  requests: FakeRequest[] = [];
  cursor = 0;

  // Install a fake XHR onto the global. Returns an uninstaller.
  install(): () => void {
    const harness = this;
    class FakeXHR {
      upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      responseText = '';
      _url = '';
      _headers: Record<string, string> = {};
      _contentType: string | undefined;
      _aborted = false;
      open(_method: string, url: string) {
        this._url = url;
      }
      setRequestHeader(k: string, v: string) {
        this._headers[k] = v;
        if (k.toLowerCase() === 'content-type') this._contentType = v;
      }
      getResponseHeader(name: string): string | null {
        const r = harness.responses[harness.cursor - 1];
        if (r && r.kind === 'ok' && name.toLowerCase() === 'range') return r.rangeHeader ?? null;
        return null;
      }
      addEventListener() {}
      removeEventListener() {}
      send(body: Blob | null) {
        const bodySize = body ? (body as Blob).size : 0;
        harness.requests.push({
          url: this._url,
          contentRange: this._headers['Content-Range'] ?? '',
          contentType: this._contentType,
          bodySize,
        });
        const r = harness.responses[harness.cursor];
        harness.cursor++;
        // Use queueMicrotask so the await chain has a moment to set up.
        queueMicrotask(() => {
          if (this._aborted) return;
          if (!r) {
            this.status = 0;
            this.onerror?.();
            return;
          }
          if (r.kind === 'network_error') {
            this.onerror?.();
            return;
          }
          if (r.kind === 'timeout') {
            this.ontimeout?.();
            return;
          }
          this.status = r.status;
          this.responseText = r.body ?? '';
          this.onload?.();
        });
      }
      abort() {
        this._aborted = true;
        this.onabort?.();
      }
    }
    const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
    return () => {
      (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
    };
  }
}

// Helper: zero-delay sleep for tests so backoff loops run instantly.
const noSleep = (_ms: number) => Promise.resolve();

// ─ Test: happy path, single chunk ────────────────────────────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 200 }];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    chunkSize: 8 * 1024 * 1024,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'integration: 1 KB single-chunk upload succeeds');
  assert(harness.requests.length === 1, 'integration: 1 KB upload made exactly 1 PUT', `got ${harness.requests.length}`);
  assertEq(harness.requests[0].contentRange, 'bytes 0-1023/1024', 'integration: 1 KB Content-Range');
}

// ─ Test: happy path, multi-chunk ─────────────────────────────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // 24 MB file, 8 MiB chunks → 3 chunks. First two return 308; third returns 200.
  const chunkSize = 8 * 1024 * 1024;
  const fileSize = 24 * 1024 * 1024;
  harness.responses = [
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-8388607' },
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-16777215' },
    { kind: 'ok', status: 200 },
  ];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(fileSize),
    contentType: 'application/zip',
    chunkSize,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'integration: 24 MB multi-chunk upload succeeds');
  assertEq(harness.requests.length, 3, 'integration: 24 MB → 3 PUTs');
  assertEq(harness.requests[0].contentRange, `bytes 0-8388607/${fileSize}`, 'integration: chunk 1 Content-Range');
  assertEq(harness.requests[1].contentRange, `bytes 8388608-16777215/${fileSize}`, 'integration: chunk 2 Content-Range');
  assertEq(harness.requests[2].contentRange, `bytes 16777216-25165823/${fileSize}`, 'integration: chunk 3 Content-Range');
}

// ─ Test: network_error on chunk → status query says GCS got it → resume ─
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  const chunkSize = 8 * 1024 * 1024;
  const fileSize = 16 * 1024 * 1024;
  harness.responses = [
    // 1st PUT for chunk 0 fails mid-stream
    { kind: 'network_error' },
    // status query: GCS actually got the chunk (308 with Range)
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-8388607' },
    // 2nd chunk PUT succeeds
    { kind: 'ok', status: 200 },
  ];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(fileSize),
    contentType: 'application/zip',
    chunkSize,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'integration: network error recovered via status query');
  assertEq(harness.requests.length, 3, 'integration: 1 chunk PUT + 1 status query + 1 chunk PUT = 3 requests');
  assertEq(harness.requests[1].contentRange, `bytes */${fileSize}`, 'integration: status query uses bytes */total');
  assertEq(harness.requests[1].bodySize, 0, 'integration: status query sends empty body');
  assertEq(harness.requests[2].contentRange, `bytes 8388608-16777215/${fileSize}`, 'integration: 2nd chunk after recovered offset');
}

// ─ Test: network_error → status query also fails → retry chunk → succeed ─
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  const chunkSize = 8 * 1024 * 1024;
  const fileSize = 8 * 1024 * 1024;
  harness.responses = [
    { kind: 'network_error' },     // chunk 0 PUT fails
    { kind: 'network_error' },     // status query fails too
    { kind: 'ok', status: 200 },   // retry of chunk 0 succeeds
  ];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(fileSize),
    contentType: 'application/zip',
    chunkSize,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'integration: chunk PUT retried after status query also fails');
  assertEq(harness.requests.length, 3, 'integration: 1 failed PUT + 1 failed status query + 1 retry PUT = 3');
}

// ─ Test: 503 retryable → backoff → retry → 200 ──────────────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  const chunkSize = 8 * 1024 * 1024;
  const fileSize = 1024;
  let sleepCalls = 0;
  harness.responses = [
    { kind: 'ok', status: 503, body: 'service unavailable' },
    // status query after backoff: GCS confirms nothing received
    { kind: 'ok', status: 308 }, // no Range header → resume from 0
    // retry succeeds
    { kind: 'ok', status: 200 },
  ];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(fileSize),
    contentType: 'application/zip',
    chunkSize,
    sleep: async () => { sleepCalls++; },
  });
  restore();
  assert(result.ok === true, 'integration: 503 retried to success');
  assert(sleepCalls === 1, 'integration: backoff sleep invoked exactly once', `got ${sleepCalls}`);
}

// ─ Test: session_expired (410) → fail with explicit kind ─────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 410, body: 'gone' }];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'integration: 410 → failure');
  if (!result.ok) {
    assertEq(result.failure.kind, 'session_expired', 'integration: 410 → kind=session_expired');
  }
}

// ─ Test: auth_failed (403) → fail with explicit kind ─────────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 403, body: 'forbidden' }];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'integration: 403 → failure');
  if (!result.ok) {
    assertEq(result.failure.kind, 'gcs_auth_failed', 'integration: 403 → kind=gcs_auth_failed');
  }
}

// ─ Test: out of retries → network_error with attempt count ───────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // All requests fail. With maxRetriesPerChunk=2, we expect:
  //   PUT (fail) → backoff → status query → PUT (fail) → backoff → status query → PUT (fail) → bail.
  // Each retry cycle = 1 PUT + 1 status query. With 2 retries total = 1 initial + 2 retries.
  for (let i = 0; i < 20; i++) harness.responses.push({ kind: 'network_error' });
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    maxRetriesPerChunk: 2,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'integration: exhausted retries → failure');
  if (!result.ok) {
    assertEq(result.failure.kind, 'network_error', 'integration: exhausted retries → kind=network_error');
    if (result.failure.kind === 'network_error') {
      assert(result.failure.attempts === 3, 'integration: attempts=3 (1 initial + 2 retries)', `got ${result.failure.attempts}`);
    }
  }
}

// ─ Test: aborted via signal before start ─────────────────────────────
{
  const ctrl = new AbortController();
  ctrl.abort();
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    signal: ctrl.signal,
    sleep: noSleep,
  });
  assert(result.ok === false, 'integration: pre-aborted signal → failure');
  if (!result.ok) {
    assertEq(result.failure.kind, 'aborted', 'integration: pre-aborted signal → kind=aborted');
  }
}

// ─ Test: progress callback fires with cumulative bytes ───────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  const chunkSize = 8 * 1024 * 1024;
  const fileSize = 16 * 1024 * 1024;
  harness.responses = [
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-8388607' },
    { kind: 'ok', status: 200 },
  ];
  const progressEvents: { loaded: number; total: number }[] = [];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(fileSize),
    contentType: 'application/zip',
    chunkSize,
    sleep: noSleep,
    onProgress: (loaded, total) => progressEvents.push({ loaded, total }),
  });
  restore();
  assert(result.ok === true, 'integration: progress test upload succeeds');
  assert(progressEvents.length >= 1, 'integration: at least one progress event fired');
  const last = progressEvents[progressEvents.length - 1];
  assert(last.loaded === fileSize && last.total === fileSize, 'integration: final progress = total/total');
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
