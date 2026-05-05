/**
 * Tests: gcp-poll (R57 DRY helper)
 *
 * 為什麼需要鎖死：R47 reconciler-recovery + R57 migration runner 都會依賴。
 * Backoff schedule 算錯 → 暴打 GCP API rate limit。terminal detection 算錯 →
 * 永遠跑不出來。timeout 算錯 → migration 卡住但沒人發現。
 *
 * Run: bun run src/test-gcp-poll.ts
 */

import assert from 'node:assert/strict';
import {
  pollGcpUntilTerminal,
  computeBackoffSchedule,
  type PollOptions,
} from './services/gcp-poll';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void): void {
  const run = async () => {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed++;
    }
  };
  // Run synchronously in sequence for deterministic output
  testQueue.push(run);
}

const testQueue: Array<() => Promise<void>> = [];

console.log('\n=== gcp-poll unit tests ===\n');

// ─── computeBackoffSchedule (pure, no async) ───

test('default backoff: 3000, 9000, 27000, capped at 30000', () => {
  const opts: PollOptions = { totalTimeoutMs: 600_000 };
  const schedule = computeBackoffSchedule(opts);
  assert.equal(schedule[0], 3000);
  assert.equal(schedule[1], 9000);
  assert.equal(schedule[2], 27_000);
  assert.equal(schedule[3], 30_000); // capped (3*27000=81000 > 30000)
  assert.equal(schedule[4], 30_000);
});

test('cumulative time stops at totalTimeoutMs', () => {
  const opts: PollOptions = { totalTimeoutMs: 60_000 };
  const schedule = computeBackoffSchedule(opts);
  const sum = schedule.reduce((a, b) => a + b, 0);
  assert.ok(sum <= 60_000, `sum should be <=60s, got ${sum}`);
});

test('last delay is truncated to fit totalTimeoutMs', () => {
  // initial 3000, factor 3, max 30000, total 10s
  // schedule: 3000 (cum=3000), 9000 (cum=12000 → truncate to 7000)
  const opts: PollOptions = { totalTimeoutMs: 10_000 };
  const schedule = computeBackoffSchedule(opts);
  assert.equal(schedule[0], 3000);
  assert.equal(schedule[1], 7000); // truncated from 9000
  assert.equal(schedule.length, 2);
});

test('custom initial / backoff / max', () => {
  const opts: PollOptions = {
    totalTimeoutMs: 600_000,
    initialDelayMs: 1000,
    backoffFactor: 2,
    maxIntervalMs: 10_000,
  };
  const s = computeBackoffSchedule(opts);
  assert.equal(s[0], 1000);
  assert.equal(s[1], 2000);
  assert.equal(s[2], 4000);
  assert.equal(s[3], 8000);
  assert.equal(s[4], 10_000); // capped (2*8000=16000 > 10000)
  assert.equal(s[5], 10_000);
});

test('zero totalTimeout → empty schedule', () => {
  const opts: PollOptions = { totalTimeoutMs: 0 };
  const schedule = computeBackoffSchedule(opts);
  assert.equal(schedule.length, 0);
});

// ─── pollGcpUntilTerminal (with mock fetcher) ───

test('happy: fetcher returns terminal=succeeded on first poll', async () => {
  let calls = 0;
  const result = await pollGcpUntilTerminal(
    async () => {
      calls++;
      return { kind: 'ok' as const, status: { state: 'DONE' as const } };
    },
    (s) => s.state === 'DONE'
      ? { terminal: true as const, outcome: 'succeeded' as const }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 10 }, // tiny delays for tests
  );
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test('fetcher returns terminal=failed → outcome=failed', async () => {
  const result = await pollGcpUntilTerminal(
    async () => ({ kind: 'ok' as const, status: { state: 'FAILED' as const } }),
    (s) => s.state === 'FAILED'
      ? { terminal: true as const, outcome: 'failed' as const, reason: 'job exit 1' }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 10 },
  );
  assert.equal(result.outcome, 'failed');
  if (result.outcome === 'failed') assert.equal(result.reason, 'job exit 1');
});

test('not terminal for 3 polls, then succeeded', async () => {
  let calls = 0;
  const result = await pollGcpUntilTerminal(
    async () => {
      calls++;
      return { kind: 'ok' as const, status: { state: calls >= 3 ? 'DONE' : 'RUNNING' } };
    },
    (s) => s.state === 'DONE'
      ? { terminal: true as const, outcome: 'succeeded' as const }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 10, backoffFactor: 1, maxIntervalMs: 10 },
  );
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

test('totalTimeout exceeded → outcome=timeout', async () => {
  const result = await pollGcpUntilTerminal(
    async () => ({ kind: 'ok' as const, status: { state: 'RUNNING' } }),
    () => ({ terminal: false as const }),
    { totalTimeoutMs: 50, initialDelayMs: 30, backoffFactor: 1, maxIntervalMs: 30 }, // 50ms total, ~1-2 polls
  );
  assert.equal(result.outcome, 'timeout');
});

test('fetcher errors transiently then succeeds', async () => {
  let calls = 0;
  const result = await pollGcpUntilTerminal(
    async () => {
      calls++;
      if (calls < 2) return { kind: 'error' as const, reason: '503 transient' };
      return { kind: 'ok' as const, status: { state: 'DONE' as const } };
    },
    (s) => s.state === 'DONE'
      ? { terminal: true as const, outcome: 'succeeded' as const }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 10, backoffFactor: 1, maxFetcherErrors: 3 },
  );
  assert.equal(result.outcome, 'succeeded');
  assert.equal(calls, 2);
});

test('fetcher errors persistently → outcome=fetcher_error after maxFetcherErrors', async () => {
  let calls = 0;
  const result = await pollGcpUntilTerminal(
    async () => {
      calls++;
      return { kind: 'error' as const, reason: '500 server' };
    },
    () => ({ terminal: false as const }),
    { totalTimeoutMs: 60_000, initialDelayMs: 10, backoffFactor: 1, maxFetcherErrors: 3 },
  );
  assert.equal(result.outcome, 'fetcher_error');
  if (result.outcome === 'fetcher_error') {
    assert.match(result.lastError, /500 server/);
  }
  assert.equal(calls, 3);
});

test('terminal=cancelled outcome propagates', async () => {
  const result = await pollGcpUntilTerminal(
    async () => ({ kind: 'ok' as const, status: { state: 'CANCELLED' as const } }),
    (s) => s.state === 'CANCELLED'
      ? { terminal: true as const, outcome: 'cancelled' as const, reason: 'user aborted' }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 10 },
  );
  assert.equal(result.outcome, 'cancelled');
  if (result.outcome === 'cancelled') {
    assert.match(result.reason, /user aborted/);
  }
});

test('attempts count increments on each fetch (success or error)', async () => {
  let calls = 0;
  const result = await pollGcpUntilTerminal(
    async () => {
      calls++;
      if (calls < 4) return { kind: 'error' as const, reason: 'transient' };
      return { kind: 'ok' as const, status: { state: 'DONE' as const } };
    },
    (s) => s.state === 'DONE'
      ? { terminal: true as const, outcome: 'succeeded' as const }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 10, backoffFactor: 1, maxFetcherErrors: 5 },
  );
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.attempts, 4);
});

test('durationMs is reported on success', async () => {
  const result = await pollGcpUntilTerminal(
    async () => ({ kind: 'ok' as const, status: { state: 'DONE' as const } }),
    (s) => s.state === 'DONE'
      ? { terminal: true as const, outcome: 'succeeded' as const }
      : { terminal: false as const },
    { totalTimeoutMs: 60_000, initialDelayMs: 50 },
  );
  if (result.outcome === 'succeeded') {
    assert.ok(result.durationMs >= 50, `durationMs should be >= 50, got ${result.durationMs}`);
  }
});

// Run the queue
async function runAll() {
  for (const fn of testQueue) await fn();
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}
runAll();
