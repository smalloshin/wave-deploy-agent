// Round 39 — Wire-contract lock for `upload-error-mapper.ts`.
//
// Target: 4 exported pure helpers + 2 internal helpers (covered indirectly).
//   - mapEnvelope(envelope) → UploadFailure
//   - mapClientError(err, context) → UploadFailure   (heuristic)
//   - fetchDiagnostic(envelope, apiBaseUrl) → Promise<UploadFailure>
//   - buildErrorReport(failure, ctx) → string
//   internal:
//   - extractI18nVars(envelope) → covered via mapEnvelope cases with `detail.*`
//   - formatBytes(n) → covered via extractI18nVars + buildErrorReport file size
//
// Lockdown rationale (same as R37/R38):
//   - This file ships to the browser and decides what error message every
//     failed upload renders. If `mapEnvelope` regresses on a code → users
//     see "Unknown error" or wrong i18n key. Silent UX bug, hard to spot
//     in code review.
//   - `mapClientError` heuristics decide what the user sees BEFORE the
//     server even responds (network failures, abort, oversized file). The
//     fallthrough order matters — wrong order = wrong code = wrong hint.
//   - `buildErrorReport` is what the user clicks "copy report" → pastes
//     into Discord / GitHub. If the format silently changes, support
//     regresses.
//   - `fetchDiagnostic` is the LLM-fallback escape hatch for `unknown`
//     codes. If it swallows errors wrong → users get blank UI.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.
//
// Note: `upload-error-mapper.ts` only does `import type` from
// '@deploy-agent/shared', so the runtime has no cross-package value
// imports. Envelope/Failure objects are constructed inline as plain
// objects — they're just shapes.

import {
  mapEnvelope,
  mapClientError,
  fetchDiagnostic,
  buildErrorReport,
} from './upload-error-mapper.js';
import type {
  UploadErrorEnvelope,
  UploadFailure,
  UploadFailureCode,
  UploadStage,
  UploadLLMDiagnostic,
} from '@deploy-agent/shared';

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
  assert(
    ok,
    name,
    ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function makeEnvelope(
  partial: Partial<UploadErrorEnvelope> & { code: UploadFailureCode; stage: UploadStage },
): UploadErrorEnvelope {
  return {
    ok: false,
    message: partial.message ?? 'test message',
    ...partial,
  };
}

// ─── mapEnvelope: every known code maps to its registered i18n entry ─────

const ALL_CODES: { code: UploadFailureCode; i18nKey: string; recoveryKey: string; defaultRetryable: boolean }[] = [
  { code: 'file_too_large_for_direct', i18nKey: 'fileTooLargeForDirect', recoveryKey: 'fileTooLargeForDirect.hint', defaultRetryable: true },
  { code: 'file_extension_invalid', i18nKey: 'fileExtensionInvalid', recoveryKey: 'fileExtensionInvalid.hint', defaultRetryable: false },
  { code: 'init_session_failed', i18nKey: 'initSessionFailed', recoveryKey: 'initSessionFailed.hint', defaultRetryable: true },
  { code: 'gcs_auth_failed', i18nKey: 'gcsAuthFailed', recoveryKey: 'gcsAuthFailed.hint', defaultRetryable: true },
  { code: 'gcs_timeout', i18nKey: 'gcsTimeout', recoveryKey: 'gcsTimeout.hint', defaultRetryable: true },
  { code: 'network_error', i18nKey: 'networkError', recoveryKey: 'networkError.hint', defaultRetryable: true },
  { code: 'submit_failed', i18nKey: 'submitFailed', recoveryKey: 'submitFailed.hint', defaultRetryable: true },
  { code: 'extract_failed', i18nKey: 'extractFailed', recoveryKey: 'extractFailed.hint', defaultRetryable: false },
  { code: 'extract_buffer_overflow', i18nKey: 'extractBufferOverflow', recoveryKey: 'extractBufferOverflow.hint', defaultRetryable: false },
  { code: 'analyze_failed', i18nKey: 'analyzeFailed', recoveryKey: 'analyzeFailed.hint', defaultRetryable: true },
  { code: 'domain_conflict', i18nKey: 'domainConflict', recoveryKey: 'domainConflict.hint', defaultRetryable: false },
  { code: 'project_quota_exceeded', i18nKey: 'projectQuotaExceeded', recoveryKey: 'projectQuotaExceeded.hint', defaultRetryable: false },
  { code: 'db_dump_upload_failed', i18nKey: 'dbDumpUploadFailed', recoveryKey: 'dbDumpUploadFailed.hint', defaultRetryable: true },
  { code: 'unknown', i18nKey: 'unknown', recoveryKey: 'unknown.hint', defaultRetryable: true },
];

for (const row of ALL_CODES) {
  const env = makeEnvelope({ stage: 'upload', code: row.code });
  const failure = mapEnvelope(env);
  assertEq(failure.code, row.code, `mapEnvelope: code ${row.code} round-trips`);
  assertEq(failure.i18nKey, row.i18nKey, `mapEnvelope: ${row.code} → i18nKey "${row.i18nKey}"`);
  assertEq(
    failure.recoveryHintKey,
    row.recoveryKey,
    `mapEnvelope: ${row.code} → recoveryHintKey "${row.recoveryKey}"`,
  );
  assertEq(
    failure.retryable,
    row.defaultRetryable,
    `mapEnvelope: ${row.code} → default retryable=${row.defaultRetryable}`,
  );
  assertEq(failure.stage, 'upload', `mapEnvelope: ${row.code} preserves stage`);
  assert(failure.raw === env, `mapEnvelope: ${row.code} preserves raw envelope identity`);
}

// ─── mapEnvelope: explicit envelope.retryable overrides registry default ─

{
  const env = makeEnvelope({ stage: 'upload', code: 'extract_failed', retryable: true });
  const f = mapEnvelope(env);
  assertEq(f.retryable, true, 'mapEnvelope: envelope.retryable=true overrides registry false');
}
{
  const env = makeEnvelope({ stage: 'upload', code: 'gcs_timeout', retryable: false });
  const f = mapEnvelope(env);
  assertEq(f.retryable, false, 'mapEnvelope: envelope.retryable=false overrides registry true');
}

// ─── mapEnvelope: i18nVars extraction ────────────────────────────────────

{
  const env = makeEnvelope({
    stage: 'validate',
    code: 'file_too_large_for_direct',
    detail: { fileSize: 447_194_585, maxSize: 31_457_280 },
  });
  const f = mapEnvelope(env);
  assertEq(
    f.i18nVars,
    { fileSize: '426.5 MB', maxSize: '30.0 MB' },
    'mapEnvelope: numeric fileSize+maxSize → formatted MB strings',
  );
}
{
  // string passthrough (server already formatted)
  const env = makeEnvelope({
    stage: 'validate',
    code: 'file_too_large_for_direct',
    detail: { fileSize: '426 MB', maxSize: '30 MB' },
  });
  const f = mapEnvelope(env);
  assertEq(
    f.i18nVars,
    { fileSize: '426 MB', maxSize: '30 MB' },
    'mapEnvelope: string fileSize+maxSize pass through unchanged',
  );
}
{
  const env = makeEnvelope({
    stage: 'validate',
    code: 'file_extension_invalid',
    detail: { ext: '.tar.gz' },
  });
  const f = mapEnvelope(env);
  assertEq(f.i18nVars, { ext: '.tar.gz' }, 'mapEnvelope: extracts ext from detail');
}
{
  const env = makeEnvelope({
    stage: 'submit',
    code: 'domain_conflict',
    detail: { domain: 'example.com' },
  });
  const f = mapEnvelope(env);
  assertEq(f.i18nVars, { domain: 'example.com' }, 'mapEnvelope: extracts domain from detail');
}
{
  const env = makeEnvelope({ stage: 'upload', code: 'gcs_timeout', detail: {} });
  const f = mapEnvelope(env);
  assertEq(
    f.i18nVars,
    undefined,
    'mapEnvelope: empty detail → i18nVars undefined (UI can skip interpolation)',
  );
}
{
  const env = makeEnvelope({ stage: 'upload', code: 'gcs_timeout' });
  const f = mapEnvelope(env);
  assertEq(f.i18nVars, undefined, 'mapEnvelope: missing detail → i18nVars undefined');
}
{
  // ignore unrelated detail keys
  const env = makeEnvelope({
    stage: 'upload',
    code: 'gcs_timeout',
    detail: { gcsStatus: 503, retryAfter: 30 },
  });
  const f = mapEnvelope(env);
  assertEq(
    f.i18nVars,
    undefined,
    'mapEnvelope: only fileSize/maxSize/ext/domain become i18nVars (others stay in raw)',
  );
}

// ─── mapEnvelope: llmDiagnostic passthrough ──────────────────────────────

{
  const llm: UploadLLMDiagnostic = {
    category: 'platform',
    userFacingMessage: '系統暫時無法處理',
    suggestedFix: '請等 5 分鐘後重試',
    rootCause: 'GCS rate limit',
    provider: 'claude',
  };
  const env = makeEnvelope({ stage: 'upload', code: 'unknown', llmDiagnostic: llm });
  const f = mapEnvelope(env);
  assert(f.llm === llm, 'mapEnvelope: llmDiagnostic passes through to failure.llm');
}
{
  const env = makeEnvelope({ stage: 'upload', code: 'unknown' });
  const f = mapEnvelope(env);
  assertEq(f.llm, undefined, 'mapEnvelope: no llmDiagnostic → failure.llm undefined');
}

// ─── mapEnvelope: unknown future code falls back to "unknown" entry ──────
//
// Registry uses `?? CODE_TO_I18N.unknown` defensively. If a server sends a
// new code the client hasn't shipped yet, UI must still render *something*.

{
  const env = makeEnvelope({
    stage: 'upload',
    code: 'a_brand_new_code' as UploadFailureCode,
  });
  const f = mapEnvelope(env);
  assertEq(f.i18nKey, 'unknown', 'mapEnvelope: unrecognised code falls back to unknown i18nKey');
  assertEq(
    f.recoveryHintKey,
    'unknown.hint',
    'mapEnvelope: unrecognised code falls back to unknown recovery hint',
  );
}

// ─── mapClientError: heuristic dispatch ──────────────────────────────────

{
  const f = mapClientError(new TypeError('Failed to fetch'), { stage: 'upload' });
  assertEq(f.code, 'network_error', 'mapClientError: TypeError + "fetch" → network_error');
  assertEq(f.stage, 'upload', 'mapClientError: preserves stage on network_error');
  assertEq(f.retryable, true, 'mapClientError: network_error is retryable');
}
{
  const f = mapClientError(new TypeError('Network request failed'), { stage: 'upload' });
  assertEq(f.code, 'network_error', 'mapClientError: TypeError + "Network" → network_error');
}
{
  const f = mapClientError(new TypeError('Some unrelated TypeError'), { stage: 'upload' });
  assertEq(
    f.code,
    'unknown',
    'mapClientError: TypeError without "fetch"/"Network" → unknown (NOT network_error)',
  );
}
{
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  const f = mapClientError(abortErr, { stage: 'upload' });
  assertEq(f.code, 'gcs_timeout', 'mapClientError: AbortError → gcs_timeout');
}
{
  // file too large takes precedence over generic Error msg
  const f = mapClientError(new Error('whatever'), {
    stage: 'validate',
    fileSize: 100_000_000,
    maxSize: 30_000_000,
  });
  assertEq(
    f.code,
    'file_too_large_for_direct',
    'mapClientError: validate stage + fileSize > maxSize → file_too_large_for_direct',
  );
  assertEq(
    f.i18nVars,
    { fileSize: '95.4 MB', maxSize: '28.6 MB' },
    'mapClientError: file_too_large_for_direct populates i18nVars from context',
  );
}
{
  // size-check ONLY runs on validate stage (would be wrong in upload stage)
  const f = mapClientError(new Error('whatever'), {
    stage: 'upload',
    fileSize: 100_000_000,
    maxSize: 30_000_000,
  });
  assert(
    f.code !== 'file_too_large_for_direct',
    'mapClientError: size check is gated to validate stage only (upload stage would NOT trigger)',
  );
}
{
  // size-check requires BOTH fileSize AND maxSize present
  const f = mapClientError(new Error('whatever'), { stage: 'validate', fileSize: 100 });
  assert(
    f.code !== 'file_too_large_for_direct',
    'mapClientError: missing maxSize → no file_too_large_for_direct',
  );
}
{
  const f = mapClientError(new Error('Bad file extension: .tar'), { stage: 'validate' });
  assertEq(f.code, 'file_extension_invalid', 'mapClientError: "extension" keyword → file_extension_invalid');
  assertEq(
    f.retryable,
    false,
    'mapClientError: file_extension_invalid is NOT retryable (user must pick a different file)',
  );
}
{
  const f = mapClientError(new Error('expected .zip'), { stage: 'validate' });
  assertEq(f.code, 'file_extension_invalid', 'mapClientError: "zip" keyword → file_extension_invalid');
}
{
  const f = mapClientError(new Error('totally unrecognised'), { stage: 'submit' });
  assertEq(f.code, 'unknown', 'mapClientError: unmatched message → unknown');
  assertEq(f.retryable, true, 'mapClientError: unknown is retryable by default');
}
{
  // non-Error values get String()-coerced
  const f = mapClientError('weird string error', { stage: 'submit' });
  assertEq(f.code, 'unknown', 'mapClientError: string input → unknown');
  assertEq(f.raw.message, 'weird string error', 'mapClientError: string input preserved as message');
}
{
  const f = mapClientError(null, { stage: 'submit' });
  assertEq(f.code, 'unknown', 'mapClientError: null input → unknown');
  assertEq(f.raw.message, 'null', 'mapClientError: null coerces to "null" string');
}
{
  const f = mapClientError({ weird: 'object' }, { stage: 'submit' });
  assertEq(f.code, 'unknown', 'mapClientError: object input → unknown');
  // String({}) === '[object Object]'
  assertEq(f.raw.message, '[object Object]', 'mapClientError: object coerces via String()');
}
{
  // synthesised envelope shape
  const f = mapClientError(new TypeError('Failed to fetch'), { stage: 'upload' });
  assert(f.raw.ok === false, 'mapClientError: synthesised envelope has ok:false');
  assert(f.raw.stage === 'upload', 'mapClientError: synthesised envelope has correct stage');
  assertEq(f.raw.detail, {}, 'mapClientError: synthesised envelope has empty detail by default');
}

// ─── formatBytes (covered via i18nVars formatting) ───────────────────────
//
// Boundaries: < 1024 = B, < 1MB = KB, < 1GB = MB, else GB.

function fileSizeViaMapEnvelope(n: number): string | number | undefined {
  const env = makeEnvelope({
    stage: 'validate',
    code: 'file_too_large_for_direct',
    detail: { fileSize: n },
  });
  return mapEnvelope(env).i18nVars?.fileSize;
}

assertEq(fileSizeViaMapEnvelope(0), '0 B', 'formatBytes: 0 → "0 B"');
assertEq(fileSizeViaMapEnvelope(512), '512 B', 'formatBytes: 512 → "512 B"');
assertEq(fileSizeViaMapEnvelope(1023), '1023 B', 'formatBytes: 1023 → "1023 B" (last byte before KB)');
assertEq(fileSizeViaMapEnvelope(1024), '1.0 KB', 'formatBytes: 1024 → "1.0 KB"');
assertEq(fileSizeViaMapEnvelope(1024 * 1024 - 1), '1024.0 KB', 'formatBytes: just under 1 MiB rounds to 1024.0 KB');
assertEq(fileSizeViaMapEnvelope(1024 * 1024), '1.0 MB', 'formatBytes: 1 MiB → "1.0 MB"');
assertEq(fileSizeViaMapEnvelope(447_194_585), '426.5 MB', 'formatBytes: 426 MB stress file → "426.5 MB"');
assertEq(fileSizeViaMapEnvelope(1024 * 1024 * 1024), '1.00 GB', 'formatBytes: 1 GiB → "1.00 GB"');
assertEq(fileSizeViaMapEnvelope(2.5 * 1024 * 1024 * 1024), '2.50 GB', 'formatBytes: 2.5 GiB → "2.50 GB"');

// ─── buildErrorReport ────────────────────────────────────────────────────

function makeFailure(partial: Partial<UploadFailure> = {}): UploadFailure {
  const stage: UploadStage = partial.stage ?? 'upload';
  const code: UploadFailureCode = partial.code ?? 'gcs_timeout';
  const raw: UploadErrorEnvelope = partial.raw ?? makeEnvelope({ stage, code, message: 'boom' });
  return {
    stage,
    code,
    i18nKey: 'gcsTimeout',
    retryable: true,
    raw,
    ...partial,
  };
}

// Make navigator deterministic for snapshot-style assertions.
const ORIG_NAVIGATOR = (globalThis as any).navigator;
(globalThis as any).navigator = { userAgent: 'TestUA/1.0' };

{
  const failure = makeFailure();
  const report = buildErrorReport(failure, { projectId: 'proj_42' });
  assert(report.startsWith('=== Upload Error Report ==='), 'buildErrorReport: starts with header');
  assert(report.includes('Project: proj_42'), 'buildErrorReport: includes projectId');
  assert(report.includes('Stage: upload'), 'buildErrorReport: includes stage');
  assert(report.includes('Code: gcs_timeout'), 'buildErrorReport: includes code');
  assert(report.includes('Retryable: true'), 'buildErrorReport: includes retryable flag');
  assert(report.includes('Message: boom'), 'buildErrorReport: includes raw message');
  assert(report.includes('User-Agent: TestUA/1.0'), 'buildErrorReport: appends UA from navigator');
  assert(!report.includes('File:'), 'buildErrorReport: omits File line when fileMeta absent');
  assert(!report.includes('Request ID:'), 'buildErrorReport: omits Request ID line when absent');
  assert(!report.includes('Detail:'), 'buildErrorReport: omits Detail line when detail absent/empty');
  assert(!report.includes('LLM Diagnostic'), 'buildErrorReport: omits LLM section when llm absent');
}
{
  const failure = makeFailure({
    raw: makeEnvelope({
      stage: 'upload',
      code: 'gcs_timeout',
      message: 'gateway timeout',
      requestId: 'req_xyz',
      detail: { gcsStatus: 504 },
    }),
  });
  const report = buildErrorReport(failure, {
    projectId: 'new',
    fileMeta: { name: 'app.zip', size: 447_194_585 },
  });
  assert(report.includes('Project: new'), 'buildErrorReport: handles "new" projectId literal');
  assert(
    report.includes('File: app.zip (426.5 MB)'),
    'buildErrorReport: File line includes formatted size',
  );
  assert(report.includes('Request ID: req_xyz'), 'buildErrorReport: includes Request ID when present');
  assert(report.includes('Detail:'), 'buildErrorReport: includes Detail line when detail non-empty');
  assert(report.includes('"gcsStatus": 504'), 'buildErrorReport: Detail body is pretty JSON');
}
{
  // empty-object detail must NOT trigger the Detail section
  const failure = makeFailure({
    raw: makeEnvelope({ stage: 'upload', code: 'gcs_timeout', detail: {} }),
  });
  const report = buildErrorReport(failure, { projectId: 'p1' });
  assert(!report.includes('Detail:'), 'buildErrorReport: empty-object detail does NOT add Detail line');
}
{
  const llm: UploadLLMDiagnostic = {
    category: 'user',
    userFacingMessage: '請改用更小的 zip',
    suggestedFix: '把 node_modules 拿掉',
    rootCause: 'oversize',
    provider: 'gpt-5',
  };
  const failure = makeFailure({ llm });
  const report = buildErrorReport(failure, { projectId: 'p1' });
  assert(report.includes('--- LLM Diagnostic (gpt-5) ---'), 'buildErrorReport: LLM section header includes provider');
  assert(report.includes('Category: user'), 'buildErrorReport: LLM Category line');
  assert(report.includes('User-facing: 請改用更小的 zip'), 'buildErrorReport: User-facing line preserved');
  assert(report.includes('Suggested fix: 把 node_modules 拿掉'), 'buildErrorReport: Suggested fix line preserved');
  assert(report.includes('Root cause: oversize'), 'buildErrorReport: Root cause line included when present');
}
{
  const llm: UploadLLMDiagnostic = {
    category: 'platform',
    userFacingMessage: '稍後再試',
    suggestedFix: '等 5 分鐘',
    provider: 'rule_based',
  };
  const failure = makeFailure({ llm });
  const report = buildErrorReport(failure, { projectId: 'p1' });
  assert(
    !report.includes('Root cause:'),
    'buildErrorReport: Root cause line OMITTED when llm.rootCause undefined',
  );
}
{
  // Time line is always present (deterministic format check, not value check)
  const failure = makeFailure();
  const report = buildErrorReport(failure, { projectId: 'p1' });
  assert(/Time: \d{4}-\d{2}-\d{2}T/.test(report), 'buildErrorReport: Time line is ISO 8601');
}
{
  // navigator missing → 'n/a'
  (globalThis as any).navigator = undefined;
  const failure = makeFailure();
  const report = buildErrorReport(failure, { projectId: 'p1' });
  assert(report.includes('User-Agent: n/a'), 'buildErrorReport: missing navigator → "n/a"');
  // restore
  (globalThis as any).navigator = { userAgent: 'TestUA/1.0' };
}

// restore navigator
if (ORIG_NAVIGATOR === undefined) {
  delete (globalThis as any).navigator;
} else {
  (globalThis as any).navigator = ORIG_NAVIGATOR;
}

// ─── fetchDiagnostic ─────────────────────────────────────────────────────
//
// Mocks global fetch. Tests:
//  - success path: response.ok, returns merged failure with llm
//  - non-ok HTTP: returns base envelope (no llm)
//  - network throws: returns base envelope (no llm)

const ORIG_FETCH = (globalThis as any).fetch;

function installFetch(impl: (input: any, init?: any) => Promise<any>): void {
  (globalThis as any).fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (ORIG_FETCH === undefined) delete (globalThis as any).fetch;
  else (globalThis as any).fetch = ORIG_FETCH;
}

{
  const baseEnv = makeEnvelope({ stage: 'upload', code: 'unknown', message: 'mystery' });
  const llm: UploadLLMDiagnostic = {
    category: 'platform',
    userFacingMessage: 'try later',
    suggestedFix: 'wait',
    provider: 'claude',
  };
  let calledUrl = '';
  let calledInit: any = null;
  installFetch(async (url, init) => {
    calledUrl = String(url);
    calledInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ llmDiagnostic: llm }),
    };
  });

  const f = await fetchDiagnostic(baseEnv, 'https://api.example');
  restoreFetch();

  assertEq(calledUrl, 'https://api.example/api/upload/diagnose', 'fetchDiagnostic: posts to /api/upload/diagnose');
  assertEq(calledInit?.method, 'POST', 'fetchDiagnostic: uses POST method');
  assertEq(
    calledInit?.headers?.['Content-Type'],
    'application/json',
    'fetchDiagnostic: sets Content-Type: application/json',
  );
  // body should round-trip the envelope under "envelope" key
  const body = JSON.parse(calledInit?.body ?? '{}');
  assertEq(body.envelope?.code, 'unknown', 'fetchDiagnostic: body.envelope.code preserved');
  assertEq(body.envelope?.stage, 'upload', 'fetchDiagnostic: body.envelope.stage preserved');
  assertEq(body.envelope?.message, 'mystery', 'fetchDiagnostic: body.envelope.message preserved');

  assert(f.llm?.userFacingMessage === 'try later', 'fetchDiagnostic: success → failure.llm populated from response');
  assertEq(f.code, 'unknown', 'fetchDiagnostic: success preserves original code');
  assertEq(f.stage, 'upload', 'fetchDiagnostic: success preserves original stage');
}

{
  const baseEnv = makeEnvelope({ stage: 'upload', code: 'unknown', message: 'mystery' });
  installFetch(async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  }));
  const f = await fetchDiagnostic(baseEnv, 'https://api.example');
  restoreFetch();
  assertEq(f.llm, undefined, 'fetchDiagnostic: HTTP 503 → falls back to base envelope (no llm)');
  assertEq(f.code, 'unknown', 'fetchDiagnostic: HTTP 503 still returns mapped failure');
}

{
  const baseEnv = makeEnvelope({ stage: 'upload', code: 'unknown', message: 'mystery' });
  installFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  const f = await fetchDiagnostic(baseEnv, 'https://api.example');
  restoreFetch();
  assertEq(f.llm, undefined, 'fetchDiagnostic: fetch throws → no llm, no thrown exception to caller');
  assertEq(f.code, 'unknown', 'fetchDiagnostic: fetch throws still returns mapped failure');
}

{
  // server returns malformed json → mapped to base
  const baseEnv = makeEnvelope({ stage: 'upload', code: 'unknown' });
  installFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('JSON.parse failed');
    },
  }));
  const f = await fetchDiagnostic(baseEnv, 'https://api.example');
  restoreFetch();
  assertEq(
    f.llm,
    undefined,
    'fetchDiagnostic: response.json() throws → swallowed, returns base envelope mapped',
  );
}

// ─── Purity & isolation ──────────────────────────────────────────────────

{
  // mapEnvelope must NOT mutate the input envelope
  const env = makeEnvelope({
    stage: 'upload',
    code: 'gcs_timeout',
    detail: { gcsStatus: 504 },
  });
  const before = JSON.stringify(env);
  mapEnvelope(env);
  assertEq(JSON.stringify(env), before, 'purity: mapEnvelope does not mutate input envelope');
}
{
  // mapClientError must produce a fresh failure each call
  const a = mapClientError(new Error('x'), { stage: 'submit' });
  const b = mapClientError(new Error('x'), { stage: 'submit' });
  assert(a !== b, 'purity: mapClientError returns a fresh object each call');
  assert(a.raw !== b.raw, 'purity: mapClientError returns a fresh envelope each call');
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
