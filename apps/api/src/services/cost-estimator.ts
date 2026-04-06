import type { CostEstimate } from '@deploy-agent/shared';

// GCP Cloud Run pricing (as of 2026, us-central1)
// Prices in USD
const PRICING = {
  cpu: {
    perVCPUSecond: 0.00002400, // $0.0864/vCPU-hour
    freePerMonth: 180000, // 50 free vCPU-hours
  },
  memory: {
    perGBSecond: 0.00000250, // $0.0090/GiB-hour
    freePerMonth: 360000, // 100 free GiB-hours
  },
  requests: {
    perMillion: 0.40,
    freePerMonth: 2000000,
  },
  networking: {
    perGB: 0.12, // North America egress
    freePerMonth: 1, // 1 GB free
  },
  ssl: {
    managed: 0, // Free managed SSL
  },
};

interface EstimateInput {
  cpu: number; // vCPUs
  memoryMB: number;
  avgRequestsPerDay: number;
  avgRequestDurationMs: number;
  avgResponseSizeKB: number;
  minInstances: number;
}

const DEFAULT_INPUT: EstimateInput = {
  cpu: 1,
  memoryMB: 512,
  avgRequestsPerDay: 1000,
  avgRequestDurationMs: 200,
  avgResponseSizeKB: 50,
  minInstances: 0,
};

export function estimateMonthlyCost(input: Partial<EstimateInput> = {}): CostEstimate {
  const cfg = { ...DEFAULT_INPUT, ...input };

  const monthlyRequests = cfg.avgRequestsPerDay * 30;
  const requestDurationSec = cfg.avgRequestDurationMs / 1000;
  const totalComputeSeconds = monthlyRequests * requestDurationSec;

  // Always-on compute (min instances)
  const alwaysOnSeconds = cfg.minInstances * 30 * 24 * 3600;
  const totalCPUSeconds = totalComputeSeconds + alwaysOnSeconds;
  const totalMemorySeconds = totalCPUSeconds; // Same duration

  // CPU cost
  const billableCPUSeconds = Math.max(0, totalCPUSeconds * cfg.cpu - PRICING.cpu.freePerMonth);
  const cpuCost = billableCPUSeconds * PRICING.cpu.perVCPUSecond;

  // Memory cost
  const memoryGB = cfg.memoryMB / 1024;
  const billableMemoryGBSeconds = Math.max(0, totalMemorySeconds * memoryGB - PRICING.memory.freePerMonth);
  const memoryCost = billableMemoryGBSeconds * PRICING.memory.perGBSecond;

  // Request cost
  const billableRequests = Math.max(0, monthlyRequests - PRICING.requests.freePerMonth);
  const requestCost = (billableRequests / 1000000) * PRICING.requests.perMillion;

  // Compute total
  const compute = Math.round((cpuCost + memoryCost + requestCost) * 100) / 100;

  // Networking
  const monthlyEgressGB = (monthlyRequests * cfg.avgResponseSizeKB) / (1024 * 1024);
  const billableEgressGB = Math.max(0, monthlyEgressGB - PRICING.networking.freePerMonth);
  const networking = Math.round(billableEgressGB * PRICING.networking.perGB * 100) / 100;

  // Storage (Artifact Registry, ~negligible for small images)
  const storage = 0.10; // ~$0.10/month for a single container image

  const ssl = PRICING.ssl.managed;

  const monthlyTotal = Math.round((compute + storage + networking + ssl) * 100) / 100;

  return {
    monthlyTotal,
    breakdown: {
      compute,
      storage,
      networking,
      ssl,
    },
    currency: 'USD',
  };
}

export function formatCostEstimate(estimate: CostEstimate): string {
  return [
    `Estimated monthly cost: $${estimate.monthlyTotal}/month`,
    `  Compute: $${estimate.breakdown.compute}`,
    `  Storage: $${estimate.breakdown.storage}`,
    `  Networking: $${estimate.breakdown.networking}`,
    `  SSL: $${estimate.breakdown.ssl} (managed, free)`,
    '',
    'Note: Based on GCP Cloud Run standard pricing.',
    'Actual costs may vary based on usage patterns.',
  ].join('\n');
}
