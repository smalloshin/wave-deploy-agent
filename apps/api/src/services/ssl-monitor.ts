// SSL Certificate Monitor
// Polls Cloud Run domain mapping status until all conditions are True
// Then transitions project ssl_provisioning → canary_check

import { gcpFetch } from './gcp-auth';
import { query } from '../db/index';

export interface SslCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface SslStatusResult {
  domain: string;
  allReady: boolean;
  conditions: SslCondition[];
  checkedAt: Date;
}

export interface SslMonitorConfig {
  gcpProject: string;
  gcpRegion: string;
  domain: string;
  maxChecks: number;
  intervalMs: number;
}

const DEFAULT_CONFIG: Omit<SslMonitorConfig, 'gcpProject' | 'gcpRegion' | 'domain'> = {
  maxChecks: 60,       // 60 checks × 15s = 15 minutes max
  intervalMs: 15000,   // 15 seconds between checks
};

// ─── Check SSL status once ───

export async function checkSslStatus(
  gcpProject: string,
  gcpRegion: string,
  domain: string
): Promise<SslStatusResult> {
  try {
    const url = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
    const res = await gcpFetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const mapping = await res.json() as { status?: { conditions?: Record<string, string>[] } };
    const conditions: SslCondition[] = (mapping.status?.conditions ?? []).map(
      (c: Record<string, string>) => ({
        type: c.type,
        status: c.status as SslCondition['status'],
        reason: c.reason,
        message: c.message,
        lastTransitionTime: c.lastTransitionTime,
      })
    );

    const allReady = conditions.length > 0 && conditions.every((c) => c.status === 'True');

    return { domain, allReady, conditions, checkedAt: new Date() };
  } catch (err) {
    return {
      domain,
      allReady: false,
      conditions: [{
        type: 'Error',
        status: 'False',
        reason: 'CheckFailed',
        message: (err as Error).message,
      }],
      checkedAt: new Date(),
    };
  }
}

// ─── Poll until SSL is ready ───

export async function monitorSsl(
  deploymentId: string,
  projectId: string,
  config: SslMonitorConfig,
  onProgress?: (status: SslStatusResult, attempt: number) => void
): Promise<SslStatusResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  for (let i = 0; i < cfg.maxChecks; i++) {
    if (i > 0) {
      await sleep(cfg.intervalMs);
    }

    const status = await checkSslStatus(cfg.gcpProject, cfg.gcpRegion, cfg.domain);
    onProgress?.(status, i + 1);

    // Update deployment record with latest SSL status
    await updateDeploymentSsl(deploymentId, status);

    if (status.allReady) {
      console.log(`  SSL: All conditions True for ${cfg.domain} (check ${i + 1}/${cfg.maxChecks})`);
      return status;
    }

    const pendingConditions = status.conditions
      .filter((c) => c.status !== 'True')
      .map((c) => `${c.type}=${c.status}`)
      .join(', ');
    console.log(`  SSL: Check ${i + 1}/${cfg.maxChecks} — pending: ${pendingConditions}`);
  }

  // Timed out — don't transition to failed, just return the result
  // The caller (deploy-worker) decides whether to continue or fail
  const finalStatus = await checkSslStatus(cfg.gcpProject, cfg.gcpRegion, cfg.domain);
  console.warn(`  SSL: Timed out after ${cfg.maxChecks} checks for ${cfg.domain} — continuing pipeline`);

  return finalStatus;
}

// ─── Update deployment SSL status in DB ───

async function updateDeploymentSsl(deploymentId: string, status: SslStatusResult): Promise<void> {
  const sslStatus = status.allReady ? 'active' : 'provisioning';
  await query(
    `UPDATE deployments SET ssl_status = $1 WHERE id = $2`,
    [sslStatus, deploymentId]
  );
}

// ─── Get live SSL status for a deployment (used by API/MCP) ───

export async function getLiveSslStatus(
  deploymentId: string
): Promise<SslStatusResult | null> {
  const result = await query(
    `SELECT d.custom_domain, p.config
     FROM deployments d
     JOIN projects p ON d.project_id = p.id
     WHERE d.id = $1`,
    [deploymentId]
  );

  if (result.rows.length === 0) return null;

  const domain = result.rows[0].custom_domain as string;
  if (!domain) return null;

  const config = typeof result.rows[0].config === 'string'
    ? JSON.parse(result.rows[0].config)
    : result.rows[0].config;

  const gcpProject = config?.gcpProject || process.env.GCP_PROJECT || '';
  const gcpRegion = config?.gcpRegion || process.env.GCP_REGION || '';

  if (!gcpProject || !gcpRegion) return null;

  return checkSslStatus(gcpProject, gcpRegion, domain);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
