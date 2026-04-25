/**
 * Safe number coercion helpers.
 *
 * Why this file exists:
 * Across the codebase we feed Number() / parseInt() with values that originate
 * from env vars, query strings, or external APIs (GCS object metadata, etc.).
 * `Number(undefined)` and `Number("abc")` both return NaN. Once NaN enters a
 * pipeline it propagates silently:
 *   - `Math.min(NaN, 1000) === NaN`  → SQL `LIMIT NaN` blows up
 *   - `NaN > threshold` is always false → wrong branch silently taken
 *   - `arr.reduce((s, x) => s + Number(x.size), 0)` → total becomes NaN if any element is bad
 *
 * The 2026-04-25 RBAC bug (`split(':')[1]` truncating route keys with embedded
 * `:param` segments) was the same class of failure: an unsafe coercion that
 * passed type-check but was wrong at runtime. These helpers exist so we have
 * one obvious place to do the safe thing.
 *
 * Conventions:
 *   - All helpers return a finite number or the supplied fallback, never NaN.
 *   - Clamping is opt-in via `min` / `max`; both inclusive.
 *   - Empty string and whitespace are treated as missing → fallback.
 */

export interface SafeNumberOptions {
  /** Inclusive lower bound. Result is clamped if below. */
  min?: number;
  /** Inclusive upper bound. Result is clamped if above. */
  max?: number;
}

/**
 * Parse an arbitrary value into a finite number, falling back if parsing fails.
 *
 * Accepts:
 *   - number (NaN / Infinity → fallback)
 *   - string (parsed via Number(); empty / whitespace → fallback)
 *   - bigint (converted; out-of-Number-range still becomes finite or fallback)
 * Anything else (object, null, undefined, boolean) → fallback.
 *
 * Optional clamp via `opts.min` / `opts.max`.
 */
export function safeNumber(
  value: unknown,
  fallback: number,
  opts: SafeNumberOptions = {},
): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      n = fallback;
    } else {
      n = Number(trimmed);
    }
  } else if (typeof value === 'bigint') {
    n = Number(value);
  } else {
    n = fallback;
  }
  if (!Number.isFinite(n)) n = fallback;
  if (opts.min !== undefined && n < opts.min) n = opts.min;
  if (opts.max !== undefined && n > opts.max) n = opts.max;
  return n;
}

/**
 * Parse a positive integer (>= 1). Convenience wrapper for env vars and
 * pagination limits where 0 / negative values are nonsensical.
 *
 * Truncates toward zero (1.9 → 1, "3.7" → 3). Non-numeric / NaN → fallback.
 */
export function safePositiveInt(
  value: unknown,
  fallback: number,
  opts: { max?: number } = {},
): number {
  const n = safeNumber(value, fallback);
  const truncated = Math.trunc(n);
  const lowerBounded = truncated >= 1 ? truncated : fallback;
  if (opts.max !== undefined && lowerBounded > opts.max) return opts.max;
  return lowerBounded;
}

/**
 * Parse a non-negative byte count (>= 0). For GCS / Artifact Registry size
 * fields where the source returns a string-encoded int that we want to sum.
 *
 * Negative or non-numeric → 0 (not fallback) so accumulators don't poison.
 */
export function safeBytes(value: unknown): number {
  const n = safeNumber(value, 0);
  return n >= 0 ? n : 0;
}

/**
 * Parse a TCP port (1..65535). For Dockerfile EXPOSE / ENV PORT / runtime
 * config. Returns null if the value isn't a sane port — caller decides whether
 * to fall back to a default or skip.
 *
 * We don't allow 0 (system "pick any") because Cloud Run rejects it; we don't
 * allow 65536+ because they're not real ports. Non-integer values are rejected.
 */
export function safeParsePort(value: unknown): number | null {
  const n = safeNumber(value, NaN);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 65535) return null;
  return n;
}
