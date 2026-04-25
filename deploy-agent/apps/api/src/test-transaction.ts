/**
 * Tests: withTransaction (db/index.ts) + publishDeployment atomicity
 *
 * Two layers, like test-auth-cleanup:
 *
 * Unit (no DB needed) — driven by a fake pg.PoolClient that records query
 * calls and lets us inject failures at any step:
 *   - happy path runs BEGIN → fn → COMMIT, no ROLLBACK
 *   - thrown error inside fn runs BEGIN → fn → ROLLBACK, re-throws original
 *   - ROLLBACK failure logs but does NOT mask the original error
 *   - client is always released, even on COMMIT/ROLLBACK failure
 *
 * Integration (DB-gated, skip cleanly without DATABASE_URL) — uses the
 * real pool to verify publishDeployment is actually atomic:
 *   - happy path: 3 rows agree (deployments.is_published, projects.published_deployment_id)
 *   - if a forced post-COMMIT race were to happen, the assertions would
 *     catch it — but the realistic test we CAN do without simulating GCP
 *     is to verify that publishDeployment uses a single transaction and
 *     leaves the DB in a consistent state on success
 *
 * Run: tsx src/test-transaction.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { withTransaction, query, pool } from './db/index.js';
import {
  createProject,
  publishDeployment,
  getPublishedDeployment,
} from './services/orchestrator.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

async function dbAvailable(): Promise<boolean> {
  try {
    await query('SELECT 1', []);
    return true;
  } catch {
    return false;
  }
}

// ─── Fake client for unit tests ──────────────────────────────
// We can't unit-test the real pg.PoolClient without a DB, but we can fake
// just enough of it: a `query()` method that records calls and a `release()`
// method that we can assert on. The withTransaction helper only calls these
// two methods.

interface FakeClient {
  queries: string[];
  released: number;
  shouldFailQuery: string | null;
  query: (text: string) => Promise<unknown>;
  release: () => void;
}

function makeFakeClient(opts: { failQuery?: string } = {}): FakeClient {
  const c: FakeClient = {
    queries: [],
    released: 0,
    shouldFailQuery: opts.failQuery ?? null,
    async query(text: string) {
      c.queries.push(text);
      if (c.shouldFailQuery && text.includes(c.shouldFailQuery)) {
        throw new Error(`fake-client: forced fail on "${c.shouldFailQuery}"`);
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      c.released++;
    },
  };
  return c;
}

// Patch pool.connect for the duration of one unit test, restore after.
async function withFakePoolClient<T>(
  client: FakeClient,
  fn: () => Promise<T>,
): Promise<T> {
  const originalConnect = pool.connect.bind(pool);
  // pg.Pool.connect returns a PoolClient; the fake satisfies the surface
  // withTransaction uses (.query and .release).
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () =>
    client as unknown as pg.PoolClient;
  try {
    return await fn();
  } finally {
    (pool as unknown as { connect: typeof originalConnect }).connect = originalConnect;
  }
}

console.log('\n=== withTransaction unit tests ===\n');

await test('happy path: BEGIN → fn → COMMIT, no ROLLBACK, client released', async () => {
  const client = makeFakeClient();
  const result = await withFakePoolClient(client, async () => {
    return withTransaction(async (c) => {
      await c.query('SELECT 1');
      return 'ok';
    });
  });
  assert.equal(result, 'ok');
  assert.deepEqual(client.queries, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.equal(client.released, 1, 'client must be released exactly once');
});

await test('thrown error inside fn: BEGIN → fn → ROLLBACK, re-throws original', async () => {
  const client = makeFakeClient();
  const original = new Error('domain error');
  let caught: Error | null = null;
  await withFakePoolClient(client, async () => {
    try {
      await withTransaction(async () => {
        throw original;
      });
    } catch (err) {
      caught = err as Error;
    }
  });
  assert.equal(caught, original, 'original error should propagate');
  assert.deepEqual(client.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(client.released, 1);
});

await test('ROLLBACK failure does NOT mask original error', async () => {
  // The original error is what the user actually wants to see; a ROLLBACK
  // failure on top of it would be confusing. Verify we re-throw the original.
  const client = makeFakeClient({ failQuery: 'ROLLBACK' });
  const original = new Error('domain error');
  let caught: Error | null = null;

  // Suppress the expected ROLLBACK error log so test output stays clean
  const originalErr = console.error;
  console.error = () => {};

  await withFakePoolClient(client, async () => {
    try {
      await withTransaction(async () => {
        throw original;
      });
    } catch (err) {
      caught = err as Error;
    }
  });

  console.error = originalErr;

  assert.equal(caught, original, 'should still re-throw the ORIGINAL error');
  assert.equal(client.released, 1, 'client released even when ROLLBACK fails');
});

await test('client.release() is called even when COMMIT fails', async () => {
  const client = makeFakeClient({ failQuery: 'COMMIT' });
  let caught: Error | null = null;
  await withFakePoolClient(client, async () => {
    try {
      await withTransaction(async () => 'ok');
    } catch (err) {
      caught = err as Error;
    }
  });
  // COMMIT failed → caught in catch block → ROLLBACK attempted → client released
  assert.ok(caught, 'COMMIT failure should bubble');
  assert.equal(client.released, 1);
});

await test('multiple queries inside fn share the same client', async () => {
  const client = makeFakeClient();
  await withFakePoolClient(client, async () => {
    await withTransaction(async (c) => {
      await c.query('UPDATE foo SET x = 1');
      await c.query('UPDATE bar SET y = 2');
      await c.query('UPDATE baz SET z = 3');
    });
  });
  assert.deepEqual(client.queries, [
    'BEGIN',
    'UPDATE foo SET x = 1',
    'UPDATE bar SET y = 2',
    'UPDATE baz SET z = 3',
    'COMMIT',
  ]);
});

console.log('\n=== publishDeployment integration tests ===\n');

await test('publishDeployment leaves DB in consistent state on success', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    console.log('  SKIP  DATABASE_URL not set — integration test skipped');
    return;
  }

  // Create a project + two synthetic deployments
  const project = await createProject({
    name: `tx-test-${Date.now()}`,
    sourceType: 'upload',
  });

  const d1 = await query<{ id: string }>(
    `INSERT INTO deployments (project_id, version, status, is_published)
     VALUES ($1, 1, 'live', true) RETURNING id`,
    [project.id],
  );
  const d2 = await query<{ id: string }>(
    `INSERT INTO deployments (project_id, version, status, is_published)
     VALUES ($1, 2, 'live', false) RETURNING id`,
    [project.id],
  );

  // Publish d2 — should atomically: unpublish d1, mark d2 published, update project pointer
  await publishDeployment(project.id, d2.rows[0].id);

  // Verify all three pieces of state agree
  const d1After = await query<{ is_published: boolean }>(
    `SELECT is_published FROM deployments WHERE id = $1`,
    [d1.rows[0].id],
  );
  const d2After = await query<{ is_published: boolean; published_at: string | null }>(
    `SELECT is_published, published_at FROM deployments WHERE id = $1`,
    [d2.rows[0].id],
  );
  const projectAfter = await query<{ published_deployment_id: string | null }>(
    `SELECT published_deployment_id FROM projects WHERE id = $1`,
    [project.id],
  );

  assert.equal(d1After.rows[0].is_published, false, 'd1 should be unpublished');
  assert.equal(d2After.rows[0].is_published, true, 'd2 should be published');
  assert.ok(d2After.rows[0].published_at, 'd2 should have a published_at timestamp');
  assert.equal(
    projectAfter.rows[0].published_deployment_id,
    d2.rows[0].id,
    'project pointer should match d2',
  );

  // getPublishedDeployment should return d2 (consistency check via the read path)
  const fetched = await getPublishedDeployment(project.id);
  assert.equal(fetched?.id, d2.rows[0].id);

  // Cleanup
  await query(`DELETE FROM deployments WHERE project_id = $1`, [project.id]);
  await query(`DELETE FROM projects WHERE id = $1`, [project.id]);
});

await test('publishDeployment with same id (no-op equivalent) leaves state consistent', async () => {
  const ok = await dbAvailable();
  if (!ok) {
    console.log('  SKIP  DATABASE_URL not set — integration test skipped');
    return;
  }

  // Edge case: republishing an already-published deployment (e.g. user clicks
  // "publish" on the live version). Should still leave DB consistent: that
  // deployment IS_published=true, project pointer matches.
  const project = await createProject({
    name: `tx-noop-${Date.now()}`,
    sourceType: 'upload',
  });
  const d = await query<{ id: string }>(
    `INSERT INTO deployments (project_id, version, status, is_published)
     VALUES ($1, 1, 'live', true) RETURNING id`,
    [project.id],
  );

  // Set the project pointer to point at d FIRST, so re-publishing matches the
  // intended starting state.
  await query(
    `UPDATE projects SET published_deployment_id = $1 WHERE id = $2`,
    [d.rows[0].id, project.id],
  );

  await publishDeployment(project.id, d.rows[0].id);

  const dAfter = await query<{ is_published: boolean }>(
    `SELECT is_published FROM deployments WHERE id = $1`,
    [d.rows[0].id],
  );
  const projectAfter = await query<{ published_deployment_id: string | null }>(
    `SELECT published_deployment_id FROM projects WHERE id = $1`,
    [project.id],
  );

  assert.equal(dAfter.rows[0].is_published, true);
  assert.equal(projectAfter.rows[0].published_deployment_id, d.rows[0].id);

  // Cleanup
  await query(`DELETE FROM deployments WHERE project_id = $1`, [project.id]);
  await query(`DELETE FROM projects WHERE id = $1`, [project.id]);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
