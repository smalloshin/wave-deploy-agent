# Bot API Key Bootstrap — RBAC Phase 2 consumer wiring

## Status

Active.

## Context

Round 25 shipped the RBAC server-side: 5 tables (roles / users / sessions
/ api_keys / auth_audit_log) + bcrypt + SHA-256 + middleware that checks
`Authorization: Bearer <token>` against `api_keys` (or session cookie
against `sessions`). `AUTH_MODE=permissive` lets unauthenticated requests
through with a warning; `AUTH_MODE=enforced` returns 401.

Round 31–36 closed the RBAC read-side and write-side IDOR audit (4 P0
list + 6 P1 single-resource + 16 single-resource mutating + 1 bulk
mutating). All authenticated viewers now see only data they own
(or all if admin).

The remaining gap is the **consumer side**. Three live consumers hit
the API:

1. Web Dashboard (`apps/web`) — has a login UI prototype (Round 25)
   that issues a session cookie. Working in permissive mode; needs
   wider rollout in Round 38+.
2. Discord Bot (`apps/bot`) — slash commands + NL handler that calls
   the API on behalf of operators.
3. MCP Server — not yet implemented.

When `AUTH_MODE=enforced` flips on, every anonymous consumer breaks.
The Bot is the highest-volume non-browser consumer (every approve / reject
/ status / list call goes through it), so its API-key wiring is the
gating dependency for the enforced-mode flip.

## Decision

Wire the Bot's API key as a single env var (`DEPLOY_AGENT_API_KEY`)
read at boot and threaded into every API call via a pure header helper.

Concretely:

1. **`apps/bot/src/config.ts`** already exposes
   `apiKey: process.env.DEPLOY_AGENT_API_KEY ?? ''` (Round 25 era) and
   warns at boot if unset (`'requests will be anonymous (OK in permissive
   mode; will 401 in enforced mode)'`).
2. **`apps/bot/src/api-client.ts`** already calls `authHeaders()` on
   every `get` / `post` / `apiDelete` (Round 25 era).
3. **Round 37 addition**: extract the header-building logic into a
   pure module `apps/bot/src/auth-headers.ts` and lock the contract
   with a zero-dep tsx test (`test-api-client-auth.ts`, 18 cases).

The pure helper is intentionally tiny:

```typescript
export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
```

That's the entire contract. Test cases lock:
- empty / unset key → `{}` (no Authorization on wire)
- populated key → exact `Bearer <raw>` shape
- whitespace pass-through (caller cleans the env var, not us)
- fresh object per call (no shared mutable state)
- never includes `Content-Type` or other unintended keys

## Why a pure helper instead of inline lambda

The Bot is the *only* place where bot-side and server-side RBAC interact
on the wire. Regression here is silent: the bot calls succeed in
permissive mode regardless, and only fail when enforced mode flips on
(which is when staging is most stressed). Locking the wire shape with
a unit test makes regression loud immediately during the sweep, not
in production at flip time.

Pure helper also avoids the test-isolation problem: `api-client.ts`
imports `config`, which calls `process.exit(1)` on missing
`DISCORD_TOKEN` / `DISCORD_APP_ID`. Importing api-client in a test
crashes the test runner. Extracting the header builder breaks that
dependency.

## Why no whitespace trimming

A whitespace key is an env-var operator error. Two options for handling:

- **Trim defensively** in the bot. Hides the bug, makes
  `DEPLOY_AGENT_API_KEY=" da_k_xxx "` silently work.
- **Pass through verbatim**. The server's SHA-256 lookup will fail and
  return 401, surfacing the typo immediately.

Pass-through wins. Defensive trimming can mask real key-rotation
mistakes (e.g., copying a key with trailing whitespace from a 1Password
field). The 401 is the better error.

## Consequences

**Good:**

- Bot is now `enforced`-ready. Set `DEPLOY_AGENT_API_KEY` in the bot's
  Cloud Run env, mint an api_keys row server-side, flip
  `AUTH_MODE=enforced` on the API. Bot keeps working; anonymous
  callers (curl, browsers without session) start getting 401.
- Wire shape is locked by 18 tests. Any future refactor that breaks
  the empty-key → no-header contract (e.g., adds a default `User-Agent`
  or an X-Bot-Identity header) will fail the sweep before merge.
- Pure helper is reusable: when the Web Dashboard or MCP server need
  Bearer headers, they import the same module instead of reinventing
  the predicate.

**Cost:**

- Adds one new file (`auth-headers.ts`, 22 LOC including doc comment)
  and one new test file (`test-api-client-auth.ts`, 18 cases). Bot
  source tree grows by ~150 LOC total. Worth it for the wire-contract
  lock-down.

**Boss-gated next steps** (NOT done in this round, requires user
input on identity model):

1. Decide the bot's user identity:
   - Option a: dedicated `bot@deploy-agent.local` user in `users`
     table with `reviewer` role (least-privilege; can list/approve
     reviews but not create new projects)
   - Option b: shared admin user, with the bot key carrying a
     scoped-down `permissions` array (api_keys.permissions overrides
     role permissions)
   - Option c: per-operator bot, where each Discord user has their
     own api_keys row mapped to their own user — but bot identity
     is shared so this doesn't add real attribution
   - **Default if not chosen**: Option a, it's the standard
     least-privilege pattern for a service-account-style consumer.
2. Mint the api_keys row:
   - Need an admin route (`POST /api/auth/api-keys`) — already exists
     per Round 25 plan, untested for this flow specifically.
3. Set the Cloud Run env var on `deploy-agent-bot` Cloud Run.
4. Verify in permissive mode (bot calls authenticated, behavior
   unchanged) before flipping `AUTH_MODE=enforced`.

## Verification

- `bun apps/bot/src/test-api-client-auth.ts` → 18 passed, 0 failed.
- `./scripts/sweep-zero-dep-tests.sh` → 1897 / 34 PASS (was 1879/33 at
  R35; +18 in 1 new file).
- `tsc --noEmit` clean in both `apps/bot` and `apps/api`.

## References

- Round 25 RBAC system: `2026-04-25-rbac-system-permissive-then-enforced.md`
- RBAC plan file: `~/.claude/plans/lively-petting-sifakis.md` Step 6
  (Bot updates) — this round delivers the testing/contract piece;
  identity decision + key minting is boss-gated.
- Files: `apps/bot/src/auth-headers.ts` (new, pure helper),
  `apps/bot/src/api-client.ts` (uses helper), `apps/bot/src/config.ts`
  (already exposed `apiKey`),
  `apps/bot/src/test-api-client-auth.ts` (new, 18 cases).
