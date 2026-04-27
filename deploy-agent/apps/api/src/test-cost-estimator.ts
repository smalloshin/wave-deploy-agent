// Round 41 — Wire-contract lock for `services/cost-estimator.ts`.
//
// Target: 2 exported pure helpers (zero deps; only `import type` from shared).
//   - estimateMonthlyCost(input?) → CostEstimate
//   - formatCostEstimate(estimate) → string
//
// Used in:
//   - apps/api/src/services/pipeline-worker.ts:409 (production path; cost
//     attached to deployment metadata for the dashboard)
//   - apps/api/src/test-deploy.ts (integration smoke)
//   - apps/api/src/test-pipeline.ts (integration smoke)
//
// Lockdown rationale:
//   - GCP pricing constants live inside this file as named numeric
//     literals. If someone updates them carelessly (drops a zero, adds
//     a digit), the entire production cost dashboard goes wrong silently
//     — no error, just misleading numbers shown to the user.
//   - Free-tier deduction logic (Math.max(0, totalUsed - free)) is what
//     keeps small projects displaying "$0.15/month" instead of negative
//     cost. If the max-clamp regresses, dashboard shows nonsense.
//   - The 2-decimal rounding applies to compute, networking, AND
//     monthlyTotal independently — not just at the end. Easy to
//     accidentally compound rounding (round → round → round) and break.
//   - `currency: 'USD'` literal is a typed contract — must NEVER change
//     without updating UI formatting.
//   - formatCostEstimate is what gets logged to deployment events. UI
//     scrapers / log parsers depend on the exact format.
//
// Strategy: lock pricing constants by computing expected results from
// FIRST PRINCIPLES (the same arithmetic the source does, but reproduced
// independently in the test). Anyone changing a constant needs to update
// both source AND test, surfacing the change in code review.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import { estimateMonthlyCost, formatCostEstimate } from './services/cost-estimator';
import type { CostEstimate } from '@deploy-agent/shared';

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
  assert(
    ok,
    name,
    ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertClose(
  actual: number,
  expected: number,
  epsilon: number,
  name: string,
): void {
  const ok = Math.abs(actual - expected) <= epsilon;
  assert(ok, name, ok ? undefined : `|${actual} - ${expected}| > ${epsilon}`);
}

// ─── Pricing constants (mirrored from cost-estimator.ts; pinned here) ────
//
// If these constants change in source, this test fails. Intentional —
// any pricing update must be conscious and ack'd in code review.

const PRICING = {
  cpu: { perVCPUSecond: 0.000024, freePerMonth: 180_000 },
  memory: { perGBSecond: 0.0000025, freePerMonth: 360_000 },
  requests: { perMillion: 0.4, freePerMonth: 2_000_000 },
  networking: { perGB: 0.12, freePerMonth: 1 },
  ssl: { managed: 0 },
};
const STORAGE_FLAT = 0.10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Defaults: { cpu:1, memoryMB:512, 1k req/day, 200ms, 50KB, minInst:0 ─

{
  const e = estimateMonthlyCost();
  // monthlyRequests = 30,000; computeSec = 6,000; alwaysOn = 0
  // CPU: max(0, 6000*1 - 180000) = 0 → cost 0
  // Memory: 0.5 GB * 6000 = 3000 < 360000 free → cost 0
  // Requests: 30k < 2M free → cost 0
  // compute = 0
  // egress = (30000 * 50)/1024^2 = 1500000/1048576 ≈ 1.43 GB
  // billable = 0.43; networking = round(0.43 * 0.12 * 100)/100
  // = round((1500000/1048576 - 1) * 0.12 * 100)/100
  const expectedEgress = (30_000 * 50) / (1024 * 1024);
  const billableEgress = Math.max(0, expectedEgress - PRICING.networking.freePerMonth);
  const expectedNetworking = round2(billableEgress * PRICING.networking.perGB);
  assertEq(e.breakdown.compute, 0, 'defaults: compute = 0 (everything in free tier)');
  assertEq(e.breakdown.storage, STORAGE_FLAT, 'defaults: storage = $0.10 flat');
  assertEq(e.breakdown.networking, expectedNetworking, 'defaults: networking ≈ small egress over 1 GB free');
  assertEq(e.breakdown.ssl, 0, 'defaults: ssl = 0 (managed)');
  assertEq(
    e.monthlyTotal,
    round2(0 + STORAGE_FLAT + expectedNetworking + 0),
    'defaults: monthlyTotal = sum of breakdown rounded to cents',
  );
  assertEq(e.currency, 'USD', 'defaults: currency literal "USD"');
}

// ─── CPU paid tier: force above 50 vCPU-hours free ────────────────────────

{
  // 4 vCPU × heavy compute → exceeds 180000 vCPU-seconds
  const e = estimateMonthlyCost({
    cpu: 4,
    memoryMB: 512,
    avgRequestsPerDay: 100_000,
    avgRequestDurationMs: 500,
    avgResponseSizeKB: 1, // keep networking trivial
    minInstances: 0,
  });
  const monthlyRequests = 100_000 * 30; // 3,000,000
  const totalComputeSec = monthlyRequests * (500 / 1000); // 1,500,000
  const cpuSec = totalComputeSec * 4; // 6,000,000
  const billableCpu = Math.max(0, cpuSec - PRICING.cpu.freePerMonth);
  const cpuCost = billableCpu * PRICING.cpu.perVCPUSecond;
  // Memory: 0.5 GB * 1.5M = 750,000 sec-GB > 360,000 free
  const memSecGB = totalComputeSec * 0.5; // 750,000
  const billableMem = Math.max(0, memSecGB - PRICING.memory.freePerMonth);
  const memCost = billableMem * PRICING.memory.perGBSecond;
  // Requests: 3M > 2M
  const billableReq = Math.max(0, monthlyRequests - PRICING.requests.freePerMonth);
  const reqCost = (billableReq / 1_000_000) * PRICING.requests.perMillion;
  const expectedCompute = round2(cpuCost + memCost + reqCost);
  assertClose(e.breakdown.compute, expectedCompute, 0.01, 'CPU paid: compute matches first-principles math');
  assert(e.breakdown.compute > 0, 'CPU paid: compute > 0 (above free tier)');
}

// ─── Memory free tier: stay below 360000 GB-sec ──────────────────────────

{
  // tiny container, sparse traffic → memory in free tier
  const e = estimateMonthlyCost({
    cpu: 0.5,
    memoryMB: 256,
    avgRequestsPerDay: 100,
    avgRequestDurationMs: 50,
    avgResponseSizeKB: 1,
    minInstances: 0,
  });
  // computeSec = 100*30*0.05 = 150; memSecGB = 150 * 0.25 = 37.5 ≪ 360000
  assertEq(e.breakdown.compute, 0, 'memory free tier: compute = 0');
}

// ─── Requests paid tier: > 2M req/month ──────────────────────────────────

{
  // 100k/day = 3M/month > 2M free
  // But keep CPU/memory tiny to isolate request cost contribution
  const e = estimateMonthlyCost({
    cpu: 0.1,
    memoryMB: 128,
    avgRequestsPerDay: 100_000,
    avgRequestDurationMs: 1, // basically zero compute
    avgResponseSizeKB: 0.001,
    minInstances: 0,
  });
  const billableReq = 3_000_000 - 2_000_000;
  const reqCost = (billableReq / 1_000_000) * PRICING.requests.perMillion;
  // compute should be approximately just the request cost
  assertClose(
    e.breakdown.compute,
    round2(reqCost),
    0.01,
    'requests paid tier: 3M req → 1M billable × $0.40/M = $0.40',
  );
}

// ─── minInstances drives always-on hours (idle cost) ─────────────────────

{
  // 1 always-on min instance × 30 days × 24h × 3600s = 2,592,000 vCPU-sec
  // - 180,000 free = 2,412,000 billable × $0.000024 = $57.888
  const e = estimateMonthlyCost({
    cpu: 1,
    memoryMB: 512, // 0.5 GB
    avgRequestsPerDay: 0,
    avgRequestDurationMs: 0,
    avgResponseSizeKB: 0,
    minInstances: 1,
  });
  const alwaysOnSec = 1 * 30 * 24 * 3600;
  const billableCpu = alwaysOnSec * 1 - PRICING.cpu.freePerMonth;
  const cpuCost = billableCpu * PRICING.cpu.perVCPUSecond;
  // Memory: alwaysOnSec * 0.5 = 1,296,000 - 360,000 = 936,000 × 0.0000025 = $2.34
  const billableMem = alwaysOnSec * 0.5 - PRICING.memory.freePerMonth;
  const memCost = billableMem * PRICING.memory.perGBSecond;
  const expectedCompute = round2(cpuCost + memCost);
  assertClose(
    e.breakdown.compute,
    expectedCompute,
    0.02,
    'minInstances=1 always-on: compute reflects 30d×24h×3600s × cpu + memory billable',
  );
  assert(e.breakdown.compute > 50, 'minInstances=1: compute > $50 (always-on adds real cost)');
}

// ─── Networking free tier: 1 GB free ─────────────────────────────────────

{
  // Generate < 1 GB egress
  const e = estimateMonthlyCost({
    cpu: 0.1,
    memoryMB: 128,
    avgRequestsPerDay: 100,
    avgRequestDurationMs: 1,
    avgResponseSizeKB: 1, // 100 req × 30 days × 1 KB = 3000 KB ≈ 0.003 GB
    minInstances: 0,
  });
  assertEq(e.breakdown.networking, 0, 'networking free tier: < 1 GB egress → cost 0');
}

// ─── Networking paid tier: > 1 GB egress ─────────────────────────────────

{
  // 1M req/day × 100 KB × 30 = 3,000,000 * 100 = 300,000,000 KB = ~286 GB
  const e = estimateMonthlyCost({
    cpu: 0.1,
    memoryMB: 128,
    avgRequestsPerDay: 1_000_000,
    avgRequestDurationMs: 1,
    avgResponseSizeKB: 100,
    minInstances: 0,
  });
  const monthlyEgressGB = (1_000_000 * 30 * 100) / (1024 * 1024);
  const billableGB = Math.max(0, monthlyEgressGB - 1);
  const expectedNetworking = round2(billableGB * PRICING.networking.perGB);
  assertEq(
    e.breakdown.networking,
    expectedNetworking,
    `networking paid tier: ~${monthlyEgressGB.toFixed(0)} GB egress → ~$${expectedNetworking}`,
  );
  assert(e.breakdown.networking > 1, 'networking paid tier: > $1 cost');
}

// ─── Storage = $0.10 flat (AR repo image, ~negligible) ───────────────────

{
  // Storage is hardcoded — should be 0.10 regardless of input
  const inputs = [
    {},
    { cpu: 32, memoryMB: 16384, avgRequestsPerDay: 1_000_000 },
    { cpu: 0.1, memoryMB: 128, avgRequestsPerDay: 0 },
  ];
  for (const input of inputs) {
    const e = estimateMonthlyCost(input);
    assertEq(e.breakdown.storage, 0.10, `storage flat: input ${JSON.stringify(input)} → $0.10`);
  }
}

// ─── SSL = 0 always (managed) ────────────────────────────────────────────

{
  const e = estimateMonthlyCost({ cpu: 32, memoryMB: 16384 });
  assertEq(e.breakdown.ssl, 0, 'ssl: managed → $0 always');
}

// ─── Currency literal ────────────────────────────────────────────────────

{
  const e = estimateMonthlyCost();
  // Type narrowing: contract is the literal 'USD', not just any string
  assertEq(e.currency, 'USD' as const, 'currency: literal "USD" (typed contract)');
}

// ─── Defaults applied when fields omitted ────────────────────────────────

{
  // Pass NO input → must equal estimateMonthlyCost({}) which equals
  // applying DEFAULT_INPUT internally
  const a = estimateMonthlyCost();
  const b = estimateMonthlyCost({});
  assertEq(a, b, 'defaults: no input === empty input');
}
{
  // Partial input merges with defaults — pick a workload heavy enough that
  // cpu actually matters (defaults stay in free tier so cpu changes don't
  // visibly affect compute cost; need a workload above the 50 vCPU-hour
  // free tier first, then prove cpu scales it).
  const heavyDefaults = {
    avgRequestsPerDay: 200_000,
    avgRequestDurationMs: 500,
    memoryMB: 512,
    avgResponseSizeKB: 1, // keep networking trivial
  };
  const baseline = estimateMonthlyCost({ ...heavyDefaults, cpu: 1 });
  const oneFieldChanged = estimateMonthlyCost({ ...heavyDefaults, cpu: 8 });
  assert(
    oneFieldChanged.breakdown.compute > baseline.breakdown.compute,
    'partial input merges: changing cpu from 1 to 8 increases compute (above free tier)',
  );
}

// ─── Rounding to cents ───────────────────────────────────────────────────

{
  // Pick inputs known to produce a fractional cent in compute
  const e = estimateMonthlyCost({
    cpu: 4,
    memoryMB: 4096,
    avgRequestsPerDay: 100_000,
    avgRequestDurationMs: 500,
    avgResponseSizeKB: 200,
    minInstances: 1,
  });
  // Each individual breakdown number must be rounded to ≤ 2 decimals
  for (const [k, v] of Object.entries(e.breakdown)) {
    const cents = v * 100;
    assert(
      Math.abs(Math.round(cents) - cents) < 0.0001,
      `rounding: breakdown.${k}=${v} is rounded to cents`,
    );
  }
  const cents = e.monthlyTotal * 100;
  assert(
    Math.abs(Math.round(cents) - cents) < 0.0001,
    `rounding: monthlyTotal=${e.monthlyTotal} is rounded to cents`,
  );
}

// ─── monthlyTotal = sum of breakdown (also rounded) ──────────────────────

{
  const e = estimateMonthlyCost({
    cpu: 2,
    memoryMB: 1024,
    avgRequestsPerDay: 50_000,
    avgRequestDurationMs: 250,
    avgResponseSizeKB: 80,
    minInstances: 0,
  });
  const sum = e.breakdown.compute + e.breakdown.storage + e.breakdown.networking + e.breakdown.ssl;
  assertEq(
    e.monthlyTotal,
    round2(sum),
    'monthlyTotal: equals round2(sum of breakdown components)',
  );
}

// ─── Output shape ────────────────────────────────────────────────────────

{
  const e: CostEstimate = estimateMonthlyCost();
  assert('monthlyTotal' in e, 'shape: has monthlyTotal');
  assert('breakdown' in e, 'shape: has breakdown');
  assert('currency' in e, 'shape: has currency');
  assert(typeof e.breakdown === 'object' && e.breakdown !== null, 'shape: breakdown is object');
  for (const k of ['compute', 'storage', 'networking', 'ssl']) {
    assert(k in e.breakdown, `shape: breakdown has ${k}`);
    assert(typeof (e.breakdown as any)[k] === 'number', `shape: breakdown.${k} is number`);
  }
  assert(typeof e.monthlyTotal === 'number', 'shape: monthlyTotal is number');
}

// ─── Edge: zero-everything input still returns valid shape ───────────────

{
  const e = estimateMonthlyCost({
    cpu: 0,
    memoryMB: 0,
    avgRequestsPerDay: 0,
    avgRequestDurationMs: 0,
    avgResponseSizeKB: 0,
    minInstances: 0,
  });
  assertEq(e.breakdown.compute, 0, 'zero input: compute = 0');
  assertEq(e.breakdown.networking, 0, 'zero input: networking = 0 (no egress)');
  assertEq(e.breakdown.storage, 0.10, 'zero input: storage still flat $0.10 (image always exists)');
  assertEq(e.breakdown.ssl, 0, 'zero input: ssl = 0');
  assertEq(e.monthlyTotal, 0.10, 'zero input: monthlyTotal = $0.10 (storage only)');
}

// ─── formatCostEstimate ──────────────────────────────────────────────────

{
  const fixture: CostEstimate = {
    monthlyTotal: 12.34,
    breakdown: { compute: 10.00, storage: 0.10, networking: 2.24, ssl: 0 },
    currency: 'USD',
  };
  const out = formatCostEstimate(fixture);
  assert(out.includes('Estimated monthly cost: $12.34/month'), 'format: total line');
  assert(out.includes('Compute: $10'), 'format: compute line');
  assert(out.includes('Storage: $0.1'), 'format: storage line');
  assert(out.includes('Networking: $2.24'), 'format: networking line');
  assert(out.includes('SSL: $0 (managed, free)'), 'format: ssl line with note');
  assert(out.includes('GCP Cloud Run standard pricing'), 'format: pricing note included');
  assert(out.includes('Actual costs may vary'), 'format: variance disclaimer included');
  // Newline-joined (8 lines per the source: 6 data + blank + 2 note)
  const lineCount = out.split('\n').length;
  assertEq(lineCount, 8, 'format: 8-line output (matches source line count)');
}

// ─── format: integer values render without trailing .0 ───────────────────

{
  const fixture: CostEstimate = {
    monthlyTotal: 100,
    breakdown: { compute: 99, storage: 1, networking: 0, ssl: 0 },
    currency: 'USD',
  };
  const out = formatCostEstimate(fixture);
  assert(out.includes('$100/month'), 'format: integer $100 (no trailing .00)');
  assert(out.includes('Compute: $99'), 'format: integer Compute $99');
  // SSL line shows the value with the note
  assert(out.includes('SSL: $0 (managed, free)'), 'format: SSL = 0 still gets the note');
}

// ─── Purity ──────────────────────────────────────────────────────────────

{
  const input = {
    cpu: 4,
    memoryMB: 1024,
    avgRequestsPerDay: 1000,
    avgRequestDurationMs: 100,
    avgResponseSizeKB: 10,
    minInstances: 0,
  };
  const before = JSON.stringify(input);
  estimateMonthlyCost(input);
  assertEq(JSON.stringify(input), before, 'purity: estimateMonthlyCost does not mutate input');
}
{
  const a = estimateMonthlyCost({ cpu: 2 });
  const b = estimateMonthlyCost({ cpu: 2 });
  assert(a !== b, 'purity: estimateMonthlyCost returns a fresh object each call');
  assertEq(JSON.stringify(a), JSON.stringify(b), 'purity: same input → same value');
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
