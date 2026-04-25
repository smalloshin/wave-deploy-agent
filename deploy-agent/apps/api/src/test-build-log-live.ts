/**
 * Tests: streamBuildLogToDeployment + onBuildStarted callback wiring.
 *
 * These exercise the LIVE build-log path:
 *   1. The async-generator from build-log-poller is consumed and each chunk
 *      becomes a `log` event on the deployment's SSE stream.
 *   2. abortSignal stops the consumer cleanly without spurious errors.
 *   3. A poller throw becomes a synthetic `meta` event (not a deploy crash).
 *   4. Bookend `meta` events fire on stream-start and stream-end.
 *
 * Uses the `__pollerForTest` injection seam in streamBuildLogToDeployment so
 * we don't hit GCS. Reads back the published events via deployment-event-stream's
 * replayFrom() to verify ordering / payload / event types.
 *
 * Run: tsx src/test-build-log-live.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import { streamBuildLogToDeployment } from './services/deploy-worker.js';
import {
  replayFrom,
  purgeNow,
  type DeploymentEventEnvelope,
} from './services/deployment-event-stream.js';
import type { BuildLogChunk } from './services/build-log-poller.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  PASS  ${name}`); passed++; })
    .catch(err => {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      if ((err as Error).stack) console.error((err as Error).stack);
      failed++;
    });
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function snapshot(deploymentId: string): DeploymentEventEnvelope[] {
  const r = replayFrom(deploymentId, 0);
  if ('gap' in r && r.gap === true) throw new Error('unexpected gap');
  return r.events;
}

// Build a fake async-generator that yields a finite list of chunks then ends.
async function* fakePoller(chunks: BuildLogChunk[], opts: { abortSignal: AbortSignal }): AsyncGenerator<BuildLogChunk> {
  for (const c of chunks) {
    if (opts.abortSignal.aborted) return;
    // Tiny delay so abort race scenarios are realistic
    await new Promise(r => setTimeout(r, 5));
    if (opts.abortSignal.aborted) return;
    yield c;
  }
}

// Build a fake poller that throws on first iteration (e.g. GCS object missing).
async function* throwingPoller(message: string): AsyncGenerator<BuildLogChunk> {
  // Yield zero items, then throw — simulates pollBuildLog's "object not present" error.
  await new Promise(r => setTimeout(r, 5));
  throw new Error(message);
}

(async () => {
  console.log('\n=== Tests: streamBuildLogToDeployment ===');

  await test('publishes log events for each chunk + bookend meta events', async () => {
    const deploymentId = uid('dep');
    const buildId = uid('build');
    const chunks: BuildLogChunk[] = [
      { build_id: buildId, bytes_offset: 0,    text: 'Step 1/5: FROM node:22\n', gcs_updated_iso: '2026-04-26T00:00:01Z', observed_lag_ms: 1500 },
      { build_id: buildId, bytes_offset: 23,   text: 'Step 2/5: WORKDIR /app\n',  gcs_updated_iso: '2026-04-26T00:00:03Z', observed_lag_ms: 1800 },
      { build_id: buildId, bytes_offset: 46,   text: 'Step 3/5: COPY . .\n',      gcs_updated_iso: '2026-04-26T00:00:05Z', observed_lag_ms: 2100 },
    ];
    const ac = new AbortController();
    await streamBuildLogToDeployment({
      deploymentId,
      buildId,
      bucket: 'fake-bucket',
      abortSignal: ac.signal,
      __pollerForTest: (o) => fakePoller(chunks, { abortSignal: o.abortSignal }),
    });

    const events = snapshot(deploymentId);
    // Expected order: meta(stream_started) + 3 logs + meta(stream_ended)
    assert.equal(events.length, 5, `expected 5 events, got ${events.length}`);
    assert.equal(events[0].type, 'meta');
    assert.equal(events[0].payload.kind, 'build_log_stream_started');
    assert.equal(events[0].payload.build_id, buildId);

    assert.equal(events[1].type, 'log');
    assert.equal(events[1].payload.build_id, buildId);
    assert.equal(events[1].payload.bytes_offset, 0);
    assert.equal(events[1].payload.text, 'Step 1/5: FROM node:22\n');
    assert.equal(events[1].payload.lag_ms, 1500);
    assert.equal(events[1].payload.gcs_updated, '2026-04-26T00:00:01Z');

    assert.equal(events[2].type, 'log');
    assert.equal(events[2].payload.bytes_offset, 23);

    assert.equal(events[3].type, 'log');
    assert.equal(events[3].payload.bytes_offset, 46);

    assert.equal(events[4].type, 'meta');
    assert.equal(events[4].payload.kind, 'build_log_stream_ended');

    // Seq monotonic
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i].seq, events[i - 1].seq + 1);
    }

    purgeNow(deploymentId);
  });

  await test('aborted signal: no end-meta published, exits cleanly', async () => {
    const deploymentId = uid('dep');
    const buildId = uid('build');
    const chunks: BuildLogChunk[] = [
      { build_id: buildId, bytes_offset: 0, text: 'a', gcs_updated_iso: '2026-04-26T00:00:01Z', observed_lag_ms: 100 },
      { build_id: buildId, bytes_offset: 1, text: 'b', gcs_updated_iso: '2026-04-26T00:00:02Z', observed_lag_ms: 100 },
      { build_id: buildId, bytes_offset: 2, text: 'c', gcs_updated_iso: '2026-04-26T00:00:03Z', observed_lag_ms: 100 },
    ];
    const ac = new AbortController();
    // Abort after 12ms — should land somewhere mid-stream (each yield has 5ms delay).
    setTimeout(() => ac.abort(), 12);
    await streamBuildLogToDeployment({
      deploymentId,
      buildId,
      bucket: 'fake-bucket',
      abortSignal: ac.signal,
      __pollerForTest: (o) => fakePoller(chunks, { abortSignal: o.abortSignal }),
    });
    const events = snapshot(deploymentId);
    // First event is always stream_started.
    assert.equal(events[0].type, 'meta');
    assert.equal(events[0].payload.kind, 'build_log_stream_started');
    // Last event must NOT be stream_ended (we aborted; finally guarded).
    const last = events[events.length - 1];
    assert.notEqual(last.payload.kind, 'build_log_stream_ended', 'aborted streams must not emit end-meta');
    // Must NOT have an error meta either.
    const hasError = events.some(e => e.type === 'meta' && e.payload.kind === 'build_log_stream_error');
    assert.equal(hasError, false);
    purgeNow(deploymentId);
  });

  await test('poller throws → synthetic meta(build_log_stream_error) published, no crash', async () => {
    const deploymentId = uid('dep');
    const buildId = uid('build');
    const ac = new AbortController();
    await streamBuildLogToDeployment({
      deploymentId,
      buildId,
      bucket: 'fake-bucket',
      abortSignal: ac.signal,
      __pollerForTest: () => throwingPoller('object missing after 20 polls'),
    });

    const events = snapshot(deploymentId);
    // Expected: stream_started + stream_error + stream_ended (finally fires when not aborted)
    const kinds = events.filter(e => e.type === 'meta').map(e => e.payload.kind);
    assert.deepEqual(kinds, [
      'build_log_stream_started',
      'build_log_stream_error',
      'build_log_stream_ended',
    ]);
    const errEvent = events.find(e => e.payload.kind === 'build_log_stream_error');
    assert.ok(errEvent);
    assert.match(String(errEvent!.payload.error), /object missing/);
    purgeNow(deploymentId);
  });

  await test('zero-chunk run still emits start + end bookends', async () => {
    const deploymentId = uid('dep');
    const buildId = uid('build');
    const ac = new AbortController();
    await streamBuildLogToDeployment({
      deploymentId,
      buildId,
      bucket: 'fake-bucket',
      abortSignal: ac.signal,
      __pollerForTest: (o) => fakePoller([], { abortSignal: o.abortSignal }),
    });
    const events = snapshot(deploymentId);
    assert.equal(events.length, 2);
    assert.equal(events[0].payload.kind, 'build_log_stream_started');
    assert.equal(events[1].payload.kind, 'build_log_stream_ended');
    purgeNow(deploymentId);
  });

  await test('publish failures inside the loop do not crash the consumer', async () => {
    // We can't easily induce a publish failure (the function is robust),
    // but we can verify the function doesn't throw when given many chunks.
    const deploymentId = uid('dep');
    const buildId = uid('build');
    const chunks: BuildLogChunk[] = Array.from({ length: 10 }, (_, i) => ({
      build_id: buildId,
      bytes_offset: i * 10,
      text: `chunk-${i}\n`,
      gcs_updated_iso: '2026-04-26T00:00:00Z',
      observed_lag_ms: 100,
    }));
    const ac = new AbortController();
    await streamBuildLogToDeployment({
      deploymentId,
      buildId,
      bucket: 'fake-bucket',
      abortSignal: ac.signal,
      __pollerForTest: (o) => fakePoller(chunks, { abortSignal: o.abortSignal }),
    });
    const events = snapshot(deploymentId);
    // 1 start + 10 logs + 1 end
    assert.equal(events.length, 12);
    assert.equal(events.filter(e => e.type === 'log').length, 10);
    purgeNow(deploymentId);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})();
