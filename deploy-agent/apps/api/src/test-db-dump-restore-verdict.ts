/**
 * Tests for services/db-dump-restore-verdict.ts (round 23, restore phase).
 *
 * Run with: npx tsx src/test-db-dump-restore-verdict.ts
 *
 * Sections:
 *   1. Verdict kinds × outcome matrix
 *   2. logDbDumpRestoreVerdict via console-capture
 *   3. errorCode contract + literal-true narrowing invariants
 *   5. Round-23 specific regressions (restore-phase contract guards)
 *
 * No Section 4 — restore phase has no orchestration helper (single call site
 * in services/deploy-worker.ts; the upload-side helper exists because there
 * are 4 sites, the restore-side has 1).
 */

import {
  buildDbDumpRestoreVerdict,
  logDbDumpRestoreVerdict,
  type DbDumpRestoreVerdict,
  type BuildDbDumpRestoreVerdictInput,
  type DbDumpRestoreOutcome,
} from './services/db-dump-restore-verdict';

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

function input(overrides: Partial<BuildDbDumpRestoreVerdictInput> = {}): BuildDbDumpRestoreVerdictInput {
  return {
    projectLabel: 'kol-studio',
    gcsDbDumpUri: 'gs://wave-deploy-agent_cloudbuild/db-dumps/kol-studio-1234-prod.sql.gz',
    needsCloudSql: true,
    dumpFileName: 'production-2026-04-25.sql.gz',
    connectionStringHint: 'postgresql://app:***@10.0.0.5:5432/kol_studio',
    restore: { success: true, format: 'sql_gz', durationMs: 4200, bytesRestored: 12 * 1024 * 1024, error: null },
    ...overrides,
  };
}

function okOutcome(over: Partial<DbDumpRestoreOutcome> = {}): DbDumpRestoreOutcome {
  return { success: true, format: 'sql_gz', durationMs: 1000, bytesRestored: 1024 * 1024, error: null, ...over };
}

function failOutcome(err: string, format: DbDumpRestoreOutcome['format'] = 'sql'): DbDumpRestoreOutcome {
  return { success: false, format, durationMs: 800, bytesRestored: 0, error: err };
}

// ── Section 1: verdict kinds × outcome matrix ──
console.log('--- Section 1: verdict kinds × outcome matrix ---');

(() => {
  // 1a. no gcsDbDumpUri → not-applicable
  const v = buildDbDumpRestoreVerdict(input({ gcsDbDumpUri: null, restore: null }));
  check('no gcsDbDumpUri → not-applicable', v.kind === 'not-applicable');
  check('not-applicable logLevel=info', v.logLevel === 'info');
  check('not-applicable message names project label', v.message.includes('kol-studio'));
  check('not-applicable message says skipping', v.message.includes('skipping'));
  check('not-applicable message says reason (no gcsDbDumpUri)', v.message.includes('no gcsDbDumpUri'));
})();

(() => {
  // 1b. needsCloudSql=false → not-applicable
  const v = buildDbDumpRestoreVerdict(input({ needsCloudSql: false, restore: null }));
  check('needsCloudSql=false → not-applicable', v.kind === 'not-applicable');
  check('not-applicable message says reason (needsCloudSql=false)', v.message.includes('needsCloudSql=false'));
})();

(() => {
  // 1c. happy path → restore-ok
  const v = buildDbDumpRestoreVerdict(input());
  check('all-ok → restore-ok', v.kind === 'restore-ok');
  check('restore-ok logLevel=info', v.logLevel === 'info');
  if (v.kind === 'restore-ok') {
    check('restore-ok carries gcsDbDumpUri', v.gcsDbDumpUri.startsWith('gs://'));
    check('restore-ok carries dumpFileName', v.dumpFileName === 'production-2026-04-25.sql.gz');
    check('restore-ok carries format', v.format === 'sql_gz');
    check('restore-ok carries durationMs', v.durationMs === 4200);
    check('restore-ok carries bytesRestored', v.bytesRestored === 12 * 1024 * 1024);
    check('restore-ok message says OK', v.message.includes('OK'));
    check('restore-ok message names project label', v.message.includes('kol-studio'));
    check('restore-ok message includes format string', v.message.includes('format=sql_gz'));
    check('restore-ok message includes MB rendering', v.message.includes('12.0MB'));
    check('restore-ok message includes durationMs', v.message.includes('4200'));
  }
})();

(() => {
  // 1d. inner failure (restore.success=false) → restore-failed
  const v = buildDbDumpRestoreVerdict(input({
    restore: failOutcome('ERROR: relation "kol_users" violates foreign key constraint', 'sql'),
  }));
  check('inner-failure → restore-failed', v.kind === 'restore-failed');
  check('restore-failed logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'restore-failed') {
    check('restore-failed errorCode=db_dump_restore_drift', v.errorCode === 'db_dump_restore_drift');
    check('restore-failed requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('restore-failed carries restoreError verbatim',
      v.restoreError.includes('foreign key constraint'));
    check('restore-failed carries gcsDbDumpUri', v.gcsDbDumpUri.startsWith('gs://'));
    check('restore-failed carries dumpFileName', v.dumpFileName === 'production-2026-04-25.sql.gz');
    check('restore-failed carries format from outcome', v.format === 'sql');
    check('restore-failed carries connectionStringHint redacted', v.connectionStringHint.includes(':***@'));
    check('restore-failed message names project label', v.message.includes('kol-studio'));
    check('restore-failed message says FAILED', v.message.includes('FAILED'));
    check('restore-failed message warns about half-loaded/empty state',
      v.message.includes('half-loaded') || v.message.includes('empty'));
    check('restore-failed message says deploy continued / service IS live',
      v.message.includes('IS live') || v.message.includes('deploy continued'));
    check('restore-failed message includes recovery command keyword',
      v.message.includes('Recover') || v.message.includes('gsutil cp'));
  }
})();

(() => {
  // 1e. outer-catch path (success=false + error message but format=unknown)
  const v = buildDbDumpRestoreVerdict(input({
    restore: { success: false, format: 'unknown', durationMs: 0, bytesRestored: 0, error: 'GCS download failed (503)' },
  }));
  check('outer-catch → restore-failed', v.kind === 'restore-failed');
  if (v.kind === 'restore-failed') {
    check('outer-catch format=unknown', v.format === 'unknown');
    check('outer-catch error preserved', v.restoreError === 'GCS download failed (503)');
    check('outer-catch recoveryCommand uses psql -f (unknown format default)',
      v.recoveryCommand.includes('psql -f'));
  }
})();

(() => {
  // 1f. defensive — restore=null when needed → restore-failed (caller bug)
  const v = buildDbDumpRestoreVerdict(input({ restore: null }));
  check('restore=null + applicable → restore-failed (defensive)', v.kind === 'restore-failed');
  if (v.kind === 'restore-failed') {
    check('restore=null defensive message mentions caller bug',
      v.restoreError.includes('not attempted') || v.restoreError.includes('caller bug'));
    check('restore=null format=unknown', v.format === 'unknown');
  }
})();

(() => {
  // 1g. defensive — restore.success=false with error='' → fallback string used
  const v = buildDbDumpRestoreVerdict(input({
    restore: { success: false, format: 'sql', durationMs: 100, bytesRestored: 0, error: '' },
  }));
  check('empty error string → restore-failed', v.kind === 'restore-failed');
  if (v.kind === 'restore-failed') {
    check('empty error → fallback string in restoreError',
      v.restoreError === 'restore reported failure with no error message');
  }
})();

(() => {
  // 1h. defensive — restore.success=false with error=null → fallback used
  const v = buildDbDumpRestoreVerdict(input({
    restore: { success: false, format: 'sql', durationMs: 100, bytesRestored: 0, error: null as unknown as string },
  }));
  check('null error → restore-failed', v.kind === 'restore-failed');
  if (v.kind === 'restore-failed') {
    check('null error → fallback string',
      v.restoreError === 'restore reported failure with no error message');
  }
})();

(() => {
  // 1i. connectionStringHint=null → '<unknown>' fallback
  const v = buildDbDumpRestoreVerdict(input({
    connectionStringHint: null,
    restore: failOutcome('boom'),
  }));
  if (v.kind === 'restore-failed') {
    check('connectionStringHint=null → "<unknown>" fallback', v.connectionStringHint === '<unknown>');
    check('recoveryCommand uses <DATABASE_URL> placeholder when conn null',
      v.recoveryCommand.includes('<DATABASE_URL>'));
  }
})();

(() => {
  // 1j. format-driven recovery tools
  const cases: Array<[DbDumpRestoreOutcome['format'], string]> = [
    ['sql', "psql -f <local-dump>"],
    ['custom', 'pg_restore'],
    ['sql_gz', 'gunzip -c <local-dump> | psql'],
    ['unknown', 'psql -f <local-dump>'],
  ];
  for (const [fmt, expectedTool] of cases) {
    const v = buildDbDumpRestoreVerdict(input({ restore: failOutcome('x', fmt) }));
    if (v.kind === 'restore-failed') {
      check(`1j format=${fmt} → recoveryCommand uses ${expectedTool.split(' ')[0]}`,
        v.recoveryCommand.includes(expectedTool));
    }
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
  logDbDumpRestoreVerdict(buildDbDumpRestoreVerdict(input({ gcsDbDumpUri: null, restore: null })));
  cap.restore();
  check('not-applicable → 1 console.log line', cap.logs.length === 1);
  check('not-applicable → 0 console.error', cap.errors.length === 0);
  check('not-applicable log has [DbDumpRestore] prefix', cap.logs[0].includes('[DbDumpRestore]'));
})();

(() => {
  // 2b. restore-ok → console.log
  const cap = captureConsole();
  logDbDumpRestoreVerdict(buildDbDumpRestoreVerdict(input()));
  cap.restore();
  check('restore-ok → 1 console.log', cap.logs.length === 1);
  check('restore-ok → 0 console.error', cap.errors.length === 0);
  check('restore-ok log has [DbDumpRestore] prefix', cap.logs[0].includes('[DbDumpRestore]'));
})();

(() => {
  // 2c. restore-failed → console.error with [CRITICAL errorCode=db_dump_restore_drift]
  const cap = captureConsole();
  logDbDumpRestoreVerdict(buildDbDumpRestoreVerdict(input({ restore: failOutcome('boom') })));
  cap.restore();
  check('restore-failed → 1 console.error', cap.errors.length === 1);
  check('restore-failed → 0 console.log', cap.logs.length === 0);
  check('restore-failed has [DbDumpRestore] prefix', cap.errors[0].includes('[DbDumpRestore]'));
  check('restore-failed has [CRITICAL errorCode=db_dump_restore_drift] tag',
    cap.errors[0].includes('[CRITICAL errorCode=db_dump_restore_drift]'));
})();

(() => {
  // 2d. restore-failed (outer-catch path) routes to console.error too
  const cap = captureConsole();
  logDbDumpRestoreVerdict(buildDbDumpRestoreVerdict(input({
    restore: { success: false, format: 'unknown', durationMs: 0, bytesRestored: 0, error: 'GCS auth' },
  })));
  cap.restore();
  check('outer-catch verdict → 1 console.error', cap.errors.length === 1);
  check('outer-catch verdict → 0 console.log', cap.logs.length === 0);
})();

(() => {
  // 2e. defensive restore=null → console.error (still critical)
  const cap = captureConsole();
  logDbDumpRestoreVerdict(buildDbDumpRestoreVerdict(input({ restore: null })));
  cap.restore();
  check('restore=null → 1 console.error', cap.errors.length === 1);
})();

(() => {
  // 2f. log line includes operator-greppable signature
  const cap = captureConsole();
  logDbDumpRestoreVerdict(buildDbDumpRestoreVerdict(input({ restore: failOutcome('x') })));
  cap.restore();
  check('critical log includes errorCode= signature', cap.errors[0].includes('errorCode=db_dump_restore_drift'));
})();

// ── Section 3: errorCode + literal-true narrowing ──
console.log('--- Section 3: errorCode + literal-true narrowing ---');

(() => {
  // 3a. not-applicable has NO errorCode / requiresOperatorAction / blockDeploy / blockPipeline
  const v: DbDumpRestoreVerdict = buildDbDumpRestoreVerdict(input({ gcsDbDumpUri: null, restore: null }));
  if (v.kind === 'not-applicable') {
    check('not-applicable has no errorCode', !('errorCode' in v));
    check('not-applicable has no requiresOperatorAction', !('requiresOperatorAction' in v));
    check('not-applicable has no blockDeploy field', !('blockDeploy' in v));
    check('not-applicable has no blockPipeline field', !('blockPipeline' in v));
  }
})();

(() => {
  // 3b. restore-ok has NO errorCode / requiresOperatorAction / blockDeploy / blockPipeline
  const v: DbDumpRestoreVerdict = buildDbDumpRestoreVerdict(input());
  if (v.kind === 'restore-ok') {
    check('restore-ok has no errorCode', !('errorCode' in v));
    check('restore-ok has no requiresOperatorAction', !('requiresOperatorAction' in v));
    check('restore-ok has no blockDeploy', !('blockDeploy' in v));
    check('restore-ok has no blockPipeline', !('blockPipeline' in v));
  }
})();

(() => {
  // 3c. restore-failed: errorCode literal, requiresOperatorAction true, NO blockDeploy
  const v: DbDumpRestoreVerdict = buildDbDumpRestoreVerdict(input({ restore: failOutcome('x') }));
  if (v.kind === 'restore-failed') {
    const ec: 'db_dump_restore_drift' = v.errorCode;
    const ra: true = v.requiresOperatorAction;
    check('restore-failed errorCode literal', ec === 'db_dump_restore_drift');
    check('restore-failed requiresOperatorAction literal true', ra === true);
    check('restore-failed has NO blockDeploy field (surface-only contract)', !('blockDeploy' in v));
    check('restore-failed has NO blockPipeline field (different phase)', !('blockPipeline' in v));
  }
})();

(() => {
  // 3d. literal narrowing on extra string fields
  const v: DbDumpRestoreVerdict = buildDbDumpRestoreVerdict(input({ restore: failOutcome('boom') }));
  if (v.kind === 'restore-failed') {
    const a: string = v.gcsDbDumpUri;
    const b: string = v.dumpFileName;
    const c: string = v.restoreError;
    const d: string = v.connectionStringHint;
    const e: string = v.recoveryCommand;
    check('restore-failed gcsDbDumpUri is non-empty string', a.length > 0);
    check('restore-failed dumpFileName is non-empty string', b.length > 0);
    check('restore-failed restoreError is non-empty string', c.length > 0);
    check('restore-failed connectionStringHint is non-empty string', d.length > 0);
    check('restore-failed recoveryCommand is non-empty string', e.length > 0);
  }
})();

(() => {
  // 3e. errorCode is a single literal across all restore-failed variants
  const v1 = buildDbDumpRestoreVerdict(input({ restore: failOutcome('a', 'sql') }));
  const v2 = buildDbDumpRestoreVerdict(input({ restore: failOutcome('b', 'custom') }));
  const v3 = buildDbDumpRestoreVerdict(input({ restore: null }));
  if (v1.kind === 'restore-failed' && v2.kind === 'restore-failed' && v3.kind === 'restore-failed') {
    check('all restore-failed variants share same errorCode',
      (v1.errorCode as string) === (v2.errorCode as string) &&
      (v2.errorCode as string) === (v3.errorCode as string));
  }
})();

// ── Section 5: round-23 specific regressions ──
console.log('--- Section 5: round-23 regressions ---');

(() => {
  // R-1: restore-failed has NO blockDeploy field (surface-only contract).
  //      Cloud Run is mid-flight at this point — bailing would orphan a half-built
  //      revision, so the verdict deliberately does NOT introduce a third gating flag.
  const errs = [
    'ERROR: relation does not exist',
    'connection terminated unexpectedly',
    'pg_restore: error: could not read from input file',
    'gunzip: invalid compressed data',
    'GCS download failed (503): backend timeout',
    'EACCES: permission denied opening /tmp/dump.sql',
  ];
  for (const err of errs) {
    const v = buildDbDumpRestoreVerdict(input({ restore: failOutcome(err) }));
    if (v.kind === 'restore-failed') {
      check(`R-1 NO blockDeploy field for "${err.slice(0, 30)}..."`, !('blockDeploy' in v));
      check(`R-1 NO blockPipeline field for "${err.slice(0, 30)}..."`, !('blockPipeline' in v));
    }
  }
})();

(() => {
  // R-2: restore-failed message carries gcsDbDumpUri + dumpFileName for the
  //      operator's psql/pg_restore recovery hint
  const uri = 'gs://wave-deploy-agent_cloudbuild/db-dumps/kol-studio-9999-prod.sql.gz';
  const fn = 'kol-studio-prod-snapshot.sql.gz';
  const v = buildDbDumpRestoreVerdict(input({
    gcsDbDumpUri: uri,
    dumpFileName: fn,
    restore: failOutcome('boom', 'sql_gz'),
  }));
  if (v.kind === 'restore-failed') {
    check('R-2 message includes gcsDbDumpUri verbatim', v.message.includes(uri));
    check('R-2 message includes dumpFileName verbatim', v.message.includes(fn));
    check('R-2 verdict.gcsDbDumpUri matches input', v.gcsDbDumpUri === uri);
    check('R-2 verdict.dumpFileName matches input', v.dumpFileName === fn);
  }
})();

(() => {
  // R-3: recoveryCommand is runnable shell — gsutil cp + appropriate restore tool
  const v = buildDbDumpRestoreVerdict(input({
    gcsDbDumpUri: 'gs://b/db-dumps/x-1.sql',
    connectionStringHint: 'postgresql://app:***@host:5432/db',
    restore: failOutcome('x', 'sql'),
  }));
  if (v.kind === 'restore-failed') {
    check('R-3 recoveryCommand starts with gsutil cp',
      v.recoveryCommand.startsWith('gsutil cp '));
    check('R-3 recoveryCommand includes <local-dump> placeholder',
      v.recoveryCommand.includes('<local-dump>'));
    check('R-3 recoveryCommand includes connection string hint',
      v.recoveryCommand.includes("postgresql://app:***@host:5432/db"));
    check('R-3 recoveryCommand connection string is single-quoted',
      v.recoveryCommand.includes("'postgresql://app:***@host:5432/db'"));
    check('R-3 message embeds the recoveryCommand',
      v.message.includes(v.recoveryCommand));
  }
})();

(() => {
  // R-4: BOTH inner-failure AND outer-catch funnel into the same kind
  const innerV = buildDbDumpRestoreVerdict(input({
    restore: failOutcome('foreign-key violation', 'sql'),
  }));
  const outerV = buildDbDumpRestoreVerdict(input({
    restore: { success: false, format: 'unknown', durationMs: 0, bytesRestored: 0, error: 'GCS download failed (503)' },
  }));
  check('R-4 inner-failure → restore-failed', innerV.kind === 'restore-failed');
  check('R-4 outer-catch → restore-failed', outerV.kind === 'restore-failed');
  check('R-4 both share same errorCode',
    innerV.kind === 'restore-failed' && outerV.kind === 'restore-failed' &&
    innerV.errorCode === outerV.errorCode);
  check('R-4 both share critical logLevel',
    innerV.logLevel === outerV.logLevel && innerV.logLevel === 'critical');
})();

(() => {
  // R-5: not-applicable when no gcsDbDumpUri OR needsCloudSql=false
  const noUri = buildDbDumpRestoreVerdict(input({ gcsDbDumpUri: null, restore: null }));
  const noSql = buildDbDumpRestoreVerdict(input({ needsCloudSql: false, restore: null }));
  check('R-5 no gcsDbDumpUri → not-applicable', noUri.kind === 'not-applicable');
  check('R-5 needsCloudSql=false → not-applicable', noSql.kind === 'not-applicable');
  // Even with a successful restore outcome, missing gcsDbDumpUri short-circuits
  const noUriWithRestore = buildDbDumpRestoreVerdict(input({ gcsDbDumpUri: null }));
  check('R-5 no gcsDbDumpUri short-circuits BEFORE restore outcome is checked',
    noUriWithRestore.kind === 'not-applicable');
})();

(() => {
  // R-6: restore-failed message encodes the empty-DB / half-loaded-DB user
  //      pain chain — operator must understand that "deploy succeeded but DB is broken"
  const v = buildDbDumpRestoreVerdict(input({ restore: failOutcome('truncated') }));
  if (v.kind === 'restore-failed') {
    check('R-6 message says half-loaded OR empty', v.message.includes('half-loaded') || v.message.includes('empty'));
    check('R-6 message warns about every API call 500', v.message.includes('500'));
    check('R-6 message says service IS live (deploy continued)',
      v.message.includes('IS live') || v.message.includes('deploy continued'));
    check('R-6 message tells operator to manually re-run',
      v.message.includes('manually') || v.message.includes('Recover'));
  }
})();

(() => {
  // R-7: idempotent — same input → equivalent verdict
  const i = input({ restore: failOutcome('repeat-me') });
  const a = buildDbDumpRestoreVerdict(i);
  const b = buildDbDumpRestoreVerdict(i);
  check('R-7 idempotent: same kind', a.kind === b.kind);
  check('R-7 idempotent: same logLevel', a.logLevel === b.logLevel);
  check('R-7 idempotent: same message', a.message === b.message);
  if (a.kind === 'restore-failed' && b.kind === 'restore-failed') {
    check('R-7 idempotent: same recoveryCommand', a.recoveryCommand === b.recoveryCommand);
  }
})();

(() => {
  // R-8: dashboard-grep — restore-failed log line carries unique signature
  //      operators can grep on Cloud Run logs / alerting
  const v = buildDbDumpRestoreVerdict(input({ restore: failOutcome('x') }));
  if (v.kind === 'restore-failed') {
    const cap = captureConsole();
    logDbDumpRestoreVerdict(v);
    cap.restore();
    check('R-8 log line contains [CRITICAL', cap.errors[0].includes('[CRITICAL'));
    check('R-8 log line contains errorCode=db_dump_restore_drift',
      cap.errors[0].includes('errorCode=db_dump_restore_drift'));
    check('R-8 log line contains [DbDumpRestore] module tag',
      cap.errors[0].includes('[DbDumpRestore]'));
  }
})();

(() => {
  // R-9: empty-string projectLabel still produces valid verdict (defensive)
  const v = buildDbDumpRestoreVerdict(input({ projectLabel: '' }));
  check('R-9 empty label → still produces verdict (no crash)', v.kind === 'restore-ok');
  check('R-9 empty label message non-empty', v.message.length > 0);
})();

(() => {
  // R-10: restore-ok preserves all metric fields verbatim for dashboard config write
  const v = buildDbDumpRestoreVerdict(input({
    restore: okOutcome({ format: 'custom', durationMs: 7777, bytesRestored: 99 * 1024 * 1024 }),
  }));
  if (v.kind === 'restore-ok') {
    check('R-10 restore-ok format preserved', v.format === 'custom');
    check('R-10 restore-ok durationMs preserved', v.durationMs === 7777);
    check('R-10 restore-ok bytesRestored preserved', v.bytesRestored === 99 * 1024 * 1024);
  }
})();

(() => {
  // R-11: connection-string redaction is the CALLER's job — verdict trusts input.
  //       This test documents the contract by passing a redacted hint and
  //       confirming the verdict echoes it as-is into recoveryCommand.
  const redacted = 'postgresql://app:***@10.0.0.5:5432/kol_studio?sslmode=require';
  const v = buildDbDumpRestoreVerdict(input({
    connectionStringHint: redacted,
    restore: failOutcome('x'),
  }));
  if (v.kind === 'restore-failed') {
    check('R-11 verdict echoes redacted connection string verbatim',
      v.connectionStringHint === redacted);
    check('R-11 recoveryCommand contains redacted form (no real password)',
      v.recoveryCommand.includes(':***@') && !v.recoveryCommand.includes('hunter2'));
  }
})();

(() => {
  // R-12: restore-failed.format reflects the OUTCOME format, not 'unknown',
  //       when the inner restore got far enough to detect the format
  const v = buildDbDumpRestoreVerdict(input({
    restore: failOutcome('partial restore', 'custom'),
  }));
  if (v.kind === 'restore-failed') {
    check('R-12 restore-failed format echoes outcome format', v.format === 'custom');
    check('R-12 recoveryCommand uses pg_restore for custom format',
      v.recoveryCommand.includes('pg_restore'));
  }
})();

// ── Summary ──
console.log(`\n--- Summary ---`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
