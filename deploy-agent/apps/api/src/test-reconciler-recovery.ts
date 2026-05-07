/**
 * Tests: reconciler-recovery (R47)
 *
 * Why this matters:
 *   - One real incident (wavenet-ai-gateway-frontend, revision 00001-2x7) had
 *     Cloud Run serving traffic OK, but the deploy-worker DB write that fills
 *     in `cloudRunUrl` failed silently. The reconciler then 5-minutes-later
 *     concluded "no cloudRunUrl → stuck → mark failed", flipping a working
 *     deployment to a red row in the dashboard.
 *   - The fix is a pure decider with 8 branches. If any branch regresses,
 *     production behavior either:
 *       (a) still drops working deploys to failed (regression of the bug we
 *           are fixing), or
 *       (b) auto-promotes a zombie revision (introduces a new, worse bug).
 *   - Pure tests are the only line of defence; the IO wiring in reconciler.ts
 *     can't be unit-tested without mocking Postgres + the GCP REST client.
 *
 * What we lock in (≥ 12 cases):
 *   - race window: deployment too young → skip
 *   - cloudRunUrl already set → fast-forward
 *   - cloudRunUrl empty + cloudRunService empty → mark-failed
 *   - cloudRunUrl empty + service set + Cloud Run says "doesn't exist" → mark-failed
 *   - cloudRunUrl empty + service ready + condition FAILED → mark-failed
 *   - cloudRunUrl empty + service ready + revision mismatch → mark-failed (zombie)
 *   - cloudRunUrl empty + service ready + revision match + uri set → recover
 *   - cloudRunUrl empty + service exists but RECONCILING → skip
 *   - cloudRunUrl empty + service ready but uri null → skip
 *   - cloudRunUrl empty + service ready + dbRevision null → skip
 *   - cloudRunUrl empty + service ready + liveRevision null → skip
 *   - createdAt as Date object (not just ISO string) → still works
 *   - exactly at race window boundary → skip vs not-skip
 *   - empty uri string treated as null
 *
 * Run: bun run src/test-reconciler-recovery.ts (or npx tsx)
 */

import assert from 'node:assert/strict';
import {
  decideReconcilerAction,
  RECONCILER_RACE_WINDOW_MS,
  type ReconcilerCloudRunTruth,
  type ReconcilerDeploymentInput,
  type ReconcilerVerdict,
} from './services/reconciler-recovery.js';

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

const NOW = 1_700_000_000_000; // arbitrary fixed "now" for deterministic tests

function deployment(overrides: Partial<ReconcilerDeploymentInput> = {}): ReconcilerDeploymentInput {
  return {
    id: 'd-test',
    cloudRunUrl: null,
    cloudRunService: 'svc-test',
    revisionName: 'svc-test-00001-abc',
    // default: created 30 minutes ago — well past race window (25 min after R57.1)
    createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function truth(overrides: Partial<ReconcilerCloudRunTruth> = {}): ReconcilerCloudRunTruth {
  return {
    exists: true,
    ready: true,
    uri: 'https://svc-test-abc-de.a.run.app',
    liveRevision: 'svc-test-00001-abc',
    conditionState: 'CONDITION_SUCCEEDED',
    ...overrides,
  };
}

console.log('\n=== reconciler-recovery unit tests ===\n');

// ─── (1) race window ────────────────────────────────────────

test('race window: deployment created 1 minute ago → skip', () => {
  const v = decideReconcilerAction(
    deployment({ createdAt: new Date(NOW - 60 * 1000).toISOString() }),
    truth({ exists: false }), // even with hostile truth, skip wins
    NOW,
  );
  assert.equal(v.kind, 'skip');
  assert.match((v as { kind: 'skip'; reason: string }).reason, /too young/);
});

test('race window: deployment created 14 minutes ago (still inside 25min window after R57.1) → skip', () => {
  const v = decideReconcilerAction(
    deployment({ createdAt: new Date(NOW - 14 * 60 * 1000).toISOString() }),
    truth(),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

test('race window: deployment created 24 minutes ago (still inside 25min window after R57.1) → skip', () => {
  // Regression guard for R57.1: bump from 15min → 25min must keep the boundary
  // semantics. This test was added to verify the new value is honored, not just
  // the constant comparison.
  const v = decideReconcilerAction(
    deployment({ createdAt: new Date(NOW - 24 * 60 * 1000).toISOString() }),
    truth(),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

test('race window: deployment exactly at boundary (createdAt = now - RECONCILER_RACE_WINDOW_MS) → NOT skip', () => {
  // age === RECONCILER_RACE_WINDOW_MS, the check is `<` so this should pass
  const v = decideReconcilerAction(
    deployment({ createdAt: new Date(NOW - RECONCILER_RACE_WINDOW_MS).toISOString() }),
    truth(),
    NOW,
  );
  assert.notEqual(v.kind, 'skip');
});

test('race window: createdAt as Date object (not ISO string) → still works', () => {
  const v = decideReconcilerAction(
    deployment({ createdAt: new Date(NOW - 60 * 1000) }),
    truth(),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

// ─── (2) fast-forward ───────────────────────────────────────

test('fast-forward: cloudRunUrl already set → fast-forward', () => {
  const v = decideReconcilerAction(
    deployment({ cloudRunUrl: 'https://existing.run.app' }),
    truth(),
    NOW,
  );
  assert.equal(v.kind, 'fast-forward');
});

test('fast-forward: cloudRunUrl set even if Cloud Run truth is hostile → still fast-forward', () => {
  // 已經有 URL 就不再驗 Cloud Run；驗 Cloud Run 是後續 reconciler 的事
  const v = decideReconcilerAction(
    deployment({ cloudRunUrl: 'https://existing.run.app' }),
    truth({ exists: false, ready: false, conditionState: 'CONDITION_FAILED' }),
    NOW,
  );
  assert.equal(v.kind, 'fast-forward');
});

// ─── (3) both empty ─────────────────────────────────────────

test('both empty: cloudRunUrl null + cloudRunService null → mark-failed', () => {
  const v = decideReconcilerAction(
    deployment({ cloudRunUrl: null, cloudRunService: null }),
    truth({ exists: false }),
    NOW,
  );
  assert.equal(v.kind, 'mark-failed');
  assert.match(
    (v as { kind: 'mark-failed'; reason: string }).reason,
    /no cloudRunUrl AND no cloudRunService/,
  );
});

// ─── (4) service doesn't exist ──────────────────────────────

test('missing service: cloudRunService set but Cloud Run says exists=false → mark-failed', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ exists: false, ready: false, uri: null, liveRevision: null, conditionState: 'UNKNOWN' }),
    NOW,
  );
  assert.equal(v.kind, 'mark-failed');
  assert.match(
    (v as { kind: 'mark-failed'; reason: string }).reason,
    /does not exist/,
  );
});

// ─── (5) condition FAILED ───────────────────────────────────

test('condition failed: service exists but conditionState=CONDITION_FAILED → mark-failed', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ ready: false, conditionState: 'CONDITION_FAILED' }),
    NOW,
  );
  assert.equal(v.kind, 'mark-failed');
  assert.match(
    (v as { kind: 'mark-failed'; reason: string }).reason,
    /CONDITION_FAILED/,
  );
});

// ─── (6) zombie / revision mismatch ─────────────────────────

test('zombie: service ready but liveRevision !== deployment.revisionName → mark-failed', () => {
  const v = decideReconcilerAction(
    deployment({ revisionName: 'svc-test-00002-NEW' }),
    truth({ liveRevision: 'svc-test-00001-OLD' }),
    NOW,
  );
  assert.equal(v.kind, 'mark-failed');
  assert.match(
    (v as { kind: 'mark-failed'; reason: string }).reason,
    /revision mismatch/,
  );
});

// ─── (7) recover ────────────────────────────────────────────

test('recover: ready + condition SUCCEEDED + revision match + uri set → recover', () => {
  const v = decideReconcilerAction(
    deployment({ revisionName: 'svc-test-00001-abc' }),
    truth({
      ready: true,
      conditionState: 'CONDITION_SUCCEEDED',
      uri: 'https://recovered-uri.a.run.app',
      liveRevision: 'svc-test-00001-abc',
    }),
    NOW,
  );
  assert.equal(v.kind, 'recover-cloudrun-url');
  assert.equal((v as { kind: 'recover-cloudrun-url'; uri: string }).uri, 'https://recovered-uri.a.run.app');
});

// ─── (8) ambiguous → skip ───────────────────────────────────

test('ambiguous: service exists but conditionState=CONDITION_RECONCILING → skip', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ ready: false, conditionState: 'CONDITION_RECONCILING' }),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

test('ambiguous: ready + condition SUCCEEDED + revision match BUT uri null → skip', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ uri: null }),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

test('ambiguous: ready + condition SUCCEEDED but liveRevision null → skip', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ liveRevision: null }),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

test('ambiguous: ready + condition SUCCEEDED + uri set BUT deployment.revisionName null → skip', () => {
  // revisionName 是 null 代表 deploy-worker 還沒寫到那一步，連對不對都不知道
  const v = decideReconcilerAction(
    deployment({ revisionName: null }),
    truth(),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

test('ambiguous: ready + condition UNKNOWN (parsed from a state Cloud Run added) → skip', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ ready: true, conditionState: 'UNKNOWN' }),
    NOW,
  );
  // ready 是 true 但 conditionState 不是 SUCCEEDED → 不符合 recover 條件，落 skip
  assert.equal(v.kind, 'skip');
});

test('ambiguous: empty-string uri treated as null → skip', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ uri: '' }),
    NOW,
  );
  assert.equal(v.kind, 'skip');
});

// ─── decider invariants ─────────────────────────────────────

test('verdict.kind is always one of the 4 known values', () => {
  const allInputs: Array<[ReconcilerDeploymentInput, ReconcilerCloudRunTruth]> = [
    [deployment(), truth()],
    [deployment({ cloudRunUrl: 'set' }), truth()],
    [deployment({ cloudRunService: null }), truth()],
    [deployment(), truth({ exists: false })],
    [deployment(), truth({ conditionState: 'CONDITION_FAILED' })],
    [deployment({ revisionName: 'A' }), truth({ liveRevision: 'B' })],
  ];
  const known = new Set(['mark-failed', 'recover-cloudrun-url', 'fast-forward', 'skip']);
  for (const [d, t] of allInputs) {
    const v: ReconcilerVerdict = decideReconcilerAction(d, t, NOW);
    assert.ok(known.has(v.kind), `unexpected verdict kind: ${v.kind}`);
  }
});

test('mark-failed always carries a reason string', () => {
  const cases: Array<[ReconcilerDeploymentInput, ReconcilerCloudRunTruth]> = [
    [deployment({ cloudRunService: null }), truth({ exists: false })],
    [deployment(), truth({ exists: false })],
    [deployment(), truth({ conditionState: 'CONDITION_FAILED' })],
    [deployment({ revisionName: 'A' }), truth({ liveRevision: 'B' })],
  ];
  for (const [d, t] of cases) {
    const v = decideReconcilerAction(d, t, NOW);
    assert.equal(v.kind, 'mark-failed');
    const r = (v as { kind: 'mark-failed'; reason: string }).reason;
    assert.ok(typeof r === 'string' && r.length > 0, 'reason should be non-empty string');
  }
});

test('recover verdict always carries the Cloud Run uri verbatim', () => {
  const v = decideReconcilerAction(
    deployment(),
    truth({ uri: 'https://specific-uri-for-test.a.run.app' }),
    NOW,
  );
  assert.equal(v.kind, 'recover-cloudrun-url');
  assert.equal((v as { kind: 'recover-cloudrun-url'; uri: string }).uri, 'https://specific-uri-for-test.a.run.app');
});

test('skip verdict always carries a reason string', () => {
  const cases: Array<[ReconcilerDeploymentInput, ReconcilerCloudRunTruth]> = [
    [deployment({ createdAt: new Date(NOW - 60_000).toISOString() }), truth()],
    [deployment(), truth({ uri: null })],
    [deployment(), truth({ liveRevision: null })],
    [deployment({ revisionName: null }), truth()],
    [deployment(), truth({ conditionState: 'CONDITION_RECONCILING', ready: false })],
  ];
  for (const [d, t] of cases) {
    const v = decideReconcilerAction(d, t, NOW);
    assert.equal(v.kind, 'skip');
    const r = (v as { kind: 'skip'; reason: string }).reason;
    assert.ok(typeof r === 'string' && r.length > 0, 'reason should be non-empty string');
  }
});

// ─── regression: the original incident shape ────────────────

test('regression (wavenet-ai-gateway-frontend incident): old behavior would mark failed, new behavior recovers', () => {
  // The incident: deployment recorded service name + revision but DB write
  // for cloudRunUrl dropped. Cloud Run was actually live and serving the
  // recorded revision. Old reconciler: mark failed. New: recover.
  const incidentDeployment = deployment({
    id: 'da-wavenet-ai-gateway-frontend-deploy',
    cloudRunUrl: null, // <- the bug: this was empty
    cloudRunService: 'da-wavenet-ai-gateway-frontend',
    revisionName: 'da-wavenet-ai-gateway-frontend-00001-2x7',
    createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(), // 30 min ago, well past race window
  });
  const incidentTruth = truth({
    exists: true,
    ready: true,
    uri: 'https://da-wavenet-ai-gateway-frontend-xyz-de.a.run.app',
    liveRevision: 'da-wavenet-ai-gateway-frontend-00001-2x7',
    conditionState: 'CONDITION_SUCCEEDED',
  });
  const v = decideReconcilerAction(incidentDeployment, incidentTruth, NOW);
  assert.equal(v.kind, 'recover-cloudrun-url');
  assert.equal(
    (v as { kind: 'recover-cloudrun-url'; uri: string }).uri,
    'https://da-wavenet-ai-gateway-frontend-xyz-de.a.run.app',
  );
});

// ─── final report ─────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
