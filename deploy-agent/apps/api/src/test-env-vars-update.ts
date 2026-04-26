/**
 * Round 14 unit tests — env-vars PATCH split-write verdict planner.
 *
 * Two pure functions under test:
 *   1. planEnvVarsUpdate(existing, patch) → EnvVarsUpdatePlan
 *   2. interpretEnvVarsUpdateResult({plan, cloudRun, db}) → EnvVarsUpdateVerdict
 *
 * Why these tests matter (anchor to the user-facing bug):
 *   The route previously did `await updateServiceEnvVars(...)` then
 *   `await updateProjectConfig(...)` with NO error handling on the DB write.
 *   On DB failure the operator sees a generic 500 and refreshes the dashboard.
 *   The dashboard renders `project.config.envVars` (now stale — pre-PATCH
 *   values, because the DB write failed). The operator's natural reaction
 *   (re-edit using the visible values) silently reverts what they intended
 *   to set on Cloud Run. Pure DB-lies-vs-reality drift, the same family
 *   as rounds 9, 10, 13.
 *
 *   These tests pin down the contract: the verdict for that exact case
 *   carries `errorCode: 'env_vars_db_drift'` + `requiresManualReconcile: true`
 *   + the live Cloud Run values, so the dashboard can detect it and switch
 *   to live-read mode.
 *
 * Run: `npx tsx apps/api/src/test-env-vars-update.ts`
 */

import {
  planEnvVarsUpdate,
  interpretEnvVarsUpdateResult,
  type EnvVarsUpdatePlan,
  type EnvVarsUpdateVerdict,
} from './services/env-vars-update';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`);
    console.log(`  FAIL ${label}`);
  }
}

function assert(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Section 1: planEnvVarsUpdate — diff classification
// ─────────────────────────────────────────────────────────────────────
console.log('\n[1] planEnvVarsUpdate — diff classification');

eq(
  'empty patch on empty existing → all empty',
  planEnvVarsUpdate({}, {}),
  { merged: {}, changed: [], cleared: [], unchanged: [] } as EnvVarsUpdatePlan,
);

eq(
  'empty patch on non-empty existing → preserves existing, no diff',
  planEnvVarsUpdate({ A: '1', B: '2' }, {}),
  { merged: { A: '1', B: '2' }, changed: [], cleared: [], unchanged: [] } as EnvVarsUpdatePlan,
);

eq(
  'add new key → changed',
  planEnvVarsUpdate({}, { NEW: 'x' }),
  { merged: { NEW: 'x' }, changed: ['NEW'], cleared: [], unchanged: [] } as EnvVarsUpdatePlan,
);

eq(
  'override existing key with different value → changed',
  planEnvVarsUpdate({ A: '1' }, { A: '2' }),
  { merged: { A: '2' }, changed: ['A'], cleared: [], unchanged: [] } as EnvVarsUpdatePlan,
);

eq(
  'override existing key with same value → unchanged',
  planEnvVarsUpdate({ A: '1' }, { A: '1' }),
  { merged: { A: '1' }, changed: [], cleared: [], unchanged: ['A'] } as EnvVarsUpdatePlan,
);

eq(
  'clear existing key (set to empty string) → cleared',
  planEnvVarsUpdate({ A: '1' }, { A: '' }),
  { merged: { A: '' }, changed: [], cleared: ['A'], unchanged: [] } as EnvVarsUpdatePlan,
);

eq(
  'add new key with empty value → cleared (probable typo, surface for log)',
  planEnvVarsUpdate({}, { NEW: '' }),
  { merged: { NEW: '' }, changed: [], cleared: ['NEW'], unchanged: [] } as EnvVarsUpdatePlan,
);

eq(
  'clear key already empty → unchanged (no-op clear)',
  planEnvVarsUpdate({ A: '' }, { A: '' }),
  { merged: { A: '' }, changed: [], cleared: [], unchanged: ['A'] } as EnvVarsUpdatePlan,
);

eq(
  'mixed patch: add, override, unchanged, clear → all four buckets populated',
  planEnvVarsUpdate(
    { KEEP: 'k', OVERRIDE: 'old', SAME: 's', WIPE: 'w' },
    { OVERRIDE: 'new', SAME: 's', WIPE: '', NEWKEY: 'n' },
  ),
  {
    merged: { KEEP: 'k', OVERRIDE: 'new', SAME: 's', WIPE: '', NEWKEY: 'n' },
    changed: ['OVERRIDE', 'NEWKEY'],
    cleared: ['WIPE'],
    unchanged: ['SAME'],
  } as EnvVarsUpdatePlan,
);

eq(
  'patch DOES NOT delete existing keys not mentioned (no key removal supported)',
  planEnvVarsUpdate({ KEEP: 'k', ALSO: 'a' }, { OTHER: 'o' }),
  {
    merged: { KEEP: 'k', ALSO: 'a', OTHER: 'o' },
    changed: ['OTHER'],
    cleared: [],
    unchanged: [],
  } as EnvVarsUpdatePlan,
);

// Regression guard: planEnvVarsUpdate is pure (no mutation of inputs).
{
  const existing = { A: '1' };
  const patch = { A: '2', B: '3' };
  const existingSnap = JSON.stringify(existing);
  const patchSnap = JSON.stringify(patch);
  planEnvVarsUpdate(existing, patch);
  assert('planEnvVarsUpdate does not mutate `existing`', JSON.stringify(existing) === existingSnap);
  assert('planEnvVarsUpdate does not mutate `patch`', JSON.stringify(patch) === patchSnap);
}

// ─────────────────────────────────────────────────────────────────────
// Section 2: interpretEnvVarsUpdateResult — verdict classification
// ─────────────────────────────────────────────────────────────────────
console.log('\n[2] interpretEnvVarsUpdateResult — verdict classification');

const samplePlan: EnvVarsUpdatePlan = {
  merged: { A: '1', B: '2' },
  changed: ['A'],
  cleared: [],
  unchanged: ['B'],
};

const noopPlan: EnvVarsUpdatePlan = {
  merged: { A: '1' },
  changed: [],
  cleared: [],
  unchanged: ['A'],
};

// 1. success
{
  const v = interpretEnvVarsUpdateResult({
    plan: samplePlan,
    cloudRun: { success: true, error: null },
    db: { ok: true, error: null },
  });
  eq('both succeed → kind=success', v.kind, 'success');
  if (v.kind === 'success') {
    eq('  changed surfaces', v.changed, ['A']);
    eq('  logLevel=info', v.logLevel, 'info');
  }
}

// 2. success-noop (plan empty, no calls expected)
{
  const v = interpretEnvVarsUpdateResult({
    plan: noopPlan,
    cloudRun: null,
    db: null,
  });
  eq('plan has no work → kind=success-noop', v.kind, 'success-noop');
}

// noop wins even if (theoretically) someone passes outcomes. Belt-and-suspenders.
{
  const v = interpretEnvVarsUpdateResult({
    plan: noopPlan,
    cloudRun: { success: true, error: null },
    db: { ok: true, error: null },
  });
  eq('noop plan wins over outcomes → kind=success-noop', v.kind, 'success-noop');
}

// 3. cloud-run-failed (DB never attempted)
{
  const v = interpretEnvVarsUpdateResult({
    plan: samplePlan,
    cloudRun: { success: false, error: 'PERMISSION_DENIED' },
    db: null,
  });
  eq('cloud run fail, db not attempted → kind=cloud-run-failed', v.kind, 'cloud-run-failed');
  if (v.kind === 'cloud-run-failed') {
    eq('  carries cloudRunError', v.cloudRunError, 'PERMISSION_DENIED');
    eq('  logLevel=warn', v.logLevel, 'warn');
  }
}

// Defensive: cloudRun=null when plan had work → treated as cloud-run-failed
{
  const v = interpretEnvVarsUpdateResult({
    plan: samplePlan,
    cloudRun: null,
    db: null,
  });
  eq(
    'cloudRun=null with non-empty plan → kind=cloud-run-failed (defensive)',
    v.kind,
    'cloud-run-failed',
  );
}

// 4. db-failed-after-cloud-run — THE ROUND-14 FIX TARGET
{
  const v = interpretEnvVarsUpdateResult({
    plan: samplePlan,
    cloudRun: { success: true, error: null },
    db: { ok: false, error: 'JSONB serialization failed' },
  });
  eq('cloud run OK + db fail → kind=db-failed-after-cloud-run', v.kind, 'db-failed-after-cloud-run');
  if (v.kind === 'db-failed-after-cloud-run') {
    eq('  errorCode is the dashboard contract', v.errorCode, 'env_vars_db_drift');
    assert('  requiresManualReconcile is literal true', v.requiresManualReconcile === true);
    eq('  cloudRunValues = plan.merged (operator source of truth)', v.cloudRunValues, samplePlan.merged);
    eq('  carries dbError', v.dbError, 'JSONB serialization failed');
    eq('  logLevel=critical', v.logLevel, 'critical');
    eq('  changed surfaces', v.changed, ['A']);
  }
}

// 4b. db=null after cloud-run success → still classified as db-failed-after-cloud-run
{
  const v = interpretEnvVarsUpdateResult({
    plan: samplePlan,
    cloudRun: { success: true, error: null },
    db: null,
  });
  eq(
    'cloud run OK + db not attempted → kind=db-failed-after-cloud-run',
    v.kind,
    'db-failed-after-cloud-run',
  );
  if (v.kind === 'db-failed-after-cloud-run') {
    eq('  synthetic dbError', v.dbError, 'db update not attempted');
  }
}

// 5. db-failed-with-cloud-run-failed-too
{
  const v = interpretEnvVarsUpdateResult({
    plan: samplePlan,
    cloudRun: { success: false, error: 'CR boom' },
    db: { ok: false, error: 'DB boom' },
  });
  eq(
    'both fail → kind=db-failed-with-cloud-run-failed-too',
    v.kind,
    'db-failed-with-cloud-run-failed-too',
  );
  if (v.kind === 'db-failed-with-cloud-run-failed-too') {
    eq('  carries cloudRunError', v.cloudRunError, 'CR boom');
    eq('  carries dbError', v.dbError, 'DB boom');
    eq('  logLevel=warn (both failed = no divergence to recover from)', v.logLevel, 'warn');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Section 3: Regression guards on the dashboard contract
// ─────────────────────────────────────────────────────────────────────
console.log('\n[3] Regression guards — dashboard contract invariants');

// Only db-failed-after-cloud-run should require manual reconcile. If anything
// else gets that flag, the dashboard would erroneously switch to live-read mode
// for situations where the DB is actually correct.
{
  const cases: Array<{ label: string; verdict: EnvVarsUpdateVerdict }> = [
    {
      label: 'success',
      verdict: interpretEnvVarsUpdateResult({
        plan: samplePlan,
        cloudRun: { success: true, error: null },
        db: { ok: true, error: null },
      }),
    },
    {
      label: 'success-noop',
      verdict: interpretEnvVarsUpdateResult({ plan: noopPlan, cloudRun: null, db: null }),
    },
    {
      label: 'cloud-run-failed',
      verdict: interpretEnvVarsUpdateResult({
        plan: samplePlan,
        cloudRun: { success: false, error: 'x' },
        db: null,
      }),
    },
    {
      label: 'db-failed-with-cloud-run-failed-too',
      verdict: interpretEnvVarsUpdateResult({
        plan: samplePlan,
        cloudRun: { success: false, error: 'x' },
        db: { ok: false, error: 'y' },
      }),
    },
  ];
  for (const c of cases) {
    const hasReconcile = 'requiresManualReconcile' in c.verdict;
    assert(
      `${c.label} verdict does NOT carry requiresManualReconcile`,
      !hasReconcile,
    );
  }
}

// Only db-failed-after-cloud-run should carry the env_vars_db_drift error code.
{
  const cases: EnvVarsUpdateVerdict[] = [
    interpretEnvVarsUpdateResult({
      plan: samplePlan,
      cloudRun: { success: true, error: null },
      db: { ok: true, error: null },
    }),
    interpretEnvVarsUpdateResult({ plan: noopPlan, cloudRun: null, db: null }),
    interpretEnvVarsUpdateResult({
      plan: samplePlan,
      cloudRun: { success: false, error: 'x' },
      db: null,
    }),
    interpretEnvVarsUpdateResult({
      plan: samplePlan,
      cloudRun: { success: false, error: 'x' },
      db: { ok: false, error: 'y' },
    }),
  ];
  for (const v of cases) {
    assert(
      `${v.kind} does NOT carry errorCode`,
      !('errorCode' in v),
    );
  }
}

// Only critical verdict gets logLevel=critical. Pin this tightly so we don't
// accidentally start spamming critical logs on routine cloud-run rejections.
{
  assert(
    'success → logLevel=info',
    interpretEnvVarsUpdateResult({
      plan: samplePlan,
      cloudRun: { success: true, error: null },
      db: { ok: true, error: null },
    }).logLevel === 'info',
  );
  assert(
    'cloud-run-failed → logLevel=warn',
    interpretEnvVarsUpdateResult({
      plan: samplePlan,
      cloudRun: { success: false, error: 'x' },
      db: null,
    }).logLevel === 'warn',
  );
  assert(
    'db-failed-after-cloud-run → logLevel=critical',
    interpretEnvVarsUpdateResult({
      plan: samplePlan,
      cloudRun: { success: true, error: null },
      db: { ok: false, error: 'y' },
    }).logLevel === 'critical',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} tests passed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
