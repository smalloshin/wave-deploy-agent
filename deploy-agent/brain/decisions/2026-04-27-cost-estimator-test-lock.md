# Cost estimator — wire-contract lock + pricing constants pinned

## Status

Active.

## Context

`apps/api/src/services/cost-estimator.ts` (108 LOC) is the function that
produces the dollar number shown on the dashboard for every deployment
("Estimated monthly cost: $X.XX/month") and that gets logged into
deployment events for the cost trend chart. Used in production at
`pipeline-worker.ts:409`.

Two exports, both pure (only `import type` from shared):

- `estimateMonthlyCost(input?) → CostEstimate` — applies defaults,
  computes CPU / memory / requests / networking with free-tier
  deductions, rounds to cents, returns `{ monthlyTotal, breakdown,
  currency: 'USD' }`.
- `formatCostEstimate(estimate) → string` — human-readable 8-line
  summary used in deploy logs.

The file shipped with **zero unit tests**. Two integration tests
(`test-deploy.ts`, `test-pipeline.ts`) call it as part of larger
flows but neither asserts on specific numeric outputs — they just
console.log the formatted string.

The risks of leaving it untested:

1. **GCP pricing constants** (`perVCPUSecond`, `perGBSecond`,
   `perMillion`, `perGB`, free tiers) are inline numeric literals.
   A typo (`0.00002400` → `0.0002400`, off by 10×) shows up as
   wrong dashboard numbers, no exception, no log line.
2. **Free-tier `Math.max(0, ...)` clamps** are what keep small
   projects from showing negative cost. If the clamp regresses, the
   dashboard shows nonsense.
3. **Two-decimal rounding** is applied independently to compute,
   networking, and monthlyTotal. Easy to compound rounding (round →
   round → round) and break.
4. **`currency: 'USD'`** is a typed literal contract — if anyone
   weakens it to `string`, the UI's currency-formatting branch breaks
   silently.

This is the fifth application of the wire-contract lock pattern.
R37 (bot auth-headers) → R38 (shared permission-check) → R39
(upload-error-mapper) → R40 (upload-draft-storage) → **R41
(cost-estimator)**.

## Decision

### New test file `apps/api/src/test-cost-estimator.ts` (60 PASS)

Coverage:

- **Defaults applied** (8 cases): with no input, the function returns
  the documented default behavior — compute=0 (everything in free
  tier), storage=0.10 flat, networking computed from 30k req × 50 KB
  egress, ssl=0, currency='USD', monthlyTotal=sum.
- **CPU paid tier** (2 cases): heavy workload pushes CPU above 50
  vCPU-hours free; expected compute computed from first principles
  in the test (`(cpuSec * cpu - free) * perVCPUSecond + memory cost +
  request cost`) and asserted with `assertClose` epsilon 0.01.
- **Memory free tier** (1 case): tiny container + sparse traffic →
  memory in free tier → compute=0.
- **Requests paid tier** (1 case): 100k/day × 30 = 3M req → 1M
  billable × $0.40/M = $0.40 isolated by zeroing CPU/memory contribution.
- **`minInstances` always-on** (2 cases): `minInstances=1` adds 30
  days × 24 h × 3600 s = 2,592,000 always-on vCPU-seconds; expected
  compute (~$60) computed in test, asserted with epsilon 0.02.
- **Networking free tier** (1 case): < 1 GB egress → 0.
- **Networking paid tier** (2 cases): ~2861 GB egress → ~$343
  computed independently and asserted exactly.
- **Storage flat $0.10** (3 cases): regardless of input (zero, max,
  middle), storage = $0.10. Locks the constant.
- **SSL = 0 always** (1 case): managed cert is free.
- **Currency literal** (1 case): `'USD' as const` typed contract.
- **Defaults merge with partial input** (3 cases): no-input ===
  empty-input; partial input merges (heavy workload + cpu=8 > cpu=1
  comparison; both above free tier so the change actually shows up).
- **Rounding to cents** (5 cases): every breakdown field AND
  monthlyTotal must be cleanly representable as integer cents
  (`Math.round(v * 100) - v * 100 < 0.0001`).
- **monthlyTotal = sum of breakdown** (1 case): pinned arithmetic
  identity.
- **Output shape** (10 cases): all expected keys present, all
  numeric, breakdown is an object with exactly the four documented
  fields.
- **Zero-everything edge** (5 cases): all inputs zero → only
  storage cost remains ($0.10). Image always exists, so storage is
  ALWAYS billed even on zero-traffic deployments.
- **`formatCostEstimate`** (10 cases): exact substring matches for
  total / compute / storage / networking / SSL lines; pricing note
  + variance disclaimer; 8-line output count; integer values render
  without `.00` (`$100/month`, `Compute: $99`).
- **Purity** (3 cases): does not mutate input; fresh object per
  call; same input → same output.

### Pricing constants pinned in test

The test re-declares `PRICING` and `STORAGE_FLAT` at the top of the
file with the same values as source. Any change to source pricing
without updating the test fails the test by name. Intentional friction
— pricing changes must be conscious and ack'd in code review (especially
when GCP shifts pricing tiers).

## Test coverage

```
$ ./scripts/sweep-zero-dep-tests.sh
...
✓  src/test-cost-estimator.ts (60/60)
✓  lib/test-resumable-upload.ts (91/91)
✓  lib/test-upload-draft-storage.ts (55/55)
✓  lib/test-upload-error-mapper.ts (172/172)

=== Total: 2313 passed, 0 failed across 39 files ===
```

R40 → R41 delta: **+60 tests, +1 file in sweep**.

## Consequences

**Good:**
- GCP pricing constants are now numerically pinned. A drive-by
  pricing update (e.g., GCP changes `perGB` from $0.12 to $0.10)
  requires updating both source AND test. Surfaces in code review.
- Free-tier deduction logic (`Math.max(0, ...)` clamps for CPU,
  memory, requests, networking) is each individually verified. If
  someone removes the clamp, the test catches it.
- The `currency: 'USD' as const` literal contract is locked. UI
  formatting (`Intl.NumberFormat(currency)`) won't be silently
  broken.
- `formatCostEstimate` output is locked to exact substrings. Log
  scrapers and any UI that string-matches the format don't regress.
- `storage: $0.10 flat` is locked across all input shapes.
- The minInstances always-on math (30 × 24 × 3600 sec/month) is
  pinned. If anyone "optimizes" by changing the constant or refactors
  the always-on loop wrong, dashboard numbers change visibly.

**Cost:**
- Pricing constants now live in two places (source + test). Sync
  burden is ~30 seconds per pricing update; the failure mode it
  prevents (silent dashboard misreporting) is worth the friction.
- 60 tests added is one new file to maintain. Maintenance is offset
  by the fact that any future change to the calculation now reveals
  itself by failing test names that describe the math.

## Verification

- `cd apps/api && bun src/test-cost-estimator.ts` → 60 passed, 0 failed
- `./scripts/sweep-zero-dep-tests.sh` → 2313 / 39 PASS
- `tsc --noEmit` clean across all four packages: api, bot, web, shared
- No source files modified (only new test). Runtime behavior of
  `cost-estimator.ts` is unchanged.

## References

- Round 37 wire-contract pattern (bot consumer): `2026-04-27-bot-api-key-bootstrap.md`
- Round 38 shared predicate (server/client parity): `2026-04-27-permission-check-shared.md`
- Round 39 web upload-error-mapper test lock: `2026-04-27-upload-error-mapper-test-lock.md`
- Round 40 web upload-draft-storage test lock: `2026-04-27-upload-draft-storage-test-lock.md`
- Files:
  - NEW `apps/api/src/test-cost-estimator.ts` (60 tests)
