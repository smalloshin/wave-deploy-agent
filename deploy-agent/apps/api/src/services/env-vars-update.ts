/**
 * Env-vars update planning + verdict — what should the PATCH /env-vars
 * route do, and how should it report what happened?
 *
 * Why this is its own file:
 *   The route does two writes against different systems with no atomicity:
 *     1. updateServiceEnvVars(...) mutates Cloud Run (creates a new revision).
 *     2. updateProjectConfig(...) writes the merged values to projects.config.
 *
 *   Pre-round-14, on a step-2 failure (DB outage, JSONB serialization quirk,
 *   project deleted between reads) the route returned 500 with a generic
 *   error message. The operator's natural reaction — refresh the dashboard
 *   and re-edit — is exactly wrong: the dashboard's display is now stale
 *   (still showing pre-PATCH values from the cached project.config) while
 *   Cloud Run has the new values. Re-editing using the stale display can
 *   silently revert the operator's intended change. Pure "DB lies vs
 *   reality" pattern (rounds 9, 10, 13).
 *
 *   The fix: pure functions that (a) compute the merge + diff up-front so
 *   the route can talk about what changed, and (b) classify the
 *   (cloud-run, db) outcomes into a discriminated verdict the route can
 *   surface to the dashboard with a machine-readable code, so the
 *   dashboard knows to refuse showing DB-stale values and instead read
 *   live from Cloud Run via the existing GET /env-vars handler (which
 *   already prefers the live read — see projects.ts:1559).
 */

export interface EnvVarsUpdatePlan {
  /** Merged map: existing ⊕ patch (patch wins on key collision). */
  merged: Record<string, string>;
  /** Keys whose values differ from existing (or are new). */
  changed: string[];
  /** Keys present in existing that the patch explicitly nulled out (value set to ''). */
  cleared: string[];
  /** Keys present in patch with the same value as existing — noop. */
  unchanged: string[];
}

/**
 * Pure planner. Computes the merge and the diff so the route can log
 * exactly what changed and the verdict can surface affected keys.
 *
 * Note: we DON'T support key removal here (no way to express "delete this
 * key" in the request shape). To clear a value, the operator sets it to
 * empty string. That's tracked separately as `cleared` for log clarity
 * (operator may have meant to type something but slipped on Enter).
 */
export function planEnvVarsUpdate(
  existing: Record<string, string>,
  patch: Record<string, string>,
): EnvVarsUpdatePlan {
  const merged = { ...existing, ...patch };
  const changed: string[] = [];
  const cleared: string[] = [];
  const unchanged: string[] = [];

  for (const [key, newVal] of Object.entries(patch)) {
    const oldVal = existing[key];
    if (oldVal === undefined) {
      // New key
      if (newVal === '') {
        // Operator added a key with empty value. Probably typo; surface.
        cleared.push(key);
      } else {
        changed.push(key);
      }
      continue;
    }
    if (oldVal === newVal) {
      unchanged.push(key);
      continue;
    }
    // Existing key, value differs
    if (newVal === '' && oldVal !== '') {
      cleared.push(key);
    } else {
      changed.push(key);
    }
  }

  return { merged, changed, cleared, unchanged };
}

export interface CloudRunUpdateOutcome {
  /** True iff updateServiceEnvVars returned success. */
  success: boolean;
  /** Error message when success=false. */
  error: string | null;
}

export interface DbUpdateOutcome {
  /** True iff updateProjectConfig returned without throwing. Null = not attempted. */
  ok: boolean;
  error: string | null;
}

/**
 * Five verdict kinds matching the (cloudRun, db) outcome lattice:
 *
 *   1. `success` — both writes succeeded. Dashboard can trust DB.
 *
 *   2. `success-noop` — plan had nothing to do (no changes, no clears).
 *      We did NOT call Cloud Run or DB. Idempotent re-PATCH from a
 *      dashboard with stale state, for example.
 *
 *   3. `cloud-run-failed` — Cloud Run PATCH failed. We did NOT touch DB.
 *      Operator can retry safely; nothing has diverged.
 *
 *   4. `db-failed-after-cloud-run` — Cloud Run is updated, DB write
 *      failed. THIS IS THE ROUND-14 FIX TARGET. CRITICAL. Carries:
 *        - cloudRunValues: what Cloud Run is now serving (operator
 *          source of truth)
 *        - dbError: why the DB write failed
 *        - requiresManualReconcile: true (always)
 *        - errorCode: 'env_vars_db_drift' so the dashboard can detect
 *          and switch to live-read mode automatically
 *
 *   5. `db-failed-with-cloud-run-failed-too` — both failed. Cleanup is
 *      already implicit: Cloud Run was rejected (no new revision), DB
 *      wasn't touched. Equivalent to `cloud-run-failed` for the operator
 *      but kept as a distinct kind for log clarity.
 */
export type EnvVarsUpdateVerdict =
  | { kind: 'success'; logLevel: 'info'; changed: string[]; cleared: string[] }
  | { kind: 'success-noop'; logLevel: 'info' }
  | { kind: 'cloud-run-failed'; logLevel: 'warn'; cloudRunError: string }
  | {
      kind: 'db-failed-after-cloud-run';
      logLevel: 'critical';
      cloudRunValues: Record<string, string>;
      dbError: string;
      requiresManualReconcile: true;
      errorCode: 'env_vars_db_drift';
      changed: string[];
      cleared: string[];
    }
  | { kind: 'db-failed-with-cloud-run-failed-too'; logLevel: 'warn'; cloudRunError: string; dbError: string };

export function interpretEnvVarsUpdateResult(input: {
  plan: EnvVarsUpdatePlan;
  cloudRun: CloudRunUpdateOutcome | null;
  db: DbUpdateOutcome | null;
}): EnvVarsUpdateVerdict {
  // Noop: nothing actually changed, neither call should have run.
  if (input.plan.changed.length === 0 && input.plan.cleared.length === 0) {
    return { kind: 'success-noop', logLevel: 'info' };
  }

  // Cloud Run not attempted? That shouldn't happen if plan had work, but
  // defensive: classify as cloud-run-failed with synthetic error.
  if (!input.cloudRun) {
    return { kind: 'cloud-run-failed', logLevel: 'warn', cloudRunError: 'cloud-run update not attempted' };
  }

  if (!input.cloudRun.success) {
    // Cloud Run rejected the PATCH. Did we attempt DB anyway?
    if (input.db && !input.db.ok) {
      return {
        kind: 'db-failed-with-cloud-run-failed-too',
        logLevel: 'warn',
        cloudRunError: input.cloudRun.error ?? 'unknown Cloud Run error',
        dbError: input.db.error ?? 'unknown DB error',
      };
    }
    return {
      kind: 'cloud-run-failed',
      logLevel: 'warn',
      cloudRunError: input.cloudRun.error ?? 'unknown Cloud Run error',
    };
  }

  // Cloud Run succeeded. DB phase determines the verdict.
  if (!input.db || !input.db.ok) {
    return {
      kind: 'db-failed-after-cloud-run',
      logLevel: 'critical',
      cloudRunValues: input.plan.merged,
      dbError: input.db?.error ?? 'db update not attempted',
      requiresManualReconcile: true,
      errorCode: 'env_vars_db_drift',
      changed: input.plan.changed,
      cleared: input.plan.cleared,
    };
  }

  return {
    kind: 'success',
    logLevel: 'info',
    changed: input.plan.changed,
    cleared: input.plan.cleared,
  };
}
