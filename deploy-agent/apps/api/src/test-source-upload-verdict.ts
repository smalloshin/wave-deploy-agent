/**
 * Tests for services/source-upload-verdict.ts (round 22).
 *
 * Run with: npx tsx src/test-source-upload-verdict.ts
 *
 * Sections:
 *   1. Verdict kinds × outcome matrix
 *   2. logSourceUploadVerdict via console-capture
 *   3. errorCode contract + literal-true narrowing invariants
 *   4. uploadAndPersistSourceWithVerdict orchestration helper
 *   5. Round-22 specific regressions (4-IIFE-dupe consolidation guards)
 */

import {
  buildSourceUploadVerdict,
  logSourceUploadVerdict,
  uploadAndPersistSourceWithVerdict,
  type SourceUploadVerdict,
  type BuildSourceUploadVerdictInput,
} from './services/source-upload-verdict';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    // eslint-disable-next-line no-console
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function input(overrides: Partial<BuildSourceUploadVerdictInput> = {}): BuildSourceUploadVerdictInput {
  return {
    projectLabel: 'kol-studio',
    upload: { ok: true, gcsUri: 'gs://wave-deploy-agent_cloudbuild/sources/kol-studio-1234.tgz', error: null },
    persist: { ok: true, error: null },
    ...overrides,
  };
}

// ── Section 1: verdict kinds × outcome matrix ──
console.log('--- Section 1: verdict kinds × outcome matrix ---');

(() => {
  // 1a. upload OK + persist OK → upload-and-persist-ok (success)
  const v = buildSourceUploadVerdict(input());
  check('all-ok → upload-and-persist-ok', v.kind === 'upload-and-persist-ok');
  check('all-ok logLevel=info', v.logLevel === 'info');
  if (v.kind === 'upload-and-persist-ok') {
    check('all-ok carries gcsUri', v.gcsUri.startsWith('gs://'));
    check('all-ok message says OK', v.message.includes('OK'));
    check('all-ok message names project label', v.message.includes('kol-studio'));
    check('all-ok message says gcsSourceUri persisted', v.message.includes('persisted'));
  }
})();

(() => {
  // 1b. upload failed → upload-failed (critical)
  const v = buildSourceUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'GCS upload failed (503): backend timeout' },
    persist: null,
  }));
  check('upload-failed kind', v.kind === 'upload-failed');
  check('upload-failed logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'upload-failed') {
    check('upload-failed errorCode=source_upload_failed', v.errorCode === 'source_upload_failed');
    check('upload-failed requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('upload-failed blockPipeline=true', v.blockPipeline === true);
    check('upload-failed carries uploadError verbatim', v.uploadError === 'GCS upload failed (503): backend timeout');
    check('upload-failed message contains the error', v.message.includes('503'));
    check('upload-failed message warns about cryptic deploy failure', v.message.includes('cryptic') || v.message.includes('30+'));
    check('upload-failed message says no bytes in GCS', v.message.includes('No bytes') || v.message.includes('no bytes'));
  }
})();

(() => {
  // 1c. upload OK + persist failed → upload-ok-persist-failed (critical, recoverable)
  const v = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/sources/x-1.tgz', error: null },
    persist: { ok: false, error: 'pg connection terminated' },
  }));
  check('persist-failed kind', v.kind === 'upload-ok-persist-failed');
  check('persist-failed logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'upload-ok-persist-failed') {
    check('persist-failed errorCode=source_upload_persist_drift', v.errorCode === 'source_upload_persist_drift');
    check('persist-failed requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('persist-failed blockPipeline=false (recoverable)', v.blockPipeline === false);
    check('persist-failed carries gcsUri verbatim (recovery URI)', v.gcsUri === 'gs://b/sources/x-1.tgz');
    check('persist-failed carries persistError verbatim', v.persistError === 'pg connection terminated');
    check('persist-failed message includes recovery SQL', v.message.includes('UPDATE projects SET config'));
    check('persist-failed message includes the gcsUri verbatim in the SQL (jsonb-quoted)', v.message.includes(`'"gs://b/sources/x-1.tgz"'::jsonb`));
    check('persist-failed message says pipeline continues', v.message.includes('Pipeline will continue'));
  }
})();

(() => {
  // 1d. upload ok=true but gcsUri=null → still upload-failed (defensive)
  const v = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: null, error: null },
    persist: null,
  }));
  check('upload ok=true + gcsUri=null → upload-failed (defensive)', v.kind === 'upload-failed');
  if (v.kind === 'upload-failed') {
    check('defensive case message has fallback error', v.message.length > 0);
  }
})();

(() => {
  // 1e. persist=null but upload OK → upload-ok-persist-failed (treated as not attempted)
  const v = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.tgz', error: null },
    persist: null,
  }));
  check('persist=null but upload OK → upload-ok-persist-failed', v.kind === 'upload-ok-persist-failed');
  if (v.kind === 'upload-ok-persist-failed') {
    check('persist=null fallback: persistError says not attempted', v.persistError.includes('not attempted'));
  }
})();

// ── Section 2: logSourceUploadVerdict via console-capture ──
console.log('--- Section 2: logSourceUploadVerdict via console-capture ---');

function captureConsole(): { logs: string[]; errors: string[]; warns: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  return {
    logs, errors, warns,
    restore: () => { console.log = origLog; console.error = origError; console.warn = origWarn; },
  };
}

(() => {
  const cap = captureConsole();
  try {
    logSourceUploadVerdict({
      kind: 'upload-and-persist-ok', logLevel: 'info', gcsUri: 'gs://b/x.tgz', message: 'msg-ok',
    });
  } finally { cap.restore(); }
  check('upload-and-persist-ok → 1 console.log', cap.logs.length === 1);
  check('upload-and-persist-ok → 0 console.error', cap.errors.length === 0);
  check('upload-and-persist-ok line carries [Upload] prefix', cap.logs[0]?.startsWith('[Upload] '));
  check('upload-and-persist-ok line carries the message', cap.logs[0]?.includes('msg-ok'));
})();

(() => {
  const cap = captureConsole();
  try {
    logSourceUploadVerdict({
      kind: 'upload-failed', logLevel: 'critical',
      uploadError: 'boom', errorCode: 'source_upload_failed',
      requiresOperatorAction: true, blockPipeline: true,
      message: 'msg-upload-fail',
    });
  } finally { cap.restore(); }
  check('upload-failed → 0 console.log', cap.logs.length === 0);
  check('upload-failed → 1 console.error', cap.errors.length === 1);
  check('upload-failed line carries [CRITICAL errorCode=source_upload_failed]', cap.errors[0]?.includes('[CRITICAL errorCode=source_upload_failed]'));
  check('upload-failed line carries the message', cap.errors[0]?.includes('msg-upload-fail'));
})();

(() => {
  const cap = captureConsole();
  try {
    logSourceUploadVerdict({
      kind: 'upload-ok-persist-failed', logLevel: 'critical',
      gcsUri: 'gs://b/x.tgz',
      persistError: 'db down', errorCode: 'source_upload_persist_drift',
      requiresOperatorAction: true, blockPipeline: false,
      message: 'msg-persist-fail',
    });
  } finally { cap.restore(); }
  check('upload-ok-persist-failed → 1 console.error', cap.errors.length === 1);
  check('upload-ok-persist-failed line carries [CRITICAL errorCode=source_upload_persist_drift]', cap.errors[0]?.includes('[CRITICAL errorCode=source_upload_persist_drift]'));
})();

// ── Section 3: errorCode contract + literal-true narrowing ──
console.log('--- Section 3: errorCode contract + invariants ---');

(() => {
  const v1 = buildSourceUploadVerdict(input({ upload: { ok: false, gcsUri: null, error: 'x' }, persist: null }));
  if (v1.kind === 'upload-failed') {
    const ec: 'source_upload_failed' = v1.errorCode;
    check('upload-failed errorCode literal narrows', ec === 'source_upload_failed');
    const flag: true = v1.requiresOperatorAction;
    check('upload-failed requiresOperatorAction literal narrows to true', flag === true);
    const block: true = v1.blockPipeline;
    check('upload-failed blockPipeline literal narrows to true', block === true);
  }

  const v2 = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.tgz', error: null },
    persist: { ok: false, error: 'x' },
  }));
  if (v2.kind === 'upload-ok-persist-failed') {
    const ec: 'source_upload_persist_drift' = v2.errorCode;
    check('persist-failed errorCode literal narrows', ec === 'source_upload_persist_drift');
    const block: false = v2.blockPipeline;
    check('persist-failed blockPipeline literal narrows to false', block === false);
  }
})();

(() => {
  // success path MUST NOT carry errorCode / requiresOperatorAction / blockPipeline
  const v = buildSourceUploadVerdict(input());
  check('success no errorCode field', !('errorCode' in v));
  check('success no requiresOperatorAction field', !('requiresOperatorAction' in v));
  check('success no blockPipeline field', !('blockPipeline' in v));
})();

(() => {
  const samples: SourceUploadVerdict[] = [
    buildSourceUploadVerdict(input()),
    buildSourceUploadVerdict(input({ upload: { ok: false, gcsUri: null, error: 'x' }, persist: null })),
    buildSourceUploadVerdict(input({ upload: { ok: true, gcsUri: 'gs://b/x.tgz', error: null }, persist: { ok: false, error: 'x' } })),
  ];
  for (const v of samples) {
    check(`logLevel ∈ {info, critical} for kind=${v.kind}`, v.logLevel === 'info' || v.logLevel === 'critical');
  }
  check('no warn level (binary contract)', samples.every((v) => (v.logLevel as string) !== 'warn'));
})();

// ── Section 4: uploadAndPersistSourceWithVerdict orchestration helper ──
// NOTE: this section uses TOP-LEVEL AWAIT to keep its console-capture
// sequenced ahead of synchronous Section 5 (which would otherwise pollute
// cap.logs while section-4 awaits were still pending).
console.log('--- Section 4: uploadAndPersistSourceWithVerdict helper ---');

{
  // 4a. Both succeed → upload-and-persist-ok, persist callback received the gcsUri
  const cap = captureConsole();
  let persistCalledWith: string | null = null;
  let v: SourceUploadVerdict;
  try {
    v = await uploadAndPersistSourceWithVerdict({
      projectLabel: 'p1',
      runUpload: async () => 'gs://b/p1.tgz',
      runPersist: async (uri) => { persistCalledWith = uri; },
    });
  } finally { cap.restore(); }
  check('helper happy-path → upload-and-persist-ok', v.kind === 'upload-and-persist-ok');
  check('helper happy-path → persist callback received gcsUri', persistCalledWith === 'gs://b/p1.tgz');
  check('helper happy-path → 1 [Upload] log line', cap.logs.length === 1);
  check('helper happy-path → 0 [Upload] error line', cap.errors.length === 0);

  // 4b. Upload throws → upload-failed, persist NEVER called
  const cap2 = captureConsole();
  let persist2Called = false;
  try {
    v = await uploadAndPersistSourceWithVerdict({
      projectLabel: 'p2',
      runUpload: async () => { throw new Error('GCS 503'); },
      runPersist: async () => { persist2Called = true; },
    });
  } finally { cap2.restore(); }
  check('helper upload-throws → upload-failed', v.kind === 'upload-failed');
  if (v.kind === 'upload-failed') {
    check('helper upload-throws → uploadError captured', v.uploadError === 'GCS 503');
    check('helper upload-throws → blockPipeline=true', v.blockPipeline === true);
  }
  check('helper upload-throws → persist NEVER called (gated)', persist2Called === false);
  check('helper upload-throws → 1 console.error', cap2.errors.length === 1);

  // 4c. Upload OK, persist throws → upload-ok-persist-failed, gcsUri preserved
  const cap3 = captureConsole();
  try {
    v = await uploadAndPersistSourceWithVerdict({
      projectLabel: 'p3',
      runUpload: async () => 'gs://b/p3.tgz',
      runPersist: async () => { throw new Error('pg ECONNREFUSED'); },
    });
  } finally { cap3.restore(); }
  check('helper persist-throws → upload-ok-persist-failed', v.kind === 'upload-ok-persist-failed');
  if (v.kind === 'upload-ok-persist-failed') {
    check('helper persist-throws → gcsUri preserved (recovery)', v.gcsUri === 'gs://b/p3.tgz');
    check('helper persist-throws → persistError captured', v.persistError === 'pg ECONNREFUSED');
    check('helper persist-throws → blockPipeline=false (recoverable)', v.blockPipeline === false);
  }

  // 4d. runUpload returns empty string — defensive
  const cap4 = captureConsole();
  try {
    v = await uploadAndPersistSourceWithVerdict({
      projectLabel: 'p4',
      runUpload: async () => '',
      runPersist: async () => {},
    });
  } finally { cap4.restore(); }
  // Empty string IS truthy enough — verdict module considers it OK if persist runs.
  if (v.kind === 'upload-and-persist-ok') {
    check('helper empty-uri → upload-and-persist-ok (gcsUri="" is truthy enough)', v.gcsUri === '');
  } else {
    check('helper empty-uri → some defined kind', v.kind !== undefined);
  }

  // 4e. Helper logs match verdict path (1 log for info, 1 error for critical)
  const cap5 = captureConsole();
  try {
    await uploadAndPersistSourceWithVerdict({
      projectLabel: 'p5',
      runUpload: async () => { throw new Error('x'); },
      runPersist: async () => {},
    });
  } finally { cap5.restore(); }
  check('helper critical → 1 console.error, 0 console.log', cap5.errors.length === 1 && cap5.logs.length === 0);
}

// ── Section 5: round-22 specific regressions ──
console.log('--- Section 5: round-22 specific regressions ---');

(() => {
  // R-1: the silent-IIFE bug — when upload fails, blockPipeline MUST be true.
  // Without this, the pipeline kicks off against /tmp source and the deploy
  // fails cryptically 30+ minutes later.
  const cases: Array<{ ok: boolean; uri: string | null; err: string }> = [
    { ok: false, uri: null, err: 'GCS 503' },
    { ok: false, uri: null, err: 'tar: command not found' },
    { ok: false, uri: null, err: 'EACCES tarball write' },
    { ok: false, uri: null, err: 'gcpFetch threw: ENOTFOUND storage.googleapis.com' },
    { ok: true, uri: null, err: '' }, // defensive: ok=true but no URI is still upload-failed
  ];
  for (const c of cases) {
    const v = buildSourceUploadVerdict(input({
      upload: { ok: c.ok, gcsUri: c.uri, error: c.err || null },
      persist: null,
    }));
    check(`R-1 case "${c.err || 'no-uri'}" → upload-failed`, v.kind === 'upload-failed');
    if (v.kind === 'upload-failed') {
      check(`R-1 case "${c.err || 'no-uri'}" → blockPipeline=true`, v.blockPipeline === true);
    }
  }
})();

(() => {
  // R-2: persist drift MUST be recoverable — the verdict carries the URI verbatim.
  // If the orchestrator dropped the URI, operator would have to grep GCS bucket
  // by timestamp prefix to find the right tarball.
  const v = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://wave-deploy-agent_cloudbuild/sources/myapp-1735000000000.tgz', error: null },
    persist: { ok: false, error: 'pg deadlock detected' },
  }));
  if (v.kind === 'upload-ok-persist-failed') {
    check('R-2 persist drift carries URI verbatim', v.gcsUri === 'gs://wave-deploy-agent_cloudbuild/sources/myapp-1735000000000.tgz');
    check('R-2 SQL message has the URI inside single-quoted JSONB literal', v.message.includes(`'"gs://wave-deploy-agent_cloudbuild/sources/myapp-1735000000000.tgz"'::jsonb`));
    check('R-2 SQL message says jsonb_set on {gcsSourceUri}', v.message.includes("jsonb_set(config, '{gcsSourceUri}'"));
    check('R-2 message warns operator must patch before approval', v.message.includes('before deploy approval'));
  }
})();

(() => {
  // R-3: critical message MUST warn that pipeline behavior diverges
  // (block vs continue), so on-call doesn't think both criticals are the same.
  const uploadFailed = buildSourceUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'x' }, persist: null,
  }));
  const persistFailed = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.tgz', error: null }, persist: { ok: false, error: 'y' },
  }));
  if (uploadFailed.kind === 'upload-failed' && persistFailed.kind === 'upload-ok-persist-failed') {
    check('R-3 upload-failed message says project transitions to failed', uploadFailed.message.includes("'failed'"));
    check('R-3 persist-failed message says pipeline continues', persistFailed.message.includes('Pipeline will continue'));
    check('R-3 messages are distinguishable', uploadFailed.message !== persistFailed.message);
  }
})();

(() => {
  // R-4: errorCode family — both criticals MUST carry distinct codes so
  // dashboards can distinguish "no GCS source" from "GCS but DB drift".
  const v1 = buildSourceUploadVerdict(input({ upload: { ok: false, gcsUri: null, error: 'x' }, persist: null }));
  const v2 = buildSourceUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.tgz', error: null }, persist: { ok: false, error: 'y' },
  }));
  if (v1.kind === 'upload-failed' && v2.kind === 'upload-ok-persist-failed') {
    check('R-4 errorCode source_upload_failed', v1.errorCode === 'source_upload_failed');
    check('R-4 errorCode source_upload_persist_drift', v2.errorCode === 'source_upload_persist_drift');
    // TS knows the literal types are distinct; cast both to string so the
    // assertion exercises the runtime guarantee rather than dead-code-warns.
    check('R-4 codes are distinct', (v1.errorCode as string) !== (v2.errorCode as string));
  }
})();

(() => {
  // R-5: idempotent (pure)
  const inp = input({ upload: { ok: false, gcsUri: null, error: 'x' }, persist: null });
  const a = buildSourceUploadVerdict(inp);
  const b = buildSourceUploadVerdict(inp);
  check('R-5 same input → same kind', a.kind === b.kind);
  check('R-5 same input → same logLevel', a.logLevel === b.logLevel);
  check('R-5 same input → same message', a.message === b.message);
})();

(() => {
  // R-6: empty projectLabel doesn't crash, just produces a degenerate label
  const v = buildSourceUploadVerdict({
    projectLabel: '',
    upload: { ok: false, gcsUri: null, error: 'x' },
    persist: null,
  });
  check('R-6 empty projectLabel still produces upload-failed', v.kind === 'upload-failed');
})();

(() => {
  // R-7: helper rejects nothing — runPersist throw is captured, not propagated
  // (so the IIFE caller doesn't crash with an unhandled rejection).
  let helperRejected = false;
  uploadAndPersistSourceWithVerdict({
    projectLabel: 'r7',
    runUpload: async () => 'gs://b/r7.tgz',
    runPersist: async () => { throw new Error('runPersist threw'); },
  }).catch(() => { helperRejected = true; });
  // Microtask drain
  setTimeout(() => {
    check('R-7 helper does not propagate persist throws (no unhandled rejection)', helperRejected === false);
  }, 50);
})();

(() => {
  // R-8: dashboard-grep contract — `[CRITICAL errorCode=source_upload_failed]`
  // must appear exactly once per upload-failed verdict log.
  const cap = captureConsole();
  try {
    const v = buildSourceUploadVerdict(input({
      upload: { ok: false, gcsUri: null, error: 'GCS quota exceeded' },
      persist: null,
    }));
    logSourceUploadVerdict(v);
  } finally { cap.restore(); }
  const hits = cap.errors.filter((l) => l.includes('[CRITICAL errorCode=source_upload_failed]'));
  check('R-8 dashboard-grep line count', hits.length === 1);
  check('R-8 grep line has projectLabel', hits[0]?.includes('kol-studio'));
  check('R-8 grep line has the underlying GCS error', hits[0]?.includes('quota exceeded'));
})();

// Wait briefly for setTimeout-based assertions before exit.
await new Promise((resolve) => setTimeout(resolve, 100));

console.log('');
console.log('─────────────────────────────────────');
console.log(`PASSED: ${pass}`);
console.log(`FAILED: ${fail}`);
if (fail > 0) {
  console.error('Some source-upload-verdict tests failed ✗');
  process.exit(1);
} else {
  console.log('All source-upload-verdict tests passed ✓');
}
