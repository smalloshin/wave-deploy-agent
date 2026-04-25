import type { FastifyInstance } from 'fastify';
import { query } from '../db/index';
import { checkSslStatus } from '../services/ssl-monitor';
import { getStageEvents, summarizeStages } from '../services/stage-events';
import { replayFrom, subscribe, type DeploymentEventEnvelope } from '../services/deployment-event-stream';
import { fetchBuildLogOnce } from '../services/build-log-poller';

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

  // SSE stream — real-time fan-out of stage transitions and (future) build-log chunks.
  //
  // Protocol:
  //   - Client connects: GET /api/deploys/:id/stream
  //   - Optional resume header: `Last-Event-ID: <seq>` — replays everything since that seq.
  //     If the seq is older than the ring buffer's oldest entry, server emits a synthetic
  //     `gap` event so the client knows it must refetch /timeline for fresh state.
  //   - Each event line: `id: <seq>\nevent: <type>\ndata: <json>\n\n`
  //   - `: keepalive` comment every 15s to defeat idle-connection timeouts (Cloud Run, proxies).
  //
  // Lifecycle:
  //   - On client disconnect, unsubscribe + clear keepalive interval.
  //   - We DO NOT close the stream from server side; the consumer decides when to stop
  //     (typically when overall=succeeded|failed and no further events expected).
  app.get<{ Params: { id: string } }>('/api/deploys/:id/stream', async (request, reply) => {
    // Verify deployment exists (don't open a stream for a 404)
    const exists = await query('SELECT 1 FROM deployments WHERE id = $1', [request.params.id]);
    if (exists.rows.length === 0) return reply.status(404).send({ error: 'Deployment not found' });

    const deploymentId = request.params.id;
    const lastEventIdHeader = request.headers['last-event-id'];
    const lastSeq = typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) : 0;
    const startFrom = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0;

    // Take over response lifecycle — Fastify will not auto-send anything after this.
    reply.hijack();

    // SSE headers — write directly to the raw response so we can stream chunks.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx-style proxy buffering
    });

    const writeEvent = (envelope: DeploymentEventEnvelope) => {
      // Note: SSE event names cannot contain newlines; our types are literals so safe.
      reply.raw.write(`id: ${envelope.seq}\n`);
      reply.raw.write(`event: ${envelope.type}\n`);
      reply.raw.write(`data: ${JSON.stringify({ ts: envelope.ts, ...envelope.payload })}\n\n`);
    };

    // 1. Replay from ring buffer (or emit gap)
    const replay = replayFrom(deploymentId, startFrom);
    if (replay.gap) {
      reply.raw.write(`event: gap\n`);
      reply.raw.write(`data: ${JSON.stringify({
        message: 'requested seq is older than ring buffer; refetch /timeline',
        evicted_through: replay.evicted_through,
      })}\n\n`);
    } else {
      for (const ev of replay.events) writeEvent(ev);
    }

    // 2. Subscribe to live tail
    const unsubscribe = subscribe(deploymentId, (envelope) => {
      try { writeEvent(envelope); }
      catch { /* client gone, will be cleaned up by 'close' handler */ }
    });

    // 3. Keepalive every 15s
    const keepalive = setInterval(() => {
      try { reply.raw.write(`: keepalive ${Date.now()}\n\n`); }
      catch { /* same as above */ }
    }, 15_000);

    // 4. Cleanup on client disconnect
    request.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });

    // Don't return anything — connection stays open until the client disconnects.
  });

  // Post-mortem build-log fetch — pulls the whole Cloud Build log from GCS.
  //
  // We don't stream live build logs yet (deferred — needs a deploy-engine refactor
  // to expose buildId before the build returns). This endpoint reads the full log
  // once the build is terminal so the user can scroll through it on the detail page.
  //
  // Find build_id from the build:succeeded or build:failed stage event metadata,
  // then read `gs://${gcpProject}_cloudbuild/log-{build_id}.txt`.
  app.get<{ Params: { id: string } }>('/api/deploys/:id/build-log', async (request, reply) => {
    const deploy = await query<{ project_id: string }>(
      'SELECT project_id FROM deployments WHERE id = $1',
      [request.params.id]
    );
    if (deploy.rows.length === 0) return reply.status(404).send({ error: 'Deployment not found' });

    // Pull build_id from the most recent terminal build event for this deployment
    const events = await getStageEvents(request.params.id);
    const buildEvent = [...events].reverse().find(e =>
      e.stage === 'build' && (e.status === 'succeeded' || e.status === 'failed')
    );
    const buildId = (buildEvent?.metadata as { build_id?: string } | undefined)?.build_id;
    if (!buildId) {
      return reply.status(404).send({
        error: 'No build_id recorded for this deployment yet (build may still be running)',
      });
    }

    // Read project's gcpProject from config — log bucket is `${gcpProject}_cloudbuild`.
    const proj = await query<{ config: unknown }>(
      'SELECT config FROM projects WHERE id = $1',
      [deploy.rows[0].project_id]
    );
    if (proj.rows.length === 0) return reply.status(404).send({ error: 'Project not found' });
    const cfg = typeof proj.rows[0].config === 'string'
      ? JSON.parse(proj.rows[0].config)
      : (proj.rows[0].config as Record<string, unknown>);
    const gcpProject = (cfg?.gcpProject as string | undefined) ?? process.env.GCP_PROJECT;
    if (!gcpProject) {
      return reply.status(500).send({ error: 'gcpProject not configured for this project' });
    }
    const bucket = `${gcpProject}_cloudbuild`;

    try {
      const log = await fetchBuildLogOnce(buildId, bucket);
      if (!log) {
        return reply.status(404).send({
          error: 'Build log object not found in GCS',
          buildId,
          bucket,
        });
      }
      return {
        buildId,
        bucket,
        size: log.size,
        updated: log.updated,
        text: log.text,
      };
    } catch (err) {
      return reply.status(502).send({
        error: `Failed to fetch build log: ${(err as Error).message}`,
        buildId,
        bucket,
      });
    }
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
