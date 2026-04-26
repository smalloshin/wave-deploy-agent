/**
 * Post-canary decision logic — what state should a project go to after the
 * canary check completes (or after an attempted rollback)?
 *
 * Why this is its own file:
 *   The deploy-worker pipeline is huge and full of IO. The decision here is
 *   small but critical (got it wrong before round 11 — see below) and the
 *   only way to test it cleanly is to keep it pure. Inputs are facts;
 *   outputs are intents. The orchestrator does the IO + state writes.
 *
 * The bug round 11 fixes:
 *   Before round 11, when canary failed AND auto-rollback failed, deploy-worker
 *   transitioned the project to `live` anyway with a "rollback failed" log.
 *   The user dashboard said "live" while Cloud Run was serving 100% traffic on
 *   the broken version. Worse: round 10's reconciler would happily auto-publish
 *   the broken revision in DB to "fix" the split, making it permanent.
 *
 *   The fix: when rollback fails, project goes to `failed`, deployment marked
 *   unhealthy, operator gets a CRITICAL log + Discord notification with the
 *   trapped state spelled out (which version is serving, which version we
 *   tried to roll back to). Operator must intervene; the reconciler now sees
 *   `failed` (not `live`) and stays out of the way (round 10 only scans `live`).
 */

import type { ProjectStatus } from '@deploy-agent/shared';

export interface CanaryOutcome {
  /** Did the canary check pass? */
  passed: boolean;
  /** Pre-formatted human-readable list of failed checks (empty when passed). */
  failedChecks: string;
}

export interface RollbackOutcome {
  /** True if there was a previous version to roll back to. */
  attempted: boolean;
  /** True if attempted AND publishRevision returned success. */
  success: boolean;
  /** Error message from publishRevision when attempted+failed. */
  error: string | null;
  /** Version number we rolled back TO (regardless of success). Null when not attempted. */
  targetVersion: number | null;
}

export type PostCanaryVerdict =
  | {
      kind: 'live-clean';
      autoPublishNewVersion: boolean;
      logLevel: 'info';
    }
  | {
      kind: 'live-canary-warning-no-rollback-target';
      // First deploy: canary failed but there's no previous version to roll back to.
      // We go live with the failed-canary version anyway (better than nothing live).
      autoPublishNewVersion: boolean;
      logLevel: 'warn';
    }
  | {
      kind: 'live-rolled-back';
      // Canary failed but rollback succeeded; previous version is serving.
      // Don't publish the new (failed) version in DB.
      rolledBackToVersion: number;
      logLevel: 'warn';
    }
  | {
      kind: 'failed-rollback-failed';
      // Canary failed AND rollback failed. Cloud Run still on bad version.
      // Operator MUST intervene. Don't go live, don't auto-publish.
      failedVersion: number;
      intendedRollbackVersion: number;
      rollbackError: string;
      logLevel: 'critical';
    };

/**
 * Pure decision function. Given the canary outcome, the rollback attempt
 * outcome, the new deployment's version, and whether deploys are locked,
 * return the verdict for what the orchestrator should do next.
 */
export function decidePostCanaryAction(input: {
  canary: CanaryOutcome;
  rollback: RollbackOutcome;
  newVersion: number;
  isDeployLocked: boolean;
}): PostCanaryVerdict {
  const { canary, rollback, isDeployLocked } = input;

  // Happy path: canary passed.
  if (canary.passed) {
    return {
      kind: 'live-clean',
      autoPublishNewVersion: !isDeployLocked,
      logLevel: 'info',
    };
  }

  // Canary failed.
  if (!rollback.attempted) {
    // No previous version exists (first deploy with failing canary).
    // Going live with warning is the established product decision.
    return {
      kind: 'live-canary-warning-no-rollback-target',
      autoPublishNewVersion: !isDeployLocked,
      logLevel: 'warn',
    };
  }

  if (rollback.success && rollback.targetVersion !== null) {
    return {
      kind: 'live-rolled-back',
      rolledBackToVersion: rollback.targetVersion,
      logLevel: 'warn',
    };
  }

  // Rollback was attempted but failed. CRITICAL — Cloud Run is on the bad
  // version and our automated recovery did not work.
  return {
    kind: 'failed-rollback-failed',
    failedVersion: input.newVersion,
    intendedRollbackVersion: rollback.targetVersion ?? -1,
    rollbackError: rollback.error ?? 'unknown rollback error',
    logLevel: 'critical',
  };
}

/**
 * Map a verdict to the project state transition the orchestrator should make.
 * Centralized here so the deploy-worker can't accidentally pick the wrong one
 * on a future refactor.
 */
export function verdictToTargetState(verdict: PostCanaryVerdict): ProjectStatus {
  switch (verdict.kind) {
    case 'live-clean':
    case 'live-canary-warning-no-rollback-target':
    case 'live-rolled-back':
      return 'live';
    case 'failed-rollback-failed':
      return 'failed';
  }
}
