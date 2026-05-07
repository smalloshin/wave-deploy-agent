/**
 * R57.2 (2026-05-07): periodic cleanup for `wave_deploy_migrations` rows.
 *
 * Two responsibilities:
 *
 *   1. **TTL sweep**: rows stuck in `status='running'` past their
 *      `expires_at` (15 min default per R57) get flipped to
 *      `status='expired'`. This reclaims the unique partial index slot
 *      `(project_id) WHERE status='running'` so the next deploy can
 *      acquire a row. Without this, a worker crash mid-migration
 *      blocks all future deploys for that project until manual
 *      intervention.
 *
 *   2. **Audit retention**: rows older than 30 days (default) are
 *      deleted. Migration audit log is for debugging recent deploys,
 *      not long-term compliance — Cloud Logging keeps raw logs
 *      separately.
 *
 * Caller (reconciler tick) controls cadence — typically called once
 * per hour rather than every 2-minute tick to keep DB load minimal.
 *
 * Pure-ish: takes a `query` function as input so the function itself
 * has no module-level DB import. Easier to test + drop-in for
 * different DB clients.
 */

export interface CleanupResult {
  /** Rows transitioned from `running` → `expired` because they passed the TTL. */
  expiredSweeped: number;
  /** Rows deleted because they are older than the retention window. */
  rowsDeleted: number;
  /** Optional human-readable summary; populated only on non-empty work. */
  summary: string;
}

export interface CleanupOptions {
  /**
   * Days of audit-log retention. Rows older than this are deleted.
   * Default 30. Set to 0 to disable deletion (sweep-only mode).
   */
  retentionDays?: number;
}

export type DbQueryFn = (
  text: string,
  params?: unknown[],
) => Promise<{ rowCount: number | null }>;

/**
 * Run one cleanup pass against the `wave_deploy_migrations` table.
 * Safe to call from a periodic tick; never throws — any DB error is
 * caught and reported via the returned `summary`.
 */
export async function cleanupMigrationRows(
  query: DbQueryFn,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const retentionDays = options.retentionDays ?? 30;

  let expiredSweeped = 0;
  let rowsDeleted = 0;

  // Step 1: TTL sweep — mark stale `running` rows as `expired`.
  // The `expires_at` column defaults to NOW() + 15 min when the row is
  // claimed; if a worker crashed without updating finished_at, the row
  // sits in 'running' forever and blocks future deploys via the unique
  // partial index. Sweep flips status so the index slot frees up.
  try {
    const sweepRes = await query(
      `UPDATE wave_deploy_migrations
       SET status = 'expired',
           finished_at = NOW(),
           error_message = COALESCE(error_message, 'expired by TTL sweep — worker did not finish within expires_at')
       WHERE status = 'running'
         AND expires_at < NOW()`,
    );
    expiredSweeped = sweepRes.rowCount ?? 0;
  } catch (err) {
    return {
      expiredSweeped,
      rowsDeleted,
      summary: `TTL sweep failed (non-fatal): ${(err as Error).message}`,
    };
  }

  // Step 2: retention delete (if enabled).
  if (retentionDays > 0) {
    try {
      const deleteRes = await query(
        `DELETE FROM wave_deploy_migrations
         WHERE created_at < NOW() - ($1 || ' days')::interval
           AND status != 'running'`,
        [String(retentionDays)],
      );
      rowsDeleted = deleteRes.rowCount ?? 0;
    } catch (err) {
      return {
        expiredSweeped,
        rowsDeleted,
        summary: `retention delete failed (non-fatal): ${(err as Error).message}`,
      };
    }
  }

  return {
    expiredSweeped,
    rowsDeleted,
    summary:
      expiredSweeped + rowsDeleted === 0
        ? 'no work — table is clean'
        : `swept ${expiredSweeped} stale running row(s), deleted ${rowsDeleted} row(s) older than ${retentionDays} days`,
  };
}
