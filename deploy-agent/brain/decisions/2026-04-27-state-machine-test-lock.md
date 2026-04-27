# State machine — wire-contract lock (predicates + adjacency matrix)

## Status

Active.

## Context

`packages/shared/src/state-machine.ts` (129 LOC) is the canonical source
of truth for `ProjectStatus` transition rules + state-classification
predicates. It is consumed by:

- `deploy-worker` (server-side gating; `transitionProject(id, to)`
  refuses to update if `canTransition` says no)
- `reconciler` (drift correction; reads `getValidTransitions` to plan
  catch-up moves)
- Web dashboard UI (which action buttons to render, which badges to
  show, which rows to put in the "needs your attention" panel)
- Discord notifier (when to fire — `requiresHumanAction` gates the
  Discord post)
- SSE event stream (which transitions surface to the live timeline)

Six exports, all pure (only `import type` from `./types`):

- `canTransition(from, to) → boolean` — single rule check
- `getValidTransitions(from) → ProjectStatus[]` — list of allowed next
  states
- `isTerminalState(status) → boolean` — settled? (`live`/`failed`/`stopped`)
- `isActionableState(status) → boolean` — needs human? (`review_pending`/`needs_revision`)
- `requiresHumanAction(status) → boolean` — fires notifications?
  (`review_pending` only)
- `buildTransitionPlan({currentState, toState}) → TransitionPlan` —
  three-way `idempotent-noop | allowed | rejected` planner used by
  `transitionProject` to atomically `UPDATE WHERE status = $expectedFromState`

Plus two error classes:

- `InvalidTransitionError` (rules say no)
- `ConcurrentTransitionError` (rules said yes, you lost a race) —
  introduced R12 to close a 1-2 year reconciler-vs-worker race that
  could produce nonsense transitions like `deploying → live` (skipping
  `deployed`/`ssl_provisioning`/`canary_check`).

**Coverage gap before R42:**
- `canTransition`, `buildTransitionPlan`, both error classes were
  covered by `test-transition-plan.ts` (28 tests) and `test-stop-verdict.ts`.
- The four state-classification predicates (`getValidTransitions`,
  `isTerminalState`, `isActionableState`, `requiresHumanAction`) had
  **zero test coverage**.

The risks of leaving the predicates untested:

1. **Adding a new ProjectStatus** without updating each predicate
   silently miscategorizes the new state. `isTerminalState` defaults to
   "not terminal" so the new state appears as still-running on the
   dashboard. `isActionableState` defaults to "not in queue" so the row
   never surfaces to reviewers. No exception, no log line.
2. **Predicate body regression** ("optimization": collapse two checks
   into one boolean expression) silently changes which rows surface in
   the queue / which fire notifications.
3. **Predicate set overlap** — if `requiresHumanAction` is ever widened
   beyond `isActionableState`, you get rows that fire notifications but
   never appear in the queue (notification storm with no recourse).
4. **`getValidTransitions` returns same reference each call** — the
   source returns the underlying record value directly. If a caller
   mutates it (`transitions.push('failed')`), the rules table is
   corrupted globally. Not an error, but a documented contract to lock.
5. **`canTransition` rules table** is the single point of truth for
   what the deploy pipeline can do. A typo in the table (e.g.,
   `canary_check: ['live', 'rolling_back']` losing the R11 `'failed'`
   addition) regresses to the same trapped-state bug R11 fixed.

Sixth application of the wire-contract lock pattern.
R37 (bot auth-headers) → R38 (shared permission-check) → R39
(upload-error-mapper) → R40 (upload-draft-storage) → R41
(cost-estimator) → **R42 (state-machine)**.

## Decision

### New test file `packages/shared/src/test-state-machine.ts` (100 PASS)

Coverage:

- **`ALL_STATES` list integrity** (2 cases): exactly 15 entries; no
  duplicates. Sentry against `types.ts` `ProjectStatus` union drift.

- **`getValidTransitions` per-state** (15 cases): every one of 15
  states is asserted against an inline `PINNED_TRANSITIONS` table that
  mirrors source. Any rules change requires updating both — friction
  is intentional (state-machine changes are high-stakes).

- **`getValidTransitions` unknown** (1 case): unknown state returns
  empty array, not undefined, not throw.

- **`getValidTransitions` reference identity** (1 case): repeated calls
  return the same array reference. Locks the documented contract that
  callers must NOT mutate the returned array. If source ever switches
  to `.slice()` or `.map(x => x)` the test name flips and the
  maintainer is forced to consider whether they meant to introduce
  defensive copying.

- **`canTransition` 15 × 15 = 225 adjacency cells** (1 sweep + 1
  count): full matrix asserted against `PINNED_TRANSITIONS`. A typo in
  any one cell of the rules table flips one assertion and names the
  cell. Plus 2 unknown-state safety cases.

- **`isTerminalState` per-state** (15 cases) + cardinality (1 case)
  + unknown safety (1 case). `TERMINAL_STATES` set mirrored from source
  contract.

- **`isActionableState` per-state** (15 cases) + cardinality (1 case)
  + unknown safety (1 case). `ACTIONABLE_STATES` set mirrored.

- **`requiresHumanAction` per-state** (15 cases) + cardinality (1 case)
  + unknown safety (1 case). `REQUIRES_HUMAN` set mirrored.

- **Predicate set invariants** (2 cases):
  - `requiresHumanAction ⊆ isActionableState` (no notification-without-queue)
  - `isTerminalState ∩ isActionableState = ∅` (no settled-and-pending)

- **Error class shapes** (12 cases):
  - `InvalidTransitionError`: instanceof Error, instanceof self,
    `.name`, exact message format `"Invalid state transition: X → Y"`,
    `.startsWith("Invalid state transition:")` (string-match contract
    for `deploy-worker.ts` catches).
  - `ConcurrentTransitionError`: instanceof Error, instanceof self,
    NOT instanceof InvalidTransitionError (distinct types so callers
    can switch behavior), `.name`, `.expectedFrom` / `.to` /
    `.actualState` field preservation, message includes all three in
    canonical `state=X` format.

- **`buildTransitionPlan` idempotent-noop is `live → live` only**
  (1 + 1 case): live→live returns kind=idempotent-noop; failed→failed,
  stopped→stopped, deploying→deploying, submitted→submitted,
  scanning→scanning all return kind=rejected. Lock against accidental
  fluky idempotency.

- **`buildTransitionPlan` allowed mirrors canTransition** (1 case):
  14 representative allowed transitions return kind=allowed with
  `expectedFromState === currentState`.

- **`buildTransitionPlan` rejected** (3 cases): kind, exact reason
  format `"Invalid state transition: X → Y"`, `.startsWith("Invalid
  state transition:")` string-match contract.

- **`buildTransitionPlan` 15 × 15 sweep** (1 case): full matrix —
  planner kind matches `canTransition` for every cell, with the
  documented exception that `live → live` returns `idempotent-noop`
  rather than `allowed`. Any planner divergence from rules surfaces
  by name.

- **Determinism / purity** (3 cases): same input produces equal output;
  does not mutate input object; predicates stable across repeated calls.

### PINNED_TRANSITIONS table mirrored in test

The full `VALID_TRANSITIONS` adjacency table is re-declared at the top
of the test file with the same values as source. Any change to source
rules without updating the test fails the per-state `getValidTransitions`
test by name AND the 225-cell `canTransition` sweep by name. Intentional
friction — state-machine changes must be conscious and ack'd in code
review.

## Test coverage

```
$ ./scripts/sweep-zero-dep-tests.sh
...
✓  src/test-permission-check.ts (38/38)
✓  src/test-state-machine.ts (100/100)
✓  lib/test-resumable-upload.ts (91/91)
✓  lib/test-upload-draft-storage.ts (55/55)
✓  lib/test-upload-error-mapper.ts (172/172)

=== Total: 2413 passed, 0 failed across 40 files ===
```

R41 → R42 delta: **+100 tests, +1 file in sweep**.

## Consequences

**Good:**
- The full 15 × 15 = 225-cell adjacency table is now numerically
  pinned in two places (source + test). A typo in any single cell
  flips one assertion by name. The R11 `canary_check → failed` fix
  has a regression guard.
- All four state-classification predicates have explicit per-state
  coverage. Adding a new `ProjectStatus` to `types.ts` without
  updating each predicate fails `ALL_STATES.length === 15` first
  (forcing the maintainer to update the test fixture), then forces
  per-state assertions for the new state.
- `requiresHumanAction ⊆ isActionableState` is locked. If ever
  inverted, the dashboard's notification-vs-queue logic is structurally
  invariant and the test names the regression.
- `isTerminalState ∩ isActionableState = ∅` is locked. Settled vs
  pending UI badge logic is structurally safe.
- Error class string-match contracts (`"Invalid state transition:"`
  prefix) are pinned. `deploy-worker.ts` catches that match on this
  prefix won't silently break.
- `getValidTransitions` reference-identity contract locked — if anyone
  switches to defensive copying, the test surfaces the change.
- `buildTransitionPlan` cannot diverge from `canTransition` — the full
  225-cell sweep proves the planner derives from the rules.

**Cost:**
- The `PINNED_TRANSITIONS` table is duplicated between source and
  test. Sync burden is ~30 seconds per rules change (any deploy-pipeline
  state-machine change is already a ≥30-minute design discussion
  anyway, so this is in the noise).
- 100 tests is one new file in the sweep. Maintenance cost is offset
  by the fact that rules changes can no longer be made by accident —
  every state-machine refactor surfaces at code-review time.

## Verification

- `bun packages/shared/src/test-state-machine.ts` → 100 passed, 0 failed
- `./scripts/sweep-zero-dep-tests.sh` → 2413 / 40 PASS
- `tsc --noEmit` clean across all four packages: api, bot, web, shared
- No source files modified (only new test). Runtime behavior of
  `state-machine.ts` is unchanged.

## References

- Round 37 wire-contract pattern (bot consumer): `2026-04-27-bot-api-key-bootstrap.md`
- Round 38 shared predicate (server/client parity): `2026-04-27-permission-check-shared.md`
- Round 39 web upload-error-mapper test lock: `2026-04-27-upload-error-mapper-test-lock.md`
- Round 40 web upload-draft-storage test lock: `2026-04-27-upload-draft-storage-test-lock.md`
- Round 41 api cost-estimator test lock: `2026-04-27-cost-estimator-test-lock.md`
- Round 11 canary_check → failed addition (regression-guarded by R42)
- Round 12 ConcurrentTransitionError introduction (string-match contract pinned by R42)
- Files:
  - NEW `packages/shared/src/test-state-machine.ts` (100 tests)
