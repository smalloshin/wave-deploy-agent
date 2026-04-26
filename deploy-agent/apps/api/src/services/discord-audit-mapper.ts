/**
 * Discord NL audit sanitizer — pure functions, zero side effects.
 *
 * Why this is its own module:
 *   The Discord NL bot writes to `discord_audit` BEFORE every tool call
 *   (pending row) and AFTER (success / error / denied / cancelled). The
 *   tool_input JSONB and result_text columns can contain user-supplied
 *   strings that may include API keys, passwords, bcrypt hashes, and
 *   other secrets that have no business landing in an audit table.
 *
 *   This module strips secrets BEFORE the bot POSTs to the API. The
 *   API also runs the same sanitizer on the way in as a defense-in-
 *   depth check — if the bot ever forgets to call it, the API still
 *   redacts.
 *
 * Sanitization rules (all PURE, no DB / no I/O):
 *   1. Object keys matching /password|secret|token|api[_-]?key|
 *      private[_-]?key|credential/i → value replaced with '***'.
 *   2. String values matching /^da_k_[a-zA-Z0-9]+$/ → 'da_k_***'.
 *   3. String values matching /^\$2[aby]\$\d+\$/ (bcrypt) → '$2***'.
 *   4. Recurse into nested objects, max depth 5 (cuts cycles + bombs).
 *   5. String values longer than 500 chars truncated with '…' suffix.
 *   6. Result text truncated to 2000 chars with '…[truncated]' suffix.
 *
 * Tested: see test-discord-audit-mapper.ts (QA writes after this lands).
 */

const SECRET_KEY_REGEX = /password|secret|token|api[_-]?key|private[_-]?key|credential/i;
const API_KEY_VALUE_REGEX = /^da_k_[a-zA-Z0-9]+$/;
const BCRYPT_REGEX = /^\$2[aby]\$\d+\$/;

const MAX_STRING_LEN = 500;
const MAX_RESULT_LEN = 2000;
const MAX_RECURSE_DEPTH = 5;

/**
 * Sanitize a tool-input object before it lands in `discord_audit.tool_input`.
 *
 * Rules:
 *   - Keys that LOOK like secret containers → value replaced with '***'.
 *   - Values that LOOK like API keys / bcrypt hashes → redacted.
 *   - Strings longer than 500 chars truncated.
 *   - Recursion capped at depth 5 to defuse JSON bombs / cycles.
 *
 * Returns a NEW object; never mutates input.
 */
export function sanitizeToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeObject(input, 0) as Record<string, unknown>;
}

function sanitizeObject(value: unknown, depth: number): unknown {
  if (depth >= MAX_RECURSE_DEPTH) {
    // Past the recursion cap — stringify what's left, redact, return scalar.
    if (value === null || typeof value !== 'object') return sanitizeScalar(value);
    return '[max-depth-exceeded]';
  }

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeObject(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_REGEX.test(k)) {
        out[k] = '***';
        continue;
      }
      out[k] = sanitizeObject(v, depth + 1);
    }
    return out;
  }

  return sanitizeScalar(value);
}

function sanitizeScalar(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  // Redact known secret patterns first, before length truncation.
  if (API_KEY_VALUE_REGEX.test(value)) return 'da_k_***';
  if (BCRYPT_REGEX.test(value)) return '$2***';

  if (value.length > MAX_STRING_LEN) {
    return value.slice(0, MAX_STRING_LEN) + '…';
  }
  return value;
}

/**
 * Sanitize a result-text string before it lands in `discord_audit.result_text`.
 *
 * Same secret-pattern redaction as sanitizeToolInput, but operates on a
 * single string and uses the longer 2000-char cap appropriate for
 * tool-output preview text.
 */
export function sanitizeResultText(text: string): string {
  if (typeof text !== 'string') return '';

  // Redact da_k_* tokens anywhere in the string.
  let redacted = text.replace(/da_k_[a-zA-Z0-9]+/g, 'da_k_***');
  // Redact bcrypt-looking blobs anywhere in the string.
  redacted = redacted.replace(/\$2[aby]\$\d+\$[A-Za-z0-9./]{50,}/g, '$2***');

  if (redacted.length > MAX_RESULT_LEN) {
    return redacted.slice(0, MAX_RESULT_LEN) + '…[truncated]';
  }
  return redacted;
}
