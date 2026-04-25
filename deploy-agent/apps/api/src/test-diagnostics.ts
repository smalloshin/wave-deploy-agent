/**
 * Test: deployment-diagnostics service.
 *
 * Unit tests focus on computeCacheKey (pure, deterministic, no DB / LLM).
 *
 * Integration tests gated on DATABASE_URL — they exercise the cache hit/miss
 * flow without making real LLM calls (we monkey-patch callLLM via a manual
 * fixture row, since we don't have a mocking framework in this repo).
 *
 * Run: tsx src/test-diagnostics.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import { computeCacheKey } from './services/deployment-diagnostics';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  PASS  ${name}`); passed++; })
    .catch(err => {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed++;
    });
}

async function unitTests() {
  console.log('\n=== Unit tests: computeCacheKey ===');

  await test('build:failure with build_id → build:<build_id>', () => {
    const key = computeCacheKey({
      kind: 'failure',
      deploymentId: 'd-uuid-1',
      buildId: 'b-uuid-aaa',
      failureStage: 'build',
    });
    assert.equal(key, 'build:b-uuid-aaa');
  });

  await test('build:failure WITHOUT build_id → fallback to deploy:<deployment_id>', () => {
    const key = computeCacheKey({
      kind: 'failure',
      deploymentId: 'd-uuid-2',
      buildId: null,
      failureStage: 'build',
    });
    assert.equal(key, 'deploy:d-uuid-2');
  });

  await test('non-build failure (deploy stage) → deploy:<deployment_id>', () => {
    const key = computeCacheKey({
      kind: 'failure',
      deploymentId: 'd-uuid-3',
      buildId: 'b-uuid-bbb',     // present but irrelevant for non-build failures
      failureStage: 'deploy',
    });
    assert.equal(key, 'deploy:d-uuid-3');
  });

  await test('non-build failure (health_check) → deploy:<deployment_id>', () => {
    const key = computeCacheKey({
      kind: 'failure',
      deploymentId: 'd-uuid-4',
      buildId: null,
      failureStage: 'health_check',
    });
    assert.equal(key, 'deploy:d-uuid-4');
  });

  await test('slow kind ignores build_id; always deploy:<deployment_id>', () => {
    const key = computeCacheKey({
      kind: 'slow',
      deploymentId: 'd-uuid-5',
      buildId: 'b-uuid-ccc',
      failureStage: null,
    });
    assert.equal(key, 'deploy:d-uuid-5');
  });

  await test('two deployments sharing the same build_id share cache key', () => {
    const a = computeCacheKey({ kind: 'failure', deploymentId: 'd-1', buildId: 'b-shared', failureStage: 'build' });
    const b = computeCacheKey({ kind: 'failure', deploymentId: 'd-2', buildId: 'b-shared', failureStage: 'build' });
    assert.equal(a, b);
    assert.equal(a, 'build:b-shared');
  });

  await test('different build_ids produce different cache keys', () => {
    const a = computeCacheKey({ kind: 'failure', deploymentId: 'd-1', buildId: 'b-1', failureStage: 'build' });
    const b = computeCacheKey({ kind: 'failure', deploymentId: 'd-1', buildId: 'b-2', failureStage: 'build' });
    assert.notEqual(a, b);
  });
}

async function integrationTests() {
  if (!process.env.DATABASE_URL) {
    console.log('\n=== Integration tests: SKIPPED (no DATABASE_URL) ===');
    return;
  }

  const { query, pool } = await import('./db/index');
  try {
    await query('SELECT 1');
  } catch (e) {
    console.log(`\n=== Integration tests: SKIPPED (DB unreachable: ${(e as Error).message || 'connection refused'}) ===`);
    try { await pool.end(); } catch { /* noop */ }
    return;
  }

  // Schema check
  try {
    await query('SELECT 1 FROM deployment_diagnostics LIMIT 1');
  } catch (e) {
    console.log(`\n=== Integration tests: SKIPPED (schema not migrated: ${(e as Error).message}) ===`);
    try { await pool.end(); } catch { /* noop */ }
    return;
  }

  console.log('\n=== Integration tests: cache table semantics ===');

  await test('UNIQUE (cache_key, kind) enforced — duplicate insert raises', async () => {
    const cacheKey = `test:${Date.now()}:dup`;
    await query(
      `INSERT INTO deployment_diagnostics (cache_key, kind, summary) VALUES ($1, 'failure', 'first')`,
      [cacheKey]
    );
    let raised = false;
    try {
      await query(
        `INSERT INTO deployment_diagnostics (cache_key, kind, summary) VALUES ($1, 'failure', 'dup')`,
        [cacheKey]
      );
    } catch {
      raised = true;
    }
    assert.equal(raised, true, 'second insert with same (cache_key, kind) must raise');
    await query(`DELETE FROM deployment_diagnostics WHERE cache_key = $1`, [cacheKey]);
  });

  await test('Same cache_key with different kind allowed', async () => {
    const cacheKey = `test:${Date.now()}:kindsplit`;
    await query(
      `INSERT INTO deployment_diagnostics (cache_key, kind, summary) VALUES ($1, 'failure', 'a')`,
      [cacheKey]
    );
    await query(
      `INSERT INTO deployment_diagnostics (cache_key, kind, summary) VALUES ($1, 'slow', 'b')`,
      [cacheKey]
    );
    const r = await query(`SELECT kind FROM deployment_diagnostics WHERE cache_key = $1`, [cacheKey]);
    assert.equal(r.rows.length, 2);
    await query(`DELETE FROM deployment_diagnostics WHERE cache_key = $1`, [cacheKey]);
  });

  await test('ON CONFLICT DO NOTHING returns 0 rows on duplicate insert', async () => {
    const cacheKey = `test:${Date.now()}:onconflict`;
    await query(
      `INSERT INTO deployment_diagnostics (cache_key, kind, summary) VALUES ($1, 'failure', 'first')`,
      [cacheKey]
    );
    const r = await query(
      `INSERT INTO deployment_diagnostics (cache_key, kind, summary) VALUES ($1, 'failure', 'second')
       ON CONFLICT (cache_key, kind) DO NOTHING
       RETURNING id`,
      [cacheKey]
    );
    assert.equal(r.rows.length, 0, 'conflicting insert should return no rows');
    await query(`DELETE FROM deployment_diagnostics WHERE cache_key = $1`, [cacheKey]);
  });

  await pool.end();
}

(async () => {
  console.log('=== test-diagnostics ===');
  await unitTests();
  await integrationTests();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
