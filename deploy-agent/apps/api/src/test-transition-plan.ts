/**
 * Tests: buildTransitionPlan + ConcurrentTransitionError + InvalidTransitionError
 *   (state-machine.ts, round 12)
 *
 * Background:
 *   Pre-round-12, transitionProject was SELECT → JS canTransition() check
 *   → UPDATE. Two writers (deploy-worker doing canary→live, reconciler also
 *   doing deployed→live) could both pass the validity check on the same
 *   source state, then both UPDATE. Last write wins; the audit log shows
 *   two transitions from the same from_state; the resulting status could
 *   contradict what either writer's metadata claimed.
 *
 *   Round-12 introduces:
 *     - buildTransitionPlan: pure planner. Returns one of three intents.
 *     - ConcurrentTransitionError: distinct from InvalidTransitionError so
 *       callers can tell "rules said no" from "you lost a race".
 *     - transitionProject: refactored to use plan + UPDATE WHERE status =
 *       expectedFromState (single round-trip optimistic-concurrency check).
 *
 *   This test file pins down the pure planner's output for every
 *   meaningful input, plus the regression guards that the state-machine
 *   transitions from earlier rounds (especially round 11's
 *   canary_check → failed) still resolve to `allowed`.
 *
 * Run: tsx src/test-transition-plan.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  buildTransitionPlan,
  canTransition,
  ConcurrentTransitionError,
  InvalidTransitionError,
  type ProjectStatus,
} from '@deploy-agent/shared';

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

console.log('\n=== buildTransitionPlan: idempotent self-transitions ===\n');

test('live → live → idempotent-noop (round-9 reconciler-race tolerance)', () => {
  const plan = buildTransitionPlan({ currentState: 'live', toState: 'live' });
  assert.equal(plan.kind, 'idempotent-noop');
});

test('failed → failed → REJECTED (only `live` is allowed to self-loop)', () => {
  // We deliberately do NOT make `failed → failed` idempotent. If something
  // tries to mark a failed project failed again, that's almost certainly a
  // bug we want to surface, not silently swallow.
  const plan = buildTransitionPlan({ currentState: 'failed', toState: 'failed' });
  assert.equal(plan.kind, 'rejected');
});

test('stopped → stopped → REJECTED', () => {
  const plan = buildTransitionPlan({ currentState: 'stopped', toState: 'stopped' });
  assert.equal(plan.kind, 'rejected');
});

test('deploying → deploying → REJECTED', () => {
  const plan = buildTransitionPlan({ currentState: 'deploying', toState: 'deploying' });
  assert.equal(plan.kind, 'rejected');
});

console.log('\n=== buildTransitionPlan: rules-allowed transitions ===\n');

test('submitted → scanning → allowed, expectedFromState=submitted', () => {
  const plan = buildTransitionPlan({ currentState: 'submitted', toState: 'scanning' });
  assert.equal(plan.kind, 'allowed');
  if (plan.kind === 'allowed') assert.equal(plan.expectedFromState, 'submitted');
});

test('canary_check → live → allowed', () => {
  const plan = buildTransitionPlan({ currentState: 'canary_check', toState: 'live' });
  assert.equal(plan.kind, 'allowed');
  if (plan.kind === 'allowed') assert.equal(plan.expectedFromState, 'canary_check');
});

test('canary_check → rolling_back → allowed', () => {
  const plan = buildTransitionPlan({ currentState: 'canary_check', toState: 'rolling_back' });
  assert.equal(plan.kind, 'allowed');
});

test('canary_check → failed → allowed (THE round-11 fix; regression guard)', () => {
  // Round 11 added 'failed' as a legal target from canary_check so that
  // canary-fail + rollback-fail can transition to `failed` instead of lying
  // about being `live`. If this test fails, round 11 has been undone.
  const plan = buildTransitionPlan({ currentState: 'canary_check', toState: 'failed' });
  assert.equal(plan.kind, 'allowed');
});

test('approved → preview_deploying → allowed', () => {
  const plan = buildTransitionPlan({ currentState: 'approved', toState: 'preview_deploying' });
  assert.equal(plan.kind, 'allowed');
});

test('failed → submitted → allowed (retry path)', () => {
  const plan = buildTransitionPlan({ currentState: 'failed', toState: 'submitted' });
  assert.equal(plan.kind, 'allowed');
});

test('stopped → live → allowed (restart path)', () => {
  const plan = buildTransitionPlan({ currentState: 'stopped', toState: 'live' });
  assert.equal(plan.kind, 'allowed');
});

console.log('\n=== buildTransitionPlan: rules-rejected transitions ===\n');

test('failed → live → REJECTED', () => {
  // Important: pre-round-12, deploy-worker had a catch that swallowed any
  // 'Invalid state transition' substring. If a project was in 'failed'
  // (e.g., operator action) when deploy-worker tried to push to 'live',
  // the catch silently continued. With ConcurrentTransitionError now
  // distinct from InvalidTransitionError, this case is louder. The plan
  // itself must still reject.
  const plan = buildTransitionPlan({ currentState: 'failed', toState: 'live' });
  assert.equal(plan.kind, 'rejected');
  if (plan.kind === 'rejected') {
    assert.match(plan.reason, /Invalid state transition: failed → live/);
  }
});

test('submitted → live → REJECTED (skipping the whole pipeline)', () => {
  const plan = buildTransitionPlan({ currentState: 'submitted', toState: 'live' });
  assert.equal(plan.kind, 'rejected');
});

test('live → deploying → REJECTED (must go via submitted first)', () => {
  const plan = buildTransitionPlan({ currentState: 'live', toState: 'deploying' });
  assert.equal(plan.kind, 'rejected');
});

test('rejection reason format matches legacy InvalidTransitionError message', () => {
  // deploy-worker.ts has a string-match catch on `'Invalid state transition'`.
  // The plan's rejection reason must keep that prefix so the legacy catch
  // still works for the `rejected` path.
  const plan = buildTransitionPlan({ currentState: 'live', toState: 'submitted' });
  // Wait — live → submitted IS allowed (resubmit for new version). Use a
  // genuinely illegal one for the format check.
  const rejected = buildTransitionPlan({ currentState: 'review_pending', toState: 'live' });
  assert.equal(rejected.kind, 'rejected');
  if (rejected.kind === 'rejected') {
    assert.equal(rejected.reason, 'Invalid state transition: review_pending → live');
  }
  // Sanity: the not-rejected one really is allowed
  assert.equal(plan.kind, 'allowed');
});

console.log('\n=== Cross-check: buildTransitionPlan matches canTransition ===\n');

test('every state-machine edge that canTransition allows, buildTransitionPlan also allows', () => {
  // Property test. Walks all (from, to) pairs. Excludes the only special
  // case: live → live, which canTransition allows (so it doesn't crash on
  // reconciler races) but buildTransitionPlan classifies as
  // idempotent-noop (so transitionProject doesn't write a duplicate audit
  // row). Any future divergence between the two functions should fail
  // here.
  const allStates: ProjectStatus[] = [
    'submitted', 'scanning', 'review_pending', 'approved', 'rejected',
    'needs_revision', 'preview_deploying', 'deploying', 'deployed',
    'ssl_provisioning', 'canary_check', 'rolling_back', 'live', 'stopped', 'failed',
  ];
  for (const from of allStates) {
    for (const to of allStates) {
      const can = canTransition(from, to);
      const plan = buildTransitionPlan({ currentState: from, toState: to });
      if (from === 'live' && to === 'live') {
        // Special case: idempotent
        assert.equal(plan.kind, 'idempotent-noop', `live → live should be idempotent-noop`);
        continue;
      }
      if (can) {
        assert.equal(plan.kind, 'allowed', `${from} → ${to}: canTransition=true but plan=${plan.kind}`);
      } else {
        assert.equal(plan.kind, 'rejected', `${from} → ${to}: canTransition=false but plan=${plan.kind}`);
      }
    }
  }
});

console.log('\n=== ConcurrentTransitionError shape ===\n');

test('ConcurrentTransitionError has name set + carries actualState', () => {
  const err = new ConcurrentTransitionError('deployed', 'live', 'failed');
  assert.equal(err.name, 'ConcurrentTransitionError');
  assert.equal(err.expectedFrom, 'deployed');
  assert.equal(err.to, 'live');
  assert.equal(err.actualState, 'failed');
  assert.match(err.message, /Concurrent state transition/);
  // Important: NOT 'Invalid state transition' — must not accidentally match
  // legacy substring catches that swallow rules-rejected transitions.
  assert.doesNotMatch(err.message, /Invalid state transition/);
});

test('ConcurrentTransitionError instanceof Error (so try/catch works)', () => {
  const err = new ConcurrentTransitionError('deployed', 'live', 'failed');
  assert.ok(err instanceof Error);
});

test('InvalidTransitionError name preserved (legacy catch still matches)', () => {
  const err = new InvalidTransitionError('failed', 'live');
  assert.equal(err.name, 'InvalidTransitionError');
  assert.match(err.message, /Invalid state transition: failed → live/);
});

console.log('\n=== Regression guards: critical paths from earlier rounds ===\n');

test('Round 9: live → live MUST be idempotent (reconciler tolerance)', () => {
  const plan = buildTransitionPlan({ currentState: 'live', toState: 'live' });
  assert.equal(plan.kind, 'idempotent-noop');
});

test('Round 11: canary_check → failed MUST be allowed (rollback-fail trapped state)', () => {
  const plan = buildTransitionPlan({ currentState: 'canary_check', toState: 'failed' });
  assert.equal(plan.kind, 'allowed');
});

test('Round 11: canary_check → live MUST still be allowed (happy-path canary)', () => {
  const plan = buildTransitionPlan({ currentState: 'canary_check', toState: 'live' });
  assert.equal(plan.kind, 'allowed');
});

test('All catch sites in deploy-worker: failed → live, stopped → live, etc.', () => {
  // Sanity-check that the kinds of "I lost the race" cases the deploy-worker
  // catch handles are correctly classified. After round 12, deploy-worker's
  // catch must distinguish:
  //  - ConcurrentTransitionError (race resolved to NOT-our-target) → swallow
  //  - InvalidTransitionError on `failed → live` (operator pushed to failed
  //    while we ran) → swallow (operator wins)
  // Both must be classified by the planner so the orchestrator can produce
  // the right error class.
  assert.equal(buildTransitionPlan({ currentState: 'failed', toState: 'live' }).kind, 'rejected');
  assert.equal(buildTransitionPlan({ currentState: 'stopped', toState: 'live' }).kind, 'allowed');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
