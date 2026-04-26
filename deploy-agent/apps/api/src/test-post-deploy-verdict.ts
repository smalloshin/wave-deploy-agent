/**
 * Tests for post-deploy-verdict (round 18).
 *
 * Run: tsx src/test-post-deploy-verdict.ts
 *
 * Sections:
 *   1. Verdict-kind classification (4 kinds × outcome matrix).
 *   2. logPostDeployVerdict side-effect contract (doesn't throw, uses
 *      the right console method, includes errorCode and prefix).
 *   3. Regression guards: errorCode contract, requiresOperatorAction
 *      narrowing, message-content invariants, deployLabel propagation.
 *   4. Round-18 specific bug regressions: image-cache-missing MUST be
 *      critical (this is the user-visible "redeploy required" trap),
 *      source-leak MUST NOT be critical, multiple failures MUST surface
 *      both errors.
 */

import {
  buildPostDeployVerdict,
  logPostDeployVerdict,
  type DeployedSourceCaptureOutcome,
  type ImageCacheWriteOutcome,
  type PostDeployVerdict,
} from './services/post-deploy-verdict';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: unknown, name: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const LABEL = 'kol-studio v3';
const sourceOk = (): DeployedSourceCaptureOutcome => ({ ok: true, error: null });
const sourceFail = (e = 'gcs upload 500'): DeployedSourceCaptureOutcome => ({ ok: false, error: e });
const cacheOk = (): ImageCacheWriteOutcome => ({ ok: true, error: null });
const cacheFail = (e = 'pg connection refused'): ImageCacheWriteOutcome => ({ ok: false, error: e });

// ─── Section 1: Verdict kinds ───
console.log('\n=== Section 1: Verdict kinds ===');

// 1a — both OK → success
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheOk(),
  });
  assertEq(v.kind, 'success', '1a.kind');
  assertEq(v.logLevel, 'info', '1a.logLevel = info');
  assert(v.message.includes(LABEL), '1a.message includes deployLabel');
}

// 1b — source fail, cache OK → success-with-source-leak
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceFail('tarball stream timeout'),
    imageCacheWrite: cacheOk(),
  });
  assertEq(v.kind, 'success-with-source-leak', '1b.kind');
  assertEq(v.logLevel, 'warn', '1b.logLevel = warn (slow leak only)');
  if (v.kind === 'success-with-source-leak') {
    assertEq(v.errorCode, 'deployed_source_orphan', '1b.errorCode');
    assertEq(v.requiresOperatorAction, false, '1b.requiresOperatorAction = false');
    assertEq(v.sourceCaptureError, 'tarball stream timeout', '1b.sourceCaptureError preserved');
  }
}

// 1c — source OK, cache fail → image-cache-missing (CRITICAL)
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail('pg deadlock'),
  });
  assertEq(v.kind, 'image-cache-missing', '1c.kind');
  assertEq(v.logLevel, 'critical', '1c.logLevel = critical');
  if (v.kind === 'image-cache-missing') {
    assertEq(v.errorCode, 'image_cache_drift', '1c.errorCode');
    assertEq(v.requiresOperatorAction, true, '1c.requiresOperatorAction = true');
    assertEq(v.imageCacheError, 'pg deadlock', '1c.imageCacheError preserved');
  }
}

// 1d — both fail → multiple-post-deploy-failures
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceFail('s err'),
    imageCacheWrite: cacheFail('c err'),
  });
  assertEq(v.kind, 'multiple-post-deploy-failures', '1d.kind');
  assertEq(v.logLevel, 'critical', '1d.logLevel = critical');
  if (v.kind === 'multiple-post-deploy-failures') {
    assertEq(v.errorCode, 'post_deploy_drift', '1d.errorCode');
    assertEq(v.requiresOperatorAction, true, '1d.requiresOperatorAction');
    assertEq(v.sourceCaptureError, 's err', '1d.sourceCaptureError');
    assertEq(v.imageCacheError, 'c err', '1d.imageCacheError');
  }
}

// 1e — null source error fallback
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: { ok: false, error: null },
    imageCacheWrite: cacheOk(),
  });
  if (v.kind === 'success-with-source-leak') {
    assertEq(v.sourceCaptureError, 'unknown source-capture error', '1e.null source error fallback');
  } else {
    assert(false, '1e.expected success-with-source-leak');
  }
}

// 1f — null cache error fallback
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: { ok: false, error: null },
  });
  if (v.kind === 'image-cache-missing') {
    assertEq(v.imageCacheError, 'unknown image-cache error', '1f.null cache error fallback');
  } else {
    assert(false, '1f.expected image-cache-missing');
  }
}

// 1g — both null errors → multiple-post-deploy-failures with fallbacks
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: { ok: false, error: null },
    imageCacheWrite: { ok: false, error: null },
  });
  if (v.kind === 'multiple-post-deploy-failures') {
    assertEq(v.sourceCaptureError, 'unknown source-capture error', '1g.source fallback');
    assertEq(v.imageCacheError, 'unknown image-cache error', '1g.cache fallback');
  } else {
    assert(false, '1g.expected multiple');
  }
}

// ─── Section 2: logPostDeployVerdict side-effect contract ───
console.log('\n=== Section 2: logPostDeployVerdict ===');

function captureLogs(fn: () => void): {
  log: string[];
  warn: string[];
  error: string[];
} {
  const log: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => log.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => warn.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => error.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return { log, warn, error };
}

// 2a — info → console.log only
{
  const v: PostDeployVerdict = {
    kind: 'success',
    logLevel: 'info',
    message: 'all good',
  };
  const captured = captureLogs(() => logPostDeployVerdict(v));
  assertEq(captured.log.length, 1, '2a.one log line');
  assertEq(captured.warn.length, 0, '2a.no warn');
  assertEq(captured.error.length, 0, '2a.no error');
  assert(captured.log[0]?.includes('all good'), '2a.message in log');
  assert(captured.log[0]?.includes('[Deploy]'), '2a.has [Deploy] prefix');
}

// 2b — warn → console.warn with errorCode
{
  const v: PostDeployVerdict = {
    kind: 'success-with-source-leak',
    logLevel: 'warn',
    sourceCaptureError: 'oops',
    errorCode: 'deployed_source_orphan',
    requiresOperatorAction: false,
    message: 'source leaked',
  };
  const captured = captureLogs(() => logPostDeployVerdict(v));
  assertEq(captured.warn.length, 1, '2b.one warn');
  assertEq(captured.error.length, 0, '2b.no error');
  assert(captured.warn[0]?.includes('deployed_source_orphan'), '2b.errorCode in warn');
  assert(captured.warn[0]?.includes('[WARN'), '2b.[WARN prefix');
}

// 2c — image-cache-missing → console.error with [CRITICAL] + errorCode
{
  const v: PostDeployVerdict = {
    kind: 'image-cache-missing',
    logLevel: 'critical',
    imageCacheError: 'pg down',
    errorCode: 'image_cache_drift',
    requiresOperatorAction: true,
    message: 'cache lost',
  };
  const captured = captureLogs(() => logPostDeployVerdict(v));
  assertEq(captured.error.length, 1, '2c.one error');
  assertEq(captured.warn.length, 0, '2c.no warn');
  assert(captured.error[0]?.includes('[CRITICAL'), '2c.[CRITICAL prefix');
  assert(captured.error[0]?.includes('image_cache_drift'), '2c.errorCode in error');
  assert(captured.error[0]?.includes('cache lost'), '2c.message in error');
}

// 2d — multiple → console.error with post_deploy_drift errorCode
{
  const v: PostDeployVerdict = {
    kind: 'multiple-post-deploy-failures',
    logLevel: 'critical',
    sourceCaptureError: 's',
    imageCacheError: 'c',
    errorCode: 'post_deploy_drift',
    requiresOperatorAction: true,
    message: 'both failed',
  };
  const captured = captureLogs(() => logPostDeployVerdict(v));
  assertEq(captured.error.length, 1, '2d.one error');
  assert(captured.error[0]?.includes('post_deploy_drift'), '2d.errorCode in error');
}

// 2e — logPostDeployVerdict never throws on any verdict shape
{
  const verdicts: PostDeployVerdict[] = [
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheFail() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheFail() }),
  ];
  let threw = false;
  for (const v of verdicts) {
    try {
      captureLogs(() => logPostDeployVerdict(v));
    } catch (e) {
      threw = true;
      console.log(`    ! threw on ${v.kind}: ${(e as Error).message}`);
    }
  }
  assert(!threw, '2e.logPostDeployVerdict never throws');
}

// ─── Section 3: Regression guards ───
console.log('\n=== Section 3: Regression guards ===');

// 3a — errorCode strings match the dashboard contract exactly
{
  const cases: Array<[PostDeployVerdict, string]> = [
    [
      buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheOk() }),
      'deployed_source_orphan',
    ],
    [
      buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheFail() }),
      'image_cache_drift',
    ],
    [
      buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheFail() }),
      'post_deploy_drift',
    ],
  ];
  for (const [v, expected] of cases) {
    if ('errorCode' in v) {
      assertEq(v.errorCode, expected, `3a.${v.kind} errorCode=${expected}`);
    } else {
      assert(false, `3a.${(v as PostDeployVerdict).kind} should have errorCode`);
    }
  }
}

// 3b — success kind has NO errorCode field (clean discriminator)
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheOk(),
  });
  if (v.kind === 'success') {
    assert(!('errorCode' in v), '3b.success has no errorCode');
    assert(!('requiresOperatorAction' in v), '3b.success has no requiresOperatorAction');
  } else {
    assert(false, '3b.expected success');
  }
}

// 3c — requiresOperatorAction is literal `true` for narrowing
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  if (v.kind === 'image-cache-missing' && v.requiresOperatorAction) {
    // This block compiling = TypeScript narrowed correctly.
    assertEq(v.errorCode, 'image_cache_drift', '3c.literal-true narrowing');
  } else {
    assert(false, '3c.discriminator narrowing');
  }
}

// 3d — message includes deployLabel for log grep
{
  const v = buildPostDeployVerdict({
    deployLabel: 'my-app v42',
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  assert(v.message.includes('my-app v42'), '3d.deployLabel in message');
}

// 3e — image-cache-missing message tells operator the user-facing impact
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  assert(v.message.toLowerCase().includes('redeploy') || v.message.toLowerCase().includes('rebuild'),
    '3e.message warns about redeploy on next start');
}

// 3f — image-cache-missing message tells operator how to fix
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  assert(v.message.toLowerCase().includes('lastdeployedimage') || v.message.toLowerCase().includes('re-run'),
    '3f.message includes fix hint');
}

// 3g — every verdict kind has logLevel ∈ {info, warn, critical}
{
  const variants = [
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheFail() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheFail() }),
  ];
  for (const v of variants) {
    assert(['info', 'warn', 'critical'].includes(v.logLevel), `3g.${v.kind} logLevel valid`);
  }
}

// 3h — every kind has non-empty message
{
  const variants = [
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheFail() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheFail() }),
  ];
  for (const v of variants) {
    assert(typeof v.message === 'string' && v.message.length > 0, `3h.${v.kind} non-empty message`);
  }
}

// ─── Section 4: Round-18 bug regressions ───
console.log('\n=== Section 4: Round-18 bug regressions ===');

// 4a — THE BUG: cache fail MUST surface as critical (the legacy
//      console.warn was invisible — operators never noticed and got
//      bitten on next /start). NEVER let this regress to warn.
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  assertEq(v.logLevel, 'critical', '4a.cache fail MUST be critical');
  if (v.kind === 'image-cache-missing') {
    assertEq(v.errorCode, 'image_cache_drift', '4a.errorCode');
  }
}

// 4b — source-capture-only fail MUST NOT be critical. It's a slow
//      lifecycle-managed leak; surfacing it as critical would dilute
//      the signal for the actual user-facing failure (cache).
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceFail(),
    imageCacheWrite: cacheOk(),
  });
  assert(v.logLevel !== 'critical', '4b.source-only fail MUST NOT be critical');
  assertEq(v.logLevel, 'warn', '4b.warn is the right level');
}

// 4c — multiple failures: BOTH error strings MUST be in the verdict so
//      the operator can debug both without log-archeology.
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceFail('s-detail'),
    imageCacheWrite: cacheFail('c-detail'),
  });
  if (v.kind === 'multiple-post-deploy-failures') {
    assert(v.message.includes('s-detail'), '4c.source error in message');
    assert(v.message.includes('c-detail'), '4c.cache error in message');
  } else {
    assert(false, '4c.kind');
  }
}

// 4d — success kind never carries error fields (would be confusing
//      noise in dashboard rendering).
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheOk(),
  });
  if (v.kind === 'success') {
    assert(!('imageCacheError' in v), '4d.success no imageCacheError');
    assert(!('sourceCaptureError' in v), '4d.success no sourceCaptureError');
  }
}

// 4e — image-cache-missing kind does NOT carry sourceCaptureError
//      (because source was OK in this branch). Avoids confusion.
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  if (v.kind === 'image-cache-missing') {
    assert(!('sourceCaptureError' in v), '4e.image-cache-missing no sourceCaptureError');
  }
}

// 4f — success-with-source-leak does NOT carry imageCacheError
{
  const v = buildPostDeployVerdict({
    deployLabel: LABEL,
    deployedSourceCapture: sourceFail(),
    imageCacheWrite: cacheOk(),
  });
  if (v.kind === 'success-with-source-leak') {
    assert(!('imageCacheError' in v), '4f.source-leak no imageCacheError');
  }
}

// 4g — exhaustive switch on kind: every kind covered (TypeScript would
//      catch this at compile time, but pin it at runtime too).
{
  const verdicts: PostDeployVerdict[] = [
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheOk() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceOk(), imageCacheWrite: cacheFail() }),
    buildPostDeployVerdict({ deployLabel: LABEL, deployedSourceCapture: sourceFail(), imageCacheWrite: cacheFail() }),
  ];
  const kinds = new Set(verdicts.map(v => v.kind));
  assertEq(kinds.size, 4, '4g.all 4 kinds reachable');
  assert(kinds.has('success'), '4g.has success');
  assert(kinds.has('success-with-source-leak'), '4g.has success-with-source-leak');
  assert(kinds.has('image-cache-missing'), '4g.has image-cache-missing');
  assert(kinds.has('multiple-post-deploy-failures'), '4g.has multiple');
}

// 4h — different deployLabel produces different messages (no hardcoding)
{
  const v1 = buildPostDeployVerdict({
    deployLabel: 'app-one v1',
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  const v2 = buildPostDeployVerdict({
    deployLabel: 'app-two v9',
    deployedSourceCapture: sourceOk(),
    imageCacheWrite: cacheFail(),
  });
  assert(v1.message.includes('app-one v1'), '4h.v1 has correct label');
  assert(v2.message.includes('app-two v9'), '4h.v2 has correct label');
  assert(v1.message !== v2.message, '4h.deployLabel flows into message');
}

// ─── Summary ───
console.log('\n──────────────────────────');
console.log(`Pass: ${pass}`);
console.log(`Fail: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\nAll tests passed.');
