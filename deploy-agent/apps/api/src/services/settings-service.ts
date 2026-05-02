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
}

export const RUNTIME_DEFAULTS: RuntimeSettings = {
  requireReview: true,
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
