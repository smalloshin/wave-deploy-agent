/**
 * Tests for services/iam-policy-verdict.ts (round 21).
 *
 * Run with: npx tsx src/test-iam-policy-verdict.ts
 *
 * Sections:
 *   1. Verdict kinds × outcome matrix (the truth table)
 *   2. logIamPolicyVerdict via console-capture
 *   3. errorCode contract + literal-true narrowing invariants
 *   4. Round-21 specific regressions (silent IAM swallow guards)
 */

import {
  buildIamPolicyVerdict,
  logIamPolicyVerdict,
  type IamPolicyVerdict,
  type IamPolicyOutcome,
  type BuildIamPolicyVerdictInput,
} from './services/iam-policy-verdict';

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

function input(overrides: Partial<BuildIamPolicyVerdictInput> = {}): BuildIamPolicyVerdictInput {
  return {
    allowUnauthenticated: true,
    serviceName: 'da-myapp',
    gcpProject: 'wave-deploy-agent',
    gcpRegion: 'asia-east1',
    serviceUrl: 'https://da-myapp-xyz-de.a.run.app',
    iamOutcome: { ok: true, httpStatus: 200, error: null },
    ...overrides,
  };
}

// ── Section 1: verdict kinds × outcome matrix ──
console.log('--- Section 1: verdict kinds × outcome matrix ---');

(() => {
  // 1a. allowUnauthenticated=false → not-applicable regardless of iamOutcome
  const v1 = buildIamPolicyVerdict(input({ allowUnauthenticated: false, iamOutcome: null }));
  check('not-applicable when allowUnauthenticated=false (no iamOutcome)', v1.kind === 'not-applicable');
  check('not-applicable has logLevel=info', v1.logLevel === 'info');
  check('not-applicable message names the service', v1.message.includes('da-myapp'));
  check('not-applicable message says private by design', v1.message.includes('private'));

  const v2 = buildIamPolicyVerdict(input({ allowUnauthenticated: false, iamOutcome: { ok: true, httpStatus: 200, error: null } }));
  check('not-applicable still wins when iamOutcome OK is supplied (false dominates)', v2.kind === 'not-applicable');

  const v3 = buildIamPolicyVerdict(input({ allowUnauthenticated: false, iamOutcome: { ok: false, httpStatus: 403, error: 'Forbidden' } }));
  check('not-applicable still wins when iamOutcome failure supplied (false dominates)', v3.kind === 'not-applicable');
})();

(() => {
  // 1b. allowUnauthenticated=true + iamOutcome.ok=true → success
  const v = buildIamPolicyVerdict(input({ allowUnauthenticated: true, iamOutcome: { ok: true, httpStatus: 200, error: null } }));
  check('success when public+ok', v.kind === 'success');
  check('success has logLevel=info', v.logLevel === 'info');
  if (v.kind === 'success') {
    check('success carries serviceName', v.serviceName === 'da-myapp');
    check('success message says publicly accessible', v.message.includes('publicly accessible') || v.message.includes('public'));
    check('success message names allUsers', v.message.includes('allUsers'));
  }
})();

(() => {
  // 1c. allowUnauthenticated=true + iamOutcome.ok=false → critical
  const v = buildIamPolicyVerdict(input({
    allowUnauthenticated: true,
    iamOutcome: { ok: false, httpStatus: 403, error: 'Permission denied on roles/run.admin' },
  }));
  check('critical when public+failed', v.kind === 'iam-policy-failed-public-deploy');
  check('critical has logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('critical carries serviceName', v.serviceName === 'da-myapp');
    check('critical carries gcpProject', v.gcpProject === 'wave-deploy-agent');
    check('critical carries gcpRegion', v.gcpRegion === 'asia-east1');
    check('critical carries serviceUrl', v.serviceUrl === 'https://da-myapp-xyz-de.a.run.app');
    check('critical carries httpStatus=403', v.httpStatus === 403);
    check('critical carries iamError verbatim', v.iamError === 'Permission denied on roles/run.admin');
    check('critical errorCode is iam_policy_drift', v.errorCode === 'iam_policy_drift');
    check('critical requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('recoveryCommand is a runnable gcloud command', v.recoveryCommand.startsWith('gcloud run services add-iam-policy-binding'));
    check('recoveryCommand names the service', v.recoveryCommand.includes('da-myapp'));
    check('recoveryCommand names the region', v.recoveryCommand.includes('asia-east1'));
    check('recoveryCommand names the project', v.recoveryCommand.includes('wave-deploy-agent'));
    check('recoveryCommand grants allUsers', v.recoveryCommand.includes('--member=allUsers'));
    check('recoveryCommand grants run.invoker', v.recoveryCommand.includes('--role=roles/run.invoker'));
    check('critical message contains 403', v.message.includes('403'));
    check('critical message contains the iam error verbatim', v.message.includes('Permission denied on roles/run.admin'));
    check('critical message says service is live', v.message.includes('LIVE'));
    check('critical message warns about Forbidden', v.message.includes('403 Forbidden') || v.message.includes('Forbidden'));
  }
})();

(() => {
  // 1d. allowUnauthenticated=true + iamOutcome=null → critical (engine bug)
  const v = buildIamPolicyVerdict(input({ allowUnauthenticated: true, iamOutcome: null }));
  check('critical when public+null iamOutcome', v.kind === 'iam-policy-failed-public-deploy');
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('null iamOutcome → httpStatus=null', v.httpStatus === null);
    check('null iamOutcome → fallback iamError message', v.iamError === 'IAM outcome not reported by deploy engine');
    check('null iamOutcome → recoveryCommand still constructed', v.recoveryCommand.includes('da-myapp'));
  }
})();

(() => {
  // 1e. allowUnauthenticated=true + iamOutcome.ok=false but httpStatus=null (fetch threw)
  const v = buildIamPolicyVerdict(input({
    allowUnauthenticated: true,
    iamOutcome: { ok: false, httpStatus: null, error: 'getaddrinfo ENOTFOUND run.googleapis.com' },
  }));
  check('critical when public+fetch-threw', v.kind === 'iam-policy-failed-public-deploy');
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('fetch-threw httpStatus=null', v.httpStatus === null);
    check('fetch-threw iamError carries network error', v.iamError.includes('ENOTFOUND'));
    check('fetch-threw critical message contains "n/a" for status', v.message.includes('n/a'));
  }
})();

(() => {
  // 1f. serviceUrl=null still produces a critical (deploy may have returned no URL)
  const v = buildIamPolicyVerdict(input({
    allowUnauthenticated: true,
    serviceUrl: null,
    iamOutcome: { ok: false, httpStatus: 500, error: 'Internal' },
  }));
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('serviceUrl=null preserved', v.serviceUrl === null);
    check('null serviceUrl message says (URL unknown)', v.message.includes('(URL unknown)'));
  }
})();

(() => {
  // 1g. https status 200 with ok=true is the canonical success
  const v = buildIamPolicyVerdict(input({ iamOutcome: { ok: true, httpStatus: 200, error: null } }));
  check('200 OK → success', v.kind === 'success');
  // 1h. https status 0 with ok=true (weird but possible) — still success because ok=true dominates
  const v2 = buildIamPolicyVerdict(input({ iamOutcome: { ok: true, httpStatus: 0, error: null } }));
  check('odd status with ok=true → success (ok dominates)', v2.kind === 'success');
})();

// ── Section 2: logIamPolicyVerdict via console-capture ──
console.log('--- Section 2: logIamPolicyVerdict via console-capture ---');

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
    logIamPolicyVerdict({ kind: 'not-applicable', logLevel: 'info', message: 'msg-na' });
  } finally { cap.restore(); }
  check('not-applicable → exactly 1 console.log', cap.logs.length === 1);
  check('not-applicable → 0 console.error', cap.errors.length === 0);
  check('not-applicable → 0 console.warn', cap.warns.length === 0);
  check('not-applicable log line carries [Deploy] prefix', cap.logs[0]?.startsWith('[Deploy] '));
  check('not-applicable log line carries the message', cap.logs[0]?.includes('msg-na'));
})();

(() => {
  const cap = captureConsole();
  try {
    logIamPolicyVerdict({
      kind: 'success', logLevel: 'info', serviceName: 'da-x', message: 'msg-success',
    });
  } finally { cap.restore(); }
  check('success → exactly 1 console.log', cap.logs.length === 1);
  check('success → 0 console.error', cap.errors.length === 0);
  check('success log line carries the message', cap.logs[0]?.includes('msg-success'));
})();

(() => {
  const cap = captureConsole();
  try {
    logIamPolicyVerdict({
      kind: 'iam-policy-failed-public-deploy',
      logLevel: 'critical',
      serviceName: 'da-x',
      gcpProject: 'p',
      gcpRegion: 'r',
      serviceUrl: 'https://x',
      httpStatus: 500,
      iamError: 'boom',
      errorCode: 'iam_policy_drift',
      requiresOperatorAction: true,
      recoveryCommand: 'gcloud x',
      message: 'msg-critical',
    });
  } finally { cap.restore(); }
  check('critical → 0 console.log', cap.logs.length === 0);
  check('critical → exactly 1 console.error', cap.errors.length === 1);
  check('critical → 0 console.warn', cap.warns.length === 0);
  check('critical line carries [Deploy] prefix', cap.errors[0]?.startsWith('[Deploy] '));
  check('critical line carries [CRITICAL errorCode=iam_policy_drift]', cap.errors[0]?.includes('[CRITICAL errorCode=iam_policy_drift]'));
  check('critical line carries the message', cap.errors[0]?.includes('msg-critical'));
})();

// ── Section 3: errorCode contract + literal-true narrowing ──
console.log('--- Section 3: errorCode contract + invariants ---');

(() => {
  const v = buildIamPolicyVerdict(input({
    allowUnauthenticated: true,
    iamOutcome: { ok: false, httpStatus: 403, error: 'denied' },
  }));
  // Type-narrow: TS proves errorCode and requiresOperatorAction exist as literal types
  if (v.kind === 'iam-policy-failed-public-deploy') {
    const ec: 'iam_policy_drift' = v.errorCode;
    check('errorCode literal narrows to iam_policy_drift', ec === 'iam_policy_drift');
    const flag: true = v.requiresOperatorAction;
    check('requiresOperatorAction literal narrows to true', flag === true);
  }
})();

(() => {
  // success / not-applicable MUST NOT carry errorCode or requiresOperatorAction
  const success = buildIamPolicyVerdict(input({ iamOutcome: { ok: true, httpStatus: 200, error: null } }));
  check('success has no errorCode field', !('errorCode' in success));
  check('success has no requiresOperatorAction field', !('requiresOperatorAction' in success));
  check('success has no recoveryCommand field', !('recoveryCommand' in success));

  const na = buildIamPolicyVerdict(input({ allowUnauthenticated: false, iamOutcome: null }));
  check('not-applicable has no errorCode field', !('errorCode' in na));
  check('not-applicable has no requiresOperatorAction field', !('requiresOperatorAction' in na));
  check('not-applicable has no recoveryCommand field', !('recoveryCommand' in na));
})();

(() => {
  // logLevel is exhaustive: info or critical only (no warn variant in this verdict)
  const samples: IamPolicyVerdict[] = [
    buildIamPolicyVerdict(input({ allowUnauthenticated: false, iamOutcome: null })),
    buildIamPolicyVerdict(input({ iamOutcome: { ok: true, httpStatus: 200, error: null } })),
    buildIamPolicyVerdict(input({ iamOutcome: { ok: false, httpStatus: 500, error: 'x' } })),
  ];
  for (const v of samples) {
    check(`logLevel ∈ {info, critical} for kind=${v.kind}`, v.logLevel === 'info' || v.logLevel === 'critical');
  }
  check('no verdict carries logLevel=warn (this verdict only has info/critical)', samples.every((v) => (v.logLevel as string) !== 'warn'));
})();

// ── Section 4: round-21 specific regressions ──
console.log('--- Section 4: round-21 specific regressions ---');

(() => {
  // R-1: the silent swallow lie — a public deploy with iamOutcome.ok=false
  // MUST be classified critical, never success. Catches the original bug.
  const cases: Array<{ httpStatus: number | null; error: string }> = [
    { httpStatus: 403, error: 'permission denied on iam.serviceAccounts.actAs' },
    { httpStatus: 500, error: 'Internal Server Error' },
    { httpStatus: 502, error: 'Bad Gateway' },
    { httpStatus: 503, error: 'transient' },
    { httpStatus: 429, error: 'rate limited' },
    { httpStatus: 401, error: 'unauthenticated' },
    { httpStatus: null, error: 'getaddrinfo ENOTFOUND' },
  ];
  for (const c of cases) {
    const v = buildIamPolicyVerdict(input({
      allowUnauthenticated: true,
      iamOutcome: { ok: false, httpStatus: c.httpStatus, error: c.error },
    }));
    check(`R-1 status=${c.httpStatus} → critical (regression guard)`, v.kind === 'iam-policy-failed-public-deploy');
    if (v.kind === 'iam-policy-failed-public-deploy') {
      check(`R-1 status=${c.httpStatus} → message contains the error verbatim`, v.message.includes(c.error));
    }
  }
})();

(() => {
  // R-2: critical message MUST warn that the service is live but private.
  // Without this, an operator reading the log might not realize the URL is
  // already serving 403s to users.
  const v = buildIamPolicyVerdict(input({
    allowUnauthenticated: true,
    iamOutcome: { ok: false, httpStatus: 403, error: 'denied' },
  }));
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('R-2 message warns "LIVE"', v.message.includes('LIVE'));
    check('R-2 message warns about 403 Forbidden', v.message.includes('403 Forbidden'));
    check('R-2 message says binding was not applied', v.message.includes('not applied'));
    check('R-2 message offers a recovery path', v.message.includes('Recover with'));
  }
})();

(() => {
  // R-3: recoveryCommand MUST be runnable as-is (no template placeholders left).
  const v = buildIamPolicyVerdict(input({
    serviceName: 'da-real-prod-app',
    gcpProject: 'real-gcp-project-123',
    gcpRegion: 'us-central1',
    iamOutcome: { ok: false, httpStatus: 500, error: 'x' },
  }));
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('R-3 recoveryCommand has no ${} placeholders', !v.recoveryCommand.includes('${'));
    check('R-3 recoveryCommand has no {{ }} placeholders', !v.recoveryCommand.includes('{{'));
    check('R-3 recoveryCommand interpolated serviceName', v.recoveryCommand.includes('da-real-prod-app'));
    check('R-3 recoveryCommand interpolated region', v.recoveryCommand.includes('us-central1'));
    check('R-3 recoveryCommand interpolated project', v.recoveryCommand.includes('real-gcp-project-123'));
    // Ensure nothing extra slipped in
    check('R-3 recoveryCommand single line (no newlines)', !v.recoveryCommand.includes('\n'));
  }
})();

(() => {
  // R-4: not-applicable + null iamOutcome MUST NOT crash and MUST NOT
  // misclassify as critical. The legacy code never looked at iamOutcome on
  // private deploys; the verdict must mirror that.
  const v = buildIamPolicyVerdict(input({ allowUnauthenticated: false, iamOutcome: null }));
  check('R-4 not-applicable when private (no iam call)', v.kind === 'not-applicable');
  check('R-4 not-applicable logLevel=info (never critical)', v.logLevel === 'info');
})();

(() => {
  // R-5: success path MUST NOT carry recoveryCommand or any operator-action
  // signal — that would noise the dashboard.
  const v = buildIamPolicyVerdict(input({ iamOutcome: { ok: true, httpStatus: 200, error: null } }));
  check('R-5 success no recoveryCommand', !('recoveryCommand' in v));
  check('R-5 success no errorCode', !('errorCode' in v));
  check('R-5 success no requiresOperatorAction', !('requiresOperatorAction' in v));
})();

(() => {
  // R-6: error message verbatim threading — operator must see the exact GCP
  // body. Catches accidental .toLowerCase() / .slice() / message rewriting.
  const weird = `{"error":{"code":403,"message":"Permission 'iam.serviceAccounts.actAs' denied on resource projects/-/serviceAccounts/run-deploy@..."}}`;
  const v = buildIamPolicyVerdict(input({
    allowUnauthenticated: true,
    iamOutcome: { ok: false, httpStatus: 403, error: weird },
  }));
  if (v.kind === 'iam-policy-failed-public-deploy') {
    check('R-6 iamError preserved verbatim', v.iamError === weird);
    check('R-6 message contains the verbatim error JSON', v.message.includes(weird));
  }
})();

(() => {
  // R-7: degenerate inputs don't crash
  const v1 = buildIamPolicyVerdict({
    allowUnauthenticated: true,
    serviceName: '',
    gcpProject: '',
    gcpRegion: '',
    serviceUrl: null,
    iamOutcome: null,
  });
  check('R-7 empty strings still produces critical', v1.kind === 'iam-policy-failed-public-deploy');
  if (v1.kind === 'iam-policy-failed-public-deploy') {
    check('R-7 empty strings recoveryCommand still has gcloud prefix', v1.recoveryCommand.startsWith('gcloud'));
  }
})();

(() => {
  // R-8: pure function — calling twice with same input gives same kind/level
  const inp = input({ iamOutcome: { ok: false, httpStatus: 500, error: 'x' } });
  const v1 = buildIamPolicyVerdict(inp);
  const v2 = buildIamPolicyVerdict(inp);
  check('R-8 idempotent: same kind', v1.kind === v2.kind);
  check('R-8 idempotent: same logLevel', v1.logLevel === v2.logLevel);
  check('R-8 idempotent: same message', v1.message === v2.message);
  if (v1.kind === 'iam-policy-failed-public-deploy' && v2.kind === 'iam-policy-failed-public-deploy') {
    check('R-8 idempotent: same recoveryCommand', v1.recoveryCommand === v2.recoveryCommand);
  }
})();

(() => {
  // R-9: log helper invariants for the critical path — the [CRITICAL] tag is
  // the dashboard contract. A grep on `[CRITICAL errorCode=iam_policy_drift]`
  // should return exactly one line per critical verdict.
  const cap = captureConsole();
  try {
    const v = buildIamPolicyVerdict(input({
      allowUnauthenticated: true,
      iamOutcome: { ok: false, httpStatus: 403, error: 'denied' },
    }));
    logIamPolicyVerdict(v);
  } finally { cap.restore(); }
  const grepHits = cap.errors.filter((l) => l.includes('[CRITICAL errorCode=iam_policy_drift]'));
  check('R-9 critical log has exactly 1 dashboard-grep line', grepHits.length === 1);
  check('R-9 grep line carries serviceName', grepHits[0]?.includes('da-myapp'));
  check('R-9 grep line carries the recovery command', grepHits[0]?.includes('gcloud run services add-iam-policy-binding'));
})();

(() => {
  // R-10: input dimension check — the lattice has exactly 4 distinct verdicts
  // by (allowUnauthenticated, iamOutcome) crossed:
  //   (false, *)         → not-applicable
  //   (true, ok=true)    → success
  //   (true, ok=false)   → critical
  //   (true, null)       → critical
  // Verify all 4 land where they should.
  const cases: Array<[BuildIamPolicyVerdictInput, IamPolicyVerdict['kind']]> = [
    [input({ allowUnauthenticated: false, iamOutcome: null }), 'not-applicable'],
    [input({ allowUnauthenticated: false, iamOutcome: { ok: true, httpStatus: 200, error: null } }), 'not-applicable'],
    [input({ allowUnauthenticated: false, iamOutcome: { ok: false, httpStatus: 500, error: 'x' } }), 'not-applicable'],
    [input({ allowUnauthenticated: true,  iamOutcome: { ok: true, httpStatus: 200, error: null } }), 'success'],
    [input({ allowUnauthenticated: true,  iamOutcome: { ok: false, httpStatus: 500, error: 'x' } }), 'iam-policy-failed-public-deploy'],
    [input({ allowUnauthenticated: true,  iamOutcome: null }), 'iam-policy-failed-public-deploy'],
  ];
  for (const [inp, expected] of cases) {
    const v = buildIamPolicyVerdict(inp);
    check(`R-10 lattice (${inp.allowUnauthenticated},${inp.iamOutcome === null ? 'null' : (inp.iamOutcome as IamPolicyOutcome).ok}) → ${expected}`, v.kind === expected);
  }
})();

console.log('');
console.log('─────────────────────────────────────');
console.log(`PASSED: ${pass}`);
console.log(`FAILED: ${fail}`);
if (fail > 0) {
  console.error('Some iam-policy-verdict tests failed ✗');
  process.exit(1);
} else {
  console.log('All iam-policy-verdict tests passed ✓');
}
