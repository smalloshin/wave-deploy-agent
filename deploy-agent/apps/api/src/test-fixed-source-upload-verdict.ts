/**
 * Tests for fixed-source-upload-verdict.ts (round 20).
 *
 * Run: npx tsx src/test-fixed-source-upload-verdict.ts
 *
 * Sections:
 *   1. All 4 verdict kinds × outcome matrix
 *   2. logFixedSourceUploadVerdict via console-capture
 *   3. errorCode contract + literal narrowing + invariants
 *   4. Round-20 specific bug regressions (the security flagship lie)
 */

import {
  buildFixedSourceUploadVerdict,
  logFixedSourceUploadVerdict,
  type FixedSourceUploadVerdict,
  type BuildFixedSourceUploadVerdictInput,
} from './services/fixed-source-upload-verdict.js';

// ─── Test harness ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(label: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label} (expected true)`);
  }
}

function assertContains(label: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}\n  string did not contain: "${needle}"\n  actual: "${haystack}"`);
  }
}

// ─── Console capture helper ──────────────────────────────────────────────
interface CapturedLog {
  level: 'log' | 'warn' | 'error';
  message: string;
}

function captureConsole(fn: () => void): CapturedLog[] {
  const logs: CapturedLog[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push({ level: 'log', message: args.map(String).join(' ') });
  };
  console.warn = (...args: unknown[]) => {
    logs.push({ level: 'warn', message: args.map(String).join(' ') });
  };
  console.error = (...args: unknown[]) => {
    logs.push({ level: 'error', message: args.map(String).join(' ') });
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return logs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const baseSuccessInput = (
  overrides: Partial<BuildFixedSourceUploadVerdictInput> = {}
): BuildFixedSourceUploadVerdictInput => ({
  applicable: true,
  projectLabel: 'kol-studio',
  tarballAndUpload: {
    ok: true,
    gcsUri: 'gs://wave-deploy-agent_cloudbuild/sources-fixed/kol-studio-1234567890.tgz',
    bytes: 12345,
    error: null,
  },
  dbPersist: { ok: true, error: null },
  ...overrides,
});

// ─── Section 1: 4 verdict kinds × outcome matrix ────────────────────────
console.log('--- Section 1: verdict kinds × outcome matrix ---');

// 1.1 not-applicable: applicable=false short-circuits
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'static-site',
    tarballAndUpload: null,
    dbPersist: null,
  });
  assertEq('1.1a not-applicable kind', v.kind, 'not-applicable');
  assertEq('1.1b not-applicable logLevel', v.logLevel, 'info');
  assertContains('1.1c message has projectLabel', v.message, 'static-site');
  assertContains('1.1d message says "not applicable"', v.message, 'not applicable');
}

// 1.2 not-applicable wins even when other fields look valid
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'p',
    tarballAndUpload: { ok: true, gcsUri: 'gs://b/o', bytes: 100, error: null },
    dbPersist: { ok: true, error: null },
  });
  assertEq('1.2 applicable=false short-circuits even with valid downstream', v.kind, 'not-applicable');
}

// 1.3 success: tarball OK + DB persist OK
{
  const v = buildFixedSourceUploadVerdict(baseSuccessInput());
  assertEq('1.3a success kind', v.kind, 'success');
  assertEq('1.3b success logLevel', v.logLevel, 'info');
  if (v.kind === 'success') {
    assertEq('1.3c success gcsUri preserved', v.gcsUri, 'gs://wave-deploy-agent_cloudbuild/sources-fixed/kol-studio-1234567890.tgz');
    assertEq('1.3d success bytes preserved', v.bytes, 12345);
    assertContains('1.3e success message has bytes', v.message, '12345');
    assertContains('1.3f success message has gcsUri', v.message, 'sources-fixed');
  }
}

// 1.4 tarball-or-upload-failed: tar threw
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'tar-failed: spawn ENOENT' },
      dbPersist: null,
    })
  );
  assertEq('1.4a tarball-fail kind', v.kind, 'tarball-or-upload-failed');
  assertEq('1.4b tarball-fail logLevel', v.logLevel, 'critical');
  if (v.kind === 'tarball-or-upload-failed') {
    assertEq('1.4c errorCode', v.errorCode, 'fixed_source_upload_failed');
    assertEq('1.4d requiresOperatorAction literal true', v.requiresOperatorAction, true);
    assertEq('1.4e blockApproval literal true', v.blockApproval, true);
    assertEq('1.4f tarballError preserved', v.tarballError, 'tar-failed: spawn ENOENT');
    assertContains('1.4g message has tar-failed prefix', v.message, 'tar-failed');
    assertContains('1.4h message warns ORIGINAL UNFIXED', v.message, 'ORIGINAL UNFIXED');
  }
}

// 1.5 tarball-or-upload-failed: upload returned !ok
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'upload-failed: GCS HTTP 403: AccessDenied' },
      dbPersist: null,
    })
  );
  assertEq('1.5a upload-fail kind', v.kind, 'tarball-or-upload-failed');
  if (v.kind === 'tarball-or-upload-failed') {
    assertContains('1.5b message has upload-failed prefix', v.message, 'upload-failed');
    assertContains('1.5c message has HTTP 403', v.message, 'HTTP 403');
  }
}

// 1.6 tarball-or-upload-failed: getProject threw
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'get-project-failed: connection timeout' },
      dbPersist: null,
    })
  );
  if (v.kind === 'tarball-or-upload-failed') {
    assertContains('1.6 get-project-failed prefix preserved', v.tarballError, 'get-project-failed');
  }
}

// 1.7 tarball-or-upload-failed: tarballAndUpload null (defensive)
{
  const v = buildFixedSourceUploadVerdict({
    applicable: true,
    projectLabel: 'p',
    tarballAndUpload: null,
    dbPersist: null,
  });
  assertEq('1.7a null tarballAndUpload → tarball-or-upload-failed', v.kind, 'tarball-or-upload-failed');
  if (v.kind === 'tarball-or-upload-failed') {
    assertContains('1.7b null fallback message', v.tarballError, 'not attempted');
  }
}

// 1.8 tarball-or-upload-failed: tarballAndUpload ok=false but null error
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: null },
      dbPersist: null,
    })
  );
  if (v.kind === 'tarball-or-upload-failed') {
    assertContains('1.8 null error string fallback', v.tarballError, 'not attempted');
  }
}

// 1.9 db-persist-failed-after-upload: tarball OK but DB write threw
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      dbPersist: { ok: false, error: 'connection refused' },
    })
  );
  assertEq('1.9a db-persist-fail kind', v.kind, 'db-persist-failed-after-upload');
  assertEq('1.9b db-persist-fail logLevel', v.logLevel, 'critical');
  if (v.kind === 'db-persist-failed-after-upload') {
    assertEq('1.9c errorCode', v.errorCode, 'fixed_source_db_drift');
    assertEq('1.9d requiresOperatorAction literal true', v.requiresOperatorAction, true);
    assertEq('1.9e blockApproval literal true', v.blockApproval, true);
    assertEq('1.9f gcsUri preserved (recoverable)', v.gcsUri, 'gs://wave-deploy-agent_cloudbuild/sources-fixed/kol-studio-1234567890.tgz');
    assertEq('1.9g bytes preserved', v.bytes, 12345);
    assertEq('1.9h dbError preserved', v.dbError, 'connection refused');
    assertContains('1.9i message has manual recovery hint', v.message, 'manually set project.config.gcsFixedSourceUri');
    assertContains('1.9j message includes recoverable URI', v.message, 'sources-fixed');
  }
}

// 1.10 db-persist-failed-after-upload: dbPersist null with tarball OK (defensive)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: null })
  );
  assertEq('1.10a null dbPersist with tarball OK → db-persist-fail', v.kind, 'db-persist-failed-after-upload');
  if (v.kind === 'db-persist-failed-after-upload') {
    assertContains('1.10b null dbPersist fallback', v.dbError, 'not attempted');
  }
}

// 1.11 db-persist-failed-after-upload: dbPersist ok=false null error
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: { ok: false, error: null } })
  );
  if (v.kind === 'db-persist-failed-after-upload') {
    assertContains('1.11 null error string fallback', v.dbError, 'not attempted');
  }
}

// 1.12 db-persist-failed: tarball.gcsUri null (degenerate but defensive)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: true, gcsUri: null, bytes: 100, error: null },
      dbPersist: { ok: false, error: 'x' },
    })
  );
  if (v.kind === 'db-persist-failed-after-upload') {
    assertEq('1.12 gcsUri empty-string fallback when tarball.gcsUri null', v.gcsUri, '');
  }
}

// 1.13 success: tarball.gcsUri null (degenerate but defensive)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: true, gcsUri: null, bytes: 100, error: null },
    })
  );
  if (v.kind === 'success') {
    assertEq('1.13 success gcsUri empty-string fallback', v.gcsUri, '');
  }
}

// 1.14 success: bytes=0 (technically valid empty tarball)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: true, gcsUri: 'gs://b/o', bytes: 0, error: null },
    })
  );
  if (v.kind === 'success') {
    assertEq('1.14 success bytes=0 preserved', v.bytes, 0);
  }
}

// 1.15 not-applicable: tarballAndUpload + dbPersist passed but applicable=false
//      (verdict planner ignores them — short-circuit must dominate)
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'p',
    tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'should-be-ignored' },
    dbPersist: { ok: false, error: 'also-ignored' },
  });
  assertEq('1.15 applicable=false ignores even ok=false downstream', v.kind, 'not-applicable');
}

// ─── Section 2: logFixedSourceUploadVerdict via console-capture ────────
console.log('--- Section 2: logFixedSourceUploadVerdict via console-capture ---');

// 2.1 not-applicable → log
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'p',
    tarballAndUpload: null,
    dbPersist: null,
  });
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertEq('2.1a single log entry', logs.length, 1);
  assertEq('2.1b level=log', logs[0]!.level, 'log');
  assertContains('2.1c [Pipeline] prefix', logs[0]!.message, '[Pipeline]');
}

// 2.2 success → log
{
  const v = buildFixedSourceUploadVerdict(baseSuccessInput());
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertEq('2.2a single log entry', logs.length, 1);
  assertEq('2.2b level=log', logs[0]!.level, 'log');
}

// 2.3 tarball-or-upload-failed → error with [CRITICAL errorCode=...]
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'tar-failed: x' },
      dbPersist: null,
    })
  );
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertEq('2.3a single log entry', logs.length, 1);
  assertEq('2.3b level=error', logs[0]!.level, 'error');
  assertContains('2.3c [CRITICAL] tag', logs[0]!.message, '[CRITICAL');
  assertContains('2.3d errorCode in log', logs[0]!.message, 'fixed_source_upload_failed');
  assertContains('2.3e [Pipeline] prefix', logs[0]!.message, '[Pipeline]');
}

// 2.4 db-persist-failed-after-upload → error with errorCode
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      dbPersist: { ok: false, error: 'db-down' },
    })
  );
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertEq('2.4a single log entry', logs.length, 1);
  assertEq('2.4b level=error', logs[0]!.level, 'error');
  assertContains('2.4c errorCode', logs[0]!.message, 'fixed_source_db_drift');
}

// 2.5 logger never throws on any kind
{
  const kinds: FixedSourceUploadVerdict[] = [
    buildFixedSourceUploadVerdict({
      applicable: false,
      projectLabel: 'p',
      tarballAndUpload: null,
      dbPersist: null,
    }),
    buildFixedSourceUploadVerdict(baseSuccessInput()),
    buildFixedSourceUploadVerdict(
      baseSuccessInput({
        tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
        dbPersist: null,
      })
    ),
    buildFixedSourceUploadVerdict(
      baseSuccessInput({
        dbPersist: { ok: false, error: 'x' },
      })
    ),
  ];
  for (let i = 0; i < kinds.length; i++) {
    let threw = false;
    captureConsole(() => {
      try {
        logFixedSourceUploadVerdict(kinds[i]!);
      } catch {
        threw = true;
      }
    });
    assertTrue(`2.5.${i} log helper does not throw on kind=${kinds[i]!.kind}`, !threw);
  }
}

// 2.6 projectLabel flows into critical log
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      projectLabel: 'unique-flagship-project',
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'tar-failed' },
      dbPersist: null,
    })
  );
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertContains('2.6 projectLabel in critical log', logs[0]!.message, 'unique-flagship-project');
}

// 2.7 db-persist-fail log includes recoverable URI
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: {
        ok: true,
        gcsUri: 'gs://recovery-bucket/recovery-path.tgz',
        bytes: 999,
        error: null,
      },
      dbPersist: { ok: false, error: 'x' },
    })
  );
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertContains('2.7 recoverable URI in log', logs[0]!.message, 'gs://recovery-bucket/recovery-path.tgz');
}

// ─── Section 3: errorCode contract + literal narrowing + invariants ────
console.log('--- Section 3: errorCode contract + invariants ---');

// 3.1 The 2 errorCode strings are stable (dashboard contract)
{
  const tarFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
      dbPersist: null,
    })
  );
  if (tarFail.kind === 'tarball-or-upload-failed') {
    assertEq('3.1a errorCode pin: tarball-or-upload-failed', tarFail.errorCode, 'fixed_source_upload_failed');
  }
  const dbFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: { ok: false, error: 'x' } })
  );
  if (dbFail.kind === 'db-persist-failed-after-upload') {
    assertEq('3.1b errorCode pin: db-persist-failed-after-upload', dbFail.errorCode, 'fixed_source_db_drift');
  }
}

// 3.2 requiresOperatorAction is literal-true on both critical kinds
{
  const tarFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
      dbPersist: null,
    })
  );
  if (tarFail.kind === 'tarball-or-upload-failed') {
    const t: true = tarFail.requiresOperatorAction;
    assertEq('3.2a tar-fail requiresOperatorAction literal true', t, true);
  }
  const dbFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: { ok: false, error: 'x' } })
  );
  if (dbFail.kind === 'db-persist-failed-after-upload') {
    const t: true = dbFail.requiresOperatorAction;
    assertEq('3.2b db-fail requiresOperatorAction literal true', t, true);
  }
}

// 3.3 blockApproval is literal-true on both critical kinds
//     (this is the contract that prevents the security flagship lie)
{
  const tarFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
      dbPersist: null,
    })
  );
  if (tarFail.kind === 'tarball-or-upload-failed') {
    const t: true = tarFail.blockApproval;
    assertEq('3.3a tar-fail blockApproval literal true', t, true);
  }
  const dbFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: { ok: false, error: 'x' } })
  );
  if (dbFail.kind === 'db-persist-failed-after-upload') {
    const t: true = dbFail.blockApproval;
    assertEq('3.3b db-fail blockApproval literal true', t, true);
  }
}

// 3.4 success kind has no errorCode / requiresOperatorAction / blockApproval
{
  const v = buildFixedSourceUploadVerdict(baseSuccessInput());
  if (v.kind === 'success') {
    // @ts-expect-error -- field intentionally absent
    const _e = v.errorCode;
    void _e;
    // @ts-expect-error -- field intentionally absent
    const _r = v.requiresOperatorAction;
    void _r;
    // @ts-expect-error -- field intentionally absent
    const _b = v.blockApproval;
    void _b;
    assertTrue('3.4 success kind has no critical-only fields', true);
  }
}

// 3.5 not-applicable kind has no errorCode / requiresOperatorAction / blockApproval
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'p',
    tarballAndUpload: null,
    dbPersist: null,
  });
  if (v.kind === 'not-applicable') {
    // @ts-expect-error -- field intentionally absent
    const _e = v.errorCode;
    void _e;
    // @ts-expect-error -- field intentionally absent
    const _b = v.blockApproval;
    void _b;
    assertTrue('3.5 not-applicable kind has no critical-only fields', true);
  }
}

// 3.6 projectLabel flows into all 4 verdict kinds
{
  const cases: Array<[string, BuildFixedSourceUploadVerdictInput]> = [
    ['not-applicable', { applicable: false, projectLabel: '', tarballAndUpload: null, dbPersist: null }],
    ['success', baseSuccessInput()],
    [
      'tarball-fail',
      baseSuccessInput({
        tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
        dbPersist: null,
      }),
    ],
    ['db-fail', baseSuccessInput({ dbPersist: { ok: false, error: 'x' } })],
  ];
  for (const [label, base] of cases) {
    const v = buildFixedSourceUploadVerdict({
      ...base,
      projectLabel: 'flow-' + label,
    });
    assertContains(`3.6.${label} projectLabel in message`, v.message, 'flow-' + label);
  }
}

// 3.7 db-persist-fail carries the recoverable URI (operator can use it directly)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: true, gcsUri: 'gs://exact/path.tgz', bytes: 555, error: null },
      dbPersist: { ok: false, error: 'x' },
    })
  );
  if (v.kind === 'db-persist-failed-after-upload') {
    assertEq('3.7a recoverable gcsUri exact', v.gcsUri, 'gs://exact/path.tgz');
    assertContains('3.7b recoverable URI quoted in message', v.message, "'gs://exact/path.tgz'");
  }
}

// ─── Section 4: round-20 specific bug regressions (security flagship lie) ─
console.log('--- Section 4: round-20 specific regressions ---');

// 4.1 REGRESSION: tarball failure MUST be CRITICAL, not warn
//     (legacy code: console.warn; round 20: critical because reviewer
//     would otherwise approve a non-existent fix)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'tar-failed: x' },
      dbPersist: null,
    })
  );
  assertEq('4.1a tarball-fail logLevel must be critical', v.logLevel, 'critical');
  if (v.kind === 'tarball-or-upload-failed') {
    assertEq('4.1b blockApproval must be true', v.blockApproval, true);
  }
}

// 4.2 REGRESSION: db-persist failure MUST also be CRITICAL
//     (same end-user impact: deploy uses original unfixed source)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      dbPersist: { ok: false, error: 'db-down' },
    })
  );
  assertEq('4.2a db-persist-fail logLevel must be critical', v.logLevel, 'critical');
  if (v.kind === 'db-persist-failed-after-upload') {
    assertEq('4.2b blockApproval must be true', v.blockApproval, true);
  }
}

// 4.3 REGRESSION: success path MUST NOT have blockApproval (otherwise
//     normal pipelines would never reach review_pending)
{
  const v = buildFixedSourceUploadVerdict(baseSuccessInput());
  assertTrue('4.3 success path has no blockApproval', !('blockApproval' in v));
}

// 4.4 REGRESSION: not-applicable MUST NOT have blockApproval (mutation-free
//     pipelines should still reach review_pending)
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'static-no-fixes',
    tarballAndUpload: null,
    dbPersist: null,
  });
  assertTrue('4.4 not-applicable has no blockApproval', !('blockApproval' in v));
}

// 4.5 REGRESSION: phase ordering — tarball-fail dominates over db-persist
//     state (defensive: if orchestrator passes both populated, the more
//     severe / earlier failure wins. Without this, an operator might
//     conclude bytes are recoverable when they aren't.)
{
  const v = buildFixedSourceUploadVerdict({
    applicable: true,
    projectLabel: 'p',
    tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'tar-failed' },
    dbPersist: { ok: true, error: null }, // shouldn't happen but be defensive
  });
  assertEq('4.5 tarball-fail dominates over downstream db state', v.kind, 'tarball-or-upload-failed');
}

// 4.6 REGRESSION: tarball-fail message MUST mention "ORIGINAL UNFIXED"
//     (this is the security warning operators must see)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
      dbPersist: null,
    })
  );
  if (v.kind === 'tarball-or-upload-failed') {
    assertContains('4.6 tarball-fail message has security warning', v.message, 'ORIGINAL UNFIXED');
  }
}

// 4.7 REGRESSION: db-persist-fail message MUST mention "ORIGINAL UNFIXED"
//     (same security warning, different recovery path)
{
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: { ok: false, error: 'x' } })
  );
  if (v.kind === 'db-persist-failed-after-upload') {
    assertContains('4.7 db-persist-fail message has security warning', v.message, 'ORIGINAL UNFIXED');
  }
}

// 4.8 REGRESSION: db-persist-fail recoverable URI MUST be in the message
//     verbatim so operator can copy-paste it into the recovery script
{
  const exactUri = 'gs://wave-deploy-agent_cloudbuild/sources-fixed/test-987654321.tgz';
  const v = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: true, gcsUri: exactUri, bytes: 1000, error: null },
      dbPersist: { ok: false, error: 'connection refused' },
    })
  );
  if (v.kind === 'db-persist-failed-after-upload') {
    assertContains('4.8a recoverable URI in message', v.message, exactUri);
    assertContains('4.8b message has manual-set hint', v.message, 'manually set');
  }
}

// 4.9 REGRESSION: per-step failure-mode discriminator strings preserved
//     verbatim (operator needs to know which sub-step failed)
{
  const cases: Array<[string, string]> = [
    ['tar-failed: x', 'tar-failed'],
    ['get-project-failed: y', 'get-project-failed'],
    ['upload-failed: GCS HTTP 403', 'upload-failed'],
  ];
  for (const [errorIn, prefix] of cases) {
    const v = buildFixedSourceUploadVerdict(
      baseSuccessInput({
        tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: errorIn },
        dbPersist: null,
      })
    );
    if (v.kind === 'tarball-or-upload-failed') {
      assertContains(`4.9.${prefix} discriminator preserved`, v.tarballError, prefix);
    }
  }
}

// 4.10 REGRESSION: critical verdicts MUST emit on console.error (not warn)
//      so Cloud Run severity-based filtering catches them
{
  const tarFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({
      tarballAndUpload: { ok: false, gcsUri: null, bytes: 0, error: 'x' },
      dbPersist: null,
    })
  );
  const dbFail = buildFixedSourceUploadVerdict(
    baseSuccessInput({ dbPersist: { ok: false, error: 'x' } })
  );
  for (const v of [tarFail, dbFail]) {
    const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
    assertEq(`4.10 ${v.kind} uses console.error (not warn)`, logs[0]!.level, 'error');
  }
}

// 4.11 REGRESSION: not-applicable verdict has no [CRITICAL] tag in log
//      (clean log for routine mutation-free pipelines)
{
  const v = buildFixedSourceUploadVerdict({
    applicable: false,
    projectLabel: 'p',
    tarballAndUpload: null,
    dbPersist: null,
  });
  const logs = captureConsole(() => logFixedSourceUploadVerdict(v));
  assertTrue('4.11a not-applicable log is plain log not error', logs[0]!.level === 'log');
  assertTrue('4.11b not-applicable log has no [CRITICAL] tag', !logs[0]!.message.includes('[CRITICAL'));
}

// ─── Report ──────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('All fixed-source-upload-verdict tests passed ✓');
