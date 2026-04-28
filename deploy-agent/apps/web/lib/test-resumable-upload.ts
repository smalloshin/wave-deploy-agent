// Round 27 — Tests for the resumable-upload helpers.
// Round 30 — updated for tightened defaults (1 MiB chunks, 15 retries,
//            60 s backoff cap, 120 s per-chunk XHR timeout).
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
  formatXhrDiagnostic,
  isXhrErrorDiagnostic,
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
assertEq(backoffMs(5), 32000, 'backoffMs: attempt 5 → 32s (under cap)');
assertEq(backoffMs(6), 60000, 'backoffMs: attempt 6 capped at 60s (round 30)');
assertEq(backoffMs(10), 60000, 'backoffMs: attempt 10 still 60s');
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
  | {
      kind: 'network_error';
      // Round 44: optional fields the fake xhr surfaces on onerror so the
      // production diagnostic enrichment (status / responseURL / responseText)
      // can be exercised end-to-end.
      xhrStatus?: number;
      xhrStatusText?: string;
      xhrResponseURL?: string;
      xhrResponseText?: string;
    }
  | { kind: 'timeout' };

interface FakeRequest {
  url: string;
  contentRange: string;
  contentType?: string;
  bodySize: number; // 0 for null body (status query)
  timeout: number; // 0 = unset
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
      statusText = ''; // round 44: surfaced into XhrErrorDiagnostic.xhrStatusText
      responseText = '';
      responseURL = ''; // round 44: surfaced into XhrErrorDiagnostic.xhrResponseURL
      timeout = 0; // round 30: code may set xhr.timeout
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
          timeout: this.timeout,
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
            // Round 44: populate fields that production xhr.onerror reads
            // before constructing the enriched Error. Defaults preserve the
            // legacy 0/empty behaviour for older test cases.
            this.status = r.xhrStatus ?? 0;
            this.statusText = r.xhrStatusText ?? '';
            this.responseURL = r.xhrResponseURL ?? '';
            this.responseText = r.xhrResponseText ?? '';
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

// ─── Round 30: tightened defaults ─────────────────────────────────────

// ─ Test: default chunk size is 1 MiB (round 30, was 8 MiB) ─────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  const fileSize = 3 * 1024 * 1024; // 3 MiB → 3 chunks of 1 MiB each
  harness.responses = [
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-1048575' },
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-2097151' },
    { kind: 'ok', status: 200 },
  ];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(fileSize),
    contentType: 'application/zip',
    // chunkSize OMITTED — must default to 1 MiB
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'round 30: 3 MiB upload with default chunk size succeeds');
  assertEq(harness.requests.length, 3, 'round 30: default chunk size = 1 MiB → 3 chunks for 3 MiB file');
  assertEq(harness.requests[0].contentRange, `bytes 0-1048575/${fileSize}`, 'round 30: default chunk 1 = 1 MiB');
  assertEq(harness.requests[1].contentRange, `bytes 1048576-2097151/${fileSize}`, 'round 30: default chunk 2 = next 1 MiB');
  assertEq(harness.requests[2].contentRange, `bytes 2097152-3145727/${fileSize}`, 'round 30: default chunk 3 = final 1 MiB');
}

// ─ Test: default per-chunk timeout is 120000 ms (round 30) ────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 200 }];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    // chunkTimeoutMs OMITTED — must default to 120000
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'round 30: default-timeout upload succeeds');
  assertEq(harness.requests[0].timeout, 120000, 'round 30: xhr.timeout default = 120000 ms (2 min)');
}

// ─ Test: chunkTimeoutMs option is honored ──────────────────────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 200 }];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    chunkTimeoutMs: 45000,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'round 30: explicit chunkTimeoutMs upload succeeds');
  assertEq(harness.requests[0].timeout, 45000, 'round 30: xhr.timeout = explicit 45000 ms');
}

// ─ Test: chunkTimeoutMs=0 disables timeout (xhr.timeout stays 0) ─────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 200 }];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    chunkTimeoutMs: 0,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'round 30: timeout=0 upload succeeds');
  assertEq(harness.requests[0].timeout, 0, 'round 30: chunkTimeoutMs=0 leaves xhr.timeout unset');
}

// ─ Test: timeout fires `gcs_timeout` failure after retries exhaust ────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // every PUT and status query times out
  for (let i = 0; i < 20; i++) harness.responses.push({ kind: 'timeout' });
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    maxRetriesPerChunk: 2,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'round 30: persistent timeout → failure');
  if (!result.ok) {
    assertEq(result.failure.kind, 'gcs_timeout', 'round 30: timeout exhaustion → kind=gcs_timeout');
  }
}

// ─ Test: status query also gets the timeout ───────────────────────────
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // chunk PUT fails, status query needs the same timeout
  harness.responses = [
    { kind: 'network_error' },
    { kind: 'ok', status: 308, rangeHeader: 'bytes=0-1023' },
  ];
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    chunkTimeoutMs: 30000,
    sleep: noSleep,
  });
  restore();
  assert(result.ok === true, 'round 30: status query test passes');
  assert(harness.requests.length >= 2, 'round 30: at least 2 requests recorded');
  assertEq(harness.requests[1].timeout, 30000, 'round 30: status query also gets explicit chunkTimeoutMs');
}

// ─ Test: 426 MB file with default 1 MiB chunks → 427 chunks ────────────
// Realistic stress: the actual production failure file. Verify the math.
{
  const FILE_SIZE_426 = 447_194_585; // exact bytes from /Users/.../legal_flow_build.zip
  const DEFAULT_CHUNK_1MB = 1 * 1024 * 1024;
  const expectedChunks = Math.ceil(FILE_SIZE_426 / DEFAULT_CHUNK_1MB);
  // 447194585 / 1048576 = 426.4729... → ceil = 427 chunks
  assertEq(expectedChunks, 427, 'round 30: 426 MB / 1 MiB = 427 chunks');
  // Final chunk size
  const finalChunkSize = FILE_SIZE_426 - (expectedChunks - 1) * DEFAULT_CHUNK_1MB;
  assert(finalChunkSize > 0 && finalChunkSize <= DEFAULT_CHUNK_1MB, 'round 30: final chunk size in (0, 1 MiB]');
}

// ─── Round 44: formatXhrDiagnostic / isXhrErrorDiagnostic / verifyComplete ──

// Pure helpers
{
  assertEq(
    formatXhrDiagnostic({ xhrStatus: 0, xhrStatusText: '', xhrResponseURL: '', xhrResponseText: '' }),
    'network status=0 statusText="" url= body=""',
    'round 44: formatXhrDiagnostic — TCP-level cut (all-empty)',
  );
  assertEq(
    formatXhrDiagnostic({
      xhrStatus: 503,
      xhrStatusText: 'Service Unavailable',
      xhrResponseURL: 'https://storage.googleapis.com/upload/x',
      xhrResponseText: '<error>nope</error>',
    }),
    'network status=503 statusText="Service Unavailable" url=https://storage.googleapis.com/upload/x body="<error>nope</error>"',
    'round 44: formatXhrDiagnostic — 5xx with body',
  );
  // Body truncation at 200 chars
  const longBody = 'x'.repeat(500);
  const formatted = formatXhrDiagnostic({
    xhrStatus: 0,
    xhrStatusText: '',
    xhrResponseURL: '',
    xhrResponseText: longBody,
  });
  // body is JSON-stringified at ≤200 chars: opening quote + 200 'x' + closing quote = 202 chars
  const bodyJson = JSON.stringify(longBody.slice(0, 200));
  assert(
    formatted.endsWith(`body=${bodyJson}`),
    'round 44: formatXhrDiagnostic — long body truncated to 200 chars before JSON-stringify',
  );
  assert(bodyJson.length === 202, 'round 44: 200-char body → JSON length 202 (sanity check)');
}

// Type guard
{
  assert(isXhrErrorDiagnostic({ xhrStatus: 0 }) === true, 'round 44: isXhrErrorDiagnostic — minimal positive');
  assert(isXhrErrorDiagnostic(new Error('network')) === false, 'round 44: isXhrErrorDiagnostic — bare Error rejected');
  assert(isXhrErrorDiagnostic(null) === false, 'round 44: isXhrErrorDiagnostic — null rejected');
  assert(isXhrErrorDiagnostic('network') === false, 'round 44: isXhrErrorDiagnostic — string rejected');
  assert(isXhrErrorDiagnostic({ xhrStatus: 'oops' }) === false, 'round 44: isXhrErrorDiagnostic — wrong-type field rejected');
}

// Integration: enriched onerror surfaces into network_error.lastError
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // Persistent network_error with rich fields. status query also fails.
  // 1 KiB file → single chunk → 16 chunk PUT attempts (15 retries + 1 initial)
  // alternating with 15 status queries between them (no status query before first PUT).
  // Actual layout: PUT, sq, PUT, sq, ... → ceil/floor — feed plenty so we don't run dry.
  const enriched = {
    kind: 'network_error' as const,
    xhrStatus: 0,
    xhrStatusText: '',
    xhrResponseURL: 'https://storage.googleapis.com/upload/storage/v1/b/x/o?...',
    xhrResponseText: '',
  };
  harness.responses = Array(60).fill(enriched);
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'round 44: persistent network_error → failure');
  if (!result.ok && result.failure.kind === 'network_error') {
    assert(
      result.failure.lastError?.startsWith('network status=0 ') ?? false,
      'round 44: lastError carries enriched diagnostic (starts with "network status=0 ")',
      `got ${result.failure.lastError}`,
    );
    assert(
      result.failure.lastError?.includes('url=https://storage.googleapis.com/upload/storage/v1/b/x/o') ?? false,
      'round 44: lastError carries responseURL',
      `got ${result.failure.lastError}`,
    );
    assert(
      result.failure.attempts === 16,
      'round 44: 15 retries + 1 initial = 16 attempts (R30 budget unchanged)',
      `got ${result.failure.attempts}`,
    );
  }
}

// Integration: enriched onerror surfaces an HTTP-level status (CORS preflight fail)
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  const enriched = {
    kind: 'network_error' as const,
    xhrStatus: 503,
    xhrStatusText: 'Service Unavailable',
    xhrResponseURL: 'https://storage.googleapis.com/upload/storage/v1/b/x/o?...',
    xhrResponseText: '<?xml version="1.0"?><Error><Code>503</Code></Error>',
  };
  harness.responses = Array(60).fill(enriched);
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'round 44: persistent http-level error → failure');
  if (!result.ok && result.failure.kind === 'network_error') {
    assert(
      result.failure.lastError?.includes('status=503') ?? false,
      'round 44: lastError surfaces HTTP status from xhr.status',
      `got ${result.failure.lastError}`,
    );
    assert(
      result.failure.lastError?.includes('Service Unavailable') ?? false,
      'round 44: lastError surfaces statusText',
    );
    assert(
      result.failure.lastError?.includes('Error><Code>503') ?? false,
      'round 44: lastError surfaces responseText body',
    );
  }
}

// Integration: legacy onerror (no enrichment fields) keeps "network" literal
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // Old-style FakeResponse.network_error without enrichment fields → all defaults
  // → xhrStatus=0, xhrStatusText='', xhrResponseURL='', xhrResponseText=''
  // → formatXhrDiagnostic produces 'network status=0 statusText="" url= body=""'
  // The leading "network " literal is preserved on purpose for back-compat with log greps.
  harness.responses = Array(60).fill({ kind: 'network_error' });
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
  });
  restore();
  assert(result.ok === false, 'round 44: legacy network_error → failure');
  if (!result.ok && result.failure.kind === 'network_error') {
    assert(
      result.failure.lastError?.startsWith('network ') ?? false,
      'round 44: lastError keeps leading "network " literal for log-grep back-compat',
      `got ${result.failure.lastError}`,
    );
  }
}

// Integration: verifyComplete rescues a bail-out → ok=true
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  // Persistent network_error — would normally bail with network_error after 16 attempts.
  harness.responses = Array(60).fill({ kind: 'network_error' });
  let verifyCalls = 0;
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
    verifyComplete: async () => {
      verifyCalls++;
      return true;
    },
  });
  restore();
  assert(result.ok === true, 'round 44: verifyComplete=true rescues bail-out → ok');
  if (result.ok) {
    assertEq(result.bytesUploaded, 1024, 'round 44: rescue reports full file size');
  }
  assertEq(verifyCalls, 1, 'round 44: verifyComplete called exactly once on bail-out');
}

// Integration: verifyComplete=false lets the failure propagate
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = Array(60).fill({ kind: 'network_error' });
  let verifyCalls = 0;
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
    verifyComplete: async () => {
      verifyCalls++;
      return false;
    },
  });
  restore();
  assert(result.ok === false, 'round 44: verifyComplete=false → failure propagates');
  if (!result.ok) {
    assertEq(result.failure.kind, 'network_error', 'round 44: kind=network_error preserved');
  }
  assertEq(verifyCalls, 1, 'round 44: verifyComplete called even though it returned false');
}

// Integration: verifyComplete throwing → failure propagates (graceful degrade)
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = Array(60).fill({ kind: 'network_error' });
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
    verifyComplete: async () => {
      throw new Error('verify endpoint unreachable');
    },
  });
  restore();
  assert(result.ok === false, 'round 44: verifyComplete throwing → failure propagates');
  if (!result.ok) {
    assertEq(result.failure.kind, 'network_error', 'round 44: kind=network_error preserved on verify-throw');
  }
}

// Integration: verifyComplete NOT called on the happy path
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 200 }];
  let verifyCalls = 0;
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
    verifyComplete: async () => {
      verifyCalls++;
      return true;
    },
  });
  restore();
  assert(result.ok === true, 'round 44: happy path still succeeds with verifyComplete wired');
  assertEq(verifyCalls, 0, 'round 44: verifyComplete NOT called on happy path');
}

// Integration: verifyComplete NOT called on aborted
{
  const harness = new FakeXhrHarness();
  const restore = harness.install();
  harness.responses = [{ kind: 'ok', status: 200 }];
  const ac = new AbortController();
  ac.abort();
  let verifyCalls = 0;
  const result = await uploadResumable({
    sessionUri: 'https://upload.example.com/x',
    file: makeBlob(1024),
    contentType: 'application/zip',
    sleep: noSleep,
    signal: ac.signal,
    verifyComplete: async () => {
      verifyCalls++;
      return true;
    },
  });
  restore();
  assert(result.ok === false, 'round 44: pre-aborted → failure');
  if (!result.ok) assertEq(result.failure.kind, 'aborted', 'round 44: aborted kind preserved');
  assertEq(verifyCalls, 0, 'round 44: verifyComplete NOT called on aborted path');
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
