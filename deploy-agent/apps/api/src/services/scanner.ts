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

/**
 * Defensive JSON.parse for scanner stdout.
 *
 * Why: semgrep / trivy are subprocesses. Stdout can be valid JSON, valid JSON
 * truncated by maxBuffer, an OOM message, a binary core dump, or a network blob
 * leaked from a noisy lib. Every one of those used to crash the worker (uncaught
 * SyntaxError → unhandledRejection → pod restart → project stuck in 'scanning'
 * → reconciler eventually times it out 5min later, but only after the queue
 * clogs). Returning null on parse failure lets the scan complete with empty
 * findings — the security review still runs, just with no automated tool input.
 */
export function safeParseJson(stdout: string, tool: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    // Collapse whitespace in BOTH the error message and the preview — Node's
    // JSON.parse error includes the offending input verbatim with raw newlines,
    // which makes log lines hard to read in stackdriver / dashboards.
    const preview = stdout.slice(0, 200).replace(/\s+/g, ' ');
    const errMsg = (err as Error).message.replace(/\s+/g, ' ');
    console.error(
      `[${tool}] JSON.parse failed (${errMsg}); stdout preview: ${preview}`,
    );
    return null;
  }
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

    const parsed = safeParseJson(stdout, 'semgrep') as { results?: unknown[] } | null;
    if (!parsed) {
      return { tool: 'semgrep', findings: [], rawOutput: stdout, duration: Date.now() - start };
    }
    const findings: ScanFinding[] = ((parsed.results ?? []) as Array<Record<string, unknown>>).map((r, i) => ({
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
      const parsed = safeParseJson(error.stdout, 'semgrep:exit-nonzero');
      if (parsed) {
        return {
          tool: 'semgrep',
          findings: [],
          rawOutput: error.stdout,
          duration: Date.now() - start,
        };
      }
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

    const parsed = safeParseJson(stdout, 'trivy') as { Results?: unknown[] } | null;
    if (!parsed) {
      return { tool: 'trivy', findings: [], rawOutput: stdout, duration: Date.now() - start };
    }
    const findings: ScanFinding[] = [];

    for (const rawResult of parsed.Results ?? []) {
      const result = rawResult as Record<string, unknown>;
      const vulns = (result.Vulnerabilities ?? []) as Array<Record<string, unknown>>;
      const secrets = (result.Secrets ?? []) as Array<Record<string, unknown>>;
      for (const vuln of vulns) {
        findings.push({
          id: `trivy-${vuln.VulnerabilityID}`,
          tool: 'trivy',
          category: 'dependency',
          severity: mapTrivySeverity(vuln.Severity as string),
          title: `${vuln.VulnerabilityID}: ${vuln.PkgName}`,
          description: (vuln.Description as string) ?? (vuln.Title as string) ?? '',
          filePath: (result.Target as string) ?? '',
          lineStart: 0,
          lineEnd: 0,
          action: canAutoFixDependency(vuln) ? 'auto_fix' : 'report_only',
        });
      }
      for (const secret of secrets) {
        findings.push({
          id: `trivy-secret-${findings.length}`,
          tool: 'trivy',
          category: 'secrets',
          severity: 'critical',
          title: `Exposed secret: ${secret.Category}`,
          description: (secret.Match as string) ?? '',
          filePath: (result.Target as string) ?? '',
          lineStart: (secret.StartLine as number) ?? 0,
          lineEnd: (secret.EndLine as number) ?? 0,
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
