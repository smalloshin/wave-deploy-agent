// Versioning routes (Netlify-like) — split from projects.ts for reliability
// These routes were intermittently failing to register when defined at the end
// of the massive projectRoutes plugin (1600+ lines). Isolating them in their own
// plugin eliminates that problem.

import type { FastifyInstance } from 'fastify';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gcpFetch } from '../services/gcp-auth';
import {
  getProject,
  transitionProject,
  createScanReport,
  getDeploymentsByProject,
  updateProjectConfig,
  publishDeployment,
  setDeployLock,
  getPublishedDeployment,
} from '../services/orchestrator';
import { runPipeline } from '../services/pipeline-worker';
import { publishRevision, deleteRevision } from '../services/deploy-engine';
import { generateDownloadSignedUrl } from '../services/deployed-source-capture';

const execFileAsync = promisify(execFile);

export async function versioningRoutes(app: FastifyInstance) {
  app.log.info('[versioning] Registering versioning routes...');

  // List all deployment versions for a project
  app.get<{ Params: { id: string } }>('/api/projects/:id/versions', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const deployments = await getDeploymentsByProject(project.id);

    return {
      versions: deployments.map((d) => ({
        id: d.id,
        version: d.version,
        cloudRunService: d.cloudRunService,
        cloudRunUrl: d.cloudRunUrl,
        customDomain: d.customDomain,
        imageUri: d.imageUri,
        revisionName: d.revisionName,
        previewUrl: d.previewUrl,
        healthStatus: d.healthStatus,
        isPublished: d.isPublished,
        publishedAt: d.publishedAt,
        deployedAt: d.deployedAt,
        createdAt: d.createdAt,
        deployedSourceGcsUri: d.deployedSourceGcsUri,
      })),
      publishedDeploymentId: deployments.find(d => d.isPublished)?.id ?? null,
      deployLocked: project.config?.deployLocked === true,
    };
  });

  // Publish a specific deployment version (instant rollback / promote)
  app.post<{ Params: { id: string; deployId: string } }>(
    '/api/projects/:id/versions/:deployId/publish',
    async (request, reply) => {
      const project = await getProject(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const deployments = await getDeploymentsByProject(project.id);
      const target = deployments.find((d) => d.id === request.params.deployId);
      if (!target) return reply.status(404).send({ error: 'Deployment not found' });

      if (!target.revisionName || !target.cloudRunService) {
        return reply.status(400).send({
          error: 'This deployment has no Cloud Run revision — cannot publish',
        });
      }

      const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
      const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';

      // Route 100% traffic to the target revision
      const result = await publishRevision(gcpProject, gcpRegion, target.cloudRunService, target.revisionName);
      if (!result.success) {
        return reply.status(500).send({ error: `Failed to publish: ${result.error}` });
      }

      // Check if this is a rollback BEFORE updating DB
      const previousPublished = await getPublishedDeployment(project.id);
      const isRollback = (previousPublished?.version ?? 0) > target.version;

      // Update DB: mark this deployment as published
      await publishDeployment(project.id, target.id);

      return {
        published: true,
        version: target.version,
        revisionName: target.revisionName,
        isRollback,
        message: isRollback
          ? `已回滾至 v${target.version}`
          : `已發佈 v${target.version}`,
      };
    }
  );

  // Upload new version for an existing project (triggers new pipeline)
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/new-version',
    async (request, reply) => {
      const project = await getProject(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      if (project.status !== 'live' && project.status !== 'failed' && project.status !== 'stopped') {
        return reply.status(400).send({
          error: `無法從 ${project.status} 狀態升版。只有 live、failed、stopped 狀態可以升版。`,
        });
      }

      // Accept GCS URI (from the large-file upload flow)
      const body = request.body as {
        gcsUri?: string;
        fileName?: string;
        envVars?: Record<string, string>;
      };

      if (!body.gcsUri && !project.config?.gcsSourceUri) {
        return reply.status(400).send({ error: '請提供新版本原始碼（gcsUri）' });
      }

      // If new source provided, update sourceUrl
      const newGcsUri = body.gcsUri ?? (project.config?.gcsSourceUri as string);

      // Extract to /tmp for pipeline processing
      const uploadDir = join(tmpdir(), `deploy-agent-uploads/${project.slug}-${Date.now()}`);
      await mkdir(uploadDir, { recursive: true });

      let projectDir = uploadDir;
      try {
        // Download from GCS
        const { existsSync, readdirSync } = await import('node:fs');
        const tarballPath = join(uploadDir, 'source.tgz');

        const bucketAndObject = newGcsUri.replace('gs://', '');
        const slashIdx = bucketAndObject.indexOf('/');
        const bucket = bucketAndObject.slice(0, slashIdx);
        const object = bucketAndObject.slice(slashIdx + 1);
        const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
        const resp = await gcpFetch(downloadUrl);
        if (!resp.ok) throw new Error(`GCS download failed: ${resp.status}`);
        const { writeFileSync } = await import('node:fs');
        const buffer = Buffer.from(await resp.arrayBuffer());
        writeFileSync(tarballPath, buffer);

        // Extract
        const sourceDir = join(uploadDir, 'source');
        await mkdir(sourceDir, { recursive: true });
        await execFileAsync('tar', ['xzf', tarballPath, '-C', sourceDir]);

        // Find actual project root (may be nested)
        const entries = readdirSync(sourceDir, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
        if (dirs.length === 1 && !existsSync(join(sourceDir, 'Dockerfile')) && !existsSync(join(sourceDir, 'package.json'))) {
          projectDir = join(sourceDir, dirs[0].name);
        } else {
          projectDir = sourceDir;
        }

        // For monorepo services, narrow down to service subdirectory
        if (project.config?.serviceDirName) {
          const svcDir = join(projectDir, project.config.serviceDirName as string);
          if (existsSync(svcDir)) {
            projectDir = svcDir;
          }
        }
      } catch (err) {
        return reply.status(500).send({ error: `原始碼解壓失敗: ${(err as Error).message}` });
      }

      // Update project source and config. Clear gcsFixedSourceUri so the new
      // pipeline run produces a fresh post-fix snapshot instead of deploying
      // the PREVIOUS version's fixed source.
      const updatedConfig = {
        ...(project.config ?? {}),
        gcsSourceUri: newGcsUri,
        gcsFixedSourceUri: undefined,
        ...(body.envVars ? { envVars: { ...(project.config?.envVars ?? {}), ...body.envVars } } : {}),
      };
      await updateProjectConfig(project.id, updatedConfig);

      // Transition: live → submitted → scanning
      await transitionProject(project.id, 'submitted', 'user', { action: 'new-version' });
      await transitionProject(project.id, 'scanning', 'system', { trigger: 'new-version' });

      const scanReport = await createScanReport(project.id);

      // Trigger pipeline in background
      runPipeline(project.id, projectDir).catch((err) => {
        console.error(`[Pipeline] New version dispatch failed for ${project.id}:`, (err as Error).message);
      });

      reply.status(201).send({
        project: { ...project, status: 'scanning' },
        scanReport,
        message: '新版本已提交，開始掃描與部署流程',
      });
    }
  );

  // Toggle deploy lock
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/deploy-lock',
    async (request, reply) => {
      const project = await getProject(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const body = (request.body ?? {}) as { locked?: boolean };
      const locked = body.locked !== undefined ? body.locked : !project.config?.deployLocked;

      await setDeployLock(project.id, locked);

      return {
        deployLocked: locked,
        message: locked ? '部署已鎖定 — 新版本不會自動發佈' : '部署已解鎖 — 新版本將自動發佈',
      };
    }
  );

  // Manual version cleanup (keep last N, default 5)
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/versions/cleanup',
    async (request, reply) => {
      const project = await getProject(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const body = (request.body ?? {}) as { keep?: number };
      const keep = body.keep ?? 5;
      const deployments = await getDeploymentsByProject(project.id);

      if (deployments.length <= keep) {
        return { cleaned: 0, kept: deployments.length, message: `版本數 (${deployments.length}) 未超過保留上限 (${keep})` };
      }

      const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
      const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';

      const toCleanup = deployments.slice(keep);
      let cleaned = 0;
      const errors: string[] = [];

      for (const old of toCleanup) {
        if (old.isPublished) continue; // never delete published
        if (old.revisionName) {
          const result = await deleteRevision(gcpProject, gcpRegion, old.revisionName);
          if (result.success) {
            cleaned++;
          } else {
            errors.push(`${old.revisionName}: ${result.error}`);
          }
        }
      }

      return {
        cleaned,
        kept: keep,
        errors: errors.length > 0 ? errors : undefined,
        message: `清理完成：刪除 ${cleaned} 個舊 revision，保留 ${keep} 個版本`,
      };
    }
  );

  // Download the deployed source snapshot (post-fix code + generated Dockerfile)
  // Returns a 15-minute signed URL pointing at gs://wave-deploy-agent-deployed/{slug}/v{n}.tgz
  app.get<{ Params: { id: string; deployId: string } }>(
    '/api/projects/:id/versions/:deployId/download',
    async (request, reply) => {
      const project = await getProject(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const deployments = await getDeploymentsByProject(project.id);
      const target = deployments.find((d) => d.id === request.params.deployId);
      if (!target) return reply.status(404).send({ error: 'Deployment not found' });

      if (!target.deployedSourceGcsUri) {
        return reply.status(404).send({
          error: '本部署沒有留存 source 快照',
          hint: '可能是舊版部署（2026-04-17 之前）或 capture 當時失敗。重新部署一次會自動建立快照。',
        });
      }

      try {
        const signedUrl = await generateDownloadSignedUrl(target.deployedSourceGcsUri, 15);
        return {
          signedUrl,
          expiresInMinutes: 15,
          gcsUri: target.deployedSourceGcsUri,
          version: target.version,
          filename: `${project.slug}-v${target.version}.tgz`,
        };
      } catch (err) {
        app.log.error({ err }, 'Failed to generate signed URL');
        return reply.status(500).send({
          error: `產生下載連結失敗：${(err as Error).message}`,
        });
      }
    }
  );

  app.log.info('[versioning] 6 versioning routes registered successfully');
}
