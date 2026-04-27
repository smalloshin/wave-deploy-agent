/**
 * Pure read-path helpers for /api/auth/audit-log:
 *
 *   parseAuthAuditQuery(raw) → verdict { valid | invalid }
 *   buildAuthAuditListSql(query)  → { text, values }   for SELECT … LIMIT/OFFSET
 *   buildAuthAuditCountSql(query) → { text, values }   for SELECT COUNT(*)
 *
 * Mirrors discord-audit-query.ts exactly. The auth_audit_log table is the
 * other forensic table on the same admin dashboard — closing the symmetry
 * so an operator can drill into "who logged in from this IP last week"
 * the same way they drill into discord audit.
 *
 * Why split this out of the route file:
 *   - the route handler should only orchestrate (parse → execute → respond)
 *   - validation + SQL composition is pure logic that's easy to unit-test
 *     without spinning up Fastify + a DB
 *   - if MCP / GraphQL ever exposes the same filter shape we reuse the
 *     parser instead of duplicating zod schemas
 *
 * Security:
 *   - parameterized queries only ($1, $2, …), never string-concat user input
 *   - extra unknown keys are silently stripped (zod default behavior)
 *   - since > until → invalid (caller would otherwise get an empty result with
 *     no obvious reason; surface as 400)
 *   - action / userId / ipAddress all length-bounded so attackers can't
 *     stuff massive blobs through the WHERE clause
 *   - userId is UUID format only (matches users.id PK)
 *   - ipAddress is bounded; we accept either IPv4 or IPv6 textual form (the
 *     pg INET column will reject obviously-invalid casts at execute time, but
 *     we still pre-validate to avoid wasted DB round-trips)
 */

import { z } from 'zod';

// ─── Types ───────────────────────────────────────────────────

export interface ValidatedAuthAuditQuery {
  limit: number;
  offset: number;
  action?: string;
  userId?: string;
  ipAddress?: string;
  sinceIso?: string;
  untilIso?: string;
}

export type AuthAuditQueryVerdict =
  | { kind: 'valid'; query: ValidatedAuthAuditQuery }
  | { kind: 'invalid'; reason: string };

// ─── Parser ──────────────────────────────────────────────────

// Action is `VARCHAR(50)` in schema; writers all emit lowercase snake_case.
// Cap regex at 50 to match column constraint and keep filter sane.
const ACTION_REGEX = /^[a-z_]{1,50}$/;

// UUID v1-v5 (any RFC 4122). Lowercase variant — pg returns lowercase from
// gen_random_uuid().
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// IPv4 dotted quad OR IPv6 (rough; pg INET will reject anything weirder).
// We just need a length cap and a no-shell-metachar guard.
const IP_REGEX = /^[0-9a-fA-F:.]{2,45}$/;

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().regex(ACTION_REGEX, 'action must be lowercase snake_case ≤50 chars').optional(),
  userId: z.string().regex(UUID_REGEX, 'userId must be a UUID').optional(),
  ipAddress: z.string().regex(IP_REGEX, 'ipAddress must be IPv4 or IPv6').optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

function isValidIso(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

export function parseAuthAuditQuery(raw: unknown): AuthAuditQueryVerdict {
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

  const query: ValidatedAuthAuditQuery = {
    limit: data.limit,
    offset: data.offset,
    ...(data.action ? { action: data.action } : {}),
    ...(data.userId ? { userId: data.userId } : {}),
    ...(data.ipAddress ? { ipAddress: data.ipAddress } : {}),
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

function buildWhere(query: ValidatedAuthAuditQuery): FilterFragment {
  const conds: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (query.action) {
    conds.push(`al.action = $${i++}`);
    values.push(query.action);
  }
  if (query.userId) {
    conds.push(`al.user_id = $${i++}`);
    values.push(query.userId);
  }
  if (query.ipAddress) {
    // INET column equality; pg performs the textual-to-INET cast on bind.
    conds.push(`al.ip_address = $${i++}::inet`);
    values.push(query.ipAddress);
  }
  if (query.sinceIso) {
    conds.push(`al.created_at >= $${i++}`);
    values.push(query.sinceIso);
  }
  if (query.untilIso) {
    conds.push(`al.created_at <= $${i++}`);
    values.push(query.untilIso);
  }

  const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return { whereClause, values };
}

export function buildAuthAuditListSql(query: ValidatedAuthAuditQuery): {
  text: string;
  values: unknown[];
} {
  const { whereClause, values } = buildWhere(query);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;
  const text = `
    SELECT al.id, al.user_id, u.email, al.action, al.resource,
           al.ip_address, al.metadata, al.created_at
      FROM auth_audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      ${whereClause}
     ORDER BY al.created_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();
  return { text, values: [...values, query.limit, query.offset] };
}

export function buildAuthAuditCountSql(query: ValidatedAuthAuditQuery): {
  text: string;
  values: unknown[];
} {
  const { whereClause, values } = buildWhere(query);
  const text = `SELECT COUNT(*)::int AS total FROM auth_audit_log al ${whereClause}`.trim();
  return { text, values };
}
