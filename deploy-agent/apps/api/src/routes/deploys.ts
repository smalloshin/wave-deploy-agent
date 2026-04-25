import type { FastifyInstance } from 'fastify';
import { query } from '../db/index';
import { checkSslStatus } from '../services/ssl-monitor';
import { getStageEvents, summarizeStages } from '../services/stage-events';

export async function deployRoutes(app: FastifyInstance) {
  // List deployments
  app.get('/api/deploys', async () => {
    const result = await query(
      `SELECT d.*, p.name as project_name, p.slug as project_slug
       FROM deployments d
       JOIN projects p ON d.project_id = p.id
       ORDER BY d.created_at DESC
       LIMIT 50`
    );
    return { deployments: result.rows };
  });

  // Get single deployment
  app.get<{ Params: { id: string } }>('/api/deploys/:id', async (request, reply) => {
    const result = await query(
      `SELECT d.*, p.name as project_name, p.slug as project_slug
       FROM deployments d
       JOIN projects p ON d.project_id = p.id
       WHERE d.id = $1`,
      [request.params.id]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Deployment not found' });
    return { deployment: result.rows[0] };
  });

  // Get live SSL certificate status for a deployment
  app.get<{ Params: { id: string } }>('/api/deploys/:id/ssl-status', async (request, reply) => {
    const result = await query(
      `SELECT d.custom_domain, d.ssl_status, d.project_id, p.config, p.status as project_status
       FROM deployments d
       JOIN projects p ON d.project_id = p.id
       WHERE d.id = $1`,
      [request.params.id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Deployment not found' });
    }

    const row = result.rows[0];
    const domain = row.custom_domain as string;

    if (!domain) {
      return {
        deploymentId: request.params.id,
        domain: null,
        sslStatus: 'not_applicable',
        message: 'No custom domain configured',
        conditions: [],
        allReady: false,
      };
    }

    // If already marked active in DB, return cached status
    if (row.ssl_status === 'active') {
      return {
        deploymentId: request.params.id,
        domain,
        sslStatus: 'active',
        message: 'SSL certificate is active and serving traffic',
        conditions: [],
        allReady: true,
      };
    }

    // Check live status from GCP
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    const gcpProject = config?.gcpProject || process.env.GCP_PROJECT || '';
    const gcpRegion = config?.gcpRegion || process.env.GCP_REGION || '';

    if (!gcpProject || !gcpRegion) {
      return {
        deploymentId: request.params.id,
        domain,
        sslStatus: 'unknown',
        message: 'GCP project/region not configured',
        conditions: [],
        allReady: false,
      };
    }

    const liveStatus = await checkSslStatus(gcpProject, gcpRegion, domain);

    return {
      deploymentId: request.params.id,
      domain,
      sslStatus: liveStatus.allReady ? 'active' : 'provisioning',
      message: liveStatus.allReady
        ? 'SSL certificate is active and serving traffic'
        : 'SSL certificate is being provisioned by Google (typically 5-15 minutes)',
      conditions: liveStatus.conditions,
      allReady: liveStatus.allReady,
      checkedAt: liveStatus.checkedAt,
    };
  });

  // Get deployment timeline (per-stage events: extract / build / push / deploy / health_check / ssl)
  // This is the primary observability endpoint consumed by Tier 1 (Timeline view).
  app.get<{ Params: { id: string } }>('/api/deploys/:id/timeline', async (request, reply) => {
    const deploy = await query<{
      id: string;
      project_id: string;
      created_at: Date;
      version: number;
      cloud_run_url: string | null;
      custom_domain: string | null;
      health_status: string | null;
      ssl_status: string | null;
      deployed_at: Date | null;
    }>(
      `SELECT id, project_id, created_at, version, cloud_run_url, custom_domain,
              health_status, ssl_status, deployed_at
         FROM deployments WHERE id = $1`,
      [request.params.id]
    );
    if (deploy.rows.length === 0) return reply.status(404).send({ error: 'Deployment not found' });

    const events = await getStageEvents(request.params.id);
    const stages = summarizeStages(events);

    // Compute overall: failed > running > succeeded
    const overall = stages.some(s => s.status === 'failed')
      ? 'failed'
      : stages.some(s => s.status === 'started')
        ? 'running'
        : stages.length > 0
          ? 'succeeded'
          : 'pending';

    return {
      deployment: {
        id: deploy.rows[0].id,
        project_id: deploy.rows[0].project_id,
        version: deploy.rows[0].version,
        cloud_run_url: deploy.rows[0].cloud_run_url,
        custom_domain: deploy.rows[0].custom_domain,
        health_status: deploy.rows[0].health_status,
        ssl_status: deploy.rows[0].ssl_status,
        created_at: deploy.rows[0].created_at,
        deployed_at: deploy.rows[0].deployed_at,
      },
      overall,
      stages,
      events,
    };
  });

  // Get deployment logs (state transitions)
  app.get<{ Params: { id: string } }>('/api/deploys/:id/logs', async (request, reply) => {
    const deploy = await query('SELECT project_id FROM deployments WHERE id = $1', [request.params.id]);
    if (deploy.rows.length === 0) return reply.status(404).send({ error: 'Deployment not found' });

    const transitions = await query(
      `SELECT * FROM state_transitions
       WHERE project_id = $1
       ORDER BY created_at ASC`,
      [deploy.rows[0].project_id]
    );
    return { logs: transitions.rows };
  });
}
