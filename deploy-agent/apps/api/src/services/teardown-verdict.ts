/**
 * Project teardown verdict — what should DELETE /api/projects/:id (and the
 * mirror routine in project-groups.ts) actually do, and how should it report
 * what happened?
 *
 * Why this is its own file:
 *   The route does up to six writes against five different systems with no
 *   transaction:
 *     1. Cloud Run service delete (per deployment)
 *     2. Cloud Run domain mapping delete (per deployment with customDomain)
 *     3. Cloudflare DNS record delete (per deployment with customDomain)
 *     4. Artifact Registry container image delete (one per project)
 *     5. Redis allocation release (project_redis_allocations row)
 *     6. Postgres CASCADE delete of the project row (deployments,
 *        scan_reports, reviews, state_transitions all go too)
 *
 *   Pre-round-15, the route did `await deleteProjectFromDb(project.id)` at
 *   the end UNCONDITIONALLY, regardless of whether any of steps 1-4 errored.
 *   Step 5 (Redis release) was never called at all — `releaseProjectRedis`
 *   exists in redis-provisioner.ts:116 but was orphan code, and
 *   `project_redis_allocations` has NO FK CASCADE to projects (just
 *   `project_id UUID PRIMARY KEY`). So:
 *
 *     - On any GCP step failure: route returns `{ success: true, teardownLog: [...with errors] }`,
 *       the DB row + all audit trail get CASCADE-deleted, but the GCP service
 *       / domain mapping / Cloudflare CNAME / Artifact Registry image stay
 *       behind. Permanent billed orphans the operator now cannot find via
 *       the dashboard (no DB row to look up).
 *
 *     - The Redis allocation row ALWAYS leaks because nobody calls
 *       releaseProjectRedis. Eventually project_redis_allocations grows
 *       and the db_index allocator runs out of free slots.
 *
 *   Operator's natural recovery: rebuild the project with the same slug.
 *   Result: Cloud Run name collision (409), Artifact Registry image tag
 *   already exists, Cloudflare CNAME already taken, and zero audit trail
 *   to debug from. This is exactly the user-flow a one-person founder hits
 *   most often when iterating on a vibe-coded site.
 *
 *   The fix: capture each step's outcome in a structured array, classify
 *   the whole into a discriminated verdict, and the route refuses to
 *   touch the DB if any orphan exists. Operator gets a 500 with
 *   `errorCode: 'project_teardown_orphans'` + the orphan list, so they
 *   can clean up in the GCP console and retry the DELETE — with the DB
 *   row + audit trail still intact.
 */

export type TeardownStepKind =
  | 'cloud_run_service'
  | 'domain_mapping'
  | 'cloudflare_dns'
  | 'container_image'
  | 'redis_allocation';

export interface TeardownStepOutcome {
  kind: TeardownStepKind;
  /** Human-readable identifier for the resource (service name, domain, image slug, db_index, etc.) */
  reference: string;
  /** True iff the resource is now confirmed gone (delete OK, or was already gone). */
  ok: boolean;
  /** True iff the API returned 404 / not-found — idempotent success. */
  alreadyGone?: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

/**
 * Structured log entry mirror of TeardownStepOutcome — what the operator
 * sees in the response. Keeps the legacy shape `{ step, status, error? }`
 * so existing dashboard rendering doesn't break.
 */
export interface TeardownLogEntry {
  step: string;
  status: 'ok' | 'error';
  error?: string;
}

export function outcomeToLogEntry(o: TeardownStepOutcome): TeardownLogEntry {
  const action =
    o.kind === 'cloud_run_service' ? 'Delete Cloud Run service'
    : o.kind === 'domain_mapping' ? 'Delete domain mapping'
    : o.kind === 'cloudflare_dns' ? 'Delete DNS'
    : o.kind === 'container_image' ? 'Delete container image'
    : 'Release Redis allocation';
  const suffix = o.alreadyGone ? ' (already gone)' : '';
  if (o.ok) {
    return { step: `${action}: ${o.reference}${suffix}`, status: 'ok' };
  }
  return { step: `${action}: ${o.reference}`, status: 'error', error: o.error ?? 'unknown' };
}

/**
 * Three verdict kinds:
 *
 *   1. `nothing-to-delete` — project had no deployments and no allocations.
 *      DB delete is safe, no orphans possible.
 *
 *   2. `clean-teardown` — every attempted GCP step succeeded (or was
 *      already-gone). Safe to call deleteProjectFromDb and return 200.
 *
 *   3. `partial-orphans` — at least one GCP step failed. The DB delete
 *      MUST be skipped to preserve audit trail. Route returns 500 with
 *      `errorCode: 'project_teardown_orphans'` + the orphan reference list
 *      so the operator knows exactly what's still alive in GCP and can
 *      clean it up manually before retrying the delete. CRITICAL log level.
 */
export type TeardownVerdict =
  | { kind: 'nothing-to-delete'; logLevel: 'info' }
  | {
      kind: 'clean-teardown';
      logLevel: 'info';
      successfulSteps: TeardownStepOutcome[];
    }
  | {
      kind: 'partial-orphans';
      logLevel: 'critical';
      orphans: TeardownStepOutcome[];
      successfulSteps: TeardownStepOutcome[];
      errorCode: 'project_teardown_orphans';
      requiresManualCleanup: true;
    };

export function buildTeardownVerdict(outcomes: TeardownStepOutcome[]): TeardownVerdict {
  if (outcomes.length === 0) {
    return { kind: 'nothing-to-delete', logLevel: 'info' };
  }
  const orphans = outcomes.filter((o) => !o.ok);
  const successfulSteps = outcomes.filter((o) => o.ok);
  if (orphans.length === 0) {
    return { kind: 'clean-teardown', logLevel: 'info', successfulSteps };
  }
  return {
    kind: 'partial-orphans',
    logLevel: 'critical',
    orphans,
    successfulSteps,
    errorCode: 'project_teardown_orphans',
    requiresManualCleanup: true,
  };
}
