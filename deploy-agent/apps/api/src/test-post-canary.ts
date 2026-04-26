/**
 * Tests: decidePostCanaryAction + verdictToTargetState (post-canary.ts) — round 11
 *
 * Background:
 *   Before round 11, when canary failed AND auto-rollback failed, the
 *   deploy-worker still called `transitionProject(projectId, 'live', ...)`
 *   with metadata claiming the rollback didn't work. The dashboard showed
 *   "live" while Cloud Run was serving the broken version. Round 10's
 *   reconciler would then "auto-fix" the split by writing `is_published =
 *   bad-revision` to the DB, sealing the bad state in.
 *
 *   The fix: when rollback fails, project goes to `failed` so an operator
 *   must intervene; the reconciler stays out (round-10 only scans `live`).
 *
 *   This test file pins down the verdict logic for every (canary, rollback,
 *   lock) combination so the wrong path can't sneak back.
 *
 * Run: tsx src/test-post-canary.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  decidePostCanaryAction,
  verdictToTargetState,
  type PostCanaryVerdict,
} from './services/post-canary.js';

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

console.log('\n=== decidePostCanaryAction: canary passed ===\n');

test('canary passed, deploy NOT locked → live-clean, autoPublish=true', () => {
  const v = decidePostCanaryAction({
    canary: { passed: true, failedChecks: '' },
    rollback: { attempted: false, success: false, error: null, targetVersion: null },
    newVersion: 5,
    isDeployLocked: false,
  });
  assert.equal(v.kind, 'live-clean');
  if (v.kind === 'live-clean') {
    assert.equal(v.autoPublishNewVersion, true);
    assert.equal(v.logLevel, 'info');
  }
});

test('canary passed, deploy LOCKED → live-clean, autoPublish=false', () => {
  // Locked deploy means user wants to manually publish. Even on a happy
  // canary, we deploy + go live but DON'T flip is_published. The new
  // version sits as a preview until user explicitly publishes.
  const v = decidePostCanaryAction({
    canary: { passed: true, failedChecks: '' },
    rollback: { attempted: false, success: false, error: null, targetVersion: null },
    newVersion: 5,
    isDeployLocked: true,
  });
  assert.equal(v.kind, 'live-clean');
  if (v.kind === 'live-clean') assert.equal(v.autoPublishNewVersion, false);
});

console.log('\n=== decidePostCanaryAction: canary failed, no rollback target ===\n');

test('canary failed, no previous version → live-canary-warning-no-rollback-target, autoPublish=true', () => {
  // First deploy with failing canary. Established product decision: better
  // to have something live (with warnings) than nothing live.
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'http_health: 0 (threshold: 1)' },
    rollback: { attempted: false, success: false, error: null, targetVersion: null },
    newVersion: 1,
    isDeployLocked: false,
  });
  assert.equal(v.kind, 'live-canary-warning-no-rollback-target');
  if (v.kind === 'live-canary-warning-no-rollback-target') {
    assert.equal(v.autoPublishNewVersion, true);
    assert.equal(v.logLevel, 'warn');
  }
});

test('canary failed, no previous version, deploy LOCKED → autoPublish=false', () => {
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'whatever' },
    rollback: { attempted: false, success: false, error: null, targetVersion: null },
    newVersion: 1,
    isDeployLocked: true,
  });
  assert.equal(v.kind, 'live-canary-warning-no-rollback-target');
  if (v.kind === 'live-canary-warning-no-rollback-target') {
    assert.equal(v.autoPublishNewVersion, false);
  }
});

console.log('\n=== decidePostCanaryAction: canary failed, rollback succeeded ===\n');

test('canary failed, rollback SUCCEEDED → live-rolled-back', () => {
  // Cloud Run is now serving the previous (good) version. New (broken)
  // version sits in DB as unpublished. Project is live (on the previous
  // version) — that's not a lie because traffic IS healthy.
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'http_health failed' },
    rollback: { attempted: true, success: true, error: null, targetVersion: 4 },
    newVersion: 5,
    isDeployLocked: false,
  });
  assert.equal(v.kind, 'live-rolled-back');
  if (v.kind === 'live-rolled-back') {
    assert.equal(v.rolledBackToVersion, 4);
    assert.equal(v.logLevel, 'warn');
  }
});

test('rollback success ignores the deploy-locked flag', () => {
  // The lock matters for "should we publish the NEW version". After a
  // successful rollback we explicitly do NOT publish the new version
  // (it's broken), so the lock is irrelevant.
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'x' },
    rollback: { attempted: true, success: true, error: null, targetVersion: 4 },
    newVersion: 5,
    isDeployLocked: true,
  });
  assert.equal(v.kind, 'live-rolled-back');
});

console.log('\n=== decidePostCanaryAction: canary failed, rollback FAILED (round 11 fix) ===\n');

test('canary failed AND rollback failed → failed-rollback-failed (CRITICAL)', () => {
  // The bug fix. Cloud Run is on broken v5; rollback to v4 didn't work.
  // We must NOT mark live (would lie to dashboard + trick reconciler into
  // publishing v5 in DB).
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'error_rate too high' },
    rollback: { attempted: true, success: false, error: 'Traffic update failed (403): Permission denied', targetVersion: 4 },
    newVersion: 5,
    isDeployLocked: false,
  });
  assert.equal(v.kind, 'failed-rollback-failed');
  if (v.kind === 'failed-rollback-failed') {
    assert.equal(v.failedVersion, 5);
    assert.equal(v.intendedRollbackVersion, 4);
    assert.equal(v.rollbackError, 'Traffic update failed (403): Permission denied');
    assert.equal(v.logLevel, 'critical');
  }
});

test('rollback failure with null error string → uses fallback message, still CRITICAL', () => {
  // If publishRevision returns success=false but error=null (shouldn't happen
  // but defensive), we still treat it as a critical trapped state and
  // include a placeholder error message.
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'x' },
    rollback: { attempted: true, success: false, error: null, targetVersion: 4 },
    newVersion: 5,
    isDeployLocked: false,
  });
  assert.equal(v.kind, 'failed-rollback-failed');
  if (v.kind === 'failed-rollback-failed') {
    assert.equal(v.rollbackError, 'unknown rollback error');
    assert.equal(v.intendedRollbackVersion, 4);
  }
});

test('rollback failure when deploy is locked still returns failed-rollback-failed', () => {
  // Lock state doesn't change the outcome — we always go to `failed` when
  // rollback fails because Cloud Run is in an indeterminate state.
  const v = decidePostCanaryAction({
    canary: { passed: false, failedChecks: 'x' },
    rollback: { attempted: true, success: false, error: 'oops', targetVersion: 4 },
    newVersion: 5,
    isDeployLocked: true,
  });
  assert.equal(v.kind, 'failed-rollback-failed');
});

console.log('\n=== verdictToTargetState ===\n');

test('verdictToTargetState: live-clean → live', () => {
  const verdict: PostCanaryVerdict = { kind: 'live-clean', autoPublishNewVersion: true, logLevel: 'info' };
  assert.equal(verdictToTargetState(verdict), 'live');
});

test('verdictToTargetState: live-canary-warning-no-rollback-target → live', () => {
  const verdict: PostCanaryVerdict = {
    kind: 'live-canary-warning-no-rollback-target',
    autoPublishNewVersion: true,
    logLevel: 'warn',
  };
  assert.equal(verdictToTargetState(verdict), 'live');
});

test('verdictToTargetState: live-rolled-back → live', () => {
  const verdict: PostCanaryVerdict = { kind: 'live-rolled-back', rolledBackToVersion: 4, logLevel: 'warn' };
  assert.equal(verdictToTargetState(verdict), 'live');
});

test('verdictToTargetState: failed-rollback-failed → failed (THE round-11 fix)', () => {
  const verdict: PostCanaryVerdict = {
    kind: 'failed-rollback-failed',
    failedVersion: 5,
    intendedRollbackVersion: 4,
    rollbackError: 'oops',
    logLevel: 'critical',
  };
  assert.equal(verdictToTargetState(verdict), 'failed');
});

console.log('\n=== Regression guards ===\n');

test('NEVER returns failed when canary passed (would block healthy deploys)', () => {
  // Property test: for any rollback/lock combination, if canary passed we
  // should always end at 'live'. Rollback fields are nonsense when canary
  // passed (we don't attempt it), but make sure we don't accidentally
  // surface that nonsense as a `failed` verdict.
  const combos = [
    { attempted: false, success: false, error: null, targetVersion: null },
    { attempted: true, success: true, error: null, targetVersion: 4 },
    { attempted: true, success: false, error: 'x', targetVersion: 4 },
  ] as const;
  for (const rollback of combos) {
    for (const isDeployLocked of [false, true]) {
      const v = decidePostCanaryAction({
        canary: { passed: true, failedChecks: '' },
        rollback,
        newVersion: 5,
        isDeployLocked,
      });
      assert.equal(verdictToTargetState(v), 'live');
    }
  }
});

test('NEVER auto-publishes the new version after a rollback (success or fail)', () => {
  // The new version is broken. Auto-publishing it would defeat the rollback
  // and (with round 10's reconciler) get sealed in.
  for (const success of [true, false]) {
    const v = decidePostCanaryAction({
      canary: { passed: false, failedChecks: 'x' },
      rollback: { attempted: true, success, error: success ? null : 'oops', targetVersion: 4 },
      newVersion: 5,
      isDeployLocked: false,
    });
    // None of the rollback verdicts have an autoPublishNewVersion=true field;
    // success → 'live-rolled-back' (no field), fail → 'failed-rollback-failed' (no field).
    assert.notEqual(v.kind, 'live-clean');
    assert.notEqual(v.kind, 'live-canary-warning-no-rollback-target');
  }
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
