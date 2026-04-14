// GitHub Webhook handler — auto-deploy on push
// Versioning Phase 3: receive GitHub push events and trigger deploy pipeline

import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '../db/index';
import { gcpFetch } from '../services/gcp-auth';
import {
  getProject,
  transitionProject,
  createScanReport,
  updateProjectConfig,
} from '../services/orchestrator';
import { runPipeline } from '../services/pipeline-worker';

const execFileAsync = promisify(execFile);

const GCP_PROJECT = process.env.GCP_PROJECT || 'wave-deploy-agent';
const GCS_BUCKET = `${GCP_PROJECT}_cloudbuild`;

/** Parse owner/repo from a GitHub URL (https or git@) */
function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  // https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // git@github.com:owner/repo.git
  const sshMatch = repoUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

export async function webhookRoutes(app: FastifyInstance) {
  // We need raw body for HMAC verification, so add a content type parser
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.post('/api/webhooks/github', async (request, reply) => {
    const rawBody = request.body as Buffer;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const event = request.headers['x-github-event'] as string | undefined;

    if (!signature || !event) {
      return reply.status(400).send({ error: 'Missing required GitHub webhook headers' });
    }

    // Parse the payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON payload' });
    }

    // Determine the repo URL from the payload
    const repository = payload.repository as { html_url?: string; clone_url?: string } | undefined;
    if (!repository?.html_url) {
      return reply.status(400).send({ error: 'No repository info in payload' });
    }
    const repoUrl = repository.html_url as string;

    // Find the project(s) matching this repo URL
    const projectRows = await query(
      `SELECT * FROM projects WHERE github_repo_url = $1 AND auto_deploy = true`,
      [repoUrl]
    );

    if (projectRows.rows.length === 0) {
      // Also try with .git suffix or without
      const altUrl = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : `${repoUrl}.git`;
      const altRows = await query(
        `SELECT * FROM projects WHERE github_repo_url = $1 AND auto_deploy = true`,
        [altUrl]
      );
      if (altRows.rows.length === 0) {
        return reply.status(200).send({ skipped: true, reason: 'No matching project with auto_deploy enabled' });
      }
      projectRows.rows.push(...altRows.rows);
    }

    // Verify signature against each matching project's webhook secret
    // (multiple projects can share the same repo, e.g. monorepo services)
    const verifiedProjects: Array<{ id: string; branch: string; secret: string }> = [];
    for (const row of projectRows.rows) {
      const secret = row.github_webhook_secret as string | null;
      if (!secret) continue;

      const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      try {
        if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
          verifiedProjects.push({
            id: row.id as string,
            branch: (row.github_branch as string) || 'main',
            secret,
          });
        }
      } catch {
        // Length mismatch — signature doesn't match
      }
    }

    if (verifiedProjects.length === 0) {
      return reply.status(401).send({ error: 'Webhook signature verification failed' });
    }

    // Handle different event types
    if (event === 'push') {
      const ref = payload.ref as string | undefined; // e.g. "refs/heads/main"
      if (!ref) {
        return reply.status(200).send({ skipped: true, reason: 'No ref in push event' });
      }

      // Extract branch name
      const branch = ref.replace('refs/heads/', '');
      const parsed = parseGitHubRepo(repoUrl);
      if (!parsed) {
        return reply.status(400).send({ error: 'Cannot parse GitHub repo URL' });
      }

      // Filter to projects that match this branch
      const matchingProjects = verifiedProjects.filter(p => p.branch === branch);
      if (matchingProjects.length === 0) {
        return reply.status(200).send({ skipped: true, reason: `Push to ${branch}, no projects configured for this branch` });
      }

      // Return 200 immediately, process async
      reply.status(200).send({
        accepted: true,
        event: 'push',
        branch,
        projectCount: matchingProjects.length,
        message: `Processing auto-deploy for ${matchingProjects.length} project(s)`,
      });

      // Process each matching project in background
      for (const mp of matchingProjects) {
        processGitHubPush(mp.id, parsed.owner, parsed.repo, branch).catch(err => {
          console.error(`[Webhook] Auto-deploy failed for project ${mp.id}:`, (err as Error).message);
        });
      }
      return reply;
    }

    if (event === 'ping') {
      return reply.status(200).send({ pong: true, message: 'Webhook configured successfully' });
    }

    if (event === 'delete') {
      // Branch deleted — for now, just log it
      // TODO: Clean up branch deploys when branch deploy feature is added
      const refType = payload.ref_type as string | undefined;
      const ref = payload.ref as string | undefined;
      console.log(`[Webhook] delete event: ${refType} "${ref}" deleted from ${repoUrl}`);
      return reply.status(200).send({ skipped: true, reason: 'Branch delete handling not yet implemented' });
    }

    // Unhandled event type
    return reply.status(200).send({ skipped: true, reason: `Unhandled event type: ${event}` });
  });
}

/**
 * Download source tarball from GitHub, upload to GCS, and trigger deploy pipeline.
 * Only supports public repos for now.
 * TODO: Support private repos with GitHub token (stored per-project or org-level)
 */
async function processGitHubPush(
  projectId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  const project = await getProject(projectId);
  if (!project) {
    console.error(`[Webhook] Project not found: ${projectId}`);
    return;
  }

  // Only trigger if project is in a deployable state
  if (project.status !== 'live' && project.status !== 'failed' && project.status !== 'stopped') {
    console.log(`[Webhook] Skipping auto-deploy for ${project.slug}: status=${project.status} (not in deployable state)`);
    return;
  }

  console.log(`[Webhook] Starting auto-deploy for ${project.slug} from ${owner}/${repo}@${branch}`);

  try {
    // Step 1: Download tarball from GitHub (public repos only)
    const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`;
    const response = await fetch(tarballUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'wave-deploy-agent',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`GitHub tarball download failed: ${response.status} ${response.statusText}. Is the repo public?`);
    }

    const tarballBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`[Webhook]   Downloaded tarball: ${(tarballBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Step 2: Upload to GCS
    const objectName = `sources/${project.slug}-webhook-${Date.now()}.tgz`;
    const gcsUri = `gs://${GCS_BUCKET}/${objectName}`;

    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const uploadRes = await gcpFetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: tarballBuffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`GCS upload failed: ${uploadRes.status} ${errText}`);
    }
    console.log(`[Webhook]   Uploaded to GCS: ${gcsUri}`);

    // Step 3: Extract to /tmp for pipeline processing
    const uploadDir = join(tmpdir(), `deploy-agent-webhook/${project.slug}-${Date.now()}`);
    await mkdir(uploadDir, { recursive: true });
    const tarballPath = join(uploadDir, 'source.tgz');
    await writeFile(tarballPath, tarballBuffer);

    const sourceDir = join(uploadDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await execFileAsync('tar', ['xzf', tarballPath, '-C', sourceDir]);

    // Find actual project root (GitHub tarballs wrap in owner-repo-sha/ dir)
    const { readdirSync, existsSync } = await import('node:fs');
    let projectDir = sourceDir;
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    if (dirs.length === 1 && !existsSync(join(sourceDir, 'Dockerfile')) && !existsSync(join(sourceDir, 'package.json'))) {
      projectDir = join(sourceDir, dirs[0].name);
    }

    // For monorepo services, narrow down to service subdirectory
    if (project.config?.serviceDirName) {
      const svcDir = join(projectDir, project.config.serviceDirName as string);
      if (existsSync(svcDir)) {
        projectDir = svcDir;
      }
    }

    // Step 4: Update project config with new GCS URI
    const updatedConfig = {
      ...(project.config ?? {}),
      gcsSourceUri: gcsUri,
      lastWebhookTrigger: new Date().toISOString(),
      lastWebhookBranch: branch,
    };
    await updateProjectConfig(project.id, updatedConfig as Record<string, unknown>);

    // Step 5: Transition and trigger pipeline (same flow as new-version)
    await transitionProject(project.id, 'submitted', 'github-webhook', {
      action: 'auto-deploy',
      branch,
      repo: `${owner}/${repo}`,
    });
    await transitionProject(project.id, 'scanning', 'system', { trigger: 'github-webhook' });

    await createScanReport(project.id);

    // Trigger pipeline in background
    runPipeline(project.id, projectDir).catch(err => {
      console.error(`[Webhook] Pipeline failed for ${project.slug}:`, (err as Error).message);
    });

    console.log(`[Webhook]   Auto-deploy pipeline started for ${project.slug}`);
  } catch (err) {
    console.error(`[Webhook] Auto-deploy error for ${project.slug}:`, (err as Error).message);
    // Don't throw — this runs async, errors are just logged
  }
}
