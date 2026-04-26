/**
 * Tests: buildStopVerdict + verdictToLifecycleResult (stop-verdict.ts) — round 13
 *
 * Background:
 *   Pre-round-13, stopProjectService had three IO calls in sequence with
 *   no error handling on the GCP DELETE (it returned void) and a bare
 *   `try { } catch { }` that swallowed any transitionProject error
 *   indistinguishably. The result was a class of lying-state bugs:
 *     - GCP DELETE failed → DB still got cloudRunUrl='' written →
 *       service still alive but DB says stopped
 *     - GCP DELETE OK + DB write threw → service gone but DB says live
 *       and round-10 reconciler can't auto-fix (nothing alive to inspect)
 *
 *   The fix: deleteService returns a structured result, the orchestrator
 *   collects (delete, db, transition) outcomes, and this pure planner
 *   classifies the combination into one of six verdict kinds with the
 *   correct log level.
 *
 *   This test pins down each branch of the planner so the wrong path
 *   can't sneak back in.
 *
 * Run: tsx src/test-stop-verdict.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  buildStopVerdict,
  verdictToLifecycleResult,
  type DeleteOutcome,
  type DbWriteOutcome,
  type TransitionOutcome,
  type StopVerdict,
} from './services/stop-verdict.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

// ─── Test fixtures ───
const okDelete: DeleteOutcome = { ok: true, alreadyGone: false, error: null };
const okDelete404: DeleteOutcome = { ok: true, alreadyGone: true, error: null };
const failDelete: DeleteOutcome = { ok: false, alreadyGone: false, error: 'HTTP 503: Service Unavailable' };

const okDb: DbWriteOutcome = { ok: true, error: null };
const failDb: DbWriteOutcome = { ok: false, error: 'connection terminated unexpectedly' };

const okTransition: TransitionOutcome = { ok: true, errorName: null, error: null };
const invalidTransition: TransitionOutcome = {
  ok: false,
  errorName: 'InvalidTransitionError',
  error: 'Invalid state transition: failed → stopped',
};
const concurrentTransition: TransitionOutcome = {
  ok: false,
  errorName: 'ConcurrentTransitionError',
  error: 'Concurrent state transition: expected from=live → stopped, but row was already in state=failed',
};
const dbErrorTransition: TransitionOutcome = {
  ok: false,
  errorName: 'Error',
  error: 'pg pool drained',
};

console.log('\n=== buildStopVerdict: clean stop ===\n');

test('delete OK + db OK + transition OK → clean-stop, info', () => {
  const v = buildStopVerdict({
    serviceName: 'svc-123',
    delete: okDelete,
    db: okDb,
    transition: okTransition,
  });
  assert.equal(v.kind, 'clean-stop');
  assert.equal(v.logLevel, 'info');
  assert.equal(v.serviceName, 'svc-123');
  assert.match(v.message, /Stopped svc-123/);
});

test('delete 404 (already gone) + db OK + transition OK → clean-stop-already-gone, info', () => {
  // Idempotent re-stop: someone (or a previous stop attempt) already
  // deleted the GCP service. We still cleaned up DB. No alarm.
  const v = buildStopVerdict({
    serviceName: 'svc-999',
    delete: okDelete404,
    db: okDb,
    transition: okTransition,
  });
  assert.equal(v.kind, 'clean-stop-already-gone');
  assert.equal(v.logLevel, 'info');
  assert.match(v.message, /already deleted/);
});

console.log('\n=== buildStopVerdict: state-machine rejection on transition (expected) ===\n');

test('delete OK + db OK + transition InvalidTransitionError → clean-stop-transition-skipped, info', () => {
  // Operator stops a project already in `failed`. State machine rejects
  // failed → stopped. Stop intent satisfied (service gone, DB knows).
  // No alarm; log info.
  const v = buildStopVerdict({
    serviceName: 'svc-abc',
    delete: okDelete,
    db: okDb,
    transition: invalidTransition,
  });
  assert.equal(v.kind, 'clean-stop-transition-skipped');
  assert.equal(v.logLevel, 'info');
  if (v.kind === 'clean-stop-transition-skipped') {
    assert.equal(v.transitionErrorName, 'InvalidTransitionError');
  }
});

test('delete OK + db OK + transition ConcurrentTransitionError → clean-stop-transition-skipped, info', () => {
  // Round-12 race: between our read and our UPDATE, another writer
  // changed status. Stop intent still satisfied.
  const v = buildStopVerdict({
    serviceName: 'svc-xyz',
    delete: okDelete,
    db: okDb,
    transition: concurrentTransition,
  });
  assert.equal(v.kind, 'clean-stop-transition-skipped');
  assert.equal(v.logLevel, 'info');
  if (v.kind === 'clean-stop-transition-skipped') {
    assert.equal(v.transitionErrorName, 'ConcurrentTransitionError');
  }
});

console.log('\n=== buildStopVerdict: critical partial failures (round 13 fix) ===\n');

test('delete FAILED → partial-gcp-failed, CRITICAL, message warns service may still be live', () => {
  // The headline round-13 case. Pre-round-13 we would have written
  // `cloudRunUrl=''` to DB anyway — lying about a service that may
  // still be live.
  const v = buildStopVerdict({
    serviceName: 'svc-broken',
    delete: failDelete,
    db: null,           // caller short-circuited correctly
    transition: null,
  });
  assert.equal(v.kind, 'partial-gcp-failed');
  assert.equal(v.logLevel, 'critical');
  if (v.kind === 'partial-gcp-failed') {
    assert.equal(v.gcpError, 'HTTP 503: Service Unavailable');
    assert.match(v.message, /may still be live/);
    assert.match(v.message, /DB was NOT updated/);
  }
});

test('delete OK + db FAILED → partial-db-mismatch, CRITICAL, message says DB still claims live', () => {
  // The other lying-state case. Service is gone but DB row says live.
  // Round-10 reconciler cannot auto-fix because there is nothing alive
  // to inspect.
  const v = buildStopVerdict({
    serviceName: 'svc-mismatch',
    delete: okDelete,
    db: failDb,
    transition: null,
  });
  assert.equal(v.kind, 'partial-db-mismatch');
  assert.equal(v.logLevel, 'critical');
  if (v.kind === 'partial-db-mismatch') {
    assert.equal(v.dbError, 'connection terminated unexpectedly');
    assert.match(v.message, /service is DELETED but/);
    assert.match(v.message, /Reconciler cannot auto-fix/);
  }
});

test('delete OK + db OK + transition non-state-machine error → partial-transition-failed, warn', () => {
  // Service gone, deployment row reflects offline, but projects.status
  // didn't update due to e.g. pg outage between writes. Less critical
  // than the above two but still a partial state worth surfacing.
  const v = buildStopVerdict({
    serviceName: 'svc-half',
    delete: okDelete,
    db: okDb,
    transition: dbErrorTransition,
  });
  assert.equal(v.kind, 'partial-transition-failed');
  assert.equal(v.logLevel, 'warn');
  if (v.kind === 'partial-transition-failed') {
    assert.equal(v.transitionError, 'pg pool drained');
  }
});

console.log('\n=== buildStopVerdict: edge cases ===\n');

test('delete failed with null error string → falls back to "unknown GCP error"', () => {
  const v = buildStopVerdict({
    serviceName: 'svc-x',
    delete: { ok: false, alreadyGone: false, error: null },
    db: null,
    transition: null,
  });
  assert.equal(v.kind, 'partial-gcp-failed');
  if (v.kind === 'partial-gcp-failed') assert.equal(v.gcpError, 'unknown GCP error');
});

test('db failure with null error string → falls back to "unknown DB error"', () => {
  const v = buildStopVerdict({
    serviceName: 'svc-y',
    delete: okDelete,
    db: { ok: false, error: null },
    transition: null,
  });
  assert.equal(v.kind, 'partial-db-mismatch');
  if (v.kind === 'partial-db-mismatch') assert.equal(v.dbError, 'unknown DB error');
});

test('transition failure with null error name → not classified as state-machine rejection', () => {
  // If error.name is null/undefined we should NOT classify it as
  // expected (InvalidTransition/Concurrent). Treat as warn-level partial.
  const v = buildStopVerdict({
    serviceName: 'svc-q',
    delete: okDelete,
    db: okDb,
    transition: { ok: false, errorName: null, error: 'mystery error' },
  });
  assert.equal(v.kind, 'partial-transition-failed');
  assert.equal(v.logLevel, 'warn');
});

console.log('\n=== verdictToLifecycleResult: success/failure mapping ===\n');

test('clean-stop → success=true', () => {
  const v: StopVerdict = { kind: 'clean-stop', logLevel: 'info', serviceName: 'a', message: 'ok' };
  assert.equal(verdictToLifecycleResult(v).success, true);
});

test('clean-stop-already-gone → success=true (idempotent)', () => {
  const v: StopVerdict = { kind: 'clean-stop-already-gone', logLevel: 'info', serviceName: 'a', message: 'ok' };
  assert.equal(verdictToLifecycleResult(v).success, true);
});

test('clean-stop-transition-skipped → success=true (state-machine rejection is expected)', () => {
  const v: StopVerdict = {
    kind: 'clean-stop-transition-skipped',
    logLevel: 'info',
    serviceName: 'a',
    transitionErrorName: 'InvalidTransitionError',
    message: 'ok',
  };
  assert.equal(verdictToLifecycleResult(v).success, true);
});

test('partial-transition-failed → success=true (soft failure: stop intent mostly succeeded)', () => {
  // Deliberately success=true: from operator POV the service IS stopped
  // and the deployment row IS updated. Only projects.status is stale.
  // Showing red X for this is misleading.
  const v: StopVerdict = {
    kind: 'partial-transition-failed',
    logLevel: 'warn',
    serviceName: 'a',
    transitionError: 'mystery',
    message: 'ok',
  };
  assert.equal(verdictToLifecycleResult(v).success, true);
});

test('partial-gcp-failed → success=false (operator must act)', () => {
  const v: StopVerdict = {
    kind: 'partial-gcp-failed',
    logLevel: 'critical',
    serviceName: 'a',
    gcpError: 'HTTP 500',
    message: 'critical',
  };
  assert.equal(verdictToLifecycleResult(v).success, false);
});

test('partial-db-mismatch → success=false (operator must act)', () => {
  const v: StopVerdict = {
    kind: 'partial-db-mismatch',
    logLevel: 'critical',
    serviceName: 'a',
    dbError: 'pg outage',
    message: 'critical',
  };
  assert.equal(verdictToLifecycleResult(v).success, false);
});

console.log('\n=== Regression guards ===\n');

test('CRITICAL log levels only on the two real lying-state cases', () => {
  // If anyone adds a new verdict kind and accidentally marks it critical,
  // this test fails — forces them to think about whether it really is.
  const cases = [
    { delete: okDelete, db: okDb, transition: okTransition, expectCritical: false },
    { delete: okDelete404, db: okDb, transition: okTransition, expectCritical: false },
    { delete: okDelete, db: okDb, transition: invalidTransition, expectCritical: false },
    { delete: okDelete, db: okDb, transition: concurrentTransition, expectCritical: false },
    { delete: failDelete, db: null, transition: null, expectCritical: true },           // GCP failed
    { delete: okDelete, db: failDb, transition: null, expectCritical: true },           // DB failed
    { delete: okDelete, db: okDb, transition: dbErrorTransition, expectCritical: false }, // soft partial
  ];
  for (const c of cases) {
    const v = buildStopVerdict({ serviceName: 'svc', delete: c.delete, db: c.db, transition: c.transition });
    const isCritical = v.logLevel === 'critical';
    assert.equal(isCritical, c.expectCritical, `${v.kind} should be critical=${c.expectCritical} but got ${isCritical}`);
  }
});

test('NEVER returns clean-stop when delete failed (would write lying-state to DB)', () => {
  // Property test: if delete.ok is false, verdict MUST be
  // partial-gcp-failed regardless of what (impossibly) the caller
  // passed for db/transition.
  const v = buildStopVerdict({
    serviceName: 'svc',
    delete: failDelete,
    db: okDb,           // caller violated short-circuit rule
    transition: okTransition,
  });
  assert.equal(v.kind, 'partial-gcp-failed', 'delete-failed must take precedence over any successful db/transition');
});

test('NEVER returns clean-stop when db failed', () => {
  const v = buildStopVerdict({
    serviceName: 'svc',
    delete: okDelete,
    db: failDb,
    transition: okTransition,
  });
  assert.equal(v.kind, 'partial-db-mismatch', 'db-failed must take precedence over any successful transition');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
