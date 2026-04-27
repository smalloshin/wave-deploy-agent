# Upload error mapper — wire-contract lock + sweep extension to apps/web

## Status

Active.

## Context

`apps/web/lib/upload-error-mapper.ts` (242 LOC) was the user-facing
error-translation layer for the entire upload flow:

- `mapEnvelope(envelope) → UploadFailure` — every error code from the
  server gets routed here to pick i18n key + recovery hint + retryable
  flag.
- `mapClientError(err, context) → UploadFailure` — pre-server failures
  (network drop, abort, oversized file) get heuristic-classified here.
- `fetchDiagnostic(envelope, apiBaseUrl) → Promise<UploadFailure>` — the
  LLM fallback escape hatch when code is `unknown`.
- `buildErrorReport(failure, ctx) → string` — what the user clicks "copy
  report" to paste into Discord / GitHub issues.

This whole file shipped to users with **zero tests**. A silent regression
(wrong i18nKey for a code, dropped recovery hint, mis-ordered heuristic
fallthrough, swallowed LLM diagnostic) would manifest as wrong UX rather
than a thrown exception. Hard to spot in code review, hard to spot in
QA. Exactly the kind of file that needs a wire-contract lock.

The same pattern already shipped at R37 (`auth-headers.ts`, 18 tests) and
R38 (`permission-check.ts` shared, 38 tests). R39 applies it to the
upload-mapper layer.

Concurrently noticed: the existing `apps/web/lib/test-resumable-upload.ts`
(91 PASS, R27 + R30) was **not in the sweep** — it had only ever been run
ad-hoc by hand. The sweep script (`scripts/sweep-zero-dep-tests.sh`)
covered `apps/api/src`, `apps/bot/src`, and `packages/shared/src`
(R38), but not `apps/web/lib`. So if it ever broke nobody would know.

## Decision

### 1. New test file `apps/web/lib/test-upload-error-mapper.ts` (172 PASS)

Coverage by area:

- **Code registry round-trip** (84 cases): every one of the 14
  `UploadFailureCode` values asserts `code → i18nKey`,
  `code → recoveryHintKey`, `code → default retryable`, stage
  preservation, and raw-envelope identity preservation. If anyone
  edits `CODE_TO_I18N` and forgets to update a row, exactly one test
  flips red and names the offending code.
- **Retryable override**: `envelope.retryable: true` flips
  `extract_failed` (registry default false) to true; reverse direction
  too. Locks the precedence rule.
- **i18nVars extraction** (7 cases): numeric `fileSize`/`maxSize` get
  formatted via `formatBytes`; string values pass through unchanged
  (server already formatted); `ext` and `domain` get extracted; empty
  detail returns `undefined` (so UI skips interpolation); unrelated
  detail keys (`gcsStatus`, `retryAfter`) do NOT leak into i18nVars
  (they stay in `raw.detail` for the report).
- **llmDiagnostic passthrough** (2 cases): present → `failure.llm`
  populated; absent → undefined.
- **Unknown future code** (2 cases): if a server ships a code the
  client hasn't shipped yet (`'a_brand_new_code' as UploadFailureCode`),
  it falls back to the `unknown` i18n entry — UI still renders
  *something*, no crash.
- **mapClientError heuristic dispatch** (23 cases):
  - `TypeError` containing `'fetch'` or `'Network'` → `network_error`;
    other `TypeError` strings do NOT misfire.
  - `Error` with `name: 'AbortError'` → `gcs_timeout`.
  - `validate` stage + `fileSize > maxSize` → `file_too_large_for_direct`
    with i18nVars populated from context. Gated to `validate` stage
    only (would be wrong on `upload` stage). Requires both `fileSize`
    and `maxSize`.
  - Message contains `'extension'` or `'zip'` →
    `file_extension_invalid` (NOT retryable — user must pick different
    file).
  - Anything else → `unknown` (retryable by default).
  - Non-Error inputs (string, null, object) get `String()`-coerced and
    fall through to `unknown` with the coerced message preserved.
  - Synthesised envelope shape verified: `ok: false`, correct stage,
    empty `{}` detail.
- **formatBytes boundaries** (9 cases): 0, 512, 1023 (last byte before
  KB), 1024 (1.0 KB), 1024 × 1024 - 1 (1024.0 KB rounding), 1 MiB, the
  actual 426 MB stress file (`447_194_585 → "426.5 MB"`), 1 GiB, 2.5
  GiB. The 426 MB number is the same `legal_flow_build.zip` file from
  R30 — locks the user-facing string the chunked-upload error toast
  shows.
- **buildErrorReport** (20 cases): header line, project line (incl.
  literal `'new'`), stage, code, retryable, message, navigator UA
  (mocked deterministic), File line conditional on `fileMeta`, Request
  ID conditional on `requestId`, Detail line conditional on
  non-empty detail (empty `{}` does NOT emit Detail), LLM section
  header includes provider, Category / User-facing / Suggested fix /
  Root cause lines (Root cause OMITTED when undefined), ISO 8601 time
  format, missing-navigator → `'n/a'`.
- **fetchDiagnostic mocked-fetch** (12 cases): success path posts to
  `/api/upload/diagnose` with POST + JSON Content-Type + correct body
  shape (`{ envelope: ... }`), populates `failure.llm` from response,
  preserves original code/stage. Failure paths: HTTP 503 → no llm,
  fetch throws → no llm + no exception bubbles, `response.json()`
  throws → swallowed. **All four failure modes return a mapped
  failure, never throw.** This is the contract the UI relies on.
- **Purity** (3 cases): `mapEnvelope` does not mutate input;
  `mapClientError` returns fresh failure + fresh envelope each call.

### 2. Sweep extension to `apps/web/lib`

`scripts/sweep-zero-dep-tests.sh` gets a fourth for-loop:

```bash
for f in apps/web/lib/test-*.ts; do
  [[ -e "$f" ]] || continue
  base=$(basename "$f")
  if skip_match "$base"; then
    echo "−  $base (skipped: needs live infra)"
    continue
  fi
  run_one "lib/$base" apps/web
done
```

This both:
- Picks up the new `test-upload-error-mapper.ts` (172 PASS)
- Picks up the previously-orphaned `test-resumable-upload.ts` (91 PASS)
  which has been around since R27 / R30 but never gated on any sweep.

Why `apps/web/lib` not `apps/web/`: the `lib/` subdirectory is the only
place pure helpers live. `app/`, `components/`, `pages/` carry React
JSX + browser-only globals that bun's tsx transpiler can't run as a
node-style test without a DOM. The bound is intentional.

Why these tests are zero-dep: both `upload-error-mapper.ts` and
`resumable-upload.ts` only do `import type` from `@deploy-agent/shared`
(no runtime cross-package value imports), and they don't touch the DOM
or any browser-only API beyond `fetch` and `navigator` which are easy
to mock on `globalThis`.

## Test coverage

```
$ ./scripts/sweep-zero-dep-tests.sh
...
✓  src/test-permission-check.ts (38/38)
✓  lib/test-resumable-upload.ts (91/91)
✓  lib/test-upload-error-mapper.ts (172/172)

=== Total: 2198 passed, 0 failed across 37 files ===
```

R38 → R39 delta: **+263 tests across 2 newly-swept files** (172 brand
new + 91 previously orphaned now in the gate).

## Consequences

**Good:**
- Every i18n key + recovery hint mapping is now pinned. UI translation
  files (`uploadErrors.{key}`) and registry stay in sync — drift between
  them now flips a test.
- The 426 MB stress file's user-facing size string (`"426.5 MB"`) is
  locked. R30's chunked-upload fix and the toast user sees can't
  silently regress to `"447194585 B"` or anything else.
- `mapClientError`'s heuristic ordering is documented as executable
  spec. Reordering the `if/else if` chain or swapping any condition
  flips a test by name.
- `fetchDiagnostic` is contractually guaranteed to never throw — all
  four failure paths (HTTP not-ok, fetch throws, response.json throws,
  network success but empty body) return a mapped failure. UI can rely
  on this without a try/catch wrapper.
- The previously-orphaned `test-resumable-upload.ts` (91 cases) is now
  a CI-gated regression suite for the chunked-upload path that R30
  fixed. Future tweaks to chunk math / backoff / range parsing can't
  silently regress.
- Sweep script now scans 4 directories (api, bot, shared, web/lib).
  Pattern is consistent — any future pure-helper file in
  `apps/web/lib/test-*.ts` gets swept for free.

**Cost:**
- One more sweep loop adds ~2 seconds to total sweep time (mostly
  bun's tsx warm-up for apps/web). Total still under 10s.
- 172 tests added is one new file to maintain. The maintenance cost
  is offset by the next refactor: anyone touching upload-error-mapper
  now sees test failures instead of bug reports a week later.

## Verification

- `cd apps/web && bun lib/test-upload-error-mapper.ts` → 172 passed, 0 failed
- `./scripts/sweep-zero-dep-tests.sh` → 2198 / 37 PASS, exits 0
- `tsc --noEmit` clean across all four packages: api, bot, web, shared
- No source files modified (only new test + sweep extension). Runtime
  behavior of `upload-error-mapper.ts` is unchanged.

## References

- Round 27 / 30 chunked upload: `2026-04-27-chunked-upload-defaults.md`
- Round 37 wire-contract pattern (bot consumer): `2026-04-27-bot-api-key-bootstrap.md`
- Round 38 shared predicate (server/client parity): `2026-04-27-permission-check-shared.md`
- Files:
  - NEW `apps/web/lib/test-upload-error-mapper.ts` (172 tests)
  - MOD `scripts/sweep-zero-dep-tests.sh` (added apps/web/lib loop)
