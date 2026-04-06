import type { FastifyInstance } from 'fastify';
import { query } from '../db/index';
import { checkSslStatus } from '../services/ssl-monitor';

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
