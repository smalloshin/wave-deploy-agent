/**
 * Test: deployment-event-stream service.
 *
 * Covers the in-memory pub/sub + ring buffer that powers the SSE endpoint.
 *
 * Run: tsx src/test-event-stream.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  publish,
  replayFrom,
  subscribe,
  schedulePurge,
  purgeNow,
  _peek,
  RING_BUFFER_SIZE,
  type DeploymentEventEnvelope,
} from './services/deployment-event-stream';

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

(async () => {
  console.log('=== test-event-stream ===');

  console.log('\n=== publish + replay ===');

  await test('publish assigns monotonic seq starting at 1', () => {
    const id = `t-${Date.now()}-mono`;
    const a = publish(id, 'stage', { stage: 'extract', status: 'started' });
    const b = publish(id, 'stage', { stage: 'extract', status: 'succeeded' });
    const c = publish(id, 'stage', { stage: 'build', status: 'started' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(c.seq, 3);
    purgeNow(id);
  });

  await test('publish stamps ISO timestamp + preserves type/payload', () => {
    const id = `t-${Date.now()}-shape`;
    const env = publish(id, 'log', { line: 'building...' });
    assert.equal(env.type, 'log');
    assert.deepEqual(env.payload, { line: 'building...' });
    assert.match(env.ts, /^\d{4}-\d{2}-\d{2}T/);
    purgeNow(id);
  });

  await test('replayFrom(0) returns all buffered events', () => {
    const id = `t-${Date.now()}-replay-all`;
    publish(id, 'stage', { stage: 'extract', status: 'started' });
    publish(id, 'stage', { stage: 'extract', status: 'succeeded' });
    publish(id, 'stage', { stage: 'build', status: 'started' });
    const r = replayFrom(id, 0);
    assert.equal(r.gap, false);
    if (r.gap === false) {
      assert.equal(r.events.length, 3);
      assert.deepEqual(r.events.map(e => e.seq), [1, 2, 3]);
    }
    purgeNow(id);
  });

  await test('replayFrom(N) returns only events with seq > N', () => {
    const id = `t-${Date.now()}-replay-slice`;
    publish(id, 'stage', { stage: 'extract', status: 'started' });   // seq 1
    publish(id, 'stage', { stage: 'extract', status: 'succeeded' }); // seq 2
    publish(id, 'stage', { stage: 'build', status: 'started' });     // seq 3
    const r = replayFrom(id, 1);
    assert.equal(r.gap, false);
    if (r.gap === false) {
      assert.equal(r.events.length, 2);
      assert.deepEqual(r.events.map(e => e.seq), [2, 3]);
    }
    purgeNow(id);
  });

  await test('replayFrom on unknown deployment is empty (no gap)', () => {
    const r = replayFrom('does-not-exist', 100);
    assert.equal(r.gap, false);
    if (r.gap === false) assert.equal(r.events.length, 0);
  });

  await test('replayFrom past head returns empty (caller is ahead)', () => {
    const id = `t-${Date.now()}-ahead`;
    publish(id, 'stage', {});
    publish(id, 'stage', {});
    const r = replayFrom(id, 5);
    assert.equal(r.gap, false);
    if (r.gap === false) assert.equal(r.events.length, 0);
    purgeNow(id);
  });

  console.log('\n=== ring buffer eviction + gap detection ===');

  await test('buffer caps at RING_BUFFER_SIZE; oldest evicted', () => {
    const id = `t-${Date.now()}-ring`;
    // Publish RING_BUFFER_SIZE + 5 events
    for (let i = 0; i < RING_BUFFER_SIZE + 5; i++) {
      publish(id, 'log', { i });
    }
    const peek = _peek(id);
    assert.ok(peek);
    assert.equal(peek!.size, RING_BUFFER_SIZE);
    // Oldest seq should now be 6 (1..5 evicted)
    assert.equal(peek!.oldestSeq, 6);
    assert.equal(peek!.nextSeq, RING_BUFFER_SIZE + 6);
    purgeNow(id);
  });

  await test('replayFrom returns gap when client behind ring window', () => {
    const id = `t-${Date.now()}-gap`;
    for (let i = 0; i < RING_BUFFER_SIZE + 10; i++) {
      publish(id, 'log', { i });
    }
    // Client claims to have seq 2; oldest in buffer is now 11
    const r = replayFrom(id, 2);
    assert.equal(r.gap, true);
    if (r.gap === true) {
      // evicted_through tells client "you missed up to seq N"
      assert.equal(typeof r.evicted_through, 'number');
      assert.ok(r.evicted_through >= 10);
    }
    purgeNow(id);
  });

  await test('replayFrom at exact oldest-1 boundary is in-range (no gap)', () => {
    const id = `t-${Date.now()}-boundary`;
    for (let i = 0; i < RING_BUFFER_SIZE + 3; i++) {
      publish(id, 'log', { i });
    }
    const peek = _peek(id)!;
    // oldestSeq is 4, so lastSeq = 3 should be in range (== oldestSeq - 1)
    const r = replayFrom(id, peek.oldestSeq - 1);
    assert.equal(r.gap, false);
    if (r.gap === false) {
      // Should get all events in buffer
      assert.equal(r.events.length, RING_BUFFER_SIZE);
    }
    purgeNow(id);
  });

  console.log('\n=== subscribe / unsubscribe lifecycle ===');

  await test('subscribe receives live events after subscription', async () => {
    const id = `t-${Date.now()}-sub`;
    const received: DeploymentEventEnvelope[] = [];
    const off = subscribe(id, (env) => received.push(env));

    publish(id, 'stage', { stage: 'extract', status: 'started' });
    publish(id, 'log', { line: 'hi' });

    // Microtask flush
    await Promise.resolve();
    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'stage');
    assert.equal(received[1].type, 'log');

    off();
    purgeNow(id);
  });

  await test('subscribe does NOT receive events after unsubscribe', async () => {
    const id = `t-${Date.now()}-unsub`;
    const received: DeploymentEventEnvelope[] = [];
    const off = subscribe(id, (env) => received.push(env));

    publish(id, 'stage', {});  // received
    off();
    publish(id, 'stage', {});  // not received

    await Promise.resolve();
    assert.equal(received.length, 1);
    purgeNow(id);
  });

  await test('multiple subscribers each get every event', async () => {
    const id = `t-${Date.now()}-multi`;
    const a: DeploymentEventEnvelope[] = [];
    const b: DeploymentEventEnvelope[] = [];
    const offA = subscribe(id, (env) => a.push(env));
    const offB = subscribe(id, (env) => b.push(env));

    publish(id, 'log', { i: 1 });
    publish(id, 'log', { i: 2 });

    await Promise.resolve();
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);

    offA();
    offB();
    purgeNow(id);
  });

  console.log('\n=== purge lifecycle ===');

  await test('purgeNow clears buffer and resets state', () => {
    const id = `t-${Date.now()}-purge`;
    publish(id, 'log', {});
    publish(id, 'log', {});
    assert.ok(_peek(id));
    purgeNow(id);
    assert.equal(_peek(id), null);
  });

  await test('schedulePurge fires after delay', async () => {
    const id = `t-${Date.now()}-sched`;
    publish(id, 'log', {});
    schedulePurge(id, 50);  // very short delay
    assert.ok(_peek(id), 'still present immediately');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(_peek(id), null, 'gone after delay');
  });

  await test('schedulePurge resets when called again (idempotent)', async () => {
    const id = `t-${Date.now()}-reset`;
    publish(id, 'log', {});
    schedulePurge(id, 200);
    await new Promise(r => setTimeout(r, 50));
    schedulePurge(id, 200);   // reset — total wait now ~250ms from start
    await new Promise(r => setTimeout(r, 100));   // 150ms total — should still be alive
    assert.ok(_peek(id), 'still alive after reset');
    await new Promise(r => setTimeout(r, 200));   // now past second timer
    assert.equal(_peek(id), null);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
