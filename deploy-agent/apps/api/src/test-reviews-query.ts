// Round 30 (deferred to round 31 for ship) — Tests for reviews-query pure helpers.
//
// Mirror of test-discord-audit-query.ts and test-auth-audit-query.ts. Closing
// the symmetry so the reviews list endpoint (security-critical decisioning
// surface — approvers act from this list) has the same parser-verdict + SQL
// composer + security-regression coverage as the audit tabs.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  parseReviewsListQuery,
  buildReviewsListSql,
  buildReviewsCountSql,
  type ValidatedReviewsQuery,
} from './services/reviews-query.js';

// R33 RBAC scope test fixtures — UUIDs to mirror real owner_id shapes.
const SAMPLE_USER_ID = '11111111-2222-3333-4444-555555555555';
const SAMPLE_USER_ID_2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── parser: defaults & shape ──────────────────────────────────────────

(() => {
  const v = parseReviewsListQuery({});
  assert(v.kind === 'valid', 'empty input → valid (defaults applied)');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 50, 'default limit = 50');
    assertEq(v.query.offset, 0, 'default offset = 0');
    assertEq(v.query.status, 'pending', 'default status = pending (preserves legacy bot/dashboard behavior)');
    assertEq(v.query.decision, undefined, 'default decision = undefined');
    assertEq(v.query.sinceIso, undefined, 'default sinceIso = undefined');
    assertEq(v.query.untilIso, undefined, 'default untilIso = undefined');
  }
})();

(() => {
  const v = parseReviewsListQuery(undefined);
  assert(v.kind === 'valid', 'undefined input → valid (treated as {})');
})();

(() => {
  const v = parseReviewsListQuery(null);
  assert(v.kind === 'valid', 'null input → valid (treated as {})');
})();

// ─── parser: limit & offset ────────────────────────────────────────────

(() => {
  const v = parseReviewsListQuery({ limit: '25', offset: '50' });
  assert(v.kind === 'valid', 'string-numeric limit/offset coerce to number');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 25, 'limit "25" → 25');
    assertEq(v.query.offset, 50, 'offset "50" → 50');
  }
})();

(() => {
  const v = parseReviewsListQuery({ limit: 200 });
  assert(v.kind === 'valid', 'limit at upper bound 200 → valid');
})();

(() => {
  const v = parseReviewsListQuery({ limit: 201 });
  assert(v.kind === 'invalid', 'limit 201 → invalid (>200)');
})();

(() => {
  const v = parseReviewsListQuery({ limit: 0 });
  assert(v.kind === 'invalid', 'limit 0 → invalid (<1)');
})();

(() => {
  const v = parseReviewsListQuery({ limit: -1 });
  assert(v.kind === 'invalid', 'limit -1 → invalid');
})();

(() => {
  const v = parseReviewsListQuery({ limit: 'abc' });
  assert(v.kind === 'invalid', 'limit "abc" → invalid (NaN coerce)');
})();

(() => {
  const v = parseReviewsListQuery({ offset: -1 });
  assert(v.kind === 'invalid', 'offset -1 → invalid');
})();

(() => {
  const v = parseReviewsListQuery({ offset: 0 });
  assert(v.kind === 'valid', 'offset 0 → valid (boundary)');
})();

// ─── parser: status enum ───────────────────────────────────────────────

(() => {
  const v = parseReviewsListQuery({ status: 'pending' });
  assert(v.kind === 'valid', 'status "pending" → valid');
  if (v.kind === 'valid') assertEq(v.query.status, 'pending', 'pending preserved');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'decided' });
  assert(v.kind === 'valid', 'status "decided" → valid');
  if (v.kind === 'valid') assertEq(v.query.status, 'decided', 'decided preserved');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'all' });
  assert(v.kind === 'valid', 'status "all" → valid');
  if (v.kind === 'valid') assertEq(v.query.status, 'all', 'all preserved');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'anyTypo' });
  assert(v.kind === 'invalid', 'status "anyTypo" → invalid (the silent-typo failure mode this rewrite fixes)');
})();

(() => {
  const v = parseReviewsListQuery({ status: '' });
  assert(v.kind === 'valid', 'status "" → valid (empty-string normalization, falls back to default pending)');
  if (v.kind === 'valid') assertEq(v.query.status, 'pending', 'empty status → pending default');
})();

// ─── parser: decision enum ─────────────────────────────────────────────

(() => {
  const v = parseReviewsListQuery({ status: 'decided', decision: 'approved' });
  assert(v.kind === 'valid', 'decision "approved" with status=decided → valid');
  if (v.kind === 'valid') assertEq(v.query.decision, 'approved', 'approved preserved');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'all', decision: 'rejected' });
  assert(v.kind === 'valid', 'decision "rejected" with status=all → valid');
  if (v.kind === 'valid') assertEq(v.query.decision, 'rejected', 'rejected preserved');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'pending', decision: 'approved' });
  assert(v.kind === 'invalid', 'decision with status=pending → invalid (contradictory: pending review has no decision)');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'decided', decision: 'maybe' });
  assert(v.kind === 'invalid', 'decision "maybe" → invalid (not in enum)');
})();

// ─── parser: ISO timestamps ────────────────────────────────────────────

(() => {
  const v = parseReviewsListQuery({ since: '2026-01-01T00:00:00Z' });
  assert(v.kind === 'valid', 'since with valid ISO → valid');
  if (v.kind === 'valid') assertEq(v.query.sinceIso, '2026-01-01T00:00:00Z', 'sinceIso preserved');
})();

(() => {
  const v = parseReviewsListQuery({ until: '2026-12-31T23:59:59Z' });
  assert(v.kind === 'valid', 'until with valid ISO → valid');
  if (v.kind === 'valid') assertEq(v.query.untilIso, '2026-12-31T23:59:59Z', 'untilIso preserved');
})();

(() => {
  const v = parseReviewsListQuery({ since: 'not-a-date' });
  assert(v.kind === 'invalid', 'since "not-a-date" → invalid');
})();

(() => {
  const v = parseReviewsListQuery({ until: 'garbage' });
  assert(v.kind === 'invalid', 'until "garbage" → invalid');
})();

(() => {
  const v = parseReviewsListQuery({ since: '' });
  assert(v.kind === 'valid', 'since "" → valid (empty-string filtered before validation)');
  if (v.kind === 'valid') assertEq(v.query.sinceIso, undefined, 'empty since → undefined');
})();

(() => {
  const v = parseReviewsListQuery({ until: '' });
  assert(v.kind === 'valid', 'until "" → valid (empty-string filtered)');
})();

(() => {
  const v = parseReviewsListQuery({
    since: '2026-01-01T00:00:00Z',
    until: '2026-06-01T00:00:00Z',
  });
  assert(v.kind === 'valid', 'since < until → valid');
})();

(() => {
  const v = parseReviewsListQuery({
    since: '2026-01-01T00:00:00Z',
    until: '2026-01-01T00:00:00Z',
  });
  assert(v.kind === 'valid', 'since == until → valid (single-instant query)');
})();

(() => {
  const v = parseReviewsListQuery({
    since: '2026-06-01T00:00:00Z',
    until: '2026-01-01T00:00:00Z',
  });
  assert(v.kind === 'invalid', 'since > until → invalid (would silently return empty rows)');
})();

// ─── parser: unknown keys silently stripped ────────────────────────────

(() => {
  const v = parseReviewsListQuery({ status: 'all', foo: 'bar', wat: 123 });
  assert(v.kind === 'valid', 'unknown keys silently stripped');
  if (v.kind === 'valid') {
    assertEq(v.query.status, 'all', 'known keys preserved');
    // Cast check: unknown keys are not in ValidatedReviewsQuery type
    assertEq((v.query as unknown as Record<string, unknown>).foo, undefined, 'foo not in output');
  }
})();

// ─── buildReviewsListSql: shape & composition ──────────────────────────

(() => {
  const v = parseReviewsListQuery({});
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(sql.text.includes('SELECT r.*'), 'list SQL selects from reviews');
  assert(sql.text.includes('JOIN scan_reports sr'), 'list SQL joins scan_reports');
  assert(sql.text.includes('JOIN projects p'), 'list SQL joins projects');
  assert(sql.text.includes('r.decision IS NULL'), 'default status=pending → IS NULL predicate');
  assert(sql.text.includes('ORDER BY r.created_at DESC'), 'list SQL orders by created_at DESC');
  assert(sql.text.includes('LIMIT'), 'list SQL has LIMIT');
  assert(sql.text.includes('OFFSET'), 'list SQL has OFFSET');
  assertEq(sql.values, [50, 0], 'default values: [limit=50, offset=0]');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'decided' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(sql.text.includes('r.decision IS NOT NULL'), 'status=decided → IS NOT NULL predicate');
  assert(!sql.text.includes('r.decision IS NULL'), 'no IS NULL predicate when decided');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'all' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(!sql.text.includes('r.decision IS NULL'), 'status=all → no IS NULL predicate');
  assert(!sql.text.includes('r.decision IS NOT NULL'), 'status=all → no IS NOT NULL predicate');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'decided', decision: 'approved' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(sql.text.includes('r.decision = $1'), 'decision filter uses $1 placeholder');
  assertEq(sql.values, ['approved', 50, 0], 'decision value first, then limit/offset');
})();

(() => {
  const v = parseReviewsListQuery({
    status: 'all',
    decision: 'rejected',
    since: '2026-01-01T00:00:00Z',
    until: '2026-06-01T00:00:00Z',
    limit: 100,
    offset: 25,
  });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(sql.text.includes('r.decision = $1'), 'decision is $1');
  assert(sql.text.includes('r.created_at >= $2'), 'since is $2');
  assert(sql.text.includes('r.created_at <= $3'), 'until is $3');
  assertEq(sql.values, [
    'rejected',
    '2026-01-01T00:00:00Z',
    '2026-06-01T00:00:00Z',
    100,
    25,
  ], 'all filters present in correct order');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'pending' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  // limit/offset placeholders should be $1 $2 when no other filter values
  assert(sql.text.includes('LIMIT $1') && sql.text.includes('OFFSET $2'),
    'placeholder numbering correct when no upstream filters');
})();

// ─── buildReviewsCountSql: shape & composition ─────────────────────────

(() => {
  const v = parseReviewsListQuery({});
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsCountSql(v.query);
  assert(sql.text.includes('COUNT(*)::int'), 'count SQL uses COUNT(*)::int');
  assert(!sql.text.includes('LIMIT'), 'count SQL does not include LIMIT');
  assert(!sql.text.includes('OFFSET'), 'count SQL does not include OFFSET');
  assertEq(sql.values, [], 'count SQL with default filter (status=pending) → empty values (status is structural predicate, not parameterized)');
})();

(() => {
  const v = parseReviewsListQuery({ status: 'decided', decision: 'approved' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsCountSql(v.query);
  assertEq(sql.values, ['approved'], 'count SQL with decision filter → one value');
  assert(sql.text.includes('r.decision = $1'), 'count SQL where clause matches');
})();

(() => {
  const v = parseReviewsListQuery({
    status: 'all',
    decision: 'rejected',
    since: '2026-01-01T00:00:00Z',
  });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsCountSql(v.query);
  assertEq(sql.values, ['rejected', '2026-01-01T00:00:00Z'],
    'count SQL preserves all filter values in order');
})();

// ─── Security regression: filter values never appear in SQL text ───────

(() => {
  const v = parseReviewsListQuery({ status: 'decided', decision: 'approved' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(!sql.text.includes("'approved'") && !sql.text.includes('"approved"'),
    'security: decision value not embedded as literal in SQL text');
})();

(() => {
  const v = parseReviewsListQuery({ since: '2026-01-01T00:00:00Z' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(!sql.text.includes('2026-01-01T00:00:00Z'),
    'security: since iso not embedded in SQL text');
})();

(() => {
  const v = parseReviewsListQuery({ until: '2026-12-31T23:59:59Z' });
  if (v.kind !== 'valid') throw new Error('setup');
  const sql = buildReviewsListSql(v.query);
  assert(!sql.text.includes('2026-12-31T23:59:59Z'),
    'security: until iso not embedded in SQL text');
})();

(() => {
  // Even if a malicious-looking value squeaks past the enum check (it can't,
  // but defensive test): the parser would reject it. This test belt-and-suspenders
  // confirms the parser doesn't leak unknown values into the SQL text.
  const v = parseReviewsListQuery({ status: "'; DROP TABLE reviews;--" });
  assert(v.kind === 'invalid', 'security: SQL-injection-shaped status rejected by enum');
})();

(() => {
  // Same defensive check for decision.
  const v = parseReviewsListQuery({ status: 'decided', decision: "approved'; DROP--" });
  assert(v.kind === 'invalid', 'security: SQL-injection-shaped decision rejected by enum');
})();

// ─── Empty-string normalization (form-default UX) ──────────────────────

(() => {
  // Browsers send empty string for unset <select> defaults. parseReviewsListQuery
  // normalizes "" → undefined so the enum default kicks in. Regression test: the
  // shape this replaces was Record<string,string> ad-hoc, where ?status= would
  // hit the else-branch and silently return decided rows.
  const v = parseReviewsListQuery({ status: '', decision: '', since: '', until: '' });
  assert(v.kind === 'valid', 'all-empty-string input → valid (form default UX)');
  if (v.kind === 'valid') {
    assertEq(v.query.status, 'pending', 'empty status → pending default');
    assertEq(v.query.decision, undefined, 'empty decision → undefined');
    assertEq(v.query.sinceIso, undefined, 'empty since → undefined');
    assertEq(v.query.untilIso, undefined, 'empty until → undefined');
  }
})();

// ─── Round 33: RBAC scope filter (IDOR fix for GET /api/reviews) ───────
//
// Reviews are linked to projects via scan_reports.project_id, and the
// existing buildReviewsListSql/buildReviewsCountSql already JOIN
// `projects p ON sr.project_id = p.id`. Round 33 adds an optional
// `scope: ListProjectsScope` parameter to both SQL builders so the route
// can pass a viewer's owner_id to filter at SQL time.
//
// The scope is server-side RBAC (derived from request.auth via
// scopeForRequest), distinct from the user-supplied query filters. We
// pass it as a separate parameter rather than folding it into
// ValidatedReviewsQuery to keep the concern boundary clean (user filters
// vs server enforcement).
//
// Default: { kind: 'all' } — preserves backwards compat for any internal
// caller that doesn't have an auth context (CLI, tests).

(() => {
  // Default scope (omitted) → no owner filter, same SQL as before round 33.
  const q: ValidatedReviewsQuery = {
    limit: 50, offset: 0, status: 'pending',
  };
  const sql = buildReviewsListSql(q);
  assert(!sql.text.includes('owner_id'), 'r33: default scope omits owner_id filter');
})();

(() => {
  // scope=all → no owner filter
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'all' });
  assert(!sql.text.includes('owner_id'), 'r33: scope=all omits owner_id filter');
})();

(() => {
  // scope=owner → adds `p.owner_id = $X` predicate
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(sql.text.includes('p.owner_id ='), 'r33: scope=owner adds p.owner_id predicate');
  assert(sql.values.includes(SAMPLE_USER_ID), 'r33: ownerId in values');
})();

(() => {
  // scope=denied → must produce a query that returns ZERO rows even if
  // the route handler accidentally executes it.
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'denied' });
  assert(
    sql.text.includes('FALSE') || sql.text.includes('1=0') || sql.text.includes('1 = 0'),
    'r33: scope=denied uses zero-row predicate',
  );
})();

(() => {
  // count SQL gets the same scope treatment
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsCountSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(sql.text.includes('p.owner_id ='), 'r33: count SQL also gets owner_id predicate');
  assert(sql.values.includes(SAMPLE_USER_ID), 'r33: count SQL ownerId in values');
})();

(() => {
  // Scope predicate stacks with user filters: owner + status=decided + decision=approved + range
  const q: ValidatedReviewsQuery = {
    limit: 50, offset: 0, status: 'decided', decision: 'approved',
    sinceIso: '2026-01-01T00:00:00Z', untilIso: '2026-12-31T23:59:59Z',
  };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(sql.text.includes('r.decision IS NOT NULL'), 'r33: stacks with status filter');
  assert(sql.text.includes('r.decision = $'), 'r33: stacks with decision filter');
  assert(sql.text.includes('r.created_at >= $'), 'r33: stacks with since');
  assert(sql.text.includes('r.created_at <= $'), 'r33: stacks with until');
  assert(sql.text.includes('p.owner_id = $'), 'r33: stacks with owner scope');
  // ownerId is in values, plus the user filter values
  assert(sql.values.includes(SAMPLE_USER_ID), 'r33: ownerId is parameterized');
  assert(sql.values.includes('approved'), 'r33: decision still parameterized');
})();

(() => {
  // Placeholder numbering remains sequential when scope is added
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'all' };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  // values: [ownerId, limit, offset] — that's 3 placeholders
  assertEq(sql.values, [SAMPLE_USER_ID, 50, 0], 'r33: scope-only values are [ownerId, limit, offset]');
  // Should reference $1, $2, $3 in order
  assert(sql.text.includes('$1') && sql.text.includes('$2') && sql.text.includes('$3'),
    'r33: placeholders $1, $2, $3 present');
})();

(() => {
  // Security regression: ownerId NEVER embedded as literal in SQL text
  const evilLookingButValid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: evilLookingButValid });
  assert(
    !sql.text.includes(evilLookingButValid),
    'r33 security: ownerId not embedded as literal in SQL text',
  );
  assert(sql.values.includes(evilLookingButValid),
    'r33 security: ownerId goes through pg parameter');
})();

(() => {
  // Even SQL-injection-shaped ownerId stays in pg params
  const evil = "'; DROP TABLE reviews;--";
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: evil });
  assert(!sql.text.includes(evil), 'r33 security: SQL-injection-shaped ownerId not embedded');
  assert(sql.values.includes(evil), 'r33 security: malicious value in values, not text');
})();

(() => {
  // IDOR contract: viewer scope is locked to their ownerId. Even if the
  // route handler somehow had a bug that passed the wrong scope, the SQL
  // composer wouldn't widen back to 'all'. This asserts the type
  // discriminant is honored.
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'all' };
  const aliceSql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  const bobSql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID_2 });
  assert(aliceSql.values.includes(SAMPLE_USER_ID),
    'r33 IDOR: alice scope SQL contains alice ownerId');
  assert(!aliceSql.values.includes(SAMPLE_USER_ID_2),
    'r33 IDOR: alice scope SQL does NOT contain bob ownerId');
  assert(bobSql.values.includes(SAMPLE_USER_ID_2),
    'r33 IDOR: bob scope SQL contains bob ownerId');
  assert(!bobSql.values.includes(SAMPLE_USER_ID),
    'r33 IDOR: bob scope SQL does NOT contain alice ownerId');
})();

(() => {
  // JOIN preserved when scope is added — still need scan_reports + projects
  // to evaluate p.owner_id at all.
  const q: ValidatedReviewsQuery = { limit: 50, offset: 0, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(sql.text.includes('JOIN scan_reports sr'), 'r33: scan_reports JOIN preserved');
  assert(sql.text.includes('JOIN projects p'), 'r33: projects JOIN preserved');
})();

(() => {
  // ORDER BY + LIMIT/OFFSET preserved
  const q: ValidatedReviewsQuery = { limit: 25, offset: 10, status: 'pending' };
  const sql = buildReviewsListSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(sql.text.includes('ORDER BY r.created_at DESC'), 'r33: ORDER BY preserved');
  assert(sql.text.includes('LIMIT'), 'r33: LIMIT preserved');
  assert(sql.text.includes('OFFSET'), 'r33: OFFSET preserved');
})();

(() => {
  // count SQL ignores LIMIT/OFFSET but still applies scope
  const q: ValidatedReviewsQuery = { limit: 25, offset: 10, status: 'pending' };
  const sql = buildReviewsCountSql(q, { kind: 'owner', ownerId: SAMPLE_USER_ID });
  assert(!sql.text.includes('LIMIT'), 'r33: count SQL has no LIMIT');
  assert(!sql.text.includes('OFFSET'), 'r33: count SQL has no OFFSET');
  assert(sql.text.includes('p.owner_id = $1'), 'r33: count SQL still scope-filtered');
  assertEq(sql.values, [SAMPLE_USER_ID], 'r33: count SQL values is just [ownerId]');
})();

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
