/**
 * Test: stage-events service.
 *
 * Run:
 *   tsx src/test-stage-events.ts          # unit tests only
 *   DATABASE_URL=... tsx src/test-stage-events.ts   # + integration tests
 *
 * Pattern: existing test-*.ts scripts. Uses Node `assert` for structured
 * checks, prints PASS/FAIL with counters. Exit 0 on success, 1 on any failure.
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import { summarizeStages, type StageEventRow } from './services/stage-events';

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

function row(
  stage: string,
  status: string,
  iso: string,
  metadata: Record<string, unknown> = {}
): StageEventRow {
  return {
    id: 0,
    deployment_id: 'd-1',
    stage,
    status,
    metadata,
    created_at: new Date(iso),
  } as StageEventRow;
}

async function unitTests() {
  console.log('\n=== Unit tests: summarizeStages ===');

  await test('empty input → empty array', () => {
    assert.deepEqual(summarizeStages([]), []);
  });

  await test('canonical order: extract → build → push → deploy → health → ssl', () => {
    const events: StageEventRow[] = [
      row('ssl', 'started', '2026-04-25T10:00:06Z'),
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('deploy', 'started', '2026-04-25T10:00:04Z'),
      row('health_check', 'started', '2026-04-25T10:00:05Z'),
      row('push', 'succeeded', '2026-04-25T10:00:03Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),
      row('build', 'succeeded', '2026-04-25T10:00:03Z'),
    ];
    const out = summarizeStages(events);
    assert.deepEqual(out.map(s => s.stage), ['extract', 'build', 'push', 'deploy', 'health_check', 'ssl']);
  });

  await test('terminal priority: failed > succeeded > skipped (within same stage); started ignored if any terminal exists', () => {
    const events: StageEventRow[] = [
      row('build', 'succeeded', '2026-04-25T10:00:00Z'),
      row('build', 'failed', '2026-04-25T10:00:01Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),  // implied complete by terminals
    ];
    const out = summarizeStages(events);
    assert.equal(out[0].status, 'failed');
  });

  await test('started + succeeded → succeeded (not stuck running)', () => {
    const events: StageEventRow[] = [
      row('build', 'started', '2026-04-25T10:00:00Z'),
      row('build', 'succeeded', '2026-04-25T10:00:01Z'),
    ];
    const out = summarizeStages(events);
    assert.equal(out[0].status, 'succeeded');
  });

  await test('only started (no terminal) → started', () => {
    const events: StageEventRow[] = [
      row('build', 'started', '2026-04-25T10:00:00Z'),
    ];
    const out = summarizeStages(events);
    assert.equal(out[0].status, 'started');
  });

  await test('duration_ms = finished - started', () => {
    const events: StageEventRow[] = [
      row('build', 'started', '2026-04-25T10:00:00.000Z'),
      row('build', 'succeeded', '2026-04-25T10:00:42.500Z'),
    ];
    const out = summarizeStages(events);
    assert.equal(out[0].duration_ms, 42500);
    assert.equal(out[0].started_at, '2026-04-25T10:00:00.000Z');
    assert.equal(out[0].finished_at, '2026-04-25T10:00:42.500Z');
  });

  await test('open stage (started without end) → duration_ms null, status started', () => {
    const events: StageEventRow[] = [
      row('ssl', 'started', '2026-04-25T10:00:00Z', { domain: 'foo.bar' }),
    ];
    const out = summarizeStages(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'started');
    assert.equal(out[0].duration_ms, null);
    assert.equal(out[0].finished_at, null);
    assert.equal((out[0].metadata as { domain: string }).domain, 'foo.bar');
  });

  await test('unknown stage filtered out', () => {
    const events: StageEventRow[] = [
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('bogus', 'started', '2026-04-25T10:00:02Z'),
    ];
    const out = summarizeStages(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].stage, 'extract');
  });

  await test('missing stages just absent from output', () => {
    const events: StageEventRow[] = [
      row('build', 'succeeded', '2026-04-25T10:00:00Z'),
    ];
    const out = summarizeStages(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].stage, 'build');
  });

  await test('multiple finished events → use latest as finished_at', () => {
    const events: StageEventRow[] = [
      row('deploy', 'started', '2026-04-25T10:00:00Z'),
      row('deploy', 'failed', '2026-04-25T10:00:05Z'),
      row('deploy', 'started', '2026-04-25T10:00:06Z'), // retry
      row('deploy', 'succeeded', '2026-04-25T10:00:10Z'),
    ];
    const out = summarizeStages(events);
    // Status = failed (highest priority over succeeded)
    assert.equal(out[0].status, 'failed');
    // finished_at = latest closing event
    assert.equal(out[0].finished_at, '2026-04-25T10:00:10.000Z');
  });
}

async function integrationTests() {
  if (!process.env.DATABASE_URL) {
    console.log('\n=== Integration tests: SKIPPED (no DATABASE_URL) ===');
    return;
  }

  // Probe DB connectivity once before running anything that requires it.
  const { query, pool } = await import('./db/index');
  try {
    await query('SELECT 1');
  } catch (e) {
    console.log(`\n=== Integration tests: SKIPPED (DB unreachable: ${(e as Error).message || 'connection refused'}) ===`);
    try { await pool.end(); } catch { /* noop */ }
    return;
  }

  // Ensure schema is current — tests require deployment_stage_events table.
  try {
    await query('SELECT 1 FROM deployment_stage_events LIMIT 1');
  } catch (e) {
    console.log(`\n=== Integration tests: SKIPPED (schema not migrated: ${(e as Error).message}) ===`);
    try { await pool.end(); } catch { /* noop */ }
    return;
  }

  console.log('\n=== Integration tests: recordStageEvent + getStageEvents ===');
  const { recordStageEvent, getStageEvents } = await import('./services/stage-events');

  await test('record+read integration round-trip', async () => {
    // Pick any existing deployment, or skip
    const r = await query<{ id: string }>('SELECT id FROM deployments LIMIT 1');
    if (r.rows.length === 0) {
      console.log('        (no deployments in DB, skipping round-trip)');
      return;
    }
    const deploymentId = r.rows[0].id;
    const sentinel = `test-${Date.now()}`;

    await recordStageEvent(deploymentId, 'extract', 'started', { test: sentinel });
    await recordStageEvent(deploymentId, 'extract', 'succeeded', { test: sentinel });

    const events = await getStageEvents(deploymentId);
    const ours = events.filter(e => (e.metadata as { test?: string }).test === sentinel);
    assert.equal(ours.length, 2, 'should find both events we wrote');
    assert.equal(ours[0].stage, 'extract');
    assert.equal(ours[0].status, 'started');
    assert.equal(ours[1].status, 'succeeded');

    // Cleanup
    await query(
      `DELETE FROM deployment_stage_events WHERE metadata->>'test' = $1`,
      [sentinel]
    );
  });

  await test('recordStageEvent never throws on bad deployment_id', async () => {
    // FK violation should be swallowed
    await recordStageEvent('00000000-0000-0000-0000-000000000000', 'build', 'started', {});
    // If we got here, no throw.
  });

  await test('recordStageEvent no-ops on empty deployment_id', async () => {
    await recordStageEvent('', 'build', 'started', {});
  });

  await pool.end();
}

(async () => {
  console.log('=== test-stage-events ===');
  await unitTests();
  await integrationTests();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
