/**
 * Redis Provisioner — allocates per-project logical Redis databases on the
 * shared Redis instance.
 *
 * Architecture:
 *   A single long-running Redis instance (shared-redis) is hosted on a GCE
 *   e2-micro VM or an external provider (Upstash). Each project gets a unique
 *   logical DB index (0-15) and a derived key namespace prefix, giving soft
 *   isolation without the overhead of per-project instances.
 *
 * Configuration (env vars on the API service):
 *   SHARED_REDIS_HOST       — e.g. "10.128.0.5" (internal IP of Redis VM)
 *   SHARED_REDIS_PORT       — default 6379
 *   SHARED_REDIS_PASSWORD   — optional auth password
 *
 * The returned REDIS_URL is injected into the deployed Cloud Run service's
 * env vars so the app can connect without any user configuration.
 */

import { query } from '../db/index';

export interface RedisProvisionResult {
  /** Full connection URL (includes logical DB index) */
  redisUrl: string;
  /** Key prefix the app should use for namespacing (defense-in-depth) */
  keyPrefix: string;
  /** Logical database index (0-15) allocated to this project */
  dbIndex: number;
  /** true if newly allocated, false if reusing existing allocation */
  created: boolean;
  /** Provider description for logs/UI */
  providerInfo: string;
}

/**
 * Provision (or look up) a Redis logical DB allocation for a project.
 * Idempotent: if an allocation already exists, return it unchanged.
 */
export async function provisionProjectRedis(
  projectId: string,
  projectSlug: string,
): Promise<RedisProvisionResult> {
  const host = process.env.SHARED_REDIS_HOST;
  const port = process.env.SHARED_REDIS_PORT ?? '6379';
  const password = process.env.SHARED_REDIS_PASSWORD ?? '';

  if (!host) {
    throw new Error(
      'SHARED_REDIS_HOST not configured — Redis auto-provisioning unavailable. ' +
      'Set SHARED_REDIS_HOST on the deploy-agent service to enable.',
    );
  }

  await ensureAllocationTable();

  // 1. Check for existing allocation for this project
  const existing = await query(
    `SELECT db_index, key_prefix FROM project_redis_allocations WHERE project_id = $1`,
    [projectId],
  );

  let dbIndex: number;
  let keyPrefix: string;
  let created = false;

  if (existing.rows.length > 0) {
    dbIndex = existing.rows[0].db_index;
    keyPrefix = existing.rows[0].key_prefix;
    console.log(`[Redis] Reusing allocation: project ${projectSlug} → db${dbIndex}`);
  } else {
    // 2. Find next available DB index (0-15 for standard Redis)
    const used = await query(`SELECT db_index FROM project_redis_allocations ORDER BY db_index`);
    const usedSet = new Set(used.rows.map((r) => r.db_index as number));

    dbIndex = -1;
    for (let i = 0; i < 16; i++) {
      if (!usedSet.has(i)) {
        dbIndex = i;
        break;
      }
    }

    if (dbIndex === -1) {
      // All 16 logical DBs taken — fall back to sharing db 0 with namespaced keys
      dbIndex = 0;
      console.warn('[Redis] All 16 logical DBs allocated, sharing db 0 with namespace');
    }

    keyPrefix = `proj:${projectSlug}:`;

    await query(
      `INSERT INTO project_redis_allocations (project_id, project_slug, db_index, key_prefix)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE SET db_index = $3, key_prefix = $4`,
      [projectId, projectSlug, dbIndex, keyPrefix],
    );

    created = true;
    console.log(`[Redis] Allocated: project ${projectSlug} → db${dbIndex} (prefix=${keyPrefix})`);
  }

  // 3. Build connection URL
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  const redisUrl = `redis://${auth}${host}:${port}/${dbIndex}`;

  return {
    redisUrl,
    keyPrefix,
    dbIndex,
    created,
    providerInfo: `shared-redis@${host}:${port} db${dbIndex}`,
  };
}

/** Release a project's Redis allocation (on project delete). */
export async function releaseProjectRedis(projectId: string): Promise<void> {
  await query(`DELETE FROM project_redis_allocations WHERE project_id = $1`, [projectId]);
  console.log(`[Redis] Released allocation for project ${projectId}`);
}

async function ensureAllocationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS project_redis_allocations (
      project_id UUID PRIMARY KEY,
      project_slug VARCHAR(100) NOT NULL,
      db_index INTEGER NOT NULL,
      key_prefix VARCHAR(200) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
