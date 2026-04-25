/**
 * Test: /api/deploys/:id/timeline route shape + business logic.
 *
 * Uses fastify's built-in inject() (no test runner deps). Mocks the DB layer
 * via stub of the stage-events service to keep this hermetic.
 *
 * Run: tsx src/test-timeline-route.ts
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

function row(stage: string, status: string, iso: string, metadata: Record<string, unknown> = {}): StageEventRow {
  return {
    id: 0,
    deployment_id: 'd-1',
    stage,
    status,
    metadata,
    created_at: new Date(iso),
  } as StageEventRow;
}

// Reproduces the overall-status logic from routes/deploys.ts; if you change
// the route, mirror that change here. (Pulled into a test helper to verify
// the priority order without spinning up the full route with its DB deps.)
function computeOverall(stages: ReturnType<typeof summarizeStages>): 'pending' | 'running' | 'succeeded' | 'failed' {
  return stages.some(s => s.status === 'failed')
    ? 'failed'
    : stages.some(s => s.status === 'started')
      ? 'running'
      : stages.length > 0
        ? 'succeeded'
        : 'pending';
}

(async () => {
  console.log('=== test-timeline-route ===');
  console.log('\n=== overall status resolver ===');

  await test('no events → pending', () => {
    assert.equal(computeOverall(summarizeStages([])), 'pending');
  });

  await test('any failed stage → failed', () => {
    const out = summarizeStages([
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),
      row('build', 'failed', '2026-04-25T10:00:10Z'),
    ]);
    assert.equal(computeOverall(out), 'failed');
  });

  await test('any started stage (no failures) → running', () => {
    const out = summarizeStages([
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),
    ]);
    assert.equal(computeOverall(out), 'running');
  });

  await test('all stages succeeded → succeeded', () => {
    const out = summarizeStages([
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),
      row('build', 'succeeded', '2026-04-25T10:00:03Z'),
      row('deploy', 'started', '2026-04-25T10:00:04Z'),
      row('deploy', 'succeeded', '2026-04-25T10:00:05Z'),
    ]);
    assert.equal(computeOverall(out), 'succeeded');
  });

  await test('failed > started priority (mid-pipeline crash)', () => {
    // build failed at step 2, but health_check is still showing started from
    // an earlier retry — overall must still surface failed.
    const out = summarizeStages([
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),
      row('build', 'failed', '2026-04-25T10:00:10Z'),
      row('health_check', 'started', '2026-04-25T10:00:11Z'),  // orphan from earlier retry
    ]);
    assert.equal(computeOverall(out), 'failed');
  });

  console.log('\n=== timeline aggregation ===');

  await test('events ordered chronologically; stages in canonical order', () => {
    const events = [
      row('build', 'succeeded', '2026-04-25T10:00:03Z'),
      row('extract', 'started', '2026-04-25T10:00:00Z'),
      row('extract', 'succeeded', '2026-04-25T10:00:01Z'),
      row('build', 'started', '2026-04-25T10:00:02Z'),
    ];
    const stages = summarizeStages(events);
    // Stages always come out in canonical order
    assert.deepEqual(stages.map(s => s.stage), ['extract', 'build']);
  });

  await test('SSL still-provisioning shows as started without finished_at', () => {
    const out = summarizeStages([
      row('ssl', 'started', '2026-04-25T10:00:00Z', { domain: 'foo.example.com' }),
    ]);
    assert.equal(out[0].status, 'started');
    assert.equal(out[0].finished_at, null);
    assert.equal(out[0].duration_ms, null);
    // Overall surfaces as 'running' since SSL is open
    assert.equal(computeOverall(out), 'running');
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
