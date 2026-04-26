/**
 * Pure read-path helpers for /api/discord-audit:
 *
 *   parseDiscordAuditQuery(raw) → verdict { valid | invalid }
 *   buildListSql(query)         → { text, values }   for SELECT … LIMIT/OFFSET
 *   buildCountSql(query)        → { text, values }   for SELECT COUNT(*)
 *
 * Why split this out of the route file:
 *   - the route handler should only orchestrate (parse → execute → respond)
 *   - validation + SQL composition is pure logic that's easy to unit-test
 *     without spinning up Fastify + a DB
 *   - if we ever want to expose the same filter shape via MCP / GraphQL we
 *     reuse the parser instead of duplicating zod schemas
 *
 * Security:
 *   - parameterized queries only ($1, $2, …), never string-concat user input
 *   - extra unknown keys are silently stripped (zod default behavior)
 *   - since > until → invalid (caller would otherwise get an empty result with
 *     no obvious reason; surface as 400)
 *   - status enum is closed-set (matches schema check column)
 *   - toolName / discordUserId / status all length-bounded so attackers can't
 *     stuff massive blobs into LIKE patterns (we don't use LIKE here, but the
 *     bound also caps log noise on bad input)
 */

import { z } from 'zod';

// ─── Types ───────────────────────────────────────────────────

export interface ValidatedQuery {
  limit: number;
  offset: number;
  status?: 'pending' | 'success' | 'error' | 'denied' | 'cancelled';
  toolName?: string;
  discordUserId?: string;
  sinceIso?: string;
  untilIso?: string;
}

export type DiscordAuditQueryVerdict =
  | { kind: 'valid'; query: ValidatedQuery }
  | { kind: 'invalid'; reason: string };

// ─── Parser ──────────────────────────────────────────────────

const STATUS_VALUES = ['pending', 'success', 'error', 'denied', 'cancelled'] as const;

// Coerce-then-validate. The route receives raw query strings (everything is
// `string | string[]`), so we coerce limit/offset numerically before zod parses.
const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(STATUS_VALUES).optional(),
  // [a-z_]{1,64} matches the bot's tool registry naming (snake_case, no digits)
  toolName: z
    .string()
    .regex(/^[a-z_]{1,64}$/, 'toolName must be lowercase snake_case ≤64 chars')
    .optional(),
  // Discord snowflakes are decimal strings up to 19 digits; cap at 64 for safety
  discordUserId: z
    .string()
    .regex(/^\d{1,64}$/, 'discordUserId must be a numeric snowflake ≤64 chars')
    .optional(),
  // ISO-8601 — accepted as raw string then validated via Date parse below
  since: z.string().optional(),
  until: z.string().optional(),
});

function isValidIso(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

export function parseDiscordAuditQuery(raw: unknown): DiscordAuditQueryVerdict {
  const parsed = QuerySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const reason = first
      ? `${first.path.join('.') || 'query'}: ${first.message}`
      : 'invalid query';
    return { kind: 'invalid', reason };
  }
  const data = parsed.data;

  // ISO-8601 second-pass validation. Empty string treated as missing.
  let sinceIso: string | undefined;
  if (data.since !== undefined && data.since !== '') {
    if (!isValidIso(data.since)) {
      return { kind: 'invalid', reason: 'since: invalid ISO-8601 timestamp' };
    }
    sinceIso = data.since;
  }
  let untilIso: string | undefined;
  if (data.until !== undefined && data.until !== '') {
    if (!isValidIso(data.until)) {
      return { kind: 'invalid', reason: 'until: invalid ISO-8601 timestamp' };
    }
    untilIso = data.until;
  }

  // Range sanity: since > until would silently return empty rows.
  if (sinceIso && untilIso) {
    if (new Date(sinceIso).getTime() > new Date(untilIso).getTime()) {
      return { kind: 'invalid', reason: 'since must be <= until' };
    }
  }

  const query: ValidatedQuery = {
    limit: data.limit,
    offset: data.offset,
    ...(data.status ? { status: data.status } : {}),
    ...(data.toolName ? { toolName: data.toolName } : {}),
    ...(data.discordUserId ? { discordUserId: data.discordUserId } : {}),
    ...(sinceIso ? { sinceIso } : {}),
    ...(untilIso ? { untilIso } : {}),
  };
  return { kind: 'valid', query };
}

// ─── SQL builders ─────────────────────────────────────────────

interface FilterFragment {
  whereClause: string;
  values: unknown[];
}

function buildWhere(query: ValidatedQuery): FilterFragment {
  const conds: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (query.status) {
    conds.push(`status = $${i++}`);
    values.push(query.status);
  }
  if (query.toolName) {
    conds.push(`tool_name = $${i++}`);
    values.push(query.toolName);
  }
  if (query.discordUserId) {
    conds.push(`discord_user_id = $${i++}`);
    values.push(query.discordUserId);
  }
  if (query.sinceIso) {
    conds.push(`created_at >= $${i++}`);
    values.push(query.sinceIso);
  }
  if (query.untilIso) {
    conds.push(`created_at <= $${i++}`);
    values.push(query.untilIso);
  }

  const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return { whereClause, values };
}

export function buildListSql(query: ValidatedQuery): {
  text: string;
  values: unknown[];
} {
  const { whereClause, values } = buildWhere(query);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;
  const text = `
    SELECT id, discord_user_id, channel_id, message_id, tool_name,
           tool_input, intent_text, status, result_text, llm_provider,
           created_at, updated_at
      FROM discord_audit
      ${whereClause}
     ORDER BY created_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();
  return { text, values: [...values, query.limit, query.offset] };
}

export function buildCountSql(query: ValidatedQuery): {
  text: string;
  values: unknown[];
} {
  const { whereClause, values } = buildWhere(query);
  const text = `SELECT COUNT(*)::int AS total FROM discord_audit ${whereClause}`.trim();
  return { text, values };
}
