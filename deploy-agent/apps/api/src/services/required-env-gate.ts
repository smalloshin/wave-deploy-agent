/**
 * Required-env-var gate (R49)
 *
 * Pure decider. Consumes:
 *   - python-env-extractor output (or any source-scanner producing PythonEnvRef
 *     -shaped refs)
 *   - currently-configured project env-var keys
 *   - operator-toggled `autoGenerateSecrets` setting
 *
 * Returns one of three verdicts:
 *   - 'ok' — every required ref is satisfied or there are none
 *   - 'auto-generated' — pipeline should persist newly-generated secrets,
 *     deploy proceeds with them in env
 *   - 'block' — pipeline should fail-fast with a clear error so the operator
 *     fixes the missing vars before burning Cloud Build minutes
 *
 * Conservative rules:
 *   - Default OFF for autoGenerateSecrets. False-positive (block a deploy
 *     that would have worked) is much better than false-negative (auto-gen a
 *     secret that breaks a paired credential silently).
 *   - Whitelist for auto-gen is INTENTIONALLY NARROW (no broad `*_KEY`,
 *     no `*_TOKEN`, no `*_SECRET` — those overlap with API keys / OAuth tokens).
 *   - Block wins when mixed: if ANY missing var is unfixable, we block all.
 *     The operator should fix the unfix-able ones first; on retry we'll
 *     auto-gen the others.
 */

import crypto from 'node:crypto';

export type EnvGateVerdict =
  | { kind: 'ok' }
  | {
      kind: 'auto-generated';
      generated: Record<string, string>;
      names: string[];
    }
  | {
      kind: 'block';
      missingRequired: Array<{
        name: string;
        reason: string;
        hint: string;
      }>;
    };

export interface EnvGateInput {
  /** Required env vars detected in user source. `required: false` entries are ignored. */
  refs: Array<{ name: string; required: boolean; source: string }>;
  /** Currently-configured env vars (project.config.envVars keys). */
  userProvidedKeys: Set<string>;
  /** Whether auto-generation is enabled (operator-toggled). Default OFF. */
  autoGenerateSecrets: boolean;
}

// ─── Whitelists / denylists ─────────────────────────────────────────

/**
 * Names that are SAFE to auto-generate.
 *
 * Narrow on purpose: these are all "the app generates this random value
 * and signs/verifies tokens with it" patterns, not paired credentials
 * shared with an external service. Symmetric secrets we own end-to-end.
 *
 * Order: most specific patterns first.
 */
const AUTO_GEN_PATTERNS: RegExp[] = [
  /^NEXTAUTH_SECRET$/,
  /JWT.*SECRET/,            // JWT_SECRET, LUCA_JWT_SECRET, MY_JWT_SECRET_KEY
  /SESSION_SECRET/,         // SESSION_SECRET, EXPRESS_SESSION_SECRET
  /SIGNING_KEY/,            // COOKIE_SIGNING_KEY, X_SIGNING_KEY
  /ENCRYPTION_KEY/,         // FIELD_ENCRYPTION_KEY
  /CSRF.*SECRET/,           // CSRF_SECRET, CSRF_TOKEN_SECRET
];

/**
 * Names that MUST NEVER be auto-generated. These represent paired
 * credentials owned by an external service — we don't know the secret,
 * the service does, and randomly generating one will silently break the
 * integration (auth fails, webhooks reject, API returns 401, etc.).
 *
 * Anything not in AUTO_GEN_PATTERNS and not in DENY_PATTERNS still falls
 * through to "unknown semantics → block" (see decideEnvGate logic). The
 * deny-list is here mainly to give a CLEARER reason for the block message.
 */
const DENY_PATTERNS: RegExp[] = [
  /PASSWORD/,                  // Any *_PASSWORD
  /_API_KEY$/,                 // Most external API keys
  /_ACCESS_TOKEN$/,
  /_CLIENT_SECRET$/,
  /_WEBHOOK/,                  // *_WEBHOOK, *_WEBHOOK_SECRET, *_WEBHOOK_URL
  /^STRIPE_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^GOOGLE_/,
  /^AWS_/,
  /^SUPABASE_/,
  /^DATABASE_URL$/,
  /_DSN$/,                     // SENTRY_DSN, etc.
];

// ─── Main decider ───────────────────────────────────────────────────

export function decideEnvGate(input: EnvGateInput): EnvGateVerdict {
  // 1. Filter to required-and-missing.
  const missing: Array<{ name: string; source: string }> = [];
  const seen = new Set<string>();
  for (const ref of input.refs ?? []) {
    if (!ref || typeof ref.name !== 'string') continue;
    if (!ref.required) continue;
    if (input.userProvidedKeys.has(ref.name)) continue;
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    missing.push({ name: ref.name, source: ref.source ?? 'unknown' });
  }

  if (missing.length === 0) {
    return { kind: 'ok' };
  }

  // 2. Auto-gen disabled? Block everything.
  if (!input.autoGenerateSecrets) {
    return {
      kind: 'block',
      missingRequired: missing.map((m) => ({
        name: m.name,
        reason: `required env var (detected in ${m.source}) not configured; auto-gen disabled`,
        hint: hintFor(m.name, false),
      })),
    };
  }

  // 3. Classify each missing name.
  const generated: Record<string, string> = {};
  const blockList: Array<{ name: string; reason: string; hint: string }> = [];

  for (const m of missing) {
    if (matchesAny(m.name, DENY_PATTERNS)) {
      // Paired credential — never auto-gen.
      blockList.push({
        name: m.name,
        reason: `paired credential — owned by external service, cannot auto-generate (detected in ${m.source})`,
        hint: hintFor(m.name, true),
      });
      continue;
    }
    if (matchesAny(m.name, AUTO_GEN_PATTERNS)) {
      // Safe to auto-gen.
      generated[m.name] = generateStrongSecret();
      continue;
    }
    // Unknown semantics — block. False-positive on a deploy that would
    // have worked is much better than false-negative on a paired secret
    // that we silently auto-generated.
    blockList.push({
      name: m.name,
      reason: `required env var (detected in ${m.source}) not in auto-gen whitelist — unknown semantics, refusing to guess`,
      hint: hintFor(m.name, false),
    });
  }

  // 4. Block wins when mixed.
  if (blockList.length > 0) {
    return { kind: 'block', missingRequired: blockList };
  }

  if (Object.keys(generated).length === 0) {
    return { kind: 'ok' };
  }

  return {
    kind: 'auto-generated',
    generated,
    names: Object.keys(generated).sort(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function matchesAny(name: string, patterns: RegExp[]): boolean {
  const upper = name.toUpperCase();
  return patterns.some((p) => p.test(upper));
}

function hintFor(name: string, isPairedCred: boolean): string {
  if (isPairedCred) {
    return `Set ${name} via PUT /api/projects/:id/env-vars or the dashboard. This is a paired credential the deploy-agent cannot generate.`;
  }
  return `Set ${name} via PUT /api/projects/:id/env-vars or the dashboard. The deploy-agent does not auto-generate this variable (unknown semantics).`;
}

function generateStrongSecret(): string {
  // 32 bytes hex = 64 chars. Plenty of entropy for HMAC / JWT signing.
  return crypto.randomBytes(32).toString('hex');
}

// ─── envVars string helpers ─────────────────────────────────────────
//
// project.config.envVars CAN be either a Record<string, string> (the format
// used by deploy-worker.ts:318) OR a `KEY=VALUE\n...` string (the format
// the dashboard textarea POSTs and routes/projects.ts parses with
// parseEnvVarsText). Both forms appear in the codebase. The helpers below
// normalize across both so pipeline-worker doesn't have to care.

export type EnvVarsValue = string | Record<string, string> | undefined | null;

/** Extract the SET of keys from either format. */
export function parseEnvVarKeys(value: EnvVarsValue): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key) out.add(key);
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) out.add(k);
  }
  return out;
}

/**
 * Merge new KEY=VALUE pairs into an existing envVars value (in either format).
 * Returns the SAME shape as the input:
 *   - if input is a string → returns a `KEY=VALUE\n...` string
 *   - if input is a record (or null/undefined) → returns a Record
 *
 * New values WIN over existing ones for the same key. Existing keys not in
 * `newVars` are preserved.
 */
export function mergeEnvVars(
  existing: EnvVarsValue,
  newVars: Record<string, string>,
): string | Record<string, string> {
  if (typeof existing === 'string') {
    // String mode (dashboard textarea).
    const existingMap = new Map<string, string>();
    for (const line of existing.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1);
      if (key) existingMap.set(key, val);
    }
    for (const [k, v] of Object.entries(newVars)) existingMap.set(k, v);
    return Array.from(existingMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  }
  // Record mode (the deploy-worker format).
  const merged: Record<string, string> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(newVars)) merged[k] = v;
  return merged;
}
