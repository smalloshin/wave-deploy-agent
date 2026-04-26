/**
 * Tests for services/db-dump-upload-verdict.ts (round 23, upload phase).
 *
 * Run with: npx tsx src/test-db-dump-upload-verdict.ts
 *
 * Sections:
 *   1. Verdict kinds × outcome matrix
 *   2. logDbDumpUploadVerdict via console-capture
 *   3. errorCode contract + literal-true narrowing invariants
 *   4. uploadAndPersistDbDumpWithVerdict orchestration helper
 *   5. Round-23 specific regressions (4-site DRY consolidation guards)
 */

import {
  buildDbDumpUploadVerdict,
  logDbDumpUploadVerdict,
  uploadAndPersistDbDumpWithVerdict,
  type DbDumpUploadVerdict,
  type BuildDbDumpUploadVerdictInput,
} from './services/db-dump-upload-verdict';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function input(overrides: Partial<BuildDbDumpUploadVerdictInput> = {}): BuildDbDumpUploadVerdictInput {
  return {
    projectLabel: 'kol-studio',
    dumpFileName: 'production-2026-04-25.sql.gz',
    upload: { ok: true, gcsUri: 'gs://wave-deploy-agent_cloudbuild/db-dumps/kol-studio-1234-production-2026-04-25.sql.gz', error: null },
    persist: { ok: true, error: null },
    ...overrides,
  };
}

// ── Section 1: verdict kinds × outcome matrix ──
console.log('--- Section 1: verdict kinds × outcome matrix ---');

(() => {
  // 1a. no dump provided → not-applicable
  const v = buildDbDumpUploadVerdict(input({ upload: null, persist: null }));
  check('no dump → not-applicable', v.kind === 'not-applicable');
  check('not-applicable logLevel=info', v.logLevel === 'info');
  check('not-applicable message names project label', v.message.includes('kol-studio'));
  check('not-applicable message says skipping', v.message.includes('skipping'));
})();

(() => {
  // 1b. upload OK + persist OK → upload-and-persist-ok
  const v = buildDbDumpUploadVerdict(input());
  check('all-ok → upload-and-persist-ok', v.kind === 'upload-and-persist-ok');
  check('all-ok logLevel=info', v.logLevel === 'info');
  if (v.kind === 'upload-and-persist-ok') {
    check('all-ok carries gcsUri', v.gcsUri.startsWith('gs://'));
    check('all-ok carries dumpFileName', v.dumpFileName === 'production-2026-04-25.sql.gz');
    check('all-ok message says OK', v.message.includes('OK'));
    check('all-ok message names project label', v.message.includes('kol-studio'));
    check('all-ok message says gcsDbDumpUri persisted', v.message.includes('persisted'));
    check('all-ok message includes file name', v.message.includes('production-2026-04-25.sql.gz'));
  }
})();

(() => {
  // 1c. upload failed → upload-failed (critical, blocks pipeline)
  const v = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'GCS upload failed (503): backend timeout' },
    persist: null,
  }));
  check('upload-failed kind', v.kind === 'upload-failed');
  check('upload-failed logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'upload-failed') {
    check('upload-failed errorCode=db_dump_upload_failed', v.errorCode === 'db_dump_upload_failed');
    check('upload-failed requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('upload-failed blockPipeline=true', v.blockPipeline === true);
    check('upload-failed carries uploadError verbatim', v.uploadError === 'GCS upload failed (503): backend timeout');
    check('upload-failed carries dumpFileName', v.dumpFileName === 'production-2026-04-25.sql.gz');
    check('upload-failed message contains error', v.message.includes('503'));
    check('upload-failed message warns about empty DB chain', v.message.includes('empty database') || v.message.includes('500'));
    check('upload-failed message says no bytes / never reached', v.message.includes('never reached') || v.message.includes('No bytes'));
  }
})();

(() => {
  // 1d. upload OK + persist failed → upload-ok-persist-failed (critical, recoverable)
  const v = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/db-dumps/x-1.sql', error: null },
    persist: { ok: false, error: 'pg connection terminated' },
  }));
  check('persist-failed kind', v.kind === 'upload-ok-persist-failed');
  check('persist-failed logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'upload-ok-persist-failed') {
    check('persist-failed errorCode=db_dump_persist_drift', v.errorCode === 'db_dump_persist_drift');
    check('persist-failed requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('persist-failed blockPipeline=false (recoverable)', v.blockPipeline === false);
    check('persist-failed carries gcsUri verbatim (recovery URI)', v.gcsUri === 'gs://b/db-dumps/x-1.sql');
    check('persist-failed carries dumpFileName', v.dumpFileName === 'production-2026-04-25.sql.gz');
    check('persist-failed carries persistError verbatim', v.persistError === 'pg connection terminated');
    check('persist-failed message includes recovery SQL UPDATE', v.message.includes('UPDATE projects SET config'));
    check('persist-failed message includes the gcsUri jsonb-quoted', v.message.includes(`'"gs://b/db-dumps/x-1.sql"'::jsonb`));
    check('persist-failed message warns operator MUST patch', v.message.includes('operator MUST patch') || v.message.includes('before deploy approval'));
  }
})();

(() => {
  // 1e. upload ok=true but gcsUri=null → upload-failed (defensive)
  const v = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: null, error: null },
    persist: null,
  }));
  check('upload ok=true + gcsUri=null → upload-failed (defensive)', v.kind === 'upload-failed');
  if (v.kind === 'upload-failed') {
    check('defensive case fallback message non-empty', v.message.length > 0);
  }
})();

(() => {
  // 1f. persist=null but upload OK → upload-ok-persist-failed (treated as not attempted)
  const v = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: null,
  }));
  check('persist=null + upload OK → upload-ok-persist-failed', v.kind === 'upload-ok-persist-failed');
  if (v.kind === 'upload-ok-persist-failed') {
    check('persist=null defaults to "persist not attempted"', v.persistError.includes('persist not attempted'));
  }
})();

(() => {
  // 1g. upload ok=false + error=null → upload-failed with defensive fallback
  const v = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: null },
    persist: null,
  }));
  check('upload ok=false + error=null → upload-failed', v.kind === 'upload-failed');
  if (v.kind === 'upload-failed') {
    check('null upload error → defensive fallback string in message',
      v.uploadError === 'upload outcome reported !ok with no error');
  }
})();

// ── Section 2: log helper console-capture ──
console.log('--- Section 2: log helper console-capture ---');

function captureConsole(): { logs: string[]; errors: string[]; warns: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  return {
    logs, errors, warns,
    restore: () => { console.log = origLog; console.error = origErr; console.warn = origWarn; },
  };
}

(() => {
  // 2a. not-applicable → console.log
  const cap = captureConsole();
  logDbDumpUploadVerdict(buildDbDumpUploadVerdict(input({ upload: null, persist: null })));
  cap.restore();
  check('not-applicable → 1 console.log line', cap.logs.length === 1);
  check('not-applicable → 0 console.error', cap.errors.length === 0);
  check('not-applicable log has [DbDumpUpload] prefix', cap.logs[0].includes('[DbDumpUpload]'));
})();

(() => {
  // 2b. upload-and-persist-ok → console.log
  const cap = captureConsole();
  logDbDumpUploadVerdict(buildDbDumpUploadVerdict(input()));
  cap.restore();
  check('all-ok → 1 console.log', cap.logs.length === 1);
  check('all-ok → 0 console.error', cap.errors.length === 0);
})();

(() => {
  // 2c. upload-failed → console.error with [CRITICAL errorCode=db_dump_upload_failed]
  const cap = captureConsole();
  logDbDumpUploadVerdict(buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'boom' },
    persist: null,
  })));
  cap.restore();
  check('upload-failed → 1 console.error', cap.errors.length === 1);
  check('upload-failed → 0 console.log', cap.logs.length === 0);
  check('upload-failed has [DbDumpUpload] prefix', cap.errors[0].includes('[DbDumpUpload]'));
  check('upload-failed has [CRITICAL errorCode=db_dump_upload_failed]', cap.errors[0].includes('[CRITICAL errorCode=db_dump_upload_failed]'));
})();

(() => {
  // 2d. upload-ok-persist-failed → console.error with [CRITICAL errorCode=db_dump_persist_drift]
  const cap = captureConsole();
  logDbDumpUploadVerdict(buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'db blip' },
  })));
  cap.restore();
  check('persist-failed → 1 console.error', cap.errors.length === 1);
  check('persist-failed has [CRITICAL errorCode=db_dump_persist_drift]', cap.errors[0].includes('[CRITICAL errorCode=db_dump_persist_drift]'));
})();

// ── Section 3: errorCode + literal-true narrowing ──
console.log('--- Section 3: errorCode + literal-true narrowing ---');

(() => {
  // 3a. not-applicable kind has NO errorCode / requiresOperatorAction / blockPipeline fields
  const v: DbDumpUploadVerdict = buildDbDumpUploadVerdict(input({ upload: null, persist: null }));
  if (v.kind === 'not-applicable') {
    check('not-applicable has no errorCode field', !('errorCode' in v));
    check('not-applicable has no requiresOperatorAction field', !('requiresOperatorAction' in v));
    check('not-applicable has no blockPipeline field', !('blockPipeline' in v));
  }
})();

(() => {
  // 3b. upload-and-persist-ok has NO errorCode / requiresOperatorAction / blockPipeline
  const v: DbDumpUploadVerdict = buildDbDumpUploadVerdict(input());
  if (v.kind === 'upload-and-persist-ok') {
    check('all-ok has no errorCode field', !('errorCode' in v));
    check('all-ok has no requiresOperatorAction field', !('requiresOperatorAction' in v));
    check('all-ok has no blockPipeline field', !('blockPipeline' in v));
  }
})();

(() => {
  // 3c. upload-failed: errorCode literal, requiresOperatorAction true, blockPipeline true
  const v: DbDumpUploadVerdict = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'x' },
    persist: null,
  }));
  if (v.kind === 'upload-failed') {
    const ec: 'db_dump_upload_failed' = v.errorCode;
    const ra: true = v.requiresOperatorAction;
    const bp: true = v.blockPipeline;
    check('upload-failed errorCode literal', ec === 'db_dump_upload_failed');
    check('upload-failed requiresOperatorAction literal true', ra === true);
    check('upload-failed blockPipeline literal true', bp === true);
  }
})();

(() => {
  // 3d. upload-ok-persist-failed: literal narrowing
  const v: DbDumpUploadVerdict = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'y' },
  }));
  if (v.kind === 'upload-ok-persist-failed') {
    const ec: 'db_dump_persist_drift' = v.errorCode;
    const ra: true = v.requiresOperatorAction;
    const bp: false = v.blockPipeline;
    check('persist-failed errorCode literal', ec === 'db_dump_persist_drift');
    check('persist-failed requiresOperatorAction literal true', ra === true);
    check('persist-failed blockPipeline literal false', bp === false);
  }
})();

(() => {
  // 3e. distinct errorCodes between the two critical kinds (runtime contract)
  const v1 = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'a' },
    persist: null,
  }));
  const v2 = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'b' },
  }));
  if (v1.kind === 'upload-failed' && v2.kind === 'upload-ok-persist-failed') {
    // cast to string: TS narrows the literals to non-overlapping types so the
    // direct compare is dead-code at compile time; this is a runtime contract test.
    check('errorCodes are distinct (runtime)', (v1.errorCode as string) !== (v2.errorCode as string));
  }
})();

// ── Section 4: uploadAndPersistDbDumpWithVerdict orchestration helper ──
console.log('--- Section 4: orchestration helper ---');

// Top-level await block (NOT async IIFE) — section 5 is synchronous and uses
// console.log via check(); if section 4 ran in an async IIFE alongside section
// 5's sync IIFEs, captureConsole calls in 4 would pollute logs from 5. Round
// 22 hit this exact bug — keep this block sequenced.
{
  // 4a. upload OK + persist OK → upload-and-persist-ok
  let uploadCalls = 0;
  let persistCalls = 0;
  const cap = captureConsole();
  const v = await uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'happy-path',
    dumpFileName: 'happy.sql',
    runUpload: async () => { uploadCalls++; return 'gs://b/db-dumps/happy.sql'; },
    runPersist: async () => { persistCalls++; },
  });
  cap.restore();
  check('helper happy-path → upload-and-persist-ok', v.kind === 'upload-and-persist-ok');
  check('helper happy-path: runUpload called once', uploadCalls === 1);
  check('helper happy-path: runPersist called once', persistCalls === 1);
  check('helper happy-path: 1 [DbDumpUpload] log line', cap.logs.length === 1 && cap.errors.length === 0);

  // 4b. upload throws → upload-failed; persist NEVER called
  let persistCalls2 = 0;
  const cap2 = captureConsole();
  const v2 = await uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'upload-throws',
    dumpFileName: 'boom.sql',
    runUpload: async () => { throw new Error('GCS 503'); },
    runPersist: async () => { persistCalls2++; },
  });
  cap2.restore();
  check('helper upload-throws → upload-failed', v2.kind === 'upload-failed');
  check('helper upload-throws: runPersist NOT called', persistCalls2 === 0);
  check('helper upload-throws: 1 critical console.error', cap2.errors.length === 1 && cap2.logs.length === 0);
  if (v2.kind === 'upload-failed') {
    check('helper upload-throws: error captured verbatim', v2.uploadError === 'GCS 503');
  }

  // 4c. upload OK but persist throws → upload-ok-persist-failed; URI preserved
  const cap3 = captureConsole();
  const v3 = await uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'persist-throws',
    dumpFileName: 'p.sql',
    runUpload: async () => 'gs://b/db-dumps/p.sql',
    runPersist: async () => { throw new Error('pg fell over'); },
  });
  cap3.restore();
  check('helper persist-throws → upload-ok-persist-failed', v3.kind === 'upload-ok-persist-failed');
  if (v3.kind === 'upload-ok-persist-failed') {
    check('helper persist-throws: gcsUri preserved', v3.gcsUri === 'gs://b/db-dumps/p.sql');
    check('helper persist-throws: error captured verbatim', v3.persistError === 'pg fell over');
  }

  // 4d. defensive: empty-string gcsUri from runUpload → upload-failed
  const cap4 = captureConsole();
  const v4 = await uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'empty-uri',
    dumpFileName: 'e.sql',
    runUpload: async () => '',  // empty string is falsy → upload-failed kind
    runPersist: async () => {},
  });
  cap4.restore();
  check('helper empty-string gcsUri → upload-failed (defensive)', v4.kind === 'upload-failed');

  // 4e. log routing: helper logs critical for upload-failed, info for happy
  const cap5a = captureConsole();
  await uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'route-info',
    dumpFileName: 'i.sql',
    runUpload: async () => 'gs://b/db-dumps/i.sql',
    runPersist: async () => {},
  });
  cap5a.restore();
  check('helper info verdicts → console.log only', cap5a.logs.length === 1 && cap5a.errors.length === 0);

  const cap5b = captureConsole();
  await uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'route-critical',
    dumpFileName: 'c.sql',
    runUpload: async () => { throw new Error('x'); },
    runPersist: async () => {},
  });
  cap5b.restore();
  check('helper critical verdicts → console.error only', cap5b.errors.length === 1 && cap5b.logs.length === 0);
}

// ── Section 5: round-23 specific regressions ──
console.log('--- Section 5: round-23 regressions ---');

(() => {
  // R-1: blockPipeline=true ONLY on upload-failed (not on persist-failed, not on success/n-a)
  const errs = [
    'GCS auth failed (401)',
    'GCS upload failed (503): backend timeout',
    'connect ETIMEDOUT 142.250.x.x:443',
    'EPIPE: broken pipe',
    'fetch failed: getaddrinfo ENOTFOUND',
  ];
  for (const err of errs) {
    const v = buildDbDumpUploadVerdict(input({
      upload: { ok: false, gcsUri: null, error: err },
      persist: null,
    }));
    if (v.kind === 'upload-failed') {
      check(`R-1 blockPipeline=true for "${err.slice(0, 25)}..."`, v.blockPipeline === true);
    }
  }

  // persist-failed must NOT block
  const vp = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'db blip' },
  }));
  if (vp.kind === 'upload-ok-persist-failed') {
    check('R-1 persist-failed blockPipeline=false', vp.blockPipeline === false);
  }
})();

(() => {
  // R-2: persist-failed message includes jsonb-quoted gcsUri verbatim for SQL recovery
  const uri = 'gs://wave-deploy-agent_cloudbuild/db-dumps/kol-studio-9999-prod.sql.gz';
  const v = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: uri, error: null },
    persist: { ok: false, error: 'pg' },
  }));
  if (v.kind === 'upload-ok-persist-failed') {
    check('R-2 message includes jsonb-quoted form', v.message.includes(`'"${uri}"'::jsonb`));
    check('R-2 message uses gcsDbDumpUri (not gcsSourceUri) jsonb path', v.message.includes("'{gcsDbDumpUri}'"));
    check('R-2 message includes WHERE id = clause', v.message.includes("WHERE id = '<projectId>'"));
  }
})();

(() => {
  // R-3: critical kinds have distinguishable messages
  const va = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'A' },
    persist: null,
  }));
  const vb = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'B' },
  }));
  check('R-3 upload-failed and persist-failed messages differ', va.message !== vb.message);
  check('R-3 upload-failed mentions empty database',
    va.message.includes('empty database') || va.message.includes('500'));
  check('R-3 persist-failed mentions before deploy approval',
    vb.message.includes('before deploy approval'));
})();

(() => {
  // R-4: errorCodes distinct + spelling matches contract
  const v1 = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'x' },
    persist: null,
  }));
  const v2 = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'y' },
  }));
  if (v1.kind === 'upload-failed' && v2.kind === 'upload-ok-persist-failed') {
    check('R-4 upload-failed errorCode spelling', v1.errorCode === 'db_dump_upload_failed');
    check('R-4 persist-drift errorCode spelling', v2.errorCode === 'db_dump_persist_drift');
  }
})();

(() => {
  // R-5: idempotent — calling builder twice with same input yields equivalent verdicts
  const i = input({
    upload: { ok: false, gcsUri: null, error: 'x' },
    persist: null,
  });
  const v1 = buildDbDumpUploadVerdict(i);
  const v2 = buildDbDumpUploadVerdict(i);
  check('R-5 idempotent: same kind', v1.kind === v2.kind);
  check('R-5 idempotent: same message', v1.message === v2.message);
  check('R-5 idempotent: same logLevel', v1.logLevel === v2.logLevel);
})();

(() => {
  // R-6: empty-string projectLabel still produces valid verdict (defensive)
  const v = buildDbDumpUploadVerdict(input({ projectLabel: '' }));
  check('R-6 empty label → still produces verdict (no crash)', v.kind === 'upload-and-persist-ok');
  check('R-6 empty label message non-empty', v.message.length > 0);
})();

(() => {
  // R-7: helper does NOT propagate persist throws (caller must NOT see them)
  let propagated = false;
  uploadAndPersistDbDumpWithVerdict({
    projectLabel: 'no-throw',
    dumpFileName: 'x.sql',
    runUpload: async () => 'gs://b/x.sql',
    runPersist: async () => { throw new Error('persist boom'); },
  }).catch(() => { propagated = true; });
  // Wait a tick for the promise to resolve
  setTimeout(() => {
    check('R-7 helper does NOT propagate persist throws', !propagated);
  }, 0);
})();

(() => {
  // R-8: dashboard-grep — every critical verdict carries a unique greppable signature
  const v1 = buildDbDumpUploadVerdict(input({
    upload: { ok: false, gcsUri: null, error: 'GCS 503' },
    persist: null,
  }));
  const v2 = buildDbDumpUploadVerdict(input({
    upload: { ok: true, gcsUri: 'gs://b/x.sql', error: null },
    persist: { ok: false, error: 'pg' },
  }));
  // Every critical verdict's logged line must contain "errorCode=" + a distinct value
  if (v1.logLevel === 'critical' && v2.logLevel === 'critical') {
    const cap1 = captureConsole();
    logDbDumpUploadVerdict(v1);
    cap1.restore();
    const cap2 = captureConsole();
    logDbDumpUploadVerdict(v2);
    cap2.restore();
    check('R-8 v1 log has unique errorCode signature',
      cap1.errors[0].includes('errorCode=db_dump_upload_failed'));
    check('R-8 v2 log has unique errorCode signature',
      cap2.errors[0].includes('errorCode=db_dump_persist_drift'));
    check('R-8 v1 and v2 log signatures differ', cap1.errors[0] !== cap2.errors[0]);
  }
})();

(() => {
  // R-9: not-applicable does NOT pollute critical log channel
  const cap = captureConsole();
  logDbDumpUploadVerdict(buildDbDumpUploadVerdict(input({ upload: null, persist: null })));
  cap.restore();
  check('R-9 not-applicable produces 0 console.error', cap.errors.length === 0);
})();

// ── Summary ──
console.log(`\n--- Summary ---`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
