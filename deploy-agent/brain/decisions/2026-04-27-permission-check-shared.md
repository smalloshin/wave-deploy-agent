# Permission predicates moved to @deploy-agent/shared

## Status

Active.

## Context

Before R38, the RBAC permission predicate (`hasPermission(perms, required)`)
existed in two places:

1. **Server** — `apps/api/src/services/auth-service.ts:349`
   ```typescript
   export function hasPermission(perms: Permission[], required: Permission): boolean {
     if (perms.includes('*')) return true;
     return perms.includes(required);
   }
   ```
2. **Client** — `apps/web/lib/auth.tsx:73`
   ```typescript
   const hasPermission = useCallback((p: string) => {
     if (!user) return false;
     return user.permissions.includes('*') || user.permissions.includes(p);
   }, [user]);
   ```

Two implementations of the same predicate is two predicates. Drift is a
matter of when, not if. Drift here = security regression: UI shows a
button the server denies (user clicks → 403 toast → "the system is
broken") OR UI hides a button the server would allow (lost feature).

The same problem applied to `effectivePermissions(userPerms, keyPerms)`,
which only existed server-side because the web doesn't (yet) authenticate
via API key. But the moment a future feature lets the dashboard preview
"how this user would behave with this scoped key" (admin tooling), the
server-side logic would need to be re-implemented client-side. Better
to share now.

## Decision

Create `packages/shared/src/permission-check.ts` exporting three pure
predicates:

```typescript
export function hasPermission(perms: Permission[], required: Permission): boolean
export function effectivePermissions(userPerms, keyPerms): Permission[]
export function checkUserPermission(user: PermissionSubject | null, required): boolean
```

`checkUserPermission` is a small convenience wrapper for UI gating
(handles the null-user case so callers don't repeat `if (!user) return
false`).

`PermissionSubject` is a minimal `{ permissions: Permission[] }` type
so web callers don't need to import the full server-side `AuthUser`
interface (which carries DB-only fields like `created_at` and
`is_active`).

**Server side**: `auth-service.ts` re-exports the predicates from shared
to preserve every existing import (`import { hasPermission } from
'./auth-service'`).

**Client side**: `auth.tsx` calls `checkUserPermission(user, p)` from
shared. The `useCallback` wrapping is preserved for stable React
identity, but the inner logic is now one delegation call.

`CurrentUser.permissions` was tightened from `string[]` to `Permission[]`
to match the server's actual `GET /api/auth/me` response shape.

## Test coverage

`packages/shared/src/test-permission-check.ts` (38 PASS):

- Wildcard `'*'` grants everything
- Specific membership: viewer / reviewer roles, expected grants + denials
- Empty `perms` always denies
- `effectivePermissions` no-key path (undefined / null / empty)
- `effectivePermissions` admin-narrowing (admin user + scoped key → key only)
- `effectivePermissions` intersection (non-admin + scoped key → overlap)
- `effectivePermissions` privilege escalation regression tests:
  - empty user perms + admin key → still empty
  - empty user perms + scoped key → still empty
  - reviewer + admin-only-perm key → escalation blocked
- `checkUserPermission` null/undefined user → deny
- `checkUserPermission` with user object: viewer/admin/empty cases
- Function purity: input arrays NOT mutated
- Server/client parity contract: 7 pinned cases that the server's
  `apps/api/src/test-auth.ts` also exercises against the same predicate

## Sweep script extension

`scripts/sweep-zero-dep-tests.sh` previously only iterated `apps/api/src`
and `apps/bot/src`. R38 added a third loop for `packages/shared/src`.
Sweep now: 1935 / 35 PASS (was 1897/34 at R37; +38 new tests in 1 new file).

## Consequences

**Good:**

- Server gating and client gating cannot drift. Any future change to
  the predicate touches one file, runs one test suite, ships to both.
- Privilege escalation regression tests now LIVE in shared, so the
  intersection-not-union behavior of API key narrowing is locked.
- `checkUserPermission` standardizes the null-user case so future UI
  helpers don't reinvent it.
- Sweep script now scans `packages/*/src/` automatically — any future
  pure helper in shared can drop a `test-*.ts` next to it and get
  swept for free.

**Cost:**

- One more cross-package import line in `auth-service.ts` and
  `auth.tsx`. Minor.
- `CurrentUser.permissions` type tightened from `string[]` → `Permission[]`
  is a strictly tighter type, so any existing code that was passing
  arbitrary strings (none found via grep) would break at compile time.

## Verification

- `bun packages/shared/src/test-permission-check.ts` → 38 passed, 0 failed
- `./scripts/sweep-zero-dep-tests.sh` → 1935 / 35 PASS, sweep script
  exits 0
- `tsc --noEmit` clean in all four packages: api, bot, web, shared
- `apps/api/src/test-auth.ts` still imports `hasPermission` from
  `./services/auth-service` and still passes (re-export preserved)

## References

- Round 25 RBAC: `2026-04-25-rbac-system-permissive-then-enforced.md`
- Round 37 bot wire-contract pattern (same R37 idea applied here at the
  next layer up): `2026-04-27-bot-api-key-bootstrap.md`
- Files:
  - NEW `packages/shared/src/permission-check.ts` (pure helpers)
  - NEW `packages/shared/src/test-permission-check.ts` (38 tests)
  - MOD `packages/shared/src/index.ts` (re-export)
  - MOD `apps/api/src/services/auth-service.ts` (re-export from shared)
  - MOD `apps/web/lib/auth.tsx` (use shared helper, tighten type)
  - MOD `scripts/sweep-zero-dep-tests.sh` (loop over packages/shared)
