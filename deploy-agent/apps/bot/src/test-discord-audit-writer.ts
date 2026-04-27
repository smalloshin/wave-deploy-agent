/**
 * Wire-contract tests for discord-audit-writer.ts (Round 43).
 *
 * discord-audit-writer.ts is the bot consumer of the Discord NL audit-trail
 * API. It posts a 'pending' audit row BEFORE the tool runs, then PATCHes
 * the result AFTER. By design it SWALLOWS all errors (network throw,
 * non-200, JSON parse failures) into console.warn — because audit must
 * never block the operator's NL flow. A missing audit row is recoverable;
 * a broken bot is not.
 *
 * The same silent-failure design that makes the bot resilient also makes
 * regressions invisible:
 *   - URL path typo (/api/discord-audit → /api/discord-audits) → audit
 *     completely broken silently. NL keeps working. Forensic trail empty.
 *   - Body-key rename (toolName → tool_name) → API rejects every audit row
 *     silently. Same outcome.
 *   - status: 'pending' literal drift → API can't classify rows
 *   - id === null guard regression → PATCH calls fetch(`/api/discord-audit/null`)
 *     producing junk in API logs
 *
 * This file mocks globalThis.fetch and pins:
 *   - URL exact path + method
 *   - Headers (Content-Type always)
 *   - Body shape (every documented field present, status='pending' literal)
 *   - Return-value contract for every failure path (always returns
 *     null / void, never throws)
 *   - The id=null short-circuit on PATCH side
 *   - The id-typecheck on POST response (`json.id must be number`)
 *
 * Wire-contract lock pattern: R37 → R38 → R39 → R40 → R41 → R42 → R43.
 *
 * Run via: bun src/test-discord-audit-writer.ts
 */

export {}; // mark as module so top-level await is allowed under tsc

// CRITICAL: Set required env vars BEFORE the dynamic import below. config.ts
// runs `process.exit(1)` if DISCORD_TOKEN/DISCORD_APP_ID are missing.
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_APP_ID = 'test-app-id';
process.env.API_BASE_URL = 'http://test-api';
delete process.env.DEPLOY_AGENT_API_KEY;

const TEST_API = 'http://test-api';

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

// Silence the config.ts boot warnings + the helper's own console.warn calls.
console.warn = () => {};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: FetchCall[] = [];
type NextResponse =
  | { kind: 'ok'; json: unknown }
  | { kind: 'http-fail'; status: number; text?: string }
  | { kind: 'throw'; message: string }
  | { kind: 'json-throws' };

let nextResponse: NextResponse = { kind: 'ok', json: { id: 42 } };

(globalThis as { fetch?: unknown }).fetch = async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const u = typeof url === 'string' ? url : url.toString();
  let bodyParsed: unknown = undefined;
  if (init?.body) {
    try {
      bodyParsed = JSON.parse(init.body as string);
    } catch {
      bodyParsed = init.body;
    }
  }
  calls.push({
    url: u,
    method: init?.method ?? 'GET',
    headers: (init?.headers as Record<string, string>) ?? {},
    body: bodyParsed,
  });

  switch (nextResponse.kind) {
    case 'throw':
      throw new Error(nextResponse.message);
    case 'json-throws':
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid JSON');
        },
        text: async () => '',
      } as unknown as Response;
    case 'http-fail':
      return {
        ok: false,
        status: nextResponse.status,
        text: async () => nextResponse.kind === 'http-fail' ? nextResponse.text ?? '' : '',
        json: async () => null,
      } as unknown as Response;
    case 'ok':
      return {
        ok: true,
        status: 200,
        json: async () => (nextResponse.kind === 'ok' ? nextResponse.json : null),
        text: async () => JSON.stringify(nextResponse.kind === 'ok' ? nextResponse.json : null),
      } as unknown as Response;
  }
};

function reset(): void {
  calls = [];
  nextResponse = { kind: 'ok', json: { id: 42 } };
}

const { logDiscordAuditPending, logDiscordAuditResult } = await import(
  './discord-audit-writer.js'
);

const SAMPLE_PENDING = {
  discordUserId: '123456789',
  channelId: 'C012345',
  messageId: 'M99999',
  toolName: 'list_projects',
  toolInput: { foo: 'bar' },
  intentText: 'show me projects',
  llmProvider: 'claude' as const,
};

// ─── Run all tests sequentially in one async IIFE ──────────────────

(async () => {
  // ─── logDiscordAuditPending: happy path POST shape ──────────────

  reset();
  nextResponse = { kind: 'ok', json: { id: 42 } };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: returns numeric id from response', id === 42);
    check('pending: emits exactly one fetch call', calls.length === 1);
    const c = calls[0];
    check('pending: URL = `${API}/api/discord-audit`', c.url === `${TEST_API}/api/discord-audit`, c.url);
    check('pending: method = POST', c.method === 'POST');
    check(
      'pending: Content-Type header set to application/json',
      c.headers?.['Content-Type'] === 'application/json',
      JSON.stringify(c.headers),
    );
    check(
      'pending: NO Authorization header when apiKey unset',
      !('Authorization' in (c.headers ?? {})),
    );
    const body = c.body as Record<string, unknown>;
    check('pending: body.discordUserId preserved', body.discordUserId === '123456789');
    check('pending: body.channelId preserved', body.channelId === 'C012345');
    check('pending: body.messageId preserved', body.messageId === 'M99999');
    check('pending: body.toolName preserved', body.toolName === 'list_projects');
    check(
      'pending: body.toolInput preserved (object)',
      JSON.stringify(body.toolInput) === JSON.stringify({ foo: 'bar' }),
    );
    check('pending: body.intentText preserved', body.intentText === 'show me projects');
    check('pending: body.llmProvider preserved', body.llmProvider === 'claude');
    check('pending: body.status === "pending" literal', body.status === 'pending');
  }

  // ─── logDiscordAuditPending: optional fields omitted ────────────

  reset();
  nextResponse = { kind: 'ok', json: { id: 99 } };
  await logDiscordAuditPending({
    discordUserId: 'u1',
    channelId: 'c1',
    toolName: 'noop',
    toolInput: {},
  });
  {
    const body = calls[0].body as Record<string, unknown>;
    check('pending: optional messageId allowed undefined', body.messageId === undefined);
    check('pending: optional intentText allowed undefined', body.intentText === undefined);
    check('pending: optional llmProvider allowed undefined', body.llmProvider === undefined);
    check('pending: status still set to "pending"', body.status === 'pending');
  }

  // ─── logDiscordAuditPending: header dict spread ─────────────────

  reset();
  nextResponse = { kind: 'ok', json: { id: 1 } };
  await logDiscordAuditPending({
    discordUserId: 'u',
    channelId: 'c',
    toolName: 't',
    toolInput: {},
  });
  check(
    'pending: Content-Type survives no-Authorization spread',
    calls[0].headers?.['Content-Type'] === 'application/json',
  );

  // ─── logDiscordAuditPending: silent-failure paths ───────────────

  reset();
  nextResponse = { kind: 'http-fail', status: 503, text: 'service unavailable' };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: HTTP 503 → returns null (silent)', id === null);
    check('pending: HTTP 503 still issued the request', calls.length === 1);
  }

  reset();
  nextResponse = { kind: 'http-fail', status: 500 };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: HTTP 500 → returns null', id === null);
  }

  reset();
  nextResponse = { kind: 'http-fail', status: 401 };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: HTTP 401 → returns null (audit auth failure does NOT throw)', id === null);
  }

  reset();
  nextResponse = { kind: 'throw', message: 'connection refused' };
  {
    let threw = false;
    let result: number | null = -1;
    try {
      result = await logDiscordAuditPending(SAMPLE_PENDING);
    } catch {
      threw = true;
    }
    check('pending: fetch throws → does NOT propagate', threw === false);
    check('pending: fetch throws → returns null', result === null);
  }

  reset();
  nextResponse = { kind: 'json-throws' };
  {
    let threw = false;
    let result: number | null = -1;
    try {
      result = await logDiscordAuditPending(SAMPLE_PENDING);
    } catch {
      threw = true;
    }
    check('pending: response.json() throws → does NOT propagate', threw === false);
    check('pending: response.json() throws → returns null', result === null);
  }

  // ─── logDiscordAuditPending: id type-check ──────────────────────

  reset();
  nextResponse = { kind: 'ok', json: {} };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: response without id → returns null', id === null);
  }

  reset();
  nextResponse = { kind: 'ok', json: { id: 'not-a-number' } };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: response.id is string → returns null (typecheck)', id === null);
  }

  reset();
  nextResponse = { kind: 'ok', json: { id: 0 } };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: id = 0 (falsy but valid number) → returns 0', id === 0);
  }

  reset();
  nextResponse = { kind: 'ok', json: { id: -1 } };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: id = -1 → returns -1 (typecheck only checks number, not range)', id === -1);
  }

  reset();
  nextResponse = { kind: 'ok', json: { id: 42, extra: 'ignored' } };
  {
    const id = await logDiscordAuditPending(SAMPLE_PENDING);
    check('pending: extra response fields ignored, id picked', id === 42);
  }

  // ─── logDiscordAuditResult: PATCH happy path ────────────────────

  reset();
  nextResponse = { kind: 'ok', json: {} };
  await logDiscordAuditResult(42, 'success', 'all good');
  check('result: emits exactly one fetch call', calls.length === 1);
  {
    const c = calls[0];
    check(
      'result: URL = `${API}/api/discord-audit/${id}`',
      c.url === `${TEST_API}/api/discord-audit/42`,
      c.url,
    );
    check('result: method = PATCH', c.method === 'PATCH');
    check(
      'result: Content-Type header set',
      c.headers?.['Content-Type'] === 'application/json',
    );
    const body = c.body as Record<string, unknown>;
    check('result: body.status preserved', body.status === 'success');
    check('result: body.resultText preserved', body.resultText === 'all good');
  }

  // ─── logDiscordAuditResult: id=null short-circuit ──────────────

  reset();
  await logDiscordAuditResult(null, 'success', 'no audit row');
  check(
    'result: id=null → no fetch call (short-circuit)',
    calls.length === 0,
  );

  reset();
  await logDiscordAuditResult(null, 'error');
  check('result: id=null + error status still no-op', calls.length === 0);

  // ─── logDiscordAuditResult: every AuditStatus value valid ──────

  for (const status of ['success', 'error', 'denied', 'cancelled'] as const) {
    reset();
    nextResponse = { kind: 'ok', json: {} };
    await logDiscordAuditResult(7, status);
    const body = calls[0]?.body as Record<string, unknown>;
    check(`result: status="${status}" round-trips into body`, body?.status === status);
  }

  // ─── logDiscordAuditResult: optional resultText omitted ────────

  reset();
  nextResponse = { kind: 'ok', json: {} };
  await logDiscordAuditResult(7, 'success');
  {
    const body = calls[0].body as Record<string, unknown>;
    check('result: omitted resultText → body.resultText is undefined', body.resultText === undefined);
    check('result: status still set even when resultText omitted', body.status === 'success');
  }

  // ─── logDiscordAuditResult: silent-failure paths ───────────────

  reset();
  nextResponse = { kind: 'http-fail', status: 404 };
  {
    let threw = false;
    try {
      await logDiscordAuditResult(42, 'success', 'x');
    } catch {
      threw = true;
    }
    check('result: HTTP 404 → does NOT throw', threw === false);
  }

  reset();
  nextResponse = { kind: 'http-fail', status: 500 };
  {
    let threw = false;
    try {
      await logDiscordAuditResult(42, 'error', 'x');
    } catch {
      threw = true;
    }
    check('result: HTTP 500 → does NOT throw', threw === false);
  }

  reset();
  nextResponse = { kind: 'throw', message: 'network down' };
  {
    let threw = false;
    try {
      await logDiscordAuditResult(42, 'success', 'x');
    } catch {
      threw = true;
    }
    check('result: fetch throws → does NOT propagate', threw === false);
  }

  // ─── id-in-URL formatting ──────────────────────────────────────

  reset();
  nextResponse = { kind: 'ok', json: {} };
  await logDiscordAuditResult(1, 'success');
  check(
    'result: id=1 produces …/api/discord-audit/1 (no query string)',
    calls[0].url === `${TEST_API}/api/discord-audit/1` && !calls[0].url.includes('?'),
  );

  reset();
  nextResponse = { kind: 'ok', json: {} };
  await logDiscordAuditResult(0, 'success');
  check(
    'result: id=0 still fetches (only null short-circuits)',
    calls.length === 1 && calls[0].url === `${TEST_API}/api/discord-audit/0`,
  );

  reset();
  nextResponse = { kind: 'ok', json: {} };
  await logDiscordAuditResult(2147483647, 'success');
  check(
    'result: large id = 2147483647 round-trips into URL',
    calls[0].url === `${TEST_API}/api/discord-audit/2147483647`,
  );

  // ─── Body always JSON-serialized via JSON.stringify ────────────

  reset();
  nextResponse = { kind: 'ok', json: { id: 99 } };
  await logDiscordAuditPending({
    discordUserId: 'u',
    channelId: 'c',
    toolName: 'deep',
    toolInput: { nested: { a: 1, b: [1, 2, 3] } },
  });
  {
    const body = calls[0].body as Record<string, unknown>;
    check(
      'pending: body sent as JSON.stringify (nested object round-trip)',
      JSON.stringify(body.toolInput) === JSON.stringify({ nested: { a: 1, b: [1, 2, 3] } }),
    );
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
