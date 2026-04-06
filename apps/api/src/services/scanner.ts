import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScanFinding, ScanSeverity } from '@deploy-agent/shared';

const execFileAsync = promisify(execFile);

export interface ScanResult {
  tool: 'semgrep' | 'trivy';
  findings: ScanFinding[];
  rawOutput: string;
  duration: number;
}

export async function runSemgrep(projectDir: string): Promise<ScanResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('semgrep', [
      'scan',
      '--json',
      '--config', 'auto',
      '--timeout', '120',
      '--max-memory', '512',
      '--jobs', '1',
      projectDir,
    ], { timeout: 3 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

    const parsed = JSON.parse(stdout);
    const findings: ScanFinding[] = (parsed.results ?? []).map((r: Record<string, unknown>, i: number) => ({
      id: `semgrep-${i}`,
      tool: 'semgrep' as const,
      category: mapSemgrepCategory(r.check_id as string),
      severity: mapSemgrepSeverity(r.extra as Record<string, unknown>),
      title: (r.check_id as string)?.split('.').pop() ?? 'Unknown',
      description: ((r.extra as Record<string, unknown>)?.message as string) ?? '',
      filePath: (r.path as string) ?? '',
      lineStart: (r.start as Record<string, number>)?.line ?? 0,
      lineEnd: (r.end as Record<string, number>)?.line ?? 0,
      action: shouldAutoFix(r.check_id as string) ? 'auto_fix' as const : 'report_only' as const,
    }));

    return { tool: 'semgrep', findings, rawOutput: stdout, duration: Date.now() - start };
  } catch (err) {
    const error = err as Error & { stdout?: string };
    // Semgrep may exit non-zero but still produce valid JSON output
    if (error.stdout) {
      try {
        const parsed = JSON.parse(error.stdout);
        return {
          tool: 'semgrep',
          findings: [],
          rawOutput: error.stdout,
          duration: Date.now() - start,
        };
      } catch {}
    }
    console.error('Semgrep scan failed:', error.message);
    return { tool: 'semgrep', findings: [], rawOutput: error.message, duration: Date.now() - start };
  }
}

export async function runTrivy(projectDir: string): Promise<ScanResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('trivy', [
      'fs',
      '--format', 'json',
      '--scanners', 'vuln,secret,misconfig',
      '--timeout', '5m',
      projectDir,
    ], { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

    const parsed = JSON.parse(stdout);
    const findings: ScanFinding[] = [];

    for (const result of parsed.Results ?? []) {
      for (const vuln of result.Vulnerabilities ?? []) {
        findings.push({
          id: `trivy-${vuln.VulnerabilityID}`,
          tool: 'trivy',
          category: 'dependency',
          severity: mapTrivySeverity(vuln.Severity),
          title: `${vuln.VulnerabilityID}: ${vuln.PkgName}`,
          description: vuln.Description ?? vuln.Title ?? '',
          filePath: result.Target ?? '',
          lineStart: 0,
          lineEnd: 0,
          action: canAutoFixDependency(vuln) ? 'auto_fix' : 'report_only',
        });
      }
      for (const secret of result.Secrets ?? []) {
        findings.push({
          id: `trivy-secret-${findings.length}`,
          tool: 'trivy',
          category: 'secrets',
          severity: 'critical',
          title: `Exposed secret: ${secret.Category}`,
          description: secret.Match ?? '',
          filePath: result.Target ?? '',
          lineStart: secret.StartLine ?? 0,
          lineEnd: secret.EndLine ?? 0,
          action: 'auto_fix',
        });
      }
    }

    return { tool: 'trivy', findings, rawOutput: stdout, duration: Date.now() - start };
  } catch (err) {
    const error = err as Error;
    console.error('Trivy scan failed:', error.message);
    return { tool: 'trivy', findings: [], rawOutput: error.message, duration: Date.now() - start };
  }
}

function mapSemgrepSeverity(extra: Record<string, unknown>): ScanSeverity {
  const sev = (extra?.severity as string)?.toUpperCase();
  switch (sev) {
    case 'ERROR': return 'critical';
    case 'WARNING': return 'high';
    case 'INFO': return 'medium';
    default: return 'low';
  }
}

function mapSemgrepCategory(checkId: string): string {
  if (checkId?.includes('injection')) return 'injection';
  if (checkId?.includes('xss')) return 'xss';
  if (checkId?.includes('auth')) return 'auth';
  if (checkId?.includes('crypto')) return 'crypto';
  if (checkId?.includes('secret') || checkId?.includes('password') || checkId?.includes('key')) return 'secrets';
  return 'security';
}

function mapTrivySeverity(severity: string): ScanSeverity {
  switch (severity?.toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    case 'LOW': return 'low';
    default: return 'info';
  }
}

function shouldAutoFix(checkId: string): boolean {
  if (!checkId) return false;
  const autoFixPatterns = ['hardcoded-secret', 'sql-injection', 'xss', 'env-in-source'];
  return autoFixPatterns.some((p) => checkId.toLowerCase().includes(p));
}

function canAutoFixDependency(vuln: Record<string, unknown>): boolean {
  return !!(vuln.FixedVersion && vuln.FixedVersion !== '');
}
