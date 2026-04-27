/**
 * Pure-function tests for api-client.ts buildAuthHeaders helper (Round 37).
 *
 * Locks the contract:
 *   - empty apiKey  → {} (no Authorization header) → anonymous request,
 *                     OK in AUTH_MODE=permissive, will 401 in enforced
 *   - populated key → { Authorization: `Bearer <key>` } → bot acts as the
 *                     user identity bound to that API key (RBAC Phase 2)
 *
 * This is the only seam between the bot consumer and the deploy-agent
 * API's RBAC middleware. Regression here = bot calls suddenly authenticate
 * (or stop authenticating) silently. Lock it.
 *
 * Run via: bun src/test-api-client-auth.ts
 */

import { buildAuthHeaders } from './auth-headers.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, reason = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.error(`FAIL: ${name}: ${reason}`);
  }
}

// ─── Empty / unset key ──────────────────────────────────────────────

(() => {
  const h = buildAuthHeaders('');
  check('empty string → empty object', Object.keys(h).length === 0, `got ${JSON.stringify(h)}`);
})();

(() => {
  const h = buildAuthHeaders('');
  check('empty string → no Authorization key', !('Authorization' in h));
})();

// ─── Populated key ──────────────────────────────────────────────────

(() => {
  const h = buildAuthHeaders('da_k_test123');
  check('populated key → has Authorization key', 'Authorization' in h);
})();

(() => {
  const h = buildAuthHeaders('da_k_test123');
  check('populated key → Bearer prefix', h.Authorization === 'Bearer da_k_test123', `got ${h.Authorization}`);
})();

(() => {
  const h = buildAuthHeaders('da_k_test123');
  check('populated key → exactly one header key',
    Object.keys(h).length === 1 && Object.keys(h)[0] === 'Authorization',
    `keys: ${Object.keys(h).join(',')}`);
})();

// ─── Whitespace / edge case keys (current behavior is pass-through) ─

(() => {
  const h = buildAuthHeaders('   ');
  check('whitespace-only key → still produces header (truthy)', 'Authorization' in h);
})();

(() => {
  const h = buildAuthHeaders('   ');
  check('whitespace-only key → not trimmed (caller must clean env)',
    h.Authorization === 'Bearer    ',
    `got: ${JSON.stringify(h.Authorization)}`);
})();

(() => {
  const k = '  da_k_test123  ';
  const h = buildAuthHeaders(k);
  check('leading/trailing whitespace preserved (no auto-trim)',
    h.Authorization === `Bearer ${k}`,
    `got: ${JSON.stringify(h.Authorization)}`);
})();

// ─── Special characters preserved verbatim ──────────────────────────

(() => {
  const k = 'da_k_with-dashes_and.dots/and+plus=eq';
  const h = buildAuthHeaders(k);
  check('special chars preserved verbatim',
    h.Authorization === `Bearer ${k}`,
    `got: ${JSON.stringify(h.Authorization)}`);
})();

(() => {
  const k = 'a'.repeat(512);
  const h = buildAuthHeaders(k);
  check('long key (512 chars) preserved without truncation',
    h.Authorization === `Bearer ${k}`,
    `got length: ${h.Authorization?.length ?? 0}`);
})();

// ─── Returns fresh object each call (no shared mutable state) ───────

(() => {
  const h1 = buildAuthHeaders('da_k_a');
  const h2 = buildAuthHeaders('da_k_a');
  check('two calls return distinct objects (no shared ref)', h1 !== h2);
})();

(() => {
  const h1 = buildAuthHeaders('');
  const h2 = buildAuthHeaders('');
  check('empty calls also return distinct objects', h1 !== h2);
})();

(() => {
  const h1 = buildAuthHeaders('da_k_a');
  // Mutate h1 — h2 must be unaffected
  // (Even if implementation returns shared object, this catches it.)
  (h1 as Record<string, string>).Foo = 'bar';
  const h2 = buildAuthHeaders('da_k_a');
  check('mutating result does not leak into next call',
    !('Foo' in h2),
    `keys: ${Object.keys(h2).join(',')}`);
})();

// ─── Output shape never includes Content-Type or other unintended keys ─

(() => {
  const h = buildAuthHeaders('da_k_a');
  check('result never includes Content-Type', !('Content-Type' in h));
})();

(() => {
  const h = buildAuthHeaders('da_k_a');
  check('result never includes lowercase content-type', !('content-type' in h));
})();

(() => {
  const h = buildAuthHeaders('');
  check('empty case: result has zero own properties',
    Object.getOwnPropertyNames(h).length === 0,
    `got: ${Object.getOwnPropertyNames(h).join(',')}`);
})();

// ─── RBAC behavioral contract markers ───────────────────────────────

// These tests document the RBAC AUTH_MODE behavior the bot relies on.
// They don't test the API server, but they lock the bot side of the
// contract so a refactor here can't silently change the wire shape.

(() => {
  const h = buildAuthHeaders('');
  // Permissive mode: empty headers → server treats as anonymous → allowed.
  // Enforced mode: empty headers → server returns 401.
  // Bot warns at boot if apiKey unset (config.ts:41-43).
  check('contract: empty key produces NO Authorization → anonymous on wire',
    !('Authorization' in h));
})();

(() => {
  const h = buildAuthHeaders('da_k_real_bot_key');
  // Server validates the Bearer token via auth-service:
  //   1. SHA-256 hash the raw token
  //   2. Look up api_keys row by key_hash
  //   3. Check is_active + not-expired
  //   4. Resolve to user → role → permissions
  // The bot only needs to ensure the literal `Bearer <raw>` shape lands.
  check('contract: populated key → exact "Bearer <raw>" shape on wire',
    h.Authorization === 'Bearer da_k_real_bot_key');
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
