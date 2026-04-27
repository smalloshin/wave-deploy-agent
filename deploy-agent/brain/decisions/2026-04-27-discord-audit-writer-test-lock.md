# Discord audit-writer (bot side) — wire-contract lock

## Status

Active.

## Context

`apps/bot/src/discord-audit-writer.ts` (101 LOC) is the bot consumer of
the Discord NL audit-trail API. It posts a `'pending'` row BEFORE the
NL tool runs, then `PATCH`es the result (success / error / denied /
cancelled) AFTER.

Two exports, both async + side-effecting:

- `logDiscordAuditPending(opts) → Promise<number | null>` — POST /api/discord-audit, returns row id
- `logDiscordAuditResult(id, status, resultText?) → Promise<void>` — PATCH /api/discord-audit/:id

By design **every error path is swallowed** (network throw, non-200,
JSON parse failures) into `console.warn`. The rationale is correct:
audit must never block the operator. A missing audit row is recoverable;
a bot stuck because the audit table is unreachable is not.

The same silent-failure design that makes the bot resilient also makes
regressions invisible:

1. **URL path typo** (`/api/discord-audit` → `/api/discord-audits`) →
   audit completely broken silently. NL keeps working. Forensic trail
   empty for as long as it takes someone to check the table.
2. **Body-key rename** (`toolName` → `tool_name`) → API rejects every
   audit row silently. Same outcome.
3. **`status: 'pending'` literal drift** → API can't classify rows
   correctly when they're patched.
4. **`id === null` guard regression** → PATCH calls
   `fetch('/api/discord-audit/null')` producing junk in API logs +
   wasted requests for every NL invocation that failed to insert a
   pending row.
5. **`id` typecheck regression** (`typeof json.id === 'number'` →
   `'id' in json`) → callers downstream get string ids, PATCH then
   formats them into a URL that may or may not resolve.

This is the seventh application of the wire-contract lock pattern.
R37 (bot auth-headers) → R38 (shared permission-check) → R39
(upload-error-mapper) → R40 (upload-draft-storage) → R41
(cost-estimator) → R42 (state-machine) → **R43 (discord-audit-writer)**.

## Decision

### New test file `apps/bot/src/test-discord-audit-writer.ts` (53 PASS)

Coverage:

- **POST happy path** (15 cases): URL is exactly `${API}/api/discord-audit`,
  method=POST, `Content-Type: application/json`, NO Authorization
  header when apiKey unset, every body field (`discordUserId`,
  `channelId`, `messageId`, `toolName`, `toolInput`, `intentText`,
  `llmProvider`, `status: 'pending'`) present and round-trips losslessly.
  `status: 'pending'` is asserted as a literal — drift fails by name.

- **POST optional fields** (4 cases): `messageId`, `intentText`,
  `llmProvider` allowed undefined; `status` still set to 'pending'.

- **POST silent-failure paths** (8 cases): HTTP 503 / 500 / 401 →
  return null, no throw, request still issued. `fetch()` throws →
  caught, returns null. `response.json()` throws → caught, returns null.

- **POST id type-check** (5 cases):
  - Response without `id` → returns null
  - `id: 'string'` → returns null (typecheck guards)
  - `id: 0` → returns 0 (falsy but valid number — guard is `typeof === 'number'`, not truthy check)
  - `id: -1` → returns -1 (typecheck does not range-check)
  - Extra fields ignored, `id` picked

- **PATCH happy path** (7 cases): URL is exactly
  `${API}/api/discord-audit/${id}`, method=PATCH, `Content-Type: application/json`,
  `body.status` and `body.resultText` round-trip.

- **PATCH `id=null` short-circuit** (2 cases): `id=null` produces
  ZERO fetch calls — does not even attempt to PATCH. Critical guard.

- **PATCH every AuditStatus value** (4 cases): `'success'`, `'error'`,
  `'denied'`, `'cancelled'` all round-trip into body.

- **PATCH optional resultText** (2 cases): omitted resultText → body
  field is undefined; status still set.

- **PATCH silent-failure paths** (3 cases): HTTP 404 / 500 / fetch
  throw → does not propagate.

- **id-in-URL formatting** (3 cases): `id=1`, `id=0`, `id=2147483647`
  all formatted into the path component (no query string).

- **Body always JSON-serialized** (1 case): nested object/array
  round-trip proves `init.body = JSON.stringify(...)`, not FormData,
  not raw object.

### Test infrastructure

`globalThis.fetch` is replaced with a recording mock. The mock parses
`init.body` via JSON.parse so the test asserts the wire shape (proves
`JSON.stringify` was called).

Required env vars (`DISCORD_TOKEN`, `DISCORD_APP_ID`, `API_BASE_URL`)
are set on `process.env` BEFORE the dynamic import of
`./discord-audit-writer.js`, so `config.ts`'s boot-time `process.exit(1)`
guard doesn't kill the test process.

`console.warn` is silenced so the helper's own swallowed-error logs
don't pollute test output. (The handler's whole job is to warn-and-continue
on failure; the test verifies behavior, not log noise.)

All test cases run inside ONE async IIFE so each `await` lands in
serial order — critical because the mock's `nextResponse` and `calls`
are shared module state and would race if tests fired concurrently.

## Test coverage

```
$ ./scripts/sweep-zero-dep-tests.sh
...
✓  src/test-discord-audit-writer.ts (53/53)
✓  src/test-permission-check.ts (38/38)
✓  src/test-state-machine.ts (100/100)
✓  lib/test-resumable-upload.ts (91/91)
✓  lib/test-upload-draft-storage.ts (55/55)
✓  lib/test-upload-error-mapper.ts (172/172)

=== Total: 2466 passed, 0 failed across 41 files ===
```

R42 → R43 delta: **+53 tests, +1 file in sweep**.

## Consequences

**Good:**
- POST URL `/api/discord-audit` and PATCH URL `/api/discord-audit/:id`
  pinned. A typo / pluralization regression fails by name immediately.
- `status: 'pending'` literal pinned. Drift surfaces in code review.
- Every documented body field's wire name is asserted in the test —
  renaming `toolName → tool_name` in either source or API immediately
  fails the test and forces an explicit cross-package update.
- The `id === null` short-circuit on PATCH is locked. If the guard ever
  regresses, the test for "id=null → 0 fetch calls" flips by name —
  before any junk hits the API.
- The `typeof json.id === 'number'` guard is locked. The test for
  `id: 'not-a-number' → null` flips if anyone weakens the check.
- The id=0 vs id=null distinction is locked: id=0 still fetches (only
  null short-circuits). Prevents an off-by-one regression where
  somebody "simplifies" to `if (!id)` and silently drops legitimate
  audit-row 0 PATCHes.
- All four `AuditStatus` values are tested via name — adding a new
  status without updating the union in source AND in the test fails
  by name.
- Silent-failure design verified by tests, not just hoped-for. Network
  drops, 5xx responses, and JSON parse failures all explicitly assert
  "no throw, returns null" rather than relying on integration-test luck.

**Cost:**
- Top-level await + dynamic import + env-var priming in the test file
  is a new bot-side pattern (the existing bot tests are all pure
  helpers). Adds one `export {};` line so tsc treats the file as a
  module. Pattern is now established for any future bot fetch-mocked test.
- 53 tests, 1 new sweep file. Maintenance offset by the wire-shape
  guarantee.
- Cannot test "with apiKey set" path inside the same process without
  re-importing the module (config.ts freezes its values at first
  import). Documented in the test as a tradeoff — the empty-apiKey
  case proves the conditional, and R37 already locked
  `buildAuthHeaders` shape directly.

## Verification

- `cd apps/bot && bun src/test-discord-audit-writer.ts` → 53 passed, 0 failed
- `./scripts/sweep-zero-dep-tests.sh` → 2466 / 41 PASS
- `tsc --noEmit` clean across all four packages: api, bot, web, shared
- No source files modified (only new test). Runtime behavior of
  `discord-audit-writer.ts` is unchanged.

## References

- Round 37 wire-contract pattern (bot consumer): `2026-04-27-bot-api-key-bootstrap.md`
- Round 38 shared predicate (server/client parity): `2026-04-27-permission-check-shared.md`
- Round 39 web upload-error-mapper test lock: `2026-04-27-upload-error-mapper-test-lock.md`
- Round 40 web upload-draft-storage test lock: `2026-04-27-upload-draft-storage-test-lock.md`
- Round 41 api cost-estimator test lock: `2026-04-27-cost-estimator-test-lock.md`
- Round 42 shared state-machine test lock: `2026-04-27-state-machine-test-lock.md`
- Files:
  - NEW `apps/bot/src/test-discord-audit-writer.ts` (53 tests)
