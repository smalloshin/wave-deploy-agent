/**
 * GCP resource polling helper (R57 — DRY across R47/R57)
 *
 * 為什麼存在：R47 reconciler-recovery 已經寫過一次「等 Cloud Run service ready」
 * 的 polling logic。R57 migration runner 要等 Cloud Run Jobs execution 完成，
 * 一樣是 GCP REST polling pattern。抽成 shared helper 避免 DRY violation。
 *
 * 設計原則：
 *   - 不知道 GCP 細節（什麼 service / 什麼 status code），由 caller 提供 fetcher
 *   - Exponential backoff（3s → 9s → 27s）避免暴打 GCP API
 *   - 總超時上限可配置（migration 10 min / Cloud Run ready 5 min）
 *   - 永不 throw — 失敗回 verdict object
 *
 * 為什麼是純結構（除了 setTimeout 跟 fetcher 本身）：
 *   - 沒有對 GCP 的直接依賴
 *   - fetcher 由 caller 注入 → 測試時 mock fetcher 就好
 *   - 退避時間表 / 終止狀態判定 / 超時邏輯都可單元測試
 */

/** Caller 提供的 fetcher：呼叫 GCP REST API 拿目前 status，回傳 verdict。 */
export type GcpStatusFetcher<TStatus> = () => Promise<
  | { kind: 'ok'; status: TStatus }
  | { kind: 'error'; reason: string; httpStatus?: number }
>;

/** 是否該停止輪詢的 predicate。 */
export type IsTerminalFn<TStatus> = (status: TStatus) =>
  | { terminal: true; outcome: 'succeeded' | 'failed' | 'cancelled'; reason?: string }
  | { terminal: false };

export interface PollOptions {
  /** 最大總等待時間（ms）。超過 → outcome='timeout'。 */
  totalTimeoutMs: number;
  /** 第一次 poll 前等多久（ms）。預設 3000。Cloud Run Jobs cold start 可給 3-5s。 */
  initialDelayMs?: number;
  /** Backoff 倍率，預設 3（3s → 9s → 27s）。 */
  backoffFactor?: number;
  /** 最大 single-poll 等待間隔（ms），預設 30000 = 30s。 */
  maxIntervalMs?: number;
  /** 連續 fetcher error 容忍次數（預設 3）。超過視為 outcome='fetcher_error'。 */
  maxFetcherErrors?: number;
}

export type PollResult<TStatus> =
  | { outcome: 'succeeded'; status: TStatus; attempts: number; durationMs: number }
  | { outcome: 'failed'; status: TStatus | null; reason: string; attempts: number; durationMs: number }
  | { outcome: 'cancelled'; status: TStatus | null; reason: string; attempts: number; durationMs: number }
  | { outcome: 'timeout'; lastStatus: TStatus | null; attempts: number; durationMs: number }
  | { outcome: 'fetcher_error'; lastError: string; attempts: number; durationMs: number };

/**
 * Poll a GCP resource until it reaches a terminal state, times out, or fetcher
 * fails repeatedly. Pure logic apart from setTimeout / fetcher.
 *
 * @param fetcher  caller-provided async function returning current status
 * @param isTerminal  caller-provided predicate to detect terminal state
 * @param opts  timeout, backoff, error tolerance
 */
export async function pollGcpUntilTerminal<TStatus>(
  fetcher: GcpStatusFetcher<TStatus>,
  isTerminal: IsTerminalFn<TStatus>,
  opts: PollOptions,
): Promise<PollResult<TStatus>> {
  const start = Date.now();
  const initialDelay = opts.initialDelayMs ?? 3000;
  const backoff = opts.backoffFactor ?? 3;
  const maxInterval = opts.maxIntervalMs ?? 30_000;
  const maxFetcherErrors = opts.maxFetcherErrors ?? 3;

  let attempts = 0;
  let lastStatus: TStatus | null = null;
  let consecutiveErrors = 0;
  let consecutiveLastError = '';
  let nextDelay = initialDelay;

  while (true) {
    // Check total timeout BEFORE sleeping (avoids 1 extra wait at the end).
    const elapsed = Date.now() - start;
    if (elapsed >= opts.totalTimeoutMs) {
      return {
        outcome: 'timeout',
        lastStatus,
        attempts,
        durationMs: elapsed,
      };
    }

    await sleep(Math.min(nextDelay, opts.totalTimeoutMs - elapsed));
    attempts++;

    const result = await fetcher();
    if (result.kind === 'error') {
      consecutiveErrors++;
      consecutiveLastError = result.reason;
      if (consecutiveErrors >= maxFetcherErrors) {
        return {
          outcome: 'fetcher_error',
          lastError: result.reason,
          attempts,
          durationMs: Date.now() - start,
        };
      }
      // Continue polling — transient error, will retry
      nextDelay = Math.min(nextDelay * backoff, maxInterval);
      continue;
    }

    consecutiveErrors = 0;
    consecutiveLastError = '';
    lastStatus = result.status;

    const verdict = isTerminal(result.status);
    if (verdict.terminal) {
      const durationMs = Date.now() - start;
      if (verdict.outcome === 'succeeded') {
        return { outcome: 'succeeded', status: result.status, attempts, durationMs };
      }
      if (verdict.outcome === 'failed') {
        return {
          outcome: 'failed',
          status: result.status,
          reason: verdict.reason ?? 'terminal failure',
          attempts,
          durationMs,
        };
      }
      // cancelled
      return {
        outcome: 'cancelled',
        status: result.status,
        reason: verdict.reason ?? 'cancelled',
        attempts,
        durationMs,
      };
    }

    // Not terminal yet — back off and continue
    nextDelay = Math.min(nextDelay * backoff, maxInterval);
  }
  // unreachable
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure helper: compute the sequence of delays a poll session would take given
 * a config. Useful for tests and for documenting/displaying expected behavior.
 *
 * Returns array of delays in ms, ending when cumulative time would exceed
 * totalTimeoutMs.
 *
 * Pure — no side effects, no setTimeout.
 */
export function computeBackoffSchedule(opts: PollOptions): number[] {
  const initial = opts.initialDelayMs ?? 3000;
  const factor = opts.backoffFactor ?? 3;
  const max = opts.maxIntervalMs ?? 30_000;
  const totalCap = opts.totalTimeoutMs;

  const delays: number[] = [];
  let next = initial;
  let cumulative = 0;
  while (true) {
    const actual = Math.min(next, totalCap - cumulative);
    if (actual <= 0) break;
    delays.push(actual);
    cumulative += actual;
    if (cumulative >= totalCap) break;
    next = Math.min(next * factor, max);
  }
  return delays;
}
