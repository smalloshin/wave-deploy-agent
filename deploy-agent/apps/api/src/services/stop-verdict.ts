/**
 * Stop-flow verdict logic — what should stopProjectService report after
 * the (deleteService, updateDeployment, transitionProject) sequence
 * completes (or short-circuits on a critical failure)?
 *
 * Why this is its own file:
 *   The stop flow has three IO calls that can each fail independently.
 *   Pre-round-13, stopProjectService treated `deleteService` as
 *   infallible (its return type was void; errors went to console.error
 *   only) and wrapped the transition in `try { } catch { }` that swallowed
 *   ANY error including DB outages. The result: when the GCP DELETE
 *   failed, the function continued to write `cloudRunUrl=''` to the DB,
 *   leaving live Cloud Run services orphaned and the DB describing a
 *   stopped project. When the GCP DELETE succeeded but the DB write
 *   failed, the project sat in `live` state with metadata describing a
 *   service that was already gone — the round-10 reconciler's split
 *   detection couldn't recover it (nothing alive to reconcile against).
 *
 *   Round 13 makes the decision logic explicit + testable, and the
 *   orchestrator becomes a thin step-by-step caller that builds a verdict
 *   at the end. The verdict tells the caller (a) what log level to use,
 *   (b) what to return to the operator, and (c) whether to halt before
 *   downstream side effects.
 */

export interface DeleteOutcome {
  /** True iff the service is now confirmed gone (HTTP 2xx or 404). */
  ok: boolean;
  /** True if GCP returned 404 — service was already gone. Idempotent stop. */
  alreadyGone: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

export interface DbWriteOutcome {
  /** True iff the DB UPDATE succeeded. Null if not attempted (delete failed). */
  ok: boolean;
  /** Error message when ok=false. Null otherwise. */
  error: string | null;
}

export interface TransitionOutcome {
  /** True iff transitionProject succeeded. Null if not attempted. */
  ok: boolean;
  /** Error name (InvalidTransitionError, ConcurrentTransitionError, or other). */
  errorName: string | null;
  /** Error message. */
  error: string | null;
}

/**
 * Five outcomes:
 *
 *   1. `clean-stop` — delete OK, DB OK, transition OK. Happy path.
 *
 *   2. `clean-stop-already-gone` — GCP returned 404 (someone deleted the
 *      service out from under us, or this is a re-stop). DB was still
 *      written, project still transitioned. Idempotent — log info, no alarm.
 *
 *   3. `partial-gcp-failed` — DELETE returned non-2xx-non-404. CRITICAL.
 *      Caller MUST NOT proceed with DB updates: writing cloudRunUrl='' to
 *      DB while the service is still alive (or in unknown state) is
 *      exactly the lying-state bug round 13 is fixing. Operator gets a
 *      precise error saying GCP delete failed; service may still be alive.
 *
 *   4. `partial-db-mismatch` — DELETE OK but DB write failed. CRITICAL.
 *      The service is GONE but DB still claims it's live. Operator must
 *      reconcile manually (today round-10's reconciler doesn't catch this
 *      because it relies on Cloud Run being there to inspect — there is
 *      nothing to inspect). Log spells out the trapped state.
 *
 *   5. `partial-transition-failed` — DELETE OK + DB OK but transition
 *      failed for a non-state-machine reason (DB outage between writes,
 *      etc.). Less critical than 4 (DB row says deployment offline; only
 *      `projects.status` is stale) but still warn-worthy. State-machine
 *      rejections (InvalidTransitionError, ConcurrentTransitionError) are
 *      classified as `clean-stop-transition-skipped` because they are
 *      EXPECTED in this flow — operator may be stopping a project
 *      already in `failed` or `stopped`, which is an allowed no-op intent.
 */
export type StopVerdict =
  | { kind: 'clean-stop'; logLevel: 'info'; serviceName: string; message: string }
  | { kind: 'clean-stop-already-gone'; logLevel: 'info'; serviceName: string; message: string }
  | { kind: 'clean-stop-transition-skipped'; logLevel: 'info'; serviceName: string; transitionErrorName: string; message: string }
  | { kind: 'partial-gcp-failed'; logLevel: 'critical'; serviceName: string; gcpError: string; message: string }
  | { kind: 'partial-db-mismatch'; logLevel: 'critical'; serviceName: string; dbError: string; message: string }
  | { kind: 'partial-transition-failed'; logLevel: 'warn'; serviceName: string; transitionError: string; message: string };

/**
 * Pure planner. Takes the outcomes of the three IO steps (any of which
 * may be `null` if that step was skipped due to an earlier failure) and
 * returns the verdict.
 *
 * Short-circuit rules the caller MUST follow:
 *   - If delete.ok is false (and not alreadyGone), DO NOT call
 *     updateDeployment or transitionProject. Pass null for those outcomes.
 *   - If db.ok is false, DO NOT call transitionProject. Pass null.
 *   - These are enforced by the planner: if you violate them you'll get
 *     a verdict that doesn't match reality, but the planner won't crash.
 */
export function buildStopVerdict(input: {
  serviceName: string;
  delete: DeleteOutcome;
  db: DbWriteOutcome | null;
  transition: TransitionOutcome | null;
}): StopVerdict {
  const { serviceName } = input;

  // Critical: GCP delete failed (and wasn't already-gone).
  if (!input.delete.ok) {
    return {
      kind: 'partial-gcp-failed',
      logLevel: 'critical',
      serviceName,
      gcpError: input.delete.error ?? 'unknown GCP error',
      message:
        `Stop FAILED for ${serviceName}: Cloud Run DELETE did not succeed. ` +
        `Service may still be live. DB was NOT updated to avoid lying-state. ` +
        `Operator must manually verify GCP state and retry.`,
    };
  }

  // Critical: GCP delete OK but DB write failed.
  if (input.db && !input.db.ok) {
    return {
      kind: 'partial-db-mismatch',
      logLevel: 'critical',
      serviceName,
      dbError: input.db.error ?? 'unknown DB error',
      message:
        `Stop PARTIAL for ${serviceName}: Cloud Run service is DELETED but ` +
        `DB updateDeployment failed. Project DB row still claims service is live ` +
        `(cloudRunUrl, healthStatus). Reconciler cannot auto-fix because there is ` +
        `no Cloud Run service to inspect. Operator must manually update DB.`,
    };
  }

  // Transition step (only reached if delete + db both ok).
  if (input.transition && !input.transition.ok) {
    const isStateMachineRejection =
      input.transition.errorName === 'InvalidTransitionError' ||
      input.transition.errorName === 'ConcurrentTransitionError';
    if (isStateMachineRejection) {
      // Expected: project was already in `failed` or `stopped`, or
      // a concurrent writer beat us. Stop intent is satisfied; the
      // service is gone, the DB knows it, the project status is
      // whatever the operator wanted. No alarm.
      return {
        kind: 'clean-stop-transition-skipped',
        logLevel: 'info',
        serviceName,
        transitionErrorName: input.transition.errorName ?? 'unknown',
        message:
          `Stopped ${serviceName} (state-machine transition skipped: ` +
          `${input.transition.errorName} — project already in compatible state)`,
      };
    }
    // Non-state-machine error (DB outage between writes, etc.) is a real
    // partial failure: deployment row reflects offline but project.status
    // is stale.
    return {
      kind: 'partial-transition-failed',
      logLevel: 'warn',
      serviceName,
      transitionError: input.transition.error ?? 'unknown transition error',
      message:
        `Stopped ${serviceName} but project state transition failed ` +
        `(non-state-machine error). Deployment row shows offline; ` +
        `projects.status may be stale.`,
    };
  }

  // Clean stop. Differentiate already-gone for log clarity.
  if (input.delete.alreadyGone) {
    return {
      kind: 'clean-stop-already-gone',
      logLevel: 'info',
      serviceName,
      message: `Stopped ${serviceName} (Cloud Run service was already deleted; DB cleaned up)`,
    };
  }
  return {
    kind: 'clean-stop',
    logLevel: 'info',
    serviceName,
    message: `Stopped ${serviceName} (image kept in Artifact Registry for restart)`,
  };
}

/**
 * For the route layer: map a verdict to an HTTP-shaped result. We don't
 * use HTTP status codes here (the lifecycle is internal), but we do
 * carry `success: boolean` for the existing LifecycleResult contract.
 */
export function verdictToLifecycleResult(verdict: StopVerdict): {
  success: boolean;
  message: string;
  serviceName: string;
} {
  switch (verdict.kind) {
    case 'clean-stop':
    case 'clean-stop-already-gone':
    case 'clean-stop-transition-skipped':
      return { success: true, message: verdict.message, serviceName: verdict.serviceName };
    case 'partial-transition-failed':
      // Soft failure: stop intent mostly succeeded. Return success=true
      // with a warning message so dashboard doesn't show red X for what
      // is really "service stopped, but state row is a bit stale."
      return { success: true, message: verdict.message, serviceName: verdict.serviceName };
    case 'partial-gcp-failed':
    case 'partial-db-mismatch':
      return { success: false, message: verdict.message, serviceName: verdict.serviceName };
  }
}
