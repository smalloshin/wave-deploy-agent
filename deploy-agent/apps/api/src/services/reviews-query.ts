/**
 * Pure read-path helpers for /api/reviews:
 *
 *   parseReviewsListQuery(raw) → verdict { valid | invalid }
 *   buildReviewsListSql(query)  → { text, values }   for SELECT … LIMIT/OFFSET
 *   buildReviewsCountSql(query) → { text, values }   for SELECT COUNT(*)
 *
 * Same playbook as discord-audit-query.ts and auth-audit-query.ts. Reviews
 * is the security-critical decisioning surface (approvers act from this
 * list), and was the last list endpoint still using the pre-round-22
 * `request.query as Record<string, string>` ad-hoc pattern. Boiling it
 * gives admins the same pagination / filter UX as the audit tabs and
 * eliminates the silent-typo failure mode where `?status=anyTypo` falls
 * into the else branch and returns an unexpected dataset.
 *
 * Why split this out of the route file:
 *   - the route handler should only orchestrate (parse → execute → respond)
 *   - validation + SQL composition is pure logic that's easy to unit-test
 *     without spinning up Fastify + a DB
 *   - the query parser becomes reusable from MCP / GraphQL / CLI without
 *     duplicating the zod schema
 *
 * Backwards compatibility: legacy callers using `?status=pending` only
 * (no other params) get back the same un-paginated `{ reviews }` envelope
 * the route always returned. Any new param triggers the paged envelope
 * `{ reviews, total, limit, offset }`. The route handler decides which
 * envelope to send based on whether the caller provided pagination hints.
 *
 * Security:
 *   - parameterized queries only ($1, $2, …), never string-concat user input
 *   - extra unknown keys silently stripped (zod default)
 *   - since > until → invalid (caller would otherwise get an empty result with
 *     no obvious reason; surface as 400)
 *   - status / decision are strict enums — an unknown value returns 400
 *     instead of silently flipping branches
 */

import { z } from 'zod';
import type { ListProjectsScope } from './projects-query.js';

// ─── Types ───────────────────────────────────────────────────

export type ReviewStatusFilter = 'pending' | 'decided' | 'all';
export type ReviewDecisionFilter = 'approved' | 'rejected';

export interface ValidatedReviewsQuery {
  limit: number;
  offset: number;
  status: ReviewStatusFilter;
  decision?: ReviewDecisionFilter;
  sinceIso?: string;
  untilIso?: string;
}

export type ReviewsQueryVerdict =
  | { kind: 'valid'; query: ValidatedReviewsQuery }
  | { kind: 'invalid'; reason: string };

// ─── Parser ──────────────────────────────────────────────────

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'decided', 'all']).default('pending'),
  decision: z.enum(['approved', 'rejected']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

function isValidIso(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

export function parseReviewsListQuery(raw: unknown): ReviewsQueryVerdict {
  // Empty string in status filter (form default) → undefined so the enum
  // default kicks in. Same trick as discord-audit-query / auth-audit-query.
  const normalized = raw && typeof raw === 'object'
    ? Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          ([, v]) => v !== '',
        ),
      )
    : raw;

  const parsed = QuerySchema.safeParse(normalized ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const reason = first
      ? `${first.path.join('.') || 'query'}: ${first.message}`
      : 'invalid query';
    return { kind: 'invalid', reason };
  }
  const data = parsed.data;

  // ISO-8601 second-pass validation. Empty string already filtered above.
  let sinceIso: string | undefined;
  if (data.since !== undefined) {
    if (!isValidIso(data.since)) {
      return { kind: 'invalid', reason: 'since: invalid ISO-8601 timestamp' };
    }
    sinceIso = data.since;
  }
  let untilIso: string | undefined;
  if (data.until !== undefined) {
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

  // `decision` only makes sense when status is `decided` or `all`. If a
  // caller passes status=pending + decision=approved, that's contradictory
  // (a pending review by definition has no decision yet). Reject up-front
  // so the operator gets a clear error rather than an empty list.
  if (data.status === 'pending' && data.decision !== undefined) {
    return { kind: 'invalid', reason: 'decision filter is incompatible with status=pending' };
  }

  const query: ValidatedReviewsQuery = {
    limit: data.limit,
    offset: data.offset,
    status: data.status,
    ...(data.decision ? { decision: data.decision } : {}),
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

function buildWhere(
  query: ValidatedReviewsQuery,
  scope: ListProjectsScope = { kind: 'all' },
): FilterFragment {
  const conds: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // R33 — RBAC scope FIRST, so its placeholder is $1 and downstream user
  // filters numbered after it. This puts the server-side enforcement at the
  // top of the WHERE clause (auditors reading the SQL see "filtered by
  // owner first, then user query"). For 'denied' we emit FALSE — not a
  // parameterized predicate — so empty result regardless of other filters.
  if (scope.kind === 'owner') {
    conds.push(`p.owner_id = $${i++}`);
    values.push(scope.ownerId);
  } else if (scope.kind === 'denied') {
    // Postgres optimizer short-circuits FALSE; no scan, no rows.
    conds.push('FALSE');
  }
  // scope.kind === 'all' adds no predicate

  // Status maps to a SQL predicate, not a parameter (the predicate shape
  // differs per branch — IS NULL vs IS NOT NULL — so it's structural, not
  // user-supplied data).
  if (query.status === 'pending') {
    conds.push('r.decision IS NULL');
  } else if (query.status === 'decided') {
    conds.push('r.decision IS NOT NULL');
  }
  // status === 'all' adds no predicate

  if (query.decision) {
    conds.push(`r.decision = $${i++}`);
    values.push(query.decision);
  }
  if (query.sinceIso) {
    conds.push(`r.created_at >= $${i++}`);
    values.push(query.sinceIso);
  }
  if (query.untilIso) {
    conds.push(`r.created_at <= $${i++}`);
    values.push(query.untilIso);
  }

  const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return { whereClause, values };
}

export function buildReviewsListSql(
  query: ValidatedReviewsQuery,
  scope: ListProjectsScope = { kind: 'all' },
): {
  text: string;
  values: unknown[];
} {
  const { whereClause, values } = buildWhere(query, scope);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;
  const text = `
    SELECT r.*, sr.project_id, p.name as project_name, p.slug as project_slug
      FROM reviews r
      JOIN scan_reports sr ON r.scan_report_id = sr.id
      JOIN projects p ON sr.project_id = p.id
      ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();
  return { text, values: [...values, query.limit, query.offset] };
}

export function buildReviewsCountSql(
  query: ValidatedReviewsQuery,
  scope: ListProjectsScope = { kind: 'all' },
): {
  text: string;
  values: unknown[];
} {
  const { whereClause, values } = buildWhere(query, scope);
  const text = `
    SELECT COUNT(*)::int AS total
      FROM reviews r
      JOIN scan_reports sr ON r.scan_report_id = sr.id
      JOIN projects p ON sr.project_id = p.id
      ${whereClause}
  `.trim();
  return { text, values };
}
