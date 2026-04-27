/**
 * Pure helper for the bot's API auth header.
 *
 * Round 37: extracted from api-client.ts so the contract can be locked
 * in a zero-dep tsx test without importing `config` (which calls
 * process.exit on missing required env vars).
 *
 * Behavior:
 *   - empty / falsy apiKey → {} (no Authorization header)
 *     → anonymous request on the wire
 *     → OK in AUTH_MODE=permissive
 *     → 401 in AUTH_MODE=enforced (bot warns at boot in config.ts)
 *   - populated apiKey → { Authorization: `Bearer <key>` }
 *     → server SHA-256s the raw token, looks up api_keys row,
 *       resolves user → role → permissions
 *
 * Keep this function pure: no globals, no side effects, no trimming
 * (whitespace is the operator's problem to clean in the env var).
 */
export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
