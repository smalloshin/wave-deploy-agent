# Upload draft storage — wire-contract lock (localStorage helpers)

## Status

Active.

## Context

`apps/web/lib/upload-draft-storage.ts` (127 LOC) is the layer that
saves the upload form state (project name, domain, description, file
metadata) to `window.localStorage` so users don't lose 5 minutes of
typing on upload failure. It shipped to every browser with **zero
tests**.

Five exported helpers, all silent-failure by design (private mode,
quota exceeded, SSR no-window):

- `saveDraft(projectId, formData, fileMeta?)` — JSON to
  `wda:upload:draft:{projectId|"new"}` with v:1 schema, savedAt,
  expiresAt (+7 days). 50 KB safety cap; if serialized blob exceeds it,
  drops `fileMeta` and persists minimal version.
- `loadDraft(projectId)` — parses, returns `null` if expired (auto
  removes), wrong schema version (auto removes), bad JSON, or bad
  expiresAt date.
- `clearDraft(projectId)` — removeItem with try/catch.
- `gcExpiredDrafts()` — iterates ALL keys, removes expired or corrupt
  ones with prefix; ignores non-prefix keys.
- `makeDebouncedSave(delayMs = 500)` — closure factory for
  onChange-style autosave.

The silent-failure design is correct (you don't want a logged-out user
to see "draft save failed" alerts every keystroke), but the same design
makes regressions invisible: if `saveDraft` silently no-ops because of
a bug, users still get a working form... that quietly never persists.

This is the third application of the wire-contract lock pattern from
R37 (`auth-headers.ts`) → R38 (`permission-check.ts` shared) → R39
(`upload-error-mapper.ts`) → **R40 (`upload-draft-storage.ts`)**.

## Decision

### New test file `apps/web/lib/test-upload-draft-storage.ts` (55 PASS)

Coverage:

- **isBrowser guard**: with `window` deleted from globalThis, all five
  exports must be no-ops (no throw, `loadDraft` returns null, debounced
  closure still callable). Locks the SSR safety contract.
- **saveDraft shape & key namespacing** (10 cases): writes one key under
  `wda:upload:draft:{projectId}`, stores `v:1`, projectId, formData
  (each field), fileMeta (each field), ISO 8601 savedAt + expiresAt,
  `expiresAt = savedAt + 7 days exactly` (604800000 ms — pinned
  numerically). Also covers the literal `'new'` projectId.
- **50 KB cap fallback** (4 cases): a 55 KB form → minimal save (no
  fileMeta) but formData preserved + schema version preserved. Small
  drafts retain fileMeta (cap is upper bound only, not a floor).
- **saveDraft silent on throw** (2 cases): `setShouldThrow` simulates
  private-mode / QuotaExceeded; `saveDraft` swallows the exception and
  nothing persists. UI keeps working.
- **loadDraft round-trip** (4 cases): saveDraft → loadDraft preserves
  formData + projectId.
- **loadDraft expiry path** (3 cases): expired draft returns null AND
  emits removeItem op (auto-cleanup verified).
- **loadDraft schema-version mismatch** (2 cases): `v: 2` (future
  schema) treated as garbage — null + auto-cleanup. Migration safety net.
- **loadDraft bad JSON / bad expiresAt date** (3 cases): malformed JSON
  → null (no throw); `expiresAt: 'not a real date'` → null + auto-cleanup
  (NaN time check).
- **clearDraft** (3 cases): emits removeItem op for the right key;
  silent on removeItem throw.
- **gcExpiredDrafts** (5 cases): preserves fresh drafts; removes
  expired drafts; **ignores non-prefix keys** (does not blow away other
  apps' localStorage); removes corrupt-JSON entries; removes
  bad-expiresAt entries; outer try/catch swallows even
  `length`-getter throws.
- **makeDebouncedSave** (10 cases): nothing saved before delay; exactly
  one save after delay; rapid retrigger → only ONE save lands with the
  LAST value (not the first; not multiple); independent closures don't
  share timers; default delay (500ms) is the documented contract.

## Test infrastructure

`makeFakeStorage()` builds an in-memory `{store, ops, setShouldThrow,
removeShouldThrow}` shim that records every set/remove op. `withStorage`
helper installs `globalThis.window = { localStorage: fake }` for the
duration of a test block and restores afterward. Every test block resets.

## Test coverage

```
$ ./scripts/sweep-zero-dep-tests.sh
...
✓  lib/test-resumable-upload.ts (91/91)
✓  lib/test-upload-draft-storage.ts (55/55)
✓  lib/test-upload-error-mapper.ts (172/172)

=== Total: 2253 passed, 0 failed across 38 files ===
```

R39 → R40 delta: **+55 tests, +1 file in sweep**.

## Consequences

**Good:**
- The 7-day expiry constant is now numerically pinned. If anyone
  changes `EXPIRY_DAYS`, the `604800000 ms` assertion flips.
- The schema-version migration safety net is locked. If `v: 2` is ever
  introduced, the existing test that expects `v: 2 → null + cleanup`
  forces the maintainer to update the assertion (and consider migration
  semantics) rather than silently surfacing v1 drafts to v2 code.
- `gcExpiredDrafts`'s non-prefix-key safety (line 95: `if (k &&
  k.startsWith(KEY_PREFIX))`) is locked. If the prefix check ever
  regresses, the test for `'unrelated:other-app:key'` flips and we
  catch the data-loss bug before shipping.
- `makeDebouncedSave`'s "last value wins" + "exactly one setItem op"
  contract is locked. If a future refactor changes debounce to "first
  value wins" or fires multiple times, the rapid-retrigger test names
  the regression.
- Silent-failure design verified by tests, not just hoped-for. Private
  mode / quota exceeded are explicit assertions now.

**Cost:**
- Async tests (`await new Promise(...)`) for the debounce timer add
  ~120 ms to sweep wall time. Acceptable given total sweep still
  comfortably under 15s.
- `Object.defineProperty(s, 'length', { get() { throw } })` for the
  gc-resilience test is a niche path; it locks behavior at the cost of
  one slightly creative mock. Worth it because the outer try/catch in
  `gcExpiredDrafts` is otherwise dead code that could be silently
  removed.

## Verification

- `cd apps/web && bun lib/test-upload-draft-storage.ts` → 55 passed, 0 failed
- `./scripts/sweep-zero-dep-tests.sh` → 2253 / 38 PASS
- `tsc --noEmit` clean across all four packages: api, bot, web, shared
- No source files modified (only new test). Runtime behavior of
  `upload-draft-storage.ts` is unchanged.

## References

- Round 37 wire-contract pattern (bot consumer): `2026-04-27-bot-api-key-bootstrap.md`
- Round 38 shared predicate (server/client parity): `2026-04-27-permission-check-shared.md`
- Round 39 web upload-error-mapper test lock: `2026-04-27-upload-error-mapper-test-lock.md`
- Files:
  - NEW `apps/web/lib/test-upload-draft-storage.ts` (55 tests)
