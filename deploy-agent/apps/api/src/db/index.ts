import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 0,       // Don't kill idle connections (pipeline worker has long gaps between queries)
  connectionTimeoutMillis: 10000,
  keepAlive: true,             // Send TCP keepalive to prevent Cloud SQL proxy from dropping idle connections
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

export { pool };

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.slice(0, 100));
  }
  return result;
}

export async function getOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

/**
 * Run a unit of work inside a single Postgres transaction.
 *
 * Why this exists:
 *   Several mutations in this app touch multiple tables that must agree —
 *   the canonical example is publishDeployment() in orchestrator.ts, which
 *   does:
 *     1. UPDATE deployments SET is_published = false WHERE ...
 *     2. UPDATE deployments SET is_published = true WHERE id = $newId
 *     3. UPDATE projects SET published_deployment_id = $newId
 *   If step 2 throws, ALL deployments end up unpublished. If step 3 throws,
 *   the deployments table says one thing but the project pointer says
 *   another. Both leave the system serving traffic the UI can't explain.
 *
 *   Without a transaction wrapper every caller would have to BEGIN/COMMIT/
 *   ROLLBACK by hand on a checked-out client, which is easy to get wrong
 *   (forgetting release on error, double-COMMIT after ROLLBACK, etc.).
 *
 * Contract:
 *   - The callback receives a `pg.PoolClient` checked out from the pool.
 *     Run all the queries on THAT client (not the module-level pool) so
 *     they share the same transaction.
 *   - If the callback resolves, COMMIT. If it throws, ROLLBACK and re-throw
 *     the original error.
 *   - The client is always released back to the pool, even on ROLLBACK
 *     failure (which is logged but doesn't mask the original error).
 *
 * What this is NOT:
 *   - Not a savepoint helper. Nested calls don't nest — the inner one will
 *     fail with "current transaction is aborted" if the outer ROLLBACKs.
 *   - Not a retry layer. Serialization conflicts (rare here, single-instance
 *     API) bubble up to the caller.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // ROLLBACK failure is rare (means the connection itself is broken) but
    // we don't want it to mask the original error — log and re-throw the
    // ORIGINAL.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error(
        '[db] ROLLBACK failed after transaction error:',
        (rollbackErr as Error).message,
      );
    }
    throw err;
  } finally {
    client.release();
  }
}
