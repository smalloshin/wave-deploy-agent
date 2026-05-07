/**
 * R57.2 (2026-05-07): tests for migration-cleanup
 *
 * Zero-dep — `node:assert/strict` only. The cleanup function takes a `query`
 * callable so we mock it inline and assert the SQL shape + outcomes.
 */

import { strict as assert } from 'node:assert';

import {
  cleanupMigrationRows,
  type DbQueryFn,
} from './services/migration-cleanup';

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

interface MockCall {
  sql: string;
  params?: unknown[];
}

function mockQuery(
  responses: Array<{ rowCount: number | null }>,
): { fn: DbQueryFn; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let i = 0;
  const fn: DbQueryFn = async (text, params) => {
    calls.push({ sql: text, params });
    const r = responses[i++];
    if (!r) throw new Error('mockQuery: out of responses');
    return r;
  };
  return { fn, calls };
}

function throwingQuery(stage: 'sweep' | 'delete', message: string): DbQueryFn {
  let i = 0;
  return async () => {
    i++;
    if (stage === 'sweep' && i === 1) throw new Error(message);
    if (stage === 'delete' && i === 2) throw new Error(message);
    return { rowCount: 0 };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths
// ─────────────────────────────────────────────────────────────────────────────

test('TTL sweep + retention delete: both succeed with 0 work', async () => {
  const m = mockQuery([{ rowCount: 0 }, { rowCount: 0 }]);
  const r = await cleanupMigrationRows(m.fn);
  assert.equal(r.expiredSweeped, 0);
  assert.equal(r.rowsDeleted, 0);
  assert.match(r.summary, /no work/);
  assert.equal(m.calls.length, 2);
});

test('TTL sweep finds 3 expired running rows, retention finds 5 to delete', async () => {
  const m = mockQuery([{ rowCount: 3 }, { rowCount: 5 }]);
  const r = await cleanupMigrationRows(m.fn);
  assert.equal(r.expiredSweeped, 3);
  assert.equal(r.rowsDeleted, 5);
  assert.match(r.summary, /swept 3.*deleted 5/);
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL shape contracts
// ─────────────────────────────────────────────────────────────────────────────

test('TTL sweep SQL targets running rows with expires_at < NOW()', async () => {
  const m = mockQuery([{ rowCount: 0 }, { rowCount: 0 }]);
  await cleanupMigrationRows(m.fn);
  const sweepSql = m.calls[0]?.sql ?? '';
  assert.match(sweepSql, /UPDATE wave_deploy_migrations/);
  assert.match(sweepSql, /SET status = 'expired'/);
  assert.match(sweepSql, /WHERE status = 'running'/);
  assert.match(sweepSql, /expires_at < NOW\(\)/);
});

test('TTL sweep SQL writes finished_at + preserves existing error_message', async () => {
  const m = mockQuery([{ rowCount: 0 }, { rowCount: 0 }]);
  await cleanupMigrationRows(m.fn);
  const sweepSql = m.calls[0]?.sql ?? '';
  assert.match(sweepSql, /finished_at = NOW\(\)/);
  // COALESCE so we don't overwrite a meaningful existing error_message.
  assert.match(sweepSql, /COALESCE\(error_message,/);
});

test('retention delete SQL excludes running rows + uses parameter for retention days', async () => {
  const m = mockQuery([{ rowCount: 0 }, { rowCount: 0 }]);
  await cleanupMigrationRows(m.fn, { retentionDays: 30 });
  const deleteSql = m.calls[1]?.sql ?? '';
  assert.match(deleteSql, /DELETE FROM wave_deploy_migrations/);
  assert.match(deleteSql, /created_at < NOW\(\) - \(\$1 \|\| ' days'\)::interval/);
  assert.match(deleteSql, /status != 'running'/);
  assert.deepEqual(m.calls[1]?.params, ['30']);
});

test('retentionDays=0 disables deletion (sweep-only mode)', async () => {
  const m = mockQuery([{ rowCount: 2 }]);
  const r = await cleanupMigrationRows(m.fn, { retentionDays: 0 });
  assert.equal(r.expiredSweeped, 2);
  assert.equal(r.rowsDeleted, 0);
  // Only the sweep query should have run.
  assert.equal(m.calls.length, 1);
});

test('default retentionDays is 30 when not specified', async () => {
  const m = mockQuery([{ rowCount: 0 }, { rowCount: 0 }]);
  await cleanupMigrationRows(m.fn);
  assert.deepEqual(m.calls[1]?.params, ['30']);
});

test('custom retentionDays passes through to SQL params', async () => {
  const m = mockQuery([{ rowCount: 0 }, { rowCount: 0 }]);
  await cleanupMigrationRows(m.fn, { retentionDays: 90 });
  assert.deepEqual(m.calls[1]?.params, ['90']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — never throws, summary explains
// ─────────────────────────────────────────────────────────────────────────────

test('TTL sweep DB error is caught + reported in summary (no throw)', async () => {
  const r = await cleanupMigrationRows(throwingQuery('sweep', 'connection lost'));
  assert.equal(r.expiredSweeped, 0);
  assert.equal(r.rowsDeleted, 0);
  assert.match(r.summary, /TTL sweep failed/);
  assert.match(r.summary, /connection lost/);
});

test('retention delete DB error is caught + sweep result preserved', async () => {
  // Sweep succeeds, delete fails.
  let i = 0;
  const fn: DbQueryFn = async () => {
    i++;
    if (i === 1) return { rowCount: 7 };
    throw new Error('disk full');
  };
  const r = await cleanupMigrationRows(fn);
  assert.equal(r.expiredSweeped, 7);
  assert.equal(r.rowsDeleted, 0);
  assert.match(r.summary, /retention delete failed/);
});

test('rowCount: null is treated as 0', async () => {
  const m = mockQuery([{ rowCount: null }, { rowCount: null }]);
  const r = await cleanupMigrationRows(m.fn);
  assert.equal(r.expiredSweeped, 0);
  assert.equal(r.rowsDeleted, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    const result = t.fn();
    if (result instanceof Promise) await result;
    passed++;
  } catch (err) {
    failed++;
    console.error(`✗ ${t.name}`);
    console.error(`  ${(err as Error).message}`);
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
