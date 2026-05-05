// Runtime settings reader — small helper for services that need to
// branch on operator-toggled flags (e.g. requireReview).
//
// Keeps reads tolerant: if the `settings` row hasn't been created yet
// (fresh install, no one has opened the settings page), returns the
// safe defaults instead of throwing. Callers can therefore treat this
// as a pure config lookup.

import { query } from '../db/index';

export interface RuntimeSettings {
  /** Human review gate before deploy. Default true. When false, the
   *  pipeline auto-approves the review record and triggers deploy
   *  immediately after scan + LLM analysis. */
  requireReview: boolean;
  /** R49: when true, the pipeline-worker env-gate auto-generates strong
   *  values for required-but-missing secrets that match a NARROW
   *  whitelist (JWT_SECRET / NEXTAUTH_SECRET / SESSION_SECRET /
   *  *_SIGNING_KEY / *_ENCRYPTION_KEY / *_CSRF*SECRET).
   *  Default false — operator must opt in. False-positive (block a deploy
   *  that would have worked) is much better than false-negative (auto-gen
   *  a secret that breaks a paired service silently). */
  autoGenerateSecrets: boolean;
  /** R57: when true, deploy-worker Step 3.5 runs DB migrations via Cloud
   *  Run Jobs before swapping Cloud Run revision. Default false — operator
   *  must opt in. Reviewer flagged that default-on contradicts the v1
   *  no-rollback stance: forward-only migration + deploy fail = DB ahead
   *  of code. Operator should test in staging first.
   *  When false, migration step is skipped entirely (legacy behavior). */
  runMigrations: boolean;
}

export const RUNTIME_DEFAULTS: RuntimeSettings = {
  requireReview: true,
  autoGenerateSecrets: false,
  runMigrations: false,
};

/**
 * Pure parser: turn a row's `data` (JSON object or JSON string) into
 * RuntimeSettings, falling back to defaults on missing/invalid fields.
 * Exported so unit tests can exercise the merging logic without a DB.
 */
export function parseRuntimeSettings(stored: unknown): RuntimeSettings {
  let data: Record<string, unknown> = {};
  if (typeof stored === 'string') {
    try { data = JSON.parse(stored) as Record<string, unknown>; } catch { /* malformed JSON → defaults */ }
  } else if (stored && typeof stored === 'object') {
    data = stored as Record<string, unknown>;
  }
  return {
    requireReview:
      typeof data.requireReview === 'boolean' ? data.requireReview : RUNTIME_DEFAULTS.requireReview,
    autoGenerateSecrets:
      typeof data.autoGenerateSecrets === 'boolean'
        ? data.autoGenerateSecrets
        : RUNTIME_DEFAULTS.autoGenerateSecrets,
    runMigrations:
      typeof data.runMigrations === 'boolean'
        ? data.runMigrations
        : RUNTIME_DEFAULTS.runMigrations,
  };
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  try {
    const result = await query('SELECT data FROM settings WHERE id = 1');
    return parseRuntimeSettings(result.rows[0]?.data);
  } catch {
    return RUNTIME_DEFAULTS;
  }
}
