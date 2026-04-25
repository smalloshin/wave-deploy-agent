// Auth-cleanup scheduler — periodic background job for the auth tables.
//
// What this does:
//   - cleanupExpiredSessions(): deletes sessions whose expires_at <= NOW()
//   - cleanupAuditLog(N):       deletes auth_audit_log rows older than N days
//
// Why this exists:
//   - sessions table has no automatic eviction. Every login appends a row;
//     when the cookie expires, validateSession() ignores it (it filters on
//     expires_at > NOW()), but the row stays. Without cleanup this table
//     grows unbounded.
//   - auth_audit_log has no retention by design — every auth event lands a
//     row. At 1 login/sec it would hit 2-3M rows/month. Forensic value past
//     90 days is marginal; cost of keeping it is real (slow listAuditLog,
//     index bloat, backup size).
//
// Design choices:
//   - Run-on-boot + interval pattern, identical to reconciler.ts so the two
//     stay shape-compatible (single timer, single in-flight guard).
//   - Initial run is delayed 30s — gives DB time to settle and lets the API
//     finish answering its first few requests cleanly.
//   - Each cleanup is isolated: a failure in one doesn't skip the other.
//   - Failures are logged but never thrown — boot must not depend on this.
//
// Configuration:
//   - AUDIT_RETENTION_DAYS  (default 90)        — clamp [7, 3650] in cleanupAuditLog
//   - AUTH_CLEANUP_INTERVAL_HRS (default 24)    — how often to run
//   - AUTH_CLEANUP_INITIAL_DELAY_MS (default 30000)
//
// Test seam: stopAuthCleanup() lets tests boot + tear down between cases.

import { cleanupExpiredSessions, cleanupAuditLog } from './auth-service';
import { safePositiveInt } from '../utils/safe-number';

let timer: NodeJS.Timeout | null = null;
let isRunning = false;

const INITIAL_DELAY_MS = safePositiveInt(
  process.env.AUTH_CLEANUP_INITIAL_DELAY_MS,
  30_000,
  { max: 10 * 60 * 1000 }, // 10min cap
);

const INTERVAL_MS =
  safePositiveInt(process.env.AUTH_CLEANUP_INTERVAL_HRS, 24, { max: 24 * 30 }) *
  60 *
  60 *
  1000;

const RETENTION_DAYS = safePositiveInt(process.env.AUDIT_RETENTION_DAYS, 90, {
  max: 3650,
});

/**
 * Run all cleanups exactly once. Public so tests / cron jobs can trigger
 * a single pass without starting the scheduler. Returns deleted counts.
 */
export async function runAuthCleanupOnce(): Promise<{
  sessions: number;
  auditLog: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let sessions = 0;
  let auditLog = 0;

  try {
    sessions = await cleanupExpiredSessions();
    if (sessions > 0) {
      console.log(`[auth-cleanup] deleted ${sessions} expired session(s)`);
    }
  } catch (err) {
    const msg = `cleanupExpiredSessions: ${(err as Error).message}`;
    console.error(`[auth-cleanup] ${msg}`);
    errors.push(msg);
  }

  try {
    auditLog = await cleanupAuditLog(RETENTION_DAYS);
    if (auditLog > 0) {
      console.log(
        `[auth-cleanup] deleted ${auditLog} audit log row(s) older than ${RETENTION_DAYS}d`,
      );
    }
  } catch (err) {
    const msg = `cleanupAuditLog: ${(err as Error).message}`;
    console.error(`[auth-cleanup] ${msg}`);
    errors.push(msg);
  }

  return { sessions, auditLog, errors };
}

/**
 * Start the periodic scheduler. Idempotent — calling it twice is a no-op.
 *
 * Uses the same shape as startReconciler():
 *   - Initial setTimeout (after INITIAL_DELAY_MS)
 *   - Then setInterval (every INTERVAL_MS)
 *   - In-flight guard prevents overlap if a cleanup runs longer than the interval
 */
export function startAuthCleanup(): void {
  if (timer) return;

  console.log(
    `[auth-cleanup] scheduler started — interval=${INTERVAL_MS / 3_600_000}h, retention=${RETENTION_DAYS}d`,
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
export function stopAuthCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function wrappedRun(): Promise<void> {
  if (isRunning) {
    console.warn('[auth-cleanup] previous run still in flight, skipping this tick');
    return;
  }
  isRunning = true;
  try {
    await runAuthCleanupOnce();
  } finally {
    isRunning = false;
  }
}
