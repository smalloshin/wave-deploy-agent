import type { ProjectStatus } from './types';

const VALID_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  submitted: ['scanning', 'failed'],
  scanning: ['review_pending', 'failed'],
  review_pending: ['approved', 'rejected'],
  approved: ['preview_deploying', 'deploying', 'failed'],
  rejected: ['needs_revision'],
  needs_revision: ['submitted'],
  preview_deploying: ['deploying', 'failed'],
  deploying: ['deployed', 'failed'],
  deployed: ['ssl_provisioning', 'failed'],
  ssl_provisioning: ['canary_check', 'failed'],
  canary_check: ['live', 'rolling_back', 'failed'],  // round 11: 'failed' for canary-fail + rollback-fail trapped state
  rolling_back: ['deployed', 'failed'],
  live: ['submitted', 'stopped', 'live'], // resubmit for new version, manually stop, or idempotent re-live (reconciler race)
  stopped: ['live', 'submitted'], // restart (deploy last image) or full rescan
  failed: ['submitted', 'review_pending', 'stopped'], // retry, skip-scan, or give up
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidTransitions(from: ProjectStatus): ProjectStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}

export function isTerminalState(status: ProjectStatus): boolean {
  return status === 'live' || status === 'failed' || status === 'stopped';
}

export function isActionableState(status: ProjectStatus): boolean {
  return status === 'review_pending' || status === 'needs_revision';
}

export function requiresHumanAction(status: ProjectStatus): boolean {
  return status === 'review_pending';
}

export class InvalidTransitionError extends Error {
  constructor(from: ProjectStatus, to: ProjectStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Thrown when a transition is rules-allowed but a concurrent writer changed
 * the row's status between our read and our UPDATE. Distinct from
 * InvalidTransitionError so callers can decide whether to retry, swallow, or
 * propagate. This is what makes optimistic-concurrency safety legible:
 *
 *   InvalidTransitionError = "the state machine says no"
 *   ConcurrentTransitionError = "the state machine said yes, but you lost a race"
 *
 * Round 12: introduced when transitionProject moved from
 *   SELECT → JS check → UPDATE
 * to
 *   buildTransitionPlan → UPDATE WHERE status = $expectedFrom
 * to close a 1-2 year old race between deploy-worker and reconciler that
 * could produce nonsense state transitions like deploying → live (skipping
 * deployed/ssl_provisioning/canary_check) when the reconciler beat the
 * worker to the UPDATE.
 */
export class ConcurrentTransitionError extends Error {
  constructor(
    public expectedFrom: ProjectStatus,
    public to: ProjectStatus,
    public actualState: ProjectStatus,
  ) {
    super(
      `Concurrent state transition: expected from=${expectedFrom} → ${to}, ` +
        `but row was already in state=${actualState} (another writer beat us)`,
    );
    this.name = 'ConcurrentTransitionError';
  }
}

/**
 * Pure planner for what transitionProject should DO at the SQL level.
 * Separated from the IO so the decision logic is testable without a DB.
 *
 * Three outcomes:
 *
 *   1. `idempotent-noop` — currentState === toState AND that target is one
 *      of the rules-defined idempotent self-transitions (currently only
 *      `live → live`, the round-9-era reconciler-race tolerance pattern).
 *      Caller should NOT issue an UPDATE and should NOT write an audit row;
 *      it's a no-op repeat of an already-applied transition.
 *
 *   2. `allowed` — rules permit currentState → toState. Caller issues an
 *      `UPDATE ... WHERE status = $expectedFromState` and is responsible for
 *      handling the case where rowCount === 0 (concurrent writer beat us).
 *
 *   3. `rejected` — rules forbid currentState → toState. Caller throws
 *      `InvalidTransitionError`. The reason string preserves the historical
 *      `"Invalid state transition: X → Y"` format so existing string-match
 *      catches in callers (e.g. deploy-worker.ts) keep working.
 */
export type TransitionPlan =
  | { kind: 'idempotent-noop' }
  | { kind: 'allowed'; expectedFromState: ProjectStatus }
  | { kind: 'rejected'; reason: string };

export function buildTransitionPlan(input: {
  currentState: ProjectStatus;
  toState: ProjectStatus;
}): TransitionPlan {
  const { currentState, toState } = input;

  // Idempotent self-transition: only `live → live` qualifies. We treat it as
  // a noop because the reconciler-vs-worker race produces this case (both
  // try to push to live; the loser sees status === 'live' already and
  // shouldn't write a duplicate audit row that would suggest a fresh
  // transition happened).
  if (currentState === toState && currentState === 'live') {
    return { kind: 'idempotent-noop' };
  }

  if (canTransition(currentState, toState)) {
    return { kind: 'allowed', expectedFromState: currentState };
  }

  return {
    kind: 'rejected',
    reason: `Invalid state transition: ${currentState} → ${toState}`,
  };
}
