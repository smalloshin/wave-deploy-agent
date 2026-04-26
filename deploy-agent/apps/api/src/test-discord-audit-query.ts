// Round 27 — Tests for discord-audit-query pure helpers.
//
// Covers:
//   - parseDiscordAuditQuery: zod validation, ISO date second-pass,
//     since/until ordering, empty-string handling, defaults
//   - buildListSql / buildCountSql: where-clause composition, parameter
//     numbering, that we never string-concat user input into SQL
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  parseDiscordAuditQuery,
  buildListSql,
  buildCountSql,
  type ValidatedQuery,
} from './services/discord-audit-query.js';

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

// ─── parseDiscordAuditQuery: defaults ─────────────────────────────────

{
  const v = parseDiscordAuditQuery({});
  assertEq(v.kind, 'valid', 'parse: empty input → valid');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 50, 'parse: default limit = 50');
    assertEq(v.query.offset, 0, 'parse: default offset = 0');
    assertEq(v.query.status, undefined, 'parse: default status = undefined');
  }
}

{
  const v = parseDiscordAuditQuery(null);
  assertEq(v.kind, 'valid', 'parse: null input → valid (treated as {})');
}

{
  const v = parseDiscordAuditQuery(undefined);
  assertEq(v.kind, 'valid', 'parse: undefined input → valid (treated as {})');
}

// ─── parseDiscordAuditQuery: limit / offset ──────────────────────────

{
  const v = parseDiscordAuditQuery({ limit: '100', offset: '20' });
  assert(v.kind === 'valid', 'parse: stringified limit/offset coerced');
  if (v.kind === 'valid') {
    assertEq(v.query.limit, 100, 'parse: limit "100" → 100');
    assertEq(v.query.offset, 20, 'parse: offset "20" → 20');
  }
}

{
  const v = parseDiscordAuditQuery({ limit: '0' });
  assertEq(v.kind, 'invalid', 'parse: limit 0 → invalid (min 1)');
}

{
  const v = parseDiscordAuditQuery({ limit: '201' });
  assertEq(v.kind, 'invalid', 'parse: limit 201 → invalid (max 200)');
}

{
  const v = parseDiscordAuditQuery({ limit: '200' });
  assertEq(v.kind, 'valid', 'parse: limit 200 (boundary) → valid');
}

{
  const v = parseDiscordAuditQuery({ offset: '-1' });
  assertEq(v.kind, 'invalid', 'parse: offset -1 → invalid (min 0)');
}

{
  const v = parseDiscordAuditQuery({ limit: 'abc' });
  assertEq(v.kind, 'invalid', 'parse: non-numeric limit → invalid');
}

// ─── parseDiscordAuditQuery: status enum ─────────────────────────────

for (const s of ['pending', 'success', 'error', 'denied', 'cancelled']) {
  const v = parseDiscordAuditQuery({ status: s });
  assert(v.kind === 'valid', `parse: status "${s}" → valid`);
}

{
  const v = parseDiscordAuditQuery({ status: 'completed' });
  assertEq(v.kind, 'invalid', 'parse: status "completed" (not in enum) → invalid');
}

{
  const v = parseDiscordAuditQuery({ status: 'PENDING' });
  assertEq(v.kind, 'invalid', 'parse: status case-sensitive (PENDING rejected)');
}

// ─── parseDiscordAuditQuery: toolName regex ──────────────────────────

{
  const v = parseDiscordAuditQuery({ toolName: 'publish_version' });
  assert(v.kind === 'valid', 'parse: snake_case toolName → valid');
}

{
  const v = parseDiscordAuditQuery({ toolName: 'Publish' });
  assertEq(v.kind, 'invalid', 'parse: uppercase toolName → invalid');
}

{
  const v = parseDiscordAuditQuery({ toolName: 'publish-version' });
  assertEq(v.kind, 'invalid', 'parse: hyphenated toolName → invalid');
}

{
  const v = parseDiscordAuditQuery({ toolName: 'a'.repeat(65) });
  assertEq(v.kind, 'invalid', 'parse: toolName 65 chars → invalid (max 64)');
}

{
  const v = parseDiscordAuditQuery({ toolName: 'a'.repeat(64) });
  assert(v.kind === 'valid', 'parse: toolName 64 chars (boundary) → valid');
}

{
  const v = parseDiscordAuditQuery({ toolName: 'tool1' });
  assertEq(v.kind, 'invalid', 'parse: toolName with digit → invalid (regex is [a-z_]+)');
}

// ─── parseDiscordAuditQuery: discordUserId snowflake ────────────────

{
  const v = parseDiscordAuditQuery({ discordUserId: '123456789012345678' });
  assert(v.kind === 'valid', 'parse: 18-digit snowflake → valid');
}

{
  const v = parseDiscordAuditQuery({ discordUserId: 'abc' });
  assertEq(v.kind, 'invalid', 'parse: non-numeric snowflake → invalid');
}

{
  const v = parseDiscordAuditQuery({ discordUserId: '12345abc' });
  assertEq(v.kind, 'invalid', 'parse: mixed snowflake → invalid');
}

// ─── parseDiscordAuditQuery: ISO timestamps ──────────────────────────

{
  const v = parseDiscordAuditQuery({ since: '2026-04-26T00:00:00Z' });
  assert(v.kind === 'valid', 'parse: ISO since → valid');
  if (v.kind === 'valid') {
    assertEq(v.query.sinceIso, '2026-04-26T00:00:00Z', 'parse: sinceIso preserved verbatim');
  }
}

{
  const v = parseDiscordAuditQuery({ until: '2026-04-27T23:59:59Z' });
  assert(v.kind === 'valid', 'parse: ISO until → valid');
}

{
  const v = parseDiscordAuditQuery({ since: 'yesterday' });
  assertEq(v.kind, 'invalid', 'parse: bad ISO since → invalid');
}

{
  const v = parseDiscordAuditQuery({ until: 'soon' });
  assertEq(v.kind, 'invalid', 'parse: bad ISO until → invalid');
}

{
  // empty string treated as "not provided" (don't 400 on empty form fields)
  const v = parseDiscordAuditQuery({ since: '', until: '' });
  assert(v.kind === 'valid', 'parse: empty since/until → valid (treated as missing)');
  if (v.kind === 'valid') {
    assertEq(v.query.sinceIso, undefined, 'parse: empty since → sinceIso undefined');
    assertEq(v.query.untilIso, undefined, 'parse: empty until → untilIso undefined');
  }
}

// ─── parseDiscordAuditQuery: since > until ordering ──────────────────

{
  const v = parseDiscordAuditQuery({
    since: '2026-04-27T00:00:00Z',
    until: '2026-04-26T00:00:00Z',
  });
  assertEq(v.kind, 'invalid', 'parse: since > until → invalid');
  if (v.kind === 'invalid') {
    assert(v.reason.includes('since'), 'parse: since>until reason mentions since');
  }
}

{
  const v = parseDiscordAuditQuery({
    since: '2026-04-26T00:00:00Z',
    until: '2026-04-26T00:00:00Z',
  });
  assertEq(v.kind, 'valid', 'parse: since == until → valid');
}

// ─── parseDiscordAuditQuery: extra keys silently stripped ──────────

{
  const v = parseDiscordAuditQuery({
    limit: '50',
    nonsense: 'haha',
    'DROP TABLE': 'x',
  });
  assert(v.kind === 'valid', 'parse: extra unknown keys silently stripped');
  if (v.kind === 'valid') {
    assertEq(Object.keys(v.query).sort(), ['limit', 'offset'], 'parse: only allowed keys survive');
  }
}

// ─── buildListSql: empty filter ──────────────────────────────────────

{
  const q: ValidatedQuery = { limit: 50, offset: 0 };
  const sql = buildListSql(q);
  assert(sql.text.includes('FROM discord_audit'), 'buildListSql: queries discord_audit');
  assert(sql.text.includes('ORDER BY created_at DESC'), 'buildListSql: ORDER BY created_at DESC');
  assert(sql.text.includes('LIMIT $1 OFFSET $2'), 'buildListSql: LIMIT/OFFSET use $1/$2 when no filters');
  assert(!sql.text.includes('WHERE'), 'buildListSql: no WHERE clause when no filters');
  assertEq(sql.values, [50, 0], 'buildListSql: empty filter → values [limit, offset]');
}

// ─── buildListSql: single filter ─────────────────────────────────────

{
  const q: ValidatedQuery = { limit: 50, offset: 0, status: 'denied' };
  const sql = buildListSql(q);
  assert(sql.text.includes('WHERE status = $1'), 'buildListSql: status WHERE clause');
  assert(sql.text.includes('LIMIT $2 OFFSET $3'), 'buildListSql: LIMIT/OFFSET shifts to $2/$3 with one filter');
  assertEq(sql.values, ['denied', 50, 0], 'buildListSql: status values include status first');
}

// ─── buildListSql: all filters ───────────────────────────────────────

{
  const q: ValidatedQuery = {
    limit: 25,
    offset: 50,
    status: 'success',
    toolName: 'publish_version',
    discordUserId: '123456789012345678',
    sinceIso: '2026-04-26T00:00:00Z',
    untilIso: '2026-04-27T00:00:00Z',
  };
  const sql = buildListSql(q);
  assert(sql.text.includes('status = $1'), 'buildListSql: all-filter status = $1');
  assert(sql.text.includes('tool_name = $2'), 'buildListSql: all-filter tool_name = $2');
  assert(sql.text.includes('discord_user_id = $3'), 'buildListSql: all-filter discord_user_id = $3');
  assert(sql.text.includes('created_at >= $4'), 'buildListSql: all-filter created_at >= $4');
  assert(sql.text.includes('created_at <= $5'), 'buildListSql: all-filter created_at <= $5');
  assert(sql.text.includes('LIMIT $6 OFFSET $7'), 'buildListSql: all-filter LIMIT/OFFSET shifted to $6/$7');
  assertEq(
    sql.values,
    ['success', 'publish_version', '123456789012345678', '2026-04-26T00:00:00Z', '2026-04-27T00:00:00Z', 25, 50],
    'buildListSql: all-filter values in order',
  );
}

// ─── buildListSql: AND conjunction ───────────────────────────────────

{
  const q: ValidatedQuery = { limit: 50, offset: 0, status: 'pending', toolName: 'foo' };
  const sql = buildListSql(q);
  assert(sql.text.includes(' AND '), 'buildListSql: multi-filter joined with AND');
  // Make sure it's one AND, not two
  const andCount = (sql.text.match(/ AND /g) ?? []).length;
  assertEq(andCount, 1, 'buildListSql: 2 filters → exactly 1 AND');
}

// ─── buildCountSql ──────────────────────────────────────────────────

{
  const q: ValidatedQuery = { limit: 50, offset: 0 };
  const sql = buildCountSql(q);
  assert(sql.text.includes('SELECT COUNT(*)'), 'buildCountSql: SELECT COUNT(*)');
  assert(sql.text.includes('FROM discord_audit'), 'buildCountSql: queries discord_audit');
  assert(!sql.text.includes('LIMIT'), 'buildCountSql: no LIMIT on count');
  assert(!sql.text.includes('OFFSET'), 'buildCountSql: no OFFSET on count');
  assertEq(sql.values, [], 'buildCountSql: empty filter → empty values');
}

{
  const q: ValidatedQuery = { limit: 50, offset: 0, status: 'error', toolName: 'rollback' };
  const sql = buildCountSql(q);
  assert(sql.text.includes('WHERE status = $1 AND tool_name = $2'), 'buildCountSql: WHERE composed correctly');
  assertEq(sql.values, ['error', 'rollback'], 'buildCountSql: only filter values, no limit/offset');
}

// ─── Security regressions ───────────────────────────────────────────

{
  // Try to inject SQL via a filter string. The text NEVER contains the value;
  // it only references parameter placeholders.
  const q: ValidatedQuery = { limit: 50, offset: 0, status: 'success' };
  const sql = buildListSql(q);
  assert(!sql.text.includes('success'), 'security: filter value never appears in SQL text');
  assert(sql.text.includes('$1'), 'security: filter uses $1 placeholder');
}

{
  // toolName is regex-validated upstream, but verify the SQL builder still
  // parameterizes (defense in depth).
  const q: ValidatedQuery = { limit: 50, offset: 0, toolName: 'malicious_tool' };
  const sql = buildListSql(q);
  assert(!sql.text.includes('malicious_tool'), 'security: toolName never appears in SQL text');
}

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
