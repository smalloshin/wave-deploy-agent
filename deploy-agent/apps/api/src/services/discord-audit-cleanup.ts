// Discord audit cleanup scheduler — periodic background job for the
// discord_audit table.
//
// What this does:
//   - cleanupDiscordAudit(N): deletes discord_audit rows older than N days.
//
// Why this exists:
//   - discord_audit appends one row per Discord NL tool invocation (pending +
//     result patched in place). Without retention the table grows linearly
//     with bot traffic, dragging down listing queries and audit dashboard
//     pagination. 180 days is the agreed forensic horizon (matches the
//     comment in schema.sql at the table definition).
//
// Design choices:
//   - Mirrors auth-cleanup.ts shape exactly: run-on-boot + interval pattern,
//     in-flight guard, errors logged but never thrown. Boot must not depend
//     on this background sweeper.
//   - Pure helper `clampRetentionDays()` is exported separately so tests /
//     callers can validate input without a DB roundtrip.
//
// Configuration:
//   - DISCORD_AUDIT_RETENTION_DAYS         (default 180) — clamp [7, 3650]
//   - DISCORD_AUDIT_CLEANUP_INTERVAL_HRS   (default 24)
//   - DISCORD_AUDIT_CLEANUP_INITIAL_DELAY_MS (default 30000)
//
// Test seam: stopDiscordAuditCleanup() lets tests boot + tear down between cases.

import { pool } from '../db/index.js';
import { safePositiveInt, safeNumber } from '../utils/safe-number';

let timer: NodeJS.Timeout | null = null;
let isRunning = false;

const INITIAL_DELAY_MS = safePositiveInt(
  process.env.DISCORD_AUDIT_CLEANUP_INITIAL_DELAY_MS,
  30_000,
  { max: 10 * 60 * 1000 }, // 10min cap
);

const INTERVAL_MS =
  safePositiveInt(process.env.DISCORD_AUDIT_CLEANUP_INTERVAL_HRS, 24, {
    max: 24 * 30,
  }) *
  60 *
  60 *
  1000;

const RETENTION_DAYS = clampRetentionDays(
  process.env.DISCORD_AUDIT_RETENTION_DAYS,
  180,
);

/**
 * Coerce + clamp an arbitrary input into a safe retention-days value.
 *
 * Rules (mirrors cleanupAuditLog in auth-service):
 *   - NaN / non-numeric / null / undefined → defaultDays
 *   - Decimals truncated toward zero (1.9 → 1 → then clamped up to 7)
 *   - Clamped to [7, 3650]
 *
 * Pure function, exported for unit testing.
 */
export function clampRetentionDays(
  input: unknown,
  defaultDays = 180,
): number {
  // safeNumber returns finite or fallback; truncate toward zero.
  const raw = safeNumber(input, defaultDays);
  const truncated = Math.trunc(raw);
  // Clamp to [7, 3650]. Anything below 7 or non-positive falls to 7.
  if (!Number.isFinite(truncated) || truncated < 7) return 7;
  if (truncated > 3650) return 3650;
  return truncated;
}

/**
 * Delete discord_audit rows older than retentionDays. Returns deleted count.
 *
 * Uses parameterized SQL — never string-concat user input. The same interval
 * trick as cleanupAuditLog: cast `'$1 days'::interval` after coercing to text
 * (postgres rejects integer-as-interval directly).
 */
export async function cleanupDiscordAudit(retentionDays = 180): Promise<number> {
  const days = clampRetentionDays(retentionDays, 180);
  const result = await pool.query(
    `DELETE FROM discord_audit WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return result.rowCount ?? 0;
}

/**
 * Run the cleanup exactly once. Public so tests / cron jobs can trigger
 * a single pass without starting the scheduler.
 */
export async function runDiscordAuditCleanupOnce(): Promise<{
  deleted: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let deleted = 0;

  try {
    deleted = await cleanupDiscordAudit(RETENTION_DAYS);
    if (deleted > 0) {
      console.log(
        `[discord-audit-cleanup] deleted ${deleted} row(s) older than ${RETENTION_DAYS}d`,
      );
    }
  } catch (err) {
    const msg = `cleanupDiscordAudit: ${(err as Error).message}`;
    console.error(`[discord-audit-cleanup] ${msg}`);
    errors.push(msg);
  }

  return { deleted, errors };
}

/**
 * Start the periodic scheduler. Idempotent — calling it twice is a no-op.
 *
 * Uses the same shape as startAuthCleanup():
 *   - Initial setTimeout (after INITIAL_DELAY_MS)
 *   - Then setInterval (every INTERVAL_MS)
 *   - In-flight guard prevents overlap if a cleanup runs longer than the interval
 */
export function startDiscordAuditCleanup(): void {
  if (timer) return;

  console.log(
    `[discord-audit-cleanup] scheduler started — interval=${INTERVAL_MS / 3_600_000}h, retention=${RETENTION_DAYS}d`,
  );

  // Initial run after a short delay
  setTimeout(() => {
    void wrappedRun();
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    void wrappedRun();
  }, INTERVAL_MS);
}

/**
 * Stop the scheduler. For graceful shutdown / tests.
 */
export function stopDiscordAuditCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function wrappedRun(): Promise<void> {
  if (isRunning) {
    console.warn(
      '[discord-audit-cleanup] previous run still in flight, skipping this tick',
    );
    return;
  }
  isRunning = true;
  try {
    await runDiscordAuditCleanupOnce();
  } finally {
    isRunning = false;
  }
}
