/**
 * Round 16 unit tests — startProjectService verdict planner.
 *
 * Mirror of round 13's test-stop-verdict.ts. The pattern: pure function
 * receives the (deploy, deploymentRow, projectConfig, transition)
 * outcome lattice and returns a discriminated verdict. The route is a
 * thin orchestrator that asks the planner what to do.
 *
 * Pinned contracts:
 *   - any deploy failure short-circuits with no DB writes attempted
 *   - deploy OK + deployment row fail → CRITICAL with errorCode
 *     'start_deployment_row_drift' and requiresManualReconcile=true
 *   - deploy OK + deployment row OK + config fail → warn (soft, cache only)
 *   - deploy OK + DB OK + transition fail → warn (reconciler will fix)
 *   - all OK → success
 *   - logLevel pinned exactly (info | warn | critical)
 *
 * Run: `npx tsx apps/api/src/test-start-verdict.ts`
 */

import {
  buildStartVerdict,
  verdictToLifecycleResult,
  type DeployOutcome,
  type DbWriteOutcome,
  type TransitionOutcome,
  type StartVerdict,
} from './services/start-verdict';

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

const deployOk: DeployOutcome = {
  ok: true,
  serviceName: 'kol-studio',
  serviceUrl: 'https://kol-studio-abc123-uc.a.run.app',
  error: null,
};
const deployFail: DeployOutcome = {
  ok: false,
  serviceName: null,
  serviceUrl: null,
  error: 'Cloud Build timed out',
};

const dbOk: DbWriteOutcome = { ok: true, error: null };
const dbFail: DbWriteOutcome = { ok: false, error: 'connection terminated unexpectedly' };

const transitionOk: TransitionOutcome = { ok: true, errorName: null, error: null };
const transitionInvalid: TransitionOutcome = {
  ok: false,
  errorName: 'InvalidTransitionError',
  error: 'Invalid state transition: failed → live',
};
const transitionRealError: TransitionOutcome = {
  ok: false,
  errorName: 'Error',
  error: 'pool exhausted',
};

// ─────────────────────────────────────────────────────────────────────
// Section 1: Five verdict kinds
// ─────────────────────────────────────────────────────────────────────
console.log('\n[1] buildStartVerdict — five verdict kinds');

// 1. success — every step OK
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbOk,
    projectConfig: dbOk,
    transition: transitionOk,
    deploymentRowSkipped: false,
  });
  eq('all OK → kind=success', v.kind, 'success');
  if (v.kind === 'success') {
    eq('  serviceName surfaced', v.serviceName, 'kol-studio');
    eq('  serviceUrl surfaced', v.serviceUrl, 'https://kol-studio-abc123-uc.a.run.app');
    eq('  logLevel=info', v.logLevel, 'info');
    eq('  message includes service name', v.message, 'Restarted kol-studio');
  }
}

// 1b. success — deployment row legitimately skipped (no `latest` deployment)
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: null,
    projectConfig: dbOk,
    transition: transitionOk,
    deploymentRowSkipped: true,
  });
  eq('skipped deploymentRow + rest OK → success', v.kind, 'success');
}

// 2. deploy-failed — heavy IO failed, no DB writes attempted
{
  const v = buildStartVerdict({
    deploy: deployFail,
    deploymentRow: null,
    projectConfig: null,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq('deploy fails → kind=deploy-failed', v.kind, 'deploy-failed');
  if (v.kind === 'deploy-failed') {
    eq('  carries deployError', v.deployError, 'Cloud Build timed out');
    eq('  logLevel=warn', v.logLevel, 'warn');
    assert('  message starts with "Restart failed"', v.message.startsWith('Restart failed'));
  }
}

// 2b. deploy-failed — defensive: deploy.error null gets a fallback
{
  const v = buildStartVerdict({
    deploy: { ok: false, serviceName: null, serviceUrl: null, error: null },
    deploymentRow: null,
    projectConfig: null,
    transition: null,
    deploymentRowSkipped: false,
  });
  if (v.kind === 'deploy-failed') {
    eq('null deployError → "unknown deploy error" fallback', v.deployError, 'unknown deploy error');
  }
}

// 3. partial-deployment-row-mismatch — THE ROUND-16 CRITICAL TARGET
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbFail,
    projectConfig: null,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq('deploy OK + row fail → kind=partial-deployment-row-mismatch', v.kind, 'partial-deployment-row-mismatch');
  if (v.kind === 'partial-deployment-row-mismatch') {
    eq('  errorCode is the dashboard contract', v.errorCode, 'start_deployment_row_drift');
    assert('  requiresManualReconcile literal true', v.requiresManualReconcile === true);
    eq('  serviceName surfaced for operator out-of-band check', v.serviceName, 'kol-studio');
    eq('  serviceUrl surfaced', v.serviceUrl, 'https://kol-studio-abc123-uc.a.run.app');
    eq('  carries dbError', v.dbError, 'connection terminated unexpectedly');
    eq('  logLevel=critical', v.logLevel, 'critical');
    assert('  message mentions service is live', v.message.includes('is live at'));
  }
}

// 3b. partial-deployment-row-mismatch — deploymentRow=null AND not skipped → still critical
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: null,
    projectConfig: null,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq(
    'deploymentRow=null + not skipped → kind=partial-deployment-row-mismatch (defensive)',
    v.kind,
    'partial-deployment-row-mismatch',
  );
  if (v.kind === 'partial-deployment-row-mismatch') {
    eq('  synthetic dbError', v.dbError, 'deployment row write not attempted');
  }
}

// 4. partial-config-not-persisted — soft warn, service is up
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbOk,
    projectConfig: dbFail,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq('deploy OK + row OK + config fail → partial-config-not-persisted', v.kind, 'partial-config-not-persisted');
  if (v.kind === 'partial-config-not-persisted') {
    eq('  carries configError', v.configError, 'connection terminated unexpectedly');
    eq('  logLevel=warn', v.logLevel, 'warn');
    eq('  serviceName surfaced', v.serviceName, 'kol-studio');
  }
}

// 4b. partial-config-not-persisted — projectConfig=null (not attempted)
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbOk,
    projectConfig: null,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq('projectConfig=null → still partial-config-not-persisted', v.kind, 'partial-config-not-persisted');
}

// 5. partial-transition-failed — soft warn (reconciler will fix)
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbOk,
    projectConfig: dbOk,
    transition: transitionRealError,
    deploymentRowSkipped: false,
  });
  eq('deploy OK + DB OK + transition fail → partial-transition-failed', v.kind, 'partial-transition-failed');
  if (v.kind === 'partial-transition-failed') {
    eq('  carries transitionError', v.transitionError, 'pool exhausted');
    eq('  carries transitionErrorName', v.transitionErrorName, 'Error');
    eq('  logLevel=warn', v.logLevel, 'warn');
  }
}

// 5b. partial-transition-failed — InvalidTransitionError flavor (still warn, not critical)
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbOk,
    projectConfig: dbOk,
    transition: transitionInvalid,
    deploymentRowSkipped: false,
  });
  eq('InvalidTransitionError → still partial-transition-failed', v.kind, 'partial-transition-failed');
  if (v.kind === 'partial-transition-failed') {
    eq('  errorName preserved for downstream classification', v.transitionErrorName, 'InvalidTransitionError');
    eq('  logLevel=warn (not critical — service is up)', v.logLevel, 'warn');
  }
}

// 5c. partial-transition-failed — transition=null
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbOk,
    projectConfig: dbOk,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq('transition=null → still partial-transition-failed', v.kind, 'partial-transition-failed');
}

// ─────────────────────────────────────────────────────────────────────
// Section 2: verdictToLifecycleResult — success/false mapping contract
// ─────────────────────────────────────────────────────────────────────
console.log('\n[2] verdictToLifecycleResult — success/false mapping');

{
  // success → success=true
  const r = verdictToLifecycleResult(
    buildStartVerdict({
      deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionOk, deploymentRowSkipped: false,
    }),
  );
  eq('success → success=true', r.success, true);
  eq('success → serviceUrl surfaced', r.serviceUrl, 'https://kol-studio-abc123-uc.a.run.app');
}

{
  // deploy-failed → success=false
  const r = verdictToLifecycleResult(
    buildStartVerdict({
      deploy: deployFail, deploymentRow: null, projectConfig: null, transition: null, deploymentRowSkipped: false,
    }),
  );
  eq('deploy-failed → success=false', r.success, false);
  eq('deploy-failed → no serviceName field', r.serviceName, undefined);
}

{
  // partial-deployment-row-mismatch → success=false (CRITICAL)
  const r = verdictToLifecycleResult(
    buildStartVerdict({
      deploy: deployOk, deploymentRow: dbFail, projectConfig: null, transition: null, deploymentRowSkipped: false,
    }),
  );
  eq('partial-deployment-row-mismatch → success=false (operator must know)', r.success, false);
  eq('  serviceName surfaced (so operator can verify out-of-band)', r.serviceName, 'kol-studio');
}

{
  // partial-config-not-persisted → success=true (cache miss is soft)
  const r = verdictToLifecycleResult(
    buildStartVerdict({
      deploy: deployOk, deploymentRow: dbOk, projectConfig: dbFail, transition: null, deploymentRowSkipped: false,
    }),
  );
  eq('partial-config-not-persisted → success=true (service is up)', r.success, true);
}

{
  // partial-transition-failed → success=true (reconciler will fix)
  const r = verdictToLifecycleResult(
    buildStartVerdict({
      deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionRealError, deploymentRowSkipped: false,
    }),
  );
  eq('partial-transition-failed → success=true (reconciler fixes)', r.success, true);
}

// ─────────────────────────────────────────────────────────────────────
// Section 3: Regression guards — dashboard contract invariants
// ─────────────────────────────────────────────────────────────────────
console.log('\n[3] Regression guards — dashboard / route contract');

// Only partial-deployment-row-mismatch should carry requiresManualReconcile.
{
  const verdicts: StartVerdict[] = [
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionOk, deploymentRowSkipped: false }),
    buildStartVerdict({ deploy: deployFail, deploymentRow: null, projectConfig: null, transition: null, deploymentRowSkipped: false }),
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbFail, transition: null, deploymentRowSkipped: false }),
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionRealError, deploymentRowSkipped: false }),
  ];
  for (const v of verdicts) {
    assert(`${v.kind} does NOT carry requiresManualReconcile`, !('requiresManualReconcile' in v));
    assert(`${v.kind} does NOT carry errorCode`, !('errorCode' in v));
  }
}

// Only the critical verdict logs at critical. The others are warn or info.
// This matters because alerting hooks fire on critical and we don't want
// noise from soft partials.
{
  assert('success → logLevel=info',
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionOk, deploymentRowSkipped: false }).logLevel === 'info');
  assert('deploy-failed → logLevel=warn',
    buildStartVerdict({ deploy: deployFail, deploymentRow: null, projectConfig: null, transition: null, deploymentRowSkipped: false }).logLevel === 'warn');
  assert('partial-deployment-row-mismatch → logLevel=critical',
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbFail, projectConfig: null, transition: null, deploymentRowSkipped: false }).logLevel === 'critical');
  assert('partial-config-not-persisted → logLevel=warn',
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbFail, transition: null, deploymentRowSkipped: false }).logLevel === 'warn');
  assert('partial-transition-failed → logLevel=warn',
    buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionRealError, deploymentRowSkipped: false }).logLevel === 'warn');
}

// Phase ordering: if both deploymentRow AND projectConfig fail, the verdict
// should be the EARLIER failure (deployment row is the more critical bug).
// Otherwise an operator might fix the cache and think the dashboard issue
// is gone when it isn't.
{
  const v = buildStartVerdict({
    deploy: deployOk,
    deploymentRow: dbFail,
    projectConfig: dbFail,
    transition: null,
    deploymentRowSkipped: false,
  });
  eq(
    'when row+config both fail, verdict surfaces the row failure (earlier phase)',
    v.kind,
    'partial-deployment-row-mismatch',
  );
}

// Property: any non-success verdict that names a serviceName must have
// it match the deploy.serviceName. Catches refactors that might
// accidentally drop the service identifier.
{
  const cases: Array<{ label: string; v: StartVerdict }> = [
    { label: 'partial-deployment-row-mismatch', v: buildStartVerdict({ deploy: deployOk, deploymentRow: dbFail, projectConfig: null, transition: null, deploymentRowSkipped: false }) },
    { label: 'partial-config-not-persisted', v: buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbFail, transition: null, deploymentRowSkipped: false }) },
    { label: 'partial-transition-failed', v: buildStartVerdict({ deploy: deployOk, deploymentRow: dbOk, projectConfig: dbOk, transition: transitionRealError, deploymentRowSkipped: false }) },
  ];
  for (const c of cases) {
    if ('serviceName' in c.v) {
      assert(`${c.label} preserves serviceName from deploy outcome`, c.v.serviceName === 'kol-studio');
    }
  }
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
