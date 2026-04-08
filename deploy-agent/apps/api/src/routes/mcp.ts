import type { FastifyInstance } from 'fastify';
import {
  createProject,
  listProjects,
  getProject,
  getLatestScanReport,
  transitionProject,
  submitReview,
  createDeployment,
} from '../services/orchestrator';
import { query } from '../db/index';
import { checkSslStatus } from '../services/ssl-monitor';
import { checkDomainConflict } from './projects';

// MCP Protocol handler - implements Model Context Protocol for AI tool integration
// This enables OpenClaw, Claude Code, and other MCP-compatible tools to interact with the deploy agent

interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const TOOLS = [
  {
    name: 'submit_project',
    description: 'Submit a vibe-coded project for security scanning and deployment to GCP Cloud Run',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['local_path', 'git_url', 'upload'], description: 'Source type' },
        path_or_url: { type: 'string', description: 'Local path or Git URL' },
        project_name: { type: 'string', description: 'Project name' },
        custom_domain: { type: 'string', description: 'Custom domain (required, e.g. "my-app" → my-app.punwave.com)' },
        force_domain: { type: 'boolean', description: 'Override existing domain mapping if conflict detected (default: false)' },
        allow_unauthenticated: { type: 'boolean', description: 'Allow public access (requires senior review)' },
        db_dump_path: { type: 'string', description: 'Path to a database dump file (.sql, .dump, .sql.gz) to restore during deployment (optional)' },
      },
      required: ['source', 'path_or_url', 'project_name', 'custom_domain'],
    },
  },
  {
    name: 'get_project_status',
    description: 'Check the current status of a submitted project',
    inputSchema: {
      type: 'object' as const,
      properties: { project_id: { type: 'string' } },
      required: ['project_id'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all submitted projects with their current status',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_scan_report',
    description: 'Get the security scan report for a project',
    inputSchema: {
      type: 'object' as const,
      properties: { project_id: { type: 'string' } },
      required: ['project_id'],
    },
  },
  {
    name: 'approve_deploy',
    description: 'Approve a project for production deployment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string' },
        comments: { type: 'string' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'reject_deploy',
    description: 'Reject a project deployment with feedback',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['project_id', 'reason'],
    },
  },
  {
    name: 'get_deploy_status',
    description: 'Get deployment status including health checks and custom domain',
    inputSchema: {
      type: 'object' as const,
      properties: { project_id: { type: 'string' } },
      required: ['project_id'],
    },
  },
  {
    name: 'rollback_deploy',
    description: 'Rollback a deployment to the previous version',
    inputSchema: {
      type: 'object' as const,
      properties: { project_id: { type: 'string' } },
      required: ['project_id'],
    },
  },
];

async function handleToolCall(call: MCPToolCall): Promise<MCPToolResult> {
  try {
    switch (call.name) {
      case 'submit_project': {
        // ─── Validate ALL required fields BEFORE doing anything ───
        const missingFields: string[] = [];
        if (!call.arguments.source) missingFields.push('source (專案來源類型: local_path, git_url, 或 upload)');
        if (!call.arguments.path_or_url) missingFields.push('path_or_url (專案路徑或 Git URL)');
        if (!call.arguments.project_name) missingFields.push('project_name (專案名稱，英文小寫)');
        if (!call.arguments.custom_domain || !(call.arguments.custom_domain as string).trim()) {
          missingFields.push('custom_domain (自訂網域，例如 "my-app" → my-app.punwave.com)');
        }
        if (missingFields.length > 0) {
          return error(
            `缺少必填欄位，請向使用者詢問以下資訊後再重試：\n` +
            missingFields.map((f, i) => `  ${i + 1}. ${f}`).join('\n') +
            `\n\n⚠️ 不要猜測這些值，必須由使用者明確提供。`
          );
        }

        // If db_dump_path is provided, upload it to GCS
        let gcsDbDumpUri: string | undefined;
        let dbDumpFileName: string | undefined;
        const dbDumpPath = call.arguments.db_dump_path as string | undefined;
        if (dbDumpPath) {
          try {
            const { readFileSync, existsSync } = await import('node:fs');
            const { basename } = await import('node:path');
            if (!existsSync(dbDumpPath)) {
              return error(`DB dump file not found: ${dbDumpPath}`);
            }
            dbDumpFileName = basename(dbDumpPath);
            const dumpBuffer = readFileSync(dbDumpPath);
            const projectSlug = (call.arguments.project_name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
            const gcpProject = process.env.GCP_PROJECT || 'wave-deploy-agent';
            const bucket = `${gcpProject}_cloudbuild`;
            const objectName = `db-dumps/${projectSlug}-${Date.now()}-${dbDumpFileName}`;
            const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
            const { gcpFetch } = await import('../services/gcp-auth');
            const uploadRes = await gcpFetch(uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: dumpBuffer,
            });
            if (uploadRes.ok) {
              gcsDbDumpUri = `gs://${bucket}/${objectName}`;
              console.log(`[MCP] DB dump uploaded to ${gcsDbDumpUri}`);
            } else {
              console.warn(`[MCP] DB dump upload failed: HTTP ${uploadRes.status}`);
            }
          } catch (err) {
            console.warn(`[MCP] DB dump upload error: ${(err as Error).message}`);
          }
        }

        // Validate required custom_domain
        const customDomain = call.arguments.custom_domain as string | undefined;
        if (!customDomain?.trim()) {
          return error('custom_domain is required. Provide a subdomain, e.g. "my-app" → my-app.punwave.com');
        }

        // Domain conflict check
        const forceDomain = call.arguments.force_domain as boolean | undefined;
        if (customDomain && !forceDomain) {
          const cfZone = process.env.CLOUDFLARE_ZONE_NAME || 'punwave.com';
          const sub = customDomain.replace(`.${cfZone}`, '');
          const conflict = await checkDomainConflict(sub);
          if (conflict) {
            return error(
              `⚠ Domain conflict: "${conflict.fqdn}" is already mapped to service "${conflict.existingRoute}". ` +
              `To override, set force_domain=true. To use a different domain, change custom_domain.`
            );
          }
        }

        const project = await createProject({
          name: call.arguments.project_name as string,
          sourceType: call.arguments.source === 'git_url' ? 'git' : 'upload',
          sourceUrl: call.arguments.path_or_url as string,
          config: {
            customDomain,
            forceDomain: forceDomain ?? false,
            allowUnauthenticated: (call.arguments.allow_unauthenticated as boolean) ?? true,
            gcsDbDumpUri,
            dbDumpFileName,
          },
        });
        const dbMsg = gcsDbDumpUri ? ' Database dump will be restored during deployment.' : '';
        return text(`Project "${project.name}" submitted (ID: ${project.id}). Status: ${project.status}. Security scanning will begin shortly.${dbMsg}`);
      }

      case 'get_project_status': {
        const project = await getProject(call.arguments.project_id as string);
        if (!project) return error('Project not found');
        return text(`Project: ${project.name}\nStatus: ${project.status}\nLanguage: ${project.detectedLanguage ?? 'detecting...'}\nFramework: ${project.detectedFramework ?? 'detecting...'}`);
      }

      case 'list_projects': {
        const projects = await listProjects();
        if (projects.length === 0) return text('No projects found. Submit your first project with submit_project.');
        const lines = projects.map((p) => `- ${p.name} [${p.status}] (${p.slug})`);
        return text(`${projects.length} projects:\n${lines.join('\n')}`);
      }

      case 'get_scan_report': {
        const report = await getLatestScanReport(call.arguments.project_id as string);
        if (!report) return error('No scan report found for this project');
        return text(`Scan Report (v${report.version}):\nStatus: ${report.status}\nFindings: ${report.findings.length}\nSummary: ${report.threatSummary || 'Scan in progress...'}`);
      }

      case 'approve_deploy': {
        const pid = call.arguments.project_id as string;
        const project = await getProject(pid);
        if (!project) return error('Project not found');
        if (project.status !== 'review_pending') return error(`Cannot approve: project is in ${project.status} state`);

        // Find the pending review
        const reviewResult = await query(
          `SELECT r.id FROM reviews r
           JOIN scan_reports sr ON r.scan_report_id = sr.id
           WHERE sr.project_id = $1 AND r.decision IS NULL
           ORDER BY r.created_at DESC LIMIT 1`,
          [pid]
        );
        if (reviewResult.rows.length === 0) return error('No pending review found');

        await submitReview(reviewResult.rows[0].id as string, 'approved', 'mcp-user', call.arguments.comments as string);
        await transitionProject(pid, 'approved', 'mcp-user');
        return text(`Project "${project.name}" approved for deployment. Deployment will begin shortly.`);
      }

      case 'reject_deploy': {
        const pid = call.arguments.project_id as string;
        const project = await getProject(pid);
        if (!project) return error('Project not found');
        if (project.status !== 'review_pending') return error(`Cannot reject: project is in ${project.status} state`);

        const reviewResult = await query(
          `SELECT r.id FROM reviews r
           JOIN scan_reports sr ON r.scan_report_id = sr.id
           WHERE sr.project_id = $1 AND r.decision IS NULL
           ORDER BY r.created_at DESC LIMIT 1`,
          [pid]
        );
        if (reviewResult.rows.length === 0) return error('No pending review found');

        await submitReview(reviewResult.rows[0].id as string, 'rejected', 'mcp-user', call.arguments.reason as string);
        await transitionProject(pid, 'rejected', 'mcp-user');
        return text(`Project "${project.name}" rejected. Reason: ${call.arguments.reason}. The project owner can revise and resubmit.`);
      }

      case 'get_deploy_status': {
        const result = await query(
          `SELECT d.*, p.name as project_name, p.config, p.status as project_status FROM deployments d
           JOIN projects p ON d.project_id = p.id
           WHERE d.project_id = $1
           ORDER BY d.created_at DESC LIMIT 1`,
          [call.arguments.project_id]
        );
        if (result.rows.length === 0) return error('No deployment found for this project');
        const d = result.rows[0];

        let sslInfo = `SSL: ${d.ssl_status ?? 'pending'}`;

        // If custom domain exists and SSL not yet active, check live status
        if (d.custom_domain && d.ssl_status !== 'active') {
          const config = typeof d.config === 'string' ? JSON.parse(d.config) : d.config;
          const gcpProject = config?.gcpProject || process.env.GCP_PROJECT || '';
          const gcpRegion = config?.gcpRegion || process.env.GCP_REGION || '';

          if (gcpProject && gcpRegion) {
            const liveStatus = await checkSslStatus(gcpProject, gcpRegion, d.custom_domain as string);
            if (liveStatus.allReady) {
              sslInfo = 'SSL: ✅ active (all conditions True, certificate serving traffic)';
            } else {
              const pending = liveStatus.conditions
                .filter((c) => c.status !== 'True')
                .map((c) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
                .join(', ');
              sslInfo = `SSL: ⏳ provisioning — pending: ${pending || 'checking...'}`;
            }
          }
        } else if (d.ssl_status === 'active') {
          sslInfo = 'SSL: ✅ active (certificate serving traffic)';
        }

        return text(
          `Deploy: ${d.project_name}\n` +
          `Status: ${d.project_status}\n` +
          `URL: ${d.cloud_run_url ?? 'pending'}\n` +
          `Domain: ${d.custom_domain ?? 'none'}\n` +
          `${sslInfo}\n` +
          `Health: ${d.health_status}`
        );
      }

      case 'rollback_deploy': {
        const project = await getProject(call.arguments.project_id as string);
        if (!project) return error('Project not found');
        if (project.status !== 'live' && project.status !== 'canary_check') {
          return error(`Cannot rollback: project is in ${project.status} state`);
        }
        await transitionProject(project.id, 'rolling_back', 'mcp-user', { action: 'manual_rollback' });
        return text(`Rolling back "${project.name}" to previous version...`);
      }

      default:
        return error(`Unknown tool: ${call.name}`);
    }
  } catch (err) {
    return error(`Tool error: ${(err as Error).message}`);
  }
}

function text(t: string): MCPToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function error(t: string): MCPToolResult {
  return { content: [{ type: 'text', text: t }], isError: true };
}

export async function mcpRoutes(app: FastifyInstance) {
  // List available tools
  app.post('/mcp/tools/list', async () => {
    return { tools: TOOLS };
  });

  // Call a tool
  app.post('/mcp/tools/call', async (request) => {
    const body = request.body as { name: string; arguments: Record<string, unknown> };
    const result = await handleToolCall({ name: body.name, arguments: body.arguments ?? {} });
    return result;
  });
}
