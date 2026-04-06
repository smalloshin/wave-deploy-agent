import type { CanaryResult, CanaryCheck } from '@deploy-agent/shared';
import { gcpFetch } from './gcp-auth';

export interface CanaryConfig {
  serviceUrl: string;
  checks: number;
  intervalMs: number;
  healthPath: string;
  maxErrorRate: number;
  maxLatencyMs: number;
}

const DEFAULT_CONFIG: CanaryConfig = {
  serviceUrl: '',
  checks: 5,
  intervalMs: 10000, // 10 seconds between checks
  healthPath: '/',
  maxErrorRate: 0.2, // 20% error rate triggers rollback
  maxLatencyMs: 5000, // 5 second p99 latency triggers rollback
};

export async function runCanaryChecks(
  serviceUrl: string,
  config: Partial<CanaryConfig> = {}
): Promise<CanaryResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config, serviceUrl };
  const checks: CanaryCheck[] = [];
  let errorCount = 0;

  for (let i = 0; i < cfg.checks; i++) {
    if (i > 0) {
      await sleep(cfg.intervalMs);
    }

    // HTTP health check
    const healthCheck = await checkHealth(cfg.serviceUrl, cfg.healthPath);
    checks.push(healthCheck);
    if (!healthCheck.passed) errorCount++;

    // Latency check
    const latencyCheck = await checkLatency(cfg.serviceUrl, cfg.healthPath, cfg.maxLatencyMs);
    checks.push(latencyCheck);
    if (!latencyCheck.passed) errorCount++;
  }

  // Error rate check
  const totalChecks = checks.length;
  const failedChecks = checks.filter((c) => !c.passed).length;
  const errorRate = totalChecks > 0 ? failedChecks / totalChecks : 0;

  const errorRateCheck: CanaryCheck = {
    type: 'error_rate',
    passed: errorRate <= cfg.maxErrorRate,
    value: errorRate,
    threshold: cfg.maxErrorRate,
    timestamp: new Date(),
  };
  checks.push(errorRateCheck);

  const passed = checks.every((c) => c.passed) || errorRate <= cfg.maxErrorRate;

  return {
    checks,
    passed,
    rolledBack: false, // caller decides rollback
  };
}

// Use authenticated fetch for Cloud Run URLs (*.run.app), plain fetch for custom domains
async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (url.includes('.run.app')) {
    // Cloud Run URL — use service account identity token
    return gcpFetch(url, { ...options, useIdentityToken: true } as Parameters<typeof gcpFetch>[1]);
  }
  return fetch(url, options);
}

async function checkHealth(serviceUrl: string, path: string): Promise<CanaryCheck> {
  const url = `${serviceUrl}${path}`;
  try {
    const response = await authenticatedFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });

    return {
      type: 'http_health',
      passed: response.ok,
      value: response.status,
      threshold: 200,
      timestamp: new Date(),
    };
  } catch {
    return {
      type: 'http_health',
      passed: false,
      value: 0,
      threshold: 200,
      timestamp: new Date(),
    };
  }
}

async function checkLatency(serviceUrl: string, path: string, maxMs: number): Promise<CanaryCheck> {
  const url = `${serviceUrl}${path}`;
  const start = Date.now();
  try {
    await authenticatedFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(maxMs),
    });
    const latency = Date.now() - start;

    return {
      type: 'latency',
      passed: latency <= maxMs,
      value: latency,
      threshold: maxMs,
      timestamp: new Date(),
    };
  } catch {
    return {
      type: 'latency',
      passed: false,
      value: Date.now() - start,
      threshold: maxMs,
      timestamp: new Date(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
