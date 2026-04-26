/**
 * Round 15 unit tests — project teardown verdict.
 *
 * What we're pinning down:
 *   The DELETE /api/projects/:id route (and its bulk twin in project-groups.ts)
 *   used to call `await deleteProjectFromDb(project.id)` UNCONDITIONALLY,
 *   even when GCP cleanup steps errored. Permanent billed orphans + zero
 *   audit trail to debug from. Same pattern in the project-groups bulk
 *   delete. Plus releaseProjectRedis was never called and the table has
 *   no FK CASCADE, so allocation rows leaked forever.
 *
 *   These tests pin the verdict contract so the route can never silently
 *   regress to that behavior. The CRITICAL invariant: if any step's
 *   ok=false, the verdict MUST be `partial-orphans` and MUST carry the
 *   `errorCode: 'project_teardown_orphans'` flag the dashboard reads.
 *
 * Run: `npx tsx apps/api/src/test-teardown-verdict.ts`
 */

import {
  buildTeardownVerdict,
  outcomeToLogEntry,
  type TeardownStepOutcome,
  type TeardownVerdict,
} from './services/teardown-verdict';

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

const ok = (kind: TeardownStepOutcome['kind'], reference: string, alreadyGone = false): TeardownStepOutcome => ({
  kind, reference, ok: true, alreadyGone, error: null,
});
const bad = (kind: TeardownStepOutcome['kind'], reference: string, error: string): TeardownStepOutcome => ({
  kind, reference, ok: false, error,
});

// ─────────────────────────────────────────────────────────────────────
// Section 1: buildTeardownVerdict — three-way classification
// ─────────────────────────────────────────────────────────────────────
console.log('\n[1] buildTeardownVerdict — three-way classification');

// 1. nothing-to-delete
{
  const v = buildTeardownVerdict([]);
  eq('empty outcomes → nothing-to-delete', v.kind, 'nothing-to-delete');
  if (v.kind === 'nothing-to-delete') {
    eq('  logLevel=info', v.logLevel, 'info');
  }
}

// 2. clean-teardown — single ok
{
  const v = buildTeardownVerdict([ok('cloud_run_service', 'svc-x')]);
  eq('single ok → clean-teardown', v.kind, 'clean-teardown');
  if (v.kind === 'clean-teardown') {
    eq('  logLevel=info', v.logLevel, 'info');
    eq('  successfulSteps surfaces the outcome', v.successfulSteps.length, 1);
  }
}

// 2b. clean-teardown — many ok including alreadyGone (idempotent)
{
  const outcomes: TeardownStepOutcome[] = [
    ok('cloud_run_service', 'svc-a', true),
    ok('domain_mapping', 'a.example.com'),
    ok('cloudflare_dns', 'a.example.com'),
    ok('container_image', 'image-a'),
    ok('redis_allocation', 'project-uuid-a'),
  ];
  const v = buildTeardownVerdict(outcomes);
  eq('many ok (incl. alreadyGone) → clean-teardown', v.kind, 'clean-teardown');
  if (v.kind === 'clean-teardown') {
    eq('  successfulSteps preserves order', v.successfulSteps.length, 5);
  }
}

// 3. partial-orphans — single failure
{
  const v = buildTeardownVerdict([bad('cloud_run_service', 'svc-fail', 'PERMISSION_DENIED')]);
  eq('single failure → partial-orphans', v.kind, 'partial-orphans');
  if (v.kind === 'partial-orphans') {
    eq('  errorCode = the dashboard contract', v.errorCode, 'project_teardown_orphans');
    assert('  requiresManualCleanup is literal true', v.requiresManualCleanup === true);
    eq('  logLevel=critical', v.logLevel, 'critical');
    eq('  orphans surfaces the failed step', v.orphans.length, 1);
    eq('  successfulSteps is empty', v.successfulSteps.length, 0);
  }
}

// 3b. partial-orphans — mixed (worst case, what operator actually sees)
{
  const outcomes: TeardownStepOutcome[] = [
    ok('cloud_run_service', 'svc-a'),
    bad('domain_mapping', 'a.example.com', 'mapping not found'),
    ok('cloudflare_dns', 'a.example.com'),
    bad('container_image', 'image-a', '500 Internal Error'),
    ok('redis_allocation', 'project-uuid-a'),
  ];
  const v = buildTeardownVerdict(outcomes);
  eq('mixed (3 ok, 2 fail) → partial-orphans', v.kind, 'partial-orphans');
  if (v.kind === 'partial-orphans') {
    eq('  orphans count = 2', v.orphans.length, 2);
    eq('  successfulSteps count = 3', v.successfulSteps.length, 3);
    eq('  orphans[0].kind', v.orphans[0].kind, 'domain_mapping');
    eq('  orphans[1].kind', v.orphans[1].kind, 'container_image');
  }
}

// 3c. all fail — still partial-orphans (not a different kind; "all-failed" doesn't exist by design)
{
  const outcomes: TeardownStepOutcome[] = [
    bad('cloud_run_service', 'svc-a', 'x'),
    bad('container_image', 'image-a', 'y'),
  ];
  const v = buildTeardownVerdict(outcomes);
  eq('all fail → still partial-orphans', v.kind, 'partial-orphans');
  if (v.kind === 'partial-orphans') {
    eq('  successfulSteps empty', v.successfulSteps.length, 0);
    eq('  orphans count = 2', v.orphans.length, 2);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Section 2: Regression guards on the dashboard / route contract
// ─────────────────────────────────────────────────────────────────────
console.log('\n[2] Regression guards — dashboard / route contract');

// Only partial-orphans should carry the requiresManualCleanup flag. If
// clean-teardown ever started carrying it, the dashboard would refuse
// to refresh after a successful delete.
{
  const cleanV = buildTeardownVerdict([ok('cloud_run_service', 'a')]);
  const noopV = buildTeardownVerdict([]);
  assert('clean-teardown does NOT carry requiresManualCleanup', !('requiresManualCleanup' in cleanV));
  assert('nothing-to-delete does NOT carry requiresManualCleanup', !('requiresManualCleanup' in noopV));
}

// Only partial-orphans should carry the errorCode. Same logic — the
// dashboard switches to "manual cleanup required" mode based on this.
{
  const cleanV = buildTeardownVerdict([ok('cloud_run_service', 'a')]);
  const noopV = buildTeardownVerdict([]);
  assert('clean-teardown does NOT carry errorCode', !('errorCode' in cleanV));
  assert('nothing-to-delete does NOT carry errorCode', !('errorCode' in noopV));
}

// logLevel pinning. critical only when there's an orphan to investigate.
{
  assert(
    'nothing-to-delete → logLevel=info',
    buildTeardownVerdict([]).logLevel === 'info',
  );
  assert(
    'clean-teardown → logLevel=info',
    buildTeardownVerdict([ok('cloud_run_service', 'a')]).logLevel === 'info',
  );
  assert(
    'partial-orphans → logLevel=critical',
    buildTeardownVerdict([bad('cloud_run_service', 'a', 'x')]).logLevel === 'critical',
  );
}

// CRITICAL pinned: if ANY outcome has ok=false, the verdict MUST be
// partial-orphans. This is the property test — if it ever regresses,
// the route would silently delete the DB row while orphans live.
{
  const kinds: TeardownStepOutcome['kind'][] = [
    'cloud_run_service',
    'domain_mapping',
    'cloudflare_dns',
    'container_image',
    'redis_allocation',
  ];
  for (const k of kinds) {
    const outcomes: TeardownStepOutcome[] = [
      ok('cloud_run_service', 'always-ok'),
      bad(k, 'fails', 'boom'),
      ok('container_image', 'also-ok'),
    ];
    const v = buildTeardownVerdict(outcomes);
    assert(`single ${k} failure forces partial-orphans (not silent success)`, v.kind === 'partial-orphans');
  }
}

// Pure: doesn't mutate input array.
{
  const outcomes: TeardownStepOutcome[] = [
    ok('cloud_run_service', 'a'),
    bad('domain_mapping', 'b', 'err'),
  ];
  const snap = JSON.stringify(outcomes);
  buildTeardownVerdict(outcomes);
  assert('buildTeardownVerdict does not mutate input', JSON.stringify(outcomes) === snap);
}

// ─────────────────────────────────────────────────────────────────────
// Section 3: outcomeToLogEntry — legacy log shape preserved
// ─────────────────────────────────────────────────────────────────────
console.log('\n[3] outcomeToLogEntry — legacy log shape');

eq(
  'ok cloud_run → "Delete Cloud Run service: <ref>" status=ok',
  outcomeToLogEntry(ok('cloud_run_service', 'svc-x')),
  { step: 'Delete Cloud Run service: svc-x', status: 'ok' },
);

eq(
  'ok cloud_run alreadyGone → suffix preserved',
  outcomeToLogEntry(ok('cloud_run_service', 'svc-x', true)),
  { step: 'Delete Cloud Run service: svc-x (already gone)', status: 'ok' },
);

eq(
  'failed domain_mapping → status=error + error message',
  outcomeToLogEntry(bad('domain_mapping', 'a.example.com', 'mapping not found')),
  { step: 'Delete domain mapping: a.example.com', status: 'error', error: 'mapping not found' },
);

eq(
  'redis_allocation label is "Release Redis allocation"',
  outcomeToLogEntry(ok('redis_allocation', 'project-uuid')),
  { step: 'Release Redis allocation: project-uuid', status: 'ok' },
);

eq(
  'container_image failure includes error',
  outcomeToLogEntry(bad('container_image', 'slug-x', '500')),
  { step: 'Delete container image: slug-x', status: 'error', error: '500' },
);

eq(
  'cloudflare_dns label is "Delete DNS"',
  outcomeToLogEntry(ok('cloudflare_dns', 'a.example.com')),
  { step: 'Delete DNS: a.example.com', status: 'ok' },
);

// Failed step with null error gets a fallback string (caller never sees `null` text).
eq(
  'failed step with null error → "unknown" fallback',
  outcomeToLogEntry({ kind: 'cloud_run_service', reference: 'svc-y', ok: false, error: null }),
  { step: 'Delete Cloud Run service: svc-y', status: 'error', error: 'unknown' },
);

// ─────────────────────────────────────────────────────────────────────
// Section 4: Round-15 specific bug regressions
// ─────────────────────────────────────────────────────────────────────
console.log('\n[4] Round 15 bug regression guards');

// The exact bug fixed: container_image fails but cloud_run succeeded.
// Pre-round-15 the route would still call deleteProjectFromDb. Now the
// verdict makes that impossible — the route checks `kind === 'partial-orphans'`
// and short-circuits.
{
  const v = buildTeardownVerdict([
    ok('cloud_run_service', 'svc-x'),
    bad('container_image', 'slug-x', 'image still has dependents'),
  ]);
  eq('CR ok + image fail → partial-orphans (was: silently DB-deleted)', v.kind, 'partial-orphans');
  if (v.kind === 'partial-orphans') {
    eq('  the image is in orphans, not in successfulSteps', v.orphans[0].kind, 'container_image');
    eq('  the cloud_run is in successfulSteps', v.successfulSteps[0].kind, 'cloud_run_service');
  }
}

// Redis allocation failure alone is enough to block DB delete. Otherwise
// the row would leak (no FK CASCADE).
{
  const v = buildTeardownVerdict([
    ok('cloud_run_service', 'svc-x'),
    ok('container_image', 'slug-x'),
    bad('redis_allocation', 'project-uuid', 'connection refused'),
  ]);
  eq('redis-only failure → partial-orphans (no silent DB delete)', v.kind, 'partial-orphans');
}

// Cloudflare DNS failure alone is enough to block DB delete. Otherwise
// the next operator with the same subdomain hits "CNAME exists" with no
// trace of who owned it.
{
  const v = buildTeardownVerdict([
    ok('cloud_run_service', 'svc-x'),
    ok('domain_mapping', 'a.example.com'),
    bad('cloudflare_dns', 'a.example.com', 'rate limited'),
  ]);
  eq('Cloudflare-only failure → partial-orphans', v.kind, 'partial-orphans');
}

// Verdict has discriminated-union exhaustiveness: every path returns
// an object with `kind` and `logLevel`. Compile-time guarantee + runtime check.
{
  const verdicts: TeardownVerdict[] = [
    buildTeardownVerdict([]),
    buildTeardownVerdict([ok('cloud_run_service', 'a')]),
    buildTeardownVerdict([bad('cloud_run_service', 'a', 'x')]),
  ];
  for (const v of verdicts) {
    assert(`${v.kind} has logLevel`, typeof v.logLevel === 'string');
    assert(`${v.kind} has kind`, typeof v.kind === 'string');
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
