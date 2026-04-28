import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gcpFetch } from '../services/gcp-auth';
import { query } from '../db/index';
import {
  createProject,
  listProjects,
  getProject,
  transitionProject,
  createScanReport,
  getLatestScanReport,
  updateScanReport,
  createReview,
  getDeploymentsByProject,
  deleteProjectFromDb,
  updateProjectConfig,
  updateDeployment,
} from '../services/orchestrator';
import { runPipeline } from '../services/pipeline-worker';
import { deleteService, deleteDomainMapping, deleteContainerImage, updateServiceEnvVars, getServiceEnvVars, listCloudRunRevisions } from '../services/deploy-engine';
import { deleteCname, setupCustomDomainWithDns, type DnsConfig } from '../services/dns-manager';
import { stopProjectService, startProjectService } from '../services/service-lifecycle';
import { analyzeUploadFailure } from '../services/upload-diagnostic';
import { planEnvVarsUpdate, interpretEnvVarsUpdateResult } from '../services/env-vars-update';
import {
  buildTeardownVerdict,
  outcomeToLogEntry,
  type TeardownStepOutcome,
} from '../services/teardown-verdict';
import { uploadAndPersistSourceWithVerdict } from '../services/source-upload-verdict';
import {
  buildDbDumpUploadVerdict,
  logDbDumpUploadVerdict,
  uploadAndPersistDbDumpWithVerdict,
} from '../services/db-dump-upload-verdict';
import { releaseProjectRedis } from '../services/redis-provisioner';
import { requireOwnerOrAdmin } from '../services/owner-check';
import { scopeForRequest } from '../services/projects-query';
import type { UploadErrorEnvelope, UploadFailureCode, UploadStage } from '@deploy-agent/shared';

const execFileAsync = promisify(execFile);

/**
 * 統一格式：所有上傳相關的錯誤都用這個 envelope。
 * Client 端的 mapEnvelope() 會 normalize 成 UploadFailure 並渲染。
 *
 * 同時保留舊的 `error: 'xxx'` 欄位來維持向後相容。
 */
function uploadError(
  stage: UploadStage,
  code: UploadFailureCode,
  message: string,
  opts: { detail?: Record<string, unknown>; retryable?: boolean; requestId?: string; legacyError?: string } = {},
): UploadErrorEnvelope & { error: string } {
  return {
    ok: false,
    stage,
    code,
    message,
    detail: opts.detail,
    retryable: opts.retryable ?? true,
    requestId: opts.requestId,
    error: opts.legacyError ?? code, // 向後相容
  };
}

const GCP_PROJECT = process.env.GCP_PROJECT || 'wave-deploy-agent';
const GCP_REGION = process.env.GCP_REGION || 'asia-east1';
const CF_ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || 'punwave.com';
const GCS_BUCKET = `${GCP_PROJECT}_cloudbuild`;

// Check if a domain is already mapped to a Cloud Run service.
// Returns null if available, or { fqdn, existingRoute } if conflict found.
export async function checkDomainConflict(
  subdomain: string,
  zone: string = CF_ZONE_NAME,
): Promise<{ fqdn: string; existingRoute: string } | null> {
  const fqdn = `${subdomain}.${zone}`;
  try {
    const url = `https://${GCP_REGION}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${GCP_PROJECT}/domainmappings/${fqdn}`;
    const res = await gcpFetch(url);
    if (res.status === 404) return null; // available
    if (!res.ok) return null; // can't determine, don't block
    const body = await res.json() as { spec?: { routeName?: string } };
    const existingRoute = body.spec?.routeName ?? 'unknown';
    return { fqdn, existingRoute };
  } catch {
    return null; // network error — don't block submission
  }
}

// Check domain conflicts for one or more subdomains. Returns first conflict found.
// For monorepos, checks both the main domain and api.* variant.
async function checkDomainConflicts(
  customDomain: string | undefined,
  forceDomain: boolean,
  monorepoRoles?: Array<{ role: string; subdomain: string }>,
): Promise<{ fqdn: string; existingRoute: string } | null> {
  if (!customDomain || forceDomain) return null;

  const subdomains = monorepoRoles
    ? monorepoRoles.map(r => r.subdomain)
    : [customDomain.replace(`.${CF_ZONE_NAME}`, '')];

  for (const sub of subdomains) {
    const conflict = await checkDomainConflict(sub);
    if (conflict) return conflict;
  }
  return null;
}

// Parse "KEY=VALUE\nKEY2=VALUE2" format into a Record
function parseEnvVarsText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!text.trim()) return result;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

// Round 44b (2026-04-28): bump archive timeouts from 60s → 600s.
// legal-flow (426 MB zip → ~600 MB extracted) failed at exactly 60.3s on the
// background `tar -czf` re-upload step. Single-threaded gzip + Cloud Run tmpfs
// I/O can need several minutes for hundreds of MB. 10 min covers any
// reasonable user submission while still bounding runaway processes.
const ARCHIVE_TIMEOUT_MS = 600_000;
const ARCHIVE_MAX_BUFFER = 100 * 1024 * 1024;

// Upload source tarball to GCS for durable storage (Cloud Run /tmp is ephemeral)
async function uploadSourceToGcs(
  projectSlug: string,
  projectDir: string,
): Promise<string> {
  const gcpProject = process.env.GCP_PROJECT || 'wave-deploy-agent';
  const bucket = `${gcpProject}_cloudbuild`;
  const objectName = `sources/${projectSlug}-${Date.now()}.tgz`;
  const tarballPath = join(tmpdir(), `${projectSlug}-source-${Date.now()}.tgz`);

  // Create tarball from project directory
  await execFileAsync('tar', ['-czf', tarballPath, '-C', projectDir, '.'], { timeout: ARCHIVE_TIMEOUT_MS });

  // Upload to GCS
  const { readFileSync, unlinkSync } = await import('node:fs');
  const tarball = readFileSync(tarballPath);
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const res = await gcpFetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: tarball,
  });

  try { unlinkSync(tarballPath); } catch { /* ignore */ }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GCS upload failed (${res.status}): ${err}`);
  }

  const gcsUri = `gs://${bucket}/${objectName}`;
  console.log(`[Upload] Source uploaded to ${gcsUri}`);
  return gcsUri;
}

// Upload a DB dump file to GCS for later restore during deploy
async function uploadDbDumpToGcs(
  projectSlug: string,
  dumpBuffer: Buffer,
  dumpFileName: string,
): Promise<string> {
  const gcpProject = process.env.GCP_PROJECT || 'wave-deploy-agent';
  const bucket = `${gcpProject}_cloudbuild`;
  const objectName = `db-dumps/${projectSlug}-${Date.now()}-${dumpFileName}`;

  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const res = await gcpFetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: dumpBuffer,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GCS upload failed (${res.status}): ${err}`);
  }

  const gcsUri = `gs://${bucket}/${objectName}`;
  console.log(`[Upload] DB dump uploaded to ${gcsUri} (${(dumpBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
  return gcsUri;
}

const submitSchema = z.object({
  name: z.string().min(1).max(255),
  sourceType: z.enum(['upload', 'git', 'openclaw']),
  sourceUrl: z.string().optional(),
  config: z.object({
    deployTarget: z.enum(['cloud_run']).default('cloud_run'),
    customDomain: z.string().min(1, 'Custom domain is required'),
    forceDomain: z.boolean().default(false),  // Override existing mapping if conflict detected
    allowUnauthenticated: z.boolean().default(true),  // Public by default
    gcpProject: z.string().optional(),
    gcpRegion: z.string().optional(),
  }).optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  // List projects — RBAC scope-filtered (Round 31, OWASP A01:2021 IDOR fix).
  //
  // Before round 31 this returned ALL projects to ANY caller — a viewer could
  // see every other user's slug, owner, status, and config. Round 25 RBAC
  // gated mutating routes but missed this LIST endpoint.
  //
  // Now: admin → all rows; non-admin user → only rows where owner_id matches
  // their user id; anonymous in permissive → all (legacy bot/dashboard compat
  // during the round-25 transition window); anonymous in enforced → zero rows
  // (defensive — auth hook should have already rejected before reaching here).
  //
  // The scope decision happens in scopeForRequest() (pure helper) and the SQL
  // composition in buildListProjectsSql() inside listProjects(). Both are
  // unit-tested in test-projects-query.ts (25 PASS).
  app.get('/api/projects', async (request) => {
    const mode = (process.env.AUTH_MODE ?? 'permissive') as 'permissive' | 'enforced';
    const scope = scopeForRequest(request.auth, mode);
    const projects = await listProjects(scope);
    return { projects };
  });

  // Get single project
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // R35 — Pattern B owner check (closes IDOR on GET /api/projects/:id).
    // The single-project endpoint leaks the same metadata as the LIST
    // endpoint that R31 already scope-filtered (slug, owner, config). Per
    // the round-31 audit findings, this is the matching read-side P1.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'project_read');
    if (!owner.ok) return;
    return { project };
  });

  // Submit new project
  app.post('/api/projects', async (request, reply) => {
    const body = submitSchema.parse(request.body);

    // Domain conflict check (unless forceDomain is set)
    const customDomain = body.config?.customDomain;
    if (customDomain && !body.config?.forceDomain) {
      const sub = customDomain.replace(`.${CF_ZONE_NAME}`, '');
      const conflict = await checkDomainConflict(sub);
      if (conflict) {
        return reply.status(409).send({
          ...uploadError('submit', 'domain_conflict', `Domain "${conflict.fqdn}" is already mapped to service "${conflict.existingRoute}". Set forceDomain=true to override.`, {
            detail: { domain: conflict.fqdn, existingRoute: conflict.existingRoute },
            retryable: false,
            legacyError: 'domain_conflict',
          }),
          conflict,
        });
      }
    }

    const project = await createProject({
      name: body.name,
      sourceType: body.sourceType,
      sourceUrl: body.sourceUrl,
      config: body.config,
      // RBAC Phase 1: stamp the creating actor as owner. Anonymous (permissive
      // mode) → null, which leaves the row "unowned" and only admins can act
      // on it later (granted-legacy-unowned guard in access-denied-verdict).
      ownerId: request.auth.user?.id ?? null,
    });

    // Transition to scanning and create scan report
    await transitionProject(project.id, 'scanning', 'system', { trigger: 'auto' });
    const scanReport = await createScanReport(project.id);

    // Dispatch pipeline worker asynchronously (non-blocking)
    // sourceUrl is the local path or git URL to scan
    const projectDir = body.sourceUrl ?? '';
    if (projectDir) {
      runPipeline(project.id, projectDir).catch((err) => {
        console.error(`[Pipeline] Async dispatch failed for ${project.id}:`, (err as Error).message);
      });
    }

    return reply.status(201).send({ project: { ...project, status: 'scanning' }, scanReport });
  });

  // ── Initiate a GCS resumable upload session (for files that exceed Cloud Run's 32MB limit) ──
  // Server-side initiates the session via GCS JSON API, returns the signed session URI.
  // Browser PUTs the file body directly to the session URI — no Authorization header
  // needed (auth is embedded in URI), so no CORS preflight, no token expiry mid-upload.
  // Resumable sessions are valid for ~7 days and support chunked PUT with Content-Range.
  app.post('/api/upload/init', async (request, reply) => {
    const { fileName, contentType, fileSize } = request.body as {
      fileName: string;
      contentType?: string;
      fileSize?: number;
    };
    if (!fileName) {
      return reply.status(400).send(
        uploadError('init', 'init_session_failed', 'fileName is required', {
          retryable: false,
          legacyError: 'fileName is required',
        }),
      );
    }

    const objectName = `uploads/${Date.now()}-${fileName}`;
    const mimeType = contentType || 'application/octet-stream';

    // Initiate resumable upload session
    const { getAccessToken } = await import('../services/gcp-auth');
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send(
        uploadError('init', 'gcs_auth_failed', `Failed to obtain GCS access token: ${msg}`, {
          detail: { stage: 'access_token' },
          legacyError: 'Failed to initiate resumable session',
        }),
      );
    }
    const initUrl = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=resumable&name=${encodeURIComponent(objectName)}`;

    const initHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
    };
    if (fileSize && fileSize > 0) {
      initHeaders['X-Upload-Content-Length'] = String(fileSize);
    }

    const initRes = await fetch(initUrl, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify({ name: objectName, contentType: mimeType }),
    });

    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      const code: UploadFailureCode = initRes.status === 401 || initRes.status === 403
        ? 'gcs_auth_failed'
        : 'init_session_failed';
      return reply.status(500).send(
        uploadError('init', code, `Failed to initiate resumable session: HTTP ${initRes.status}`, {
          detail: { gcsStatus: initRes.status, gcsBody: errText.slice(0, 300) },
          legacyError: `Failed to initiate resumable session: HTTP ${initRes.status} ${errText.slice(0, 300)}`,
        }),
      );
    }

    const sessionUri = initRes.headers.get('location');
    if (!sessionUri) {
      return reply.status(500).send(
        uploadError('init', 'init_session_failed', 'GCS did not return a session Location header', {
          legacyError: 'GCS did not return a session Location header',
        }),
      );
    }

    return {
      uploadUrl: sessionUri,             // browser PUTs file body here, no auth header needed
      gcsUri: `gs://${GCS_BUCKET}/${objectName}`,
      objectName,
      contentType: mimeType,
      // accessToken intentionally omitted — session URI embeds auth
    };
  });

  // ── Verify a GCS upload completed (round 44 trans-Pacific rescue) ──
  // The 426 MB legal_flow_build.zip case: bytes reach GCS, GCS finalizes the
  // object, but the 200/201 response is lost to a trans-Pacific TCP middlebox
  // cut between GCS US multi-region and the user's Taiwan ISP. Browser fires
  // `xhr.onerror`, retry loop bails after 16 attempts, file is "lost" from the
  // user's perspective — even though `gsutil stat` confirms it's committed
  // and md5-matched.
  //
  // Client wires this as the `verifyComplete` callback in resumable-upload.ts:
  // before bailing out with network_error, ask GCS directly. If the object
  // exists at the expected size (and optionally matching md5), treat the
  // upload as successful regardless of what the chunk PUT response said.
  //
  // Auth: same as /api/upload/init — caller must be authenticated. Read-only
  // GCS metadata query, no mutation.
  app.post('/api/upload/verify', async (request, reply) => {
    const body = request.body as {
      gcsUri: string;
      expectedSize?: number;
      expectedMd5?: string; // optional base64-encoded GCS md5Hash
    } | undefined;

    if (!body?.gcsUri) {
      return reply.status(400).send({ error: 'gcsUri is required' });
    }
    const prefix = `gs://${GCS_BUCKET}/`;
    if (!body.gcsUri.startsWith(prefix)) {
      return reply.status(400).send({
        error: 'gcsUri must reference the agent bucket',
        expectedPrefix: prefix,
      });
    }
    const objectName = body.gcsUri.slice(prefix.length);
    if (!objectName) {
      return reply.status(400).send({ error: 'gcsUri must include an object name' });
    }

    const { getAccessToken } = await import('../services/gcp-auth');
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'gcs_auth_failed', message: msg });
    }

    const metaUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(objectName)}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (metaRes.status === 404) {
      return { exists: false, complete: false };
    }
    if (!metaRes.ok) {
      const errText = await metaRes.text().catch(() => '');
      return reply.status(metaRes.status === 401 || metaRes.status === 403 ? metaRes.status : 502).send({
        error: 'gcs_metadata_failed',
        gcsStatus: metaRes.status,
        gcsBody: errText.slice(0, 300),
      });
    }

    const meta = (await metaRes.json()) as {
      size?: string;
      md5Hash?: string;
      contentType?: string;
      timeCreated?: string;
      generation?: string;
    };
    const sizeBytes = meta.size ? Number.parseInt(meta.size, 10) : Number.NaN;
    const sizeMatch = body.expectedSize == null || sizeBytes === body.expectedSize;
    const md5Match = body.expectedMd5 == null || meta.md5Hash === body.expectedMd5;

    return {
      exists: true,
      complete: sizeMatch && md5Match,
      size: sizeBytes,
      md5: meta.md5Hash,
      contentType: meta.contentType,
      timeCreated: meta.timeCreated,
      generation: meta.generation,
      sizeMatch,
      md5Match,
    };
  });

  // ── Diagnose an upload failure with LLM fallback ──
  // Client calls this when it receives an envelope with code === 'unknown'.
  // Returns a UploadLLMDiagnostic that the UI can render directly.
  app.post('/api/upload/diagnose', async (request, reply) => {
    const body = request.body as { envelope?: UploadErrorEnvelope } | undefined;
    const envelope = body?.envelope;
    if (!envelope || typeof envelope !== 'object' || !envelope.stage || !envelope.code) {
      return reply.status(400).send({
        error: 'envelope is required',
        message: 'Body must include { envelope: UploadErrorEnvelope }',
      });
    }
    try {
      const llmDiagnostic = await analyzeUploadFailure(envelope);
      return { llmDiagnostic };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[upload/diagnose] LLM 分析最終失敗：', msg);
      return reply.status(500).send({
        error: 'diagnose_failed',
        message: msg,
        llmDiagnostic: {
          category: 'unknown',
          userFacingMessage: '無法分析錯誤原因',
          suggestedFix: '請複製錯誤報告聯絡管理員',
          provider: 'rule_based',
        },
      });
    }
  });

  // ── Submit project from a GCS-uploaded file (no multipart, JSON body only) ──
  app.post('/api/projects/submit-gcs', async (request, reply) => {
    const body = request.body as {
      name: string;
      gcsUri: string;       // gs://bucket/uploads/...
      fileName: string;
      customDomain?: string;
      forceDomain?: boolean;
      allowUnauthenticated?: boolean;
      envVars?: string;
      dbDumpGcsUri?: string;
      dbDumpFileName?: string;
    };

    if (!body.name?.trim()) {
      return reply.status(400).send(
        uploadError('submit', 'submit_failed', 'name is required', {
          retryable: false,
          legacyError: 'name is required',
        }),
      );
    }
    if (!body.gcsUri?.trim()) {
      return reply.status(400).send(
        uploadError('submit', 'submit_failed', 'gcsUri is required', {
          retryable: false,
          legacyError: 'gcsUri is required',
        }),
      );
    }
    if (!body.customDomain?.trim()) {
      return reply.status(400).send(
        uploadError('submit', 'submit_failed', 'customDomain is required', {
          retryable: false,
          legacyError: 'customDomain is required',
        }),
      );
    }

    // Domain conflict check
    if (body.customDomain && !body.forceDomain) {
      const sub = body.customDomain.replace(`.${CF_ZONE_NAME}`, '');
      const subsToCheck = [sub, `api.${sub}`];
      for (const s of subsToCheck) {
        const conflict = await checkDomainConflict(s);
        if (conflict) {
          return reply.status(409).send({
            ...uploadError('submit', 'domain_conflict', `Domain "${conflict.fqdn}" already mapped to "${conflict.existingRoute}".`, {
              detail: { domain: conflict.fqdn, existingRoute: conflict.existingRoute },
              retryable: false,
              legacyError: 'domain_conflict',
            }),
            conflict,
          });
        }
      }
    }

    // Download from GCS, extract, detect, then proceed same as upload flow
    const projectSlug = body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const uploadDir = join(tmpdir(), 'deploy-agent-uploads', `${projectSlug}-${Date.now()}`);
    const extractDir = join(uploadDir, 'source');
    await mkdir(extractDir, { recursive: true });

    // Download from GCS
    const objectName = body.gcsUri.replace(`gs://${GCS_BUCKET}/`, '');
    const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media`;
    const dlRes = await gcpFetch(downloadUrl);
    if (!dlRes.ok) {
      const code: UploadFailureCode = dlRes.status === 401 || dlRes.status === 403
        ? 'gcs_auth_failed'
        : 'submit_failed';
      return reply.status(500).send(
        uploadError('submit', code, `Failed to download from GCS: HTTP ${dlRes.status}`, {
          detail: { gcsStatus: dlRes.status, objectName },
          legacyError: `Failed to download from GCS: HTTP ${dlRes.status}`,
        }),
      );
    }
    const fileBuffer = Buffer.from(await dlRes.arrayBuffer());
    const archivePath = join(uploadDir, body.fileName);
    await writeFile(archivePath, fileBuffer);

    // Extract
    const lowerName = body.fileName.toLowerCase();
    try {
      if (lowerName.endsWith('.zip')) {
        await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', extractDir], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER });
      } else if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) {
        await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER });
      } else if (lowerName.endsWith('.tar')) {
        await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER });
      } else {
        const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : 'unknown';
        return reply.status(400).send(
          uploadError('extract', 'file_extension_invalid', 'Unsupported file type', {
            detail: { ext, fileName: body.fileName },
            retryable: false,
            legacyError: 'Unsupported file type',
          }),
        );
      }
    } catch (err) {
      const msg = (err as Error).message;
      const isBufferOverflow = msg.toLowerCase().includes('maxbuffer');
      return reply.status(400).send(
        uploadError(
          'extract',
          isBufferOverflow ? 'extract_buffer_overflow' : 'extract_failed',
          `Extract failed: ${msg}`,
          {
            detail: { fileName: body.fileName, errorSnippet: msg.slice(0, 300) },
            retryable: false,
            legacyError: `Extract failed: ${msg}`,
          },
        ),
      );
    }

    // Cleanup junk
    const { rmSync, existsSync, statSync, readdirSync } = await import('node:fs');
    const junkDirs = ['__MACOSX', '.DS_Store', '__pycache__'];
    for (const junk of junkDirs) {
      try { rmSync(join(extractDir, junk), { recursive: true, force: true }); } catch {}
    }

    // Determine projectDir
    const entries = readdirSync(extractDir).filter(e => e && !junkDirs.includes(e));
    let projectDir: string;
    if (entries.length === 1 && existsSync(join(extractDir, entries[0])) &&
        statSync(join(extractDir, entries[0])).isDirectory()) {
      projectDir = join(extractDir, entries[0]);
    } else {
      projectDir = extractDir;
    }

    const userEnvVars = parseEnvVarsText(body.envVars || '');

    // ── Monorepo detection (same logic as upload route) ──
    const { readFileSync: rfs } = await import('node:fs');
    const monorepoSubdirs = readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name);
    const servicesWithDockerfile = monorepoSubdirs.filter(d => existsSync(join(projectDir, d, 'Dockerfile')));
    const rootHasDockerfile = existsSync(join(projectDir, 'Dockerfile'));
    const isMonorepo = servicesWithDockerfile.length >= 2 && !rootHasDockerfile;

    console.log(`[GCS Submit] projectDir: ${projectDir}, isMonorepo: ${isMonorepo}, services: [${servicesWithDockerfile.join(', ')}]`);

    if (isMonorepo) {
      // ── Monorepo: create one project per service ──
      const groupId = `group-${Date.now()}`;
      const classifyService = (dirName: string, serviceDir: string): 'backend' | 'frontend' => {
        const lower = dirName.toLowerCase();
        if (lower.includes('backend') || lower.includes('api') || lower.includes('server')) return 'backend';
        if (lower.includes('frontend') || lower.includes('web') || lower.includes('client') || lower.includes('app')) return 'frontend';
        if (existsSync(join(serviceDir, 'requirements.txt')) || existsSync(join(serviceDir, 'go.mod'))) return 'backend';
        if (existsSync(join(serviceDir, 'vite.config.ts')) || existsSync(join(serviceDir, 'next.config.js')) ||
            existsSync(join(serviceDir, 'next.config.ts')) || existsSync(join(serviceDir, 'next.config.mjs'))) return 'frontend';
        try {
          const pkg = JSON.parse(rfs(join(serviceDir, 'package.json'), 'utf8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.next || deps.nuxt || deps.vite || deps['@sveltejs/kit'] || deps.react) return 'frontend';
          if (deps.express || deps.fastify || deps.hono || deps.koa) return 'backend';
        } catch { /* ignore */ }
        return 'backend';
      };

      const siblings = servicesWithDockerfile.map(d => ({
        dirName: d,
        role: classifyService(d, join(projectDir, d)),
        projectName: `${body.name.trim()}-${d}`,
      }));
      siblings.sort((a, b) => (a.role === 'backend' ? -1 : 1) - (b.role === 'backend' ? -1 : 1));

      const createdProjects: Array<{ project: unknown; scanReport: unknown }> = [];
      const failedServices: Array<{ name: string; error: string }> = [];

      for (const svc of siblings) {
        try {
          const serviceDir = join(projectDir, svc.dirName);
          const project = await createProject({
            name: svc.projectName,
            sourceType: 'upload',
            sourceUrl: serviceDir,
            config: {
              deployTarget: 'cloud_run',
              customDomain: body.customDomain?.trim()
                ? (svc.role === 'frontend' ? body.customDomain.trim() : `api.${body.customDomain.trim()}`)
                : undefined,
              forceDomain: body.forceDomain ?? false,
              allowUnauthenticated: body.allowUnauthenticated ?? true,
              envVars: Object.keys(userEnvVars).length > 0 ? userEnvVars : undefined,
              gcsDbDumpUri: svc.role === 'backend' ? body.dbDumpGcsUri : undefined,
              dbDumpFileName: svc.role === 'backend' ? body.dbDumpFileName : undefined,
              projectGroup: groupId,
              groupName: body.name.trim(),
              serviceRole: svc.role,
              serviceDirName: svc.dirName,
              siblings: siblings.map(s => ({ name: s.projectName, role: s.role, dirName: s.dirName })),
            },
            // RBAC Phase 1: every sibling in the monorepo group inherits the
            // submitter as owner so each service can be acted on individually.
            ownerId: request.auth.user?.id ?? null,
          });
          await transitionProject(project.id, 'scanning', 'system', { trigger: 'auto' });
          const scanReport = await createScanReport(project.id);
          createdProjects.push({ project: { ...project, status: 'scanning' }, scanReport });
        } catch (err) {
          const msg = (err as Error).message;
          console.error(`[GCS Submit] Failed to create monorepo service "${svc.projectName}": ${msg}`);
          failedServices.push({ name: svc.projectName, error: msg });
        }
      }

      reply.status(201).send({
        monorepo: true,
        groupId,
        services: createdProjects,
        failedServices: failedServices.length > 0 ? failedServices : undefined,
        uploadedFile: body.fileName,
      });

      // Background: upload source + pipeline for each service
      for (const svc of siblings) {
        const serviceDir = join(projectDir, svc.dirName);
        const svcSlug = svc.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        const created = createdProjects.find(
          (c) => (c.project as { name: string }).name === svc.projectName,
        );
        if (!created) continue;
        const projectId = (created.project as { id: string }).id;

        // Round 22: route through uploadAndPersistSourceWithVerdict so upload
        // failures don't silently kick the pipeline (which then runs a misleading
        // green scan and surfaces 30+ minutes later as a cryptic deploy failure).
        (async () => {
          const verdict = await uploadAndPersistSourceWithVerdict({
            projectLabel: `${body.name}/${svc.projectName}`,
            runUpload: () => uploadSourceToGcs(svcSlug, serviceDir),
            runPersist: async (gcsSourceUri) => {
              const current = await getProject(projectId);
              await updateProjectConfig(projectId, { ...(current?.config ?? {}), gcsSourceUri });
            },
          });
          if (verdict.kind === 'upload-failed') {
            try {
              await transitionProject(projectId, 'failed', 'system', {
                error: verdict.uploadError,
                errorCode: verdict.errorCode,
                failedStep: 'background source upload (monorepo sibling)',
              });
            } catch (txErr) {
              console.error(`[GCS Submit] transition to failed also threw: ${(txErr as Error).message}`);
            }
            return; // do NOT runPipeline — no GCS source means deploy will fail cryptically
          }
          runPipeline(projectId, serviceDir).catch((err) => {
            console.error(`[Pipeline] Async dispatch failed for ${svc.projectName}:`, (err as Error).message);
          });
        })();
      }
    } else {
      // ── Single service ──
      // If root has no Dockerfile/package.json, check subdirectories
      if (!rootHasDockerfile && !existsSync(join(projectDir, 'package.json'))) {
        const subWithDockerfile = monorepoSubdirs.find(d => existsSync(join(projectDir, d, 'Dockerfile')));
        if (subWithDockerfile) {
          console.log(`[GCS Submit] Dockerfile found in subdirectory: ${subWithDockerfile}, adjusting projectDir`);
          projectDir = join(projectDir, subWithDockerfile);
        }
      }

      const project = await createProject({
        name: body.name.trim(),
        sourceType: 'upload',
        sourceUrl: projectDir,
        config: {
          deployTarget: 'cloud_run' as const,
          customDomain: body.customDomain?.trim(),
          forceDomain: body.forceDomain ?? false,
          allowUnauthenticated: body.allowUnauthenticated ?? true,
          gcsSourceUri: body.gcsUri,
          envVars: Object.keys(userEnvVars).length > 0 ? userEnvVars : undefined,
          gcsDbDumpUri: body.dbDumpGcsUri,
          dbDumpFileName: body.dbDumpFileName,
        },
        // RBAC Phase 1: stamp owner from auth context (single-service path).
        ownerId: request.auth.user?.id ?? null,
      });

      await transitionProject(project.id, 'scanning', 'system', { trigger: 'auto' });
      const scanReport = await createScanReport(project.id);

      reply.status(201).send({
        project: { ...project, status: 'scanning' },
        scanReport,
        uploadedFile: body.fileName,
      });

      // Background: re-upload as proper source tarball + start pipeline.
      // Round 22: verdict-gated so upload failures transition project to
      // 'failed' instead of silently running the pipeline.
      (async () => {
        const verdict = await uploadAndPersistSourceWithVerdict({
          projectLabel: project.name,
          runUpload: () => uploadSourceToGcs(projectSlug, projectDir),
          runPersist: async (gcsSourceUri) => {
            const current = await getProject(project.id);
            if (current) await updateProjectConfig(project.id, { ...current.config, gcsSourceUri });
          },
        });
        if (verdict.kind === 'upload-failed') {
          try {
            await transitionProject(project.id, 'failed', 'system', {
              error: verdict.uploadError,
              errorCode: verdict.errorCode,
              failedStep: 'background source upload (single service)',
            });
          } catch (txErr) {
            console.error(`[GCS Submit] transition to failed also threw: ${(txErr as Error).message}`);
          }
          return;
        }
        runPipeline(project.id, projectDir).catch((err) => {
          console.error(`[Pipeline] Async dispatch failed for ${project.id}:`, (err as Error).message);
        });
      })();
    }
  });

  // Submit new project via file upload (multipart form)
  app.post('/api/projects/upload', async (request, reply) => {
    const parts = request.parts();

    let name = '';
    let customDomain = '';
    let forceDomain = false;
    let allowUnauthenticated = true;
    let sourceType: 'upload' | 'git' = 'upload';
    let gitUrl = '';
    let envVarsRaw = '';
    let fileBuffer: Buffer | null = null;
    let fileName = '';
    let dbDumpBuffer: Buffer | null = null;
    let dbDumpFileName = '';

    for await (const part of parts) {
      if (part.type === 'field') {
        const val = String(part.value);
        if (part.fieldname === 'name') name = val;
        else if (part.fieldname === 'customDomain') customDomain = val;
        else if (part.fieldname === 'forceDomain') forceDomain = val === 'true';
        else if (part.fieldname === 'allowUnauthenticated') allowUnauthenticated = val === 'true';
        else if (part.fieldname === 'sourceType') sourceType = val as 'upload' | 'git';
        else if (part.fieldname === 'gitUrl') gitUrl = val;
        else if (part.fieldname === 'envVars') envVarsRaw = val;
      } else if (part.type === 'file' && part.fieldname === 'file') {
        fileName = part.filename;
        fileBuffer = await part.toBuffer();
      } else if (part.type === 'file' && part.fieldname === 'dbDump') {
        dbDumpFileName = part.filename;
        dbDumpBuffer = await part.toBuffer();
      }
    }

    if (!name.trim()) {
      return reply.status(400).send(
        uploadError('submit', 'submit_failed', 'Project name is required', {
          retryable: false,
          legacyError: 'Project name is required',
        }),
      );
    }

    if (!customDomain.trim()) {
      return reply.status(400).send(
        uploadError('submit', 'submit_failed', 'Custom domain is required', {
          retryable: false,
          legacyError: 'Custom domain is required',
        }),
      );
    }

    // Domain conflict check (unless forceDomain is set)
    if (customDomain.trim() && !forceDomain) {
      const sub = customDomain.trim().replace(`.${CF_ZONE_NAME}`, '');
      // Check both main domain and api.* (monorepo convention)
      const subsToCheck = [sub, `api.${sub}`];
      for (const s of subsToCheck) {
        const conflict = await checkDomainConflict(s);
        if (conflict) {
          return reply.status(409).send({
            ...uploadError('submit', 'domain_conflict', `Domain "${conflict.fqdn}" is already mapped to service "${conflict.existingRoute}". Use forceDomain=true to override, or choose a different domain.`, {
              detail: { domain: conflict.fqdn, existingRoute: conflict.existingRoute },
              retryable: false,
              legacyError: 'domain_conflict',
            }),
            conflict,
          });
        }
      }
    }

    // If git source type, handle like before
    if (sourceType === 'git') {
      if (!gitUrl.trim()) {
        return reply.status(400).send({ error: 'Git URL is required' });
      }
      const userEnvVars = parseEnvVarsText(envVarsRaw);

      // Upload DB dump to GCS if provided.
      // Round 23: route through db-dump-upload-verdict so a failed upload
      // returns 4xx to the caller instead of silently creating a project
      // whose deploy will boot against an empty DB and 500 30+ minutes later.
      // Pre-createProject site: persist=null because gcsDbDumpUri is folded
      // into the createProject({ config }) arg below.
      let gcsDbDumpUri: string | undefined;
      if (dbDumpBuffer && dbDumpFileName) {
        const gitSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        let uploadOk = false;
        let uploadErr: string | null = null;
        try {
          gcsDbDumpUri = await uploadDbDumpToGcs(gitSlug, dbDumpBuffer, dbDumpFileName);
          uploadOk = true;
        } catch (err) {
          uploadErr = (err as Error).message;
        }
        const verdict = buildDbDumpUploadVerdict({
          projectLabel: name.trim(),
          dumpFileName: dbDumpFileName,
          upload: uploadOk
            ? { ok: true, gcsUri: gcsDbDumpUri ?? null, error: null }
            : { ok: false, gcsUri: null, error: uploadErr },
          persist: null, // pre-createProject site: URI folded into createProject below
        });
        logDbDumpUploadVerdict(verdict);
        if (verdict.kind === 'upload-failed') {
          return reply.status(502).send(
            uploadError('db_dump_upload', 'db_dump_upload_failed', verdict.message, {
              detail: { errorCode: verdict.errorCode, dumpFileName: dbDumpFileName },
              retryable: true,
              legacyError: verdict.uploadError,
            }),
          );
        }
      }

      const project = await createProject({
        name: name.trim(),
        sourceType: 'git',
        sourceUrl: gitUrl.trim(),
        config: {
          deployTarget: 'cloud_run',
          customDomain: customDomain.trim() || undefined,
          forceDomain,
          allowUnauthenticated,
          envVars: Object.keys(userEnvVars).length > 0 ? userEnvVars : undefined,
          gcsDbDumpUri,
          dbDumpFileName: dbDumpFileName || undefined,
        },
        // RBAC Phase 1: stamp owner from auth context (multipart git path).
        ownerId: request.auth.user?.id ?? null,
      });
      await transitionProject(project.id, 'scanning', 'system', { trigger: 'auto' });
      const scanReport = await createScanReport(project.id);
      runPipeline(project.id, gitUrl.trim()).catch((err) => {
        console.error(`[Pipeline] Async dispatch failed for ${project.id}:`, (err as Error).message);
      });
      return reply.status(201).send({ project: { ...project, status: 'scanning' }, scanReport });
    }

    // Upload source type — need a file
    if (!fileBuffer || !fileName) {
      return reply.status(400).send(
        uploadError('upload', 'submit_failed', 'File upload is required for upload source type', {
          retryable: false,
          legacyError: 'File upload is required for upload source type',
        }),
      );
    }

    // Save uploaded file to temp dir and extract
    const projectSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const uploadDir = join(tmpdir(), 'deploy-agent-uploads', `${projectSlug}-${Date.now()}`);
    const extractDir = join(uploadDir, 'source');
    await mkdir(extractDir, { recursive: true });

    const archivePath = join(uploadDir, fileName);
    await writeFile(archivePath, fileBuffer);

    // Extract based on file type
    const lowerName = fileName.toLowerCase();
    try {
      if (lowerName.endsWith('.zip')) {
        await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', extractDir], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER });
      } else if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) {
        await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER });
      } else if (lowerName.endsWith('.tar')) {
        await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], { timeout: ARCHIVE_TIMEOUT_MS, maxBuffer: ARCHIVE_MAX_BUFFER });
      } else {
        const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : 'unknown';
        return reply.status(400).send(
          uploadError('extract', 'file_extension_invalid', 'Unsupported file type. Please upload .zip, .tar.gz, or .tar', {
            detail: { ext, fileName },
            retryable: false,
            legacyError: 'Unsupported file type. Please upload .zip, .tar.gz, or .tar',
          }),
        );
      }
    } catch (err) {
      const msg = (err as Error).message;
      const isBufferOverflow = msg.toLowerCase().includes('maxbuffer');
      return reply.status(400).send(
        uploadError(
          'extract',
          isBufferOverflow ? 'extract_buffer_overflow' : 'extract_failed',
          `Failed to extract archive: ${msg}`,
          {
            detail: { fileName, errorSnippet: msg.slice(0, 300) },
            retryable: false,
            legacyError: `Failed to extract archive: ${msg}`,
          },
        ),
      );
    }

    // ── Defensive cleanup: remove macOS/OS junk directories ──
    const { rmSync, existsSync, statSync, readdirSync, readFileSync } = await import('node:fs');
    const junkDirs = ['__MACOSX', '.DS_Store', '__pycache__', '.Spotlight-V100', '.Trashes'];
    for (const junk of junkDirs) {
      const junkPath = join(extractDir, junk);
      try { rmSync(junkPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    // Also recursively remove .DS_Store files inside subdirectories
    const removeDsStore = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.name === '.DS_Store') { try { rmSync(full, { force: true }); } catch {} }
          else if (entry.isDirectory()) removeDsStore(full);
        }
      } catch { /* ignore */ }
    };
    removeDsStore(extractDir);

    // ── Determine projectDir: find the real root with source code ──
    const entries = readdirSync(extractDir).filter(e => e && !junkDirs.includes(e));
    let projectDir: string;

    if (entries.length === 1 && existsSync(join(extractDir, entries[0])) &&
        statSync(join(extractDir, entries[0])).isDirectory()) {
      // Single directory inside archive — use it as root
      projectDir = join(extractDir, entries[0]);
    } else {
      // Files are directly in extractDir
      projectDir = extractDir;
    }

    // ── Monorepo detection: MUST run before single-service fallback ──
    // Check for multiple Dockerfiles in subdirectories while projectDir is still the root
    {
      const monorepoSubdirs = readdirSync(projectDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => d.name);
      const servicesWithDockerfile = monorepoSubdirs.filter(d => existsSync(join(projectDir, d, 'Dockerfile')));
      const rootHasDockerfile = existsSync(join(projectDir, 'Dockerfile'));

      // If 2+ subdirectories have Dockerfiles and root does NOT have one → monorepo
      if (servicesWithDockerfile.length >= 2 && !rootHasDockerfile) {
        // Jump to monorepo handling (defined below)
        var isMonorepo = true;
        var monorepoServicesWithDockerfile = servicesWithDockerfile;
      } else {
        var isMonorepo = false;
        var monorepoServicesWithDockerfile: string[] = [];
      }
    }

    // ── Validate: must have a Dockerfile or package.json (single-service) ──
    if (!isMonorepo) {
      const hasDockerfile = existsSync(join(projectDir, 'Dockerfile'));
      const hasPackageJson = existsSync(join(projectDir, 'package.json'));
      if (!hasDockerfile && !hasPackageJson) {
        // Maybe nested one level deeper? Try to find Dockerfile
        const subdirs = readdirSync(projectDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        const subWithDockerfile = subdirs.find(d => existsSync(join(projectDir, d, 'Dockerfile')));
        if (subWithDockerfile) {
          console.log(`[Upload] Dockerfile found in subdirectory: ${subWithDockerfile}, adjusting projectDir`);
          projectDir = join(projectDir, subWithDockerfile);
        } else {
          console.warn(`[Upload] No Dockerfile or package.json found in extracted archive at: ${projectDir}`);
          console.warn(`[Upload] Directory contents: ${readdirSync(projectDir).join(', ')}`);
          // Don't block — the build step will give a clearer error
        }
      }
    }
    console.log(`[Upload] Final projectDir: ${projectDir}, hasDockerfile: ${existsSync(join(projectDir, 'Dockerfile'))}, entries: [${entries.join(', ')}], isMonorepo: ${isMonorepo}`);

    if (isMonorepo) {
      const servicesWithDockerfile = monorepoServicesWithDockerfile;
      console.log(`[Upload] Monorepo detected! Services: ${servicesWithDockerfile.join(', ')}`);
      const groupId = `group-${Date.now()}`;
      const userEnvVars = parseEnvVarsText(envVarsRaw);
      const createdProjects: Array<{ project: unknown; scanReport: unknown }> = [];

      // Upload DB dump for monorepo (only backend services will restore it).
      // Round 23: route through db-dump-upload-verdict so a failed upload
      // returns 4xx to the caller instead of silently creating N project
      // records (one per service) whose backend deploys will boot against an
      // empty DB and 500 30+ minutes later.
      // Pre-createProject site: persist=null because gcsDbDumpUri is folded
      // into each per-service createProject({ config }) call below.
      let gcsDbDumpUri: string | undefined;
      if (dbDumpBuffer && dbDumpFileName) {
        const groupSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        let uploadOk = false;
        let uploadErr: string | null = null;
        try {
          gcsDbDumpUri = await uploadDbDumpToGcs(groupSlug, dbDumpBuffer, dbDumpFileName);
          uploadOk = true;
        } catch (err) {
          uploadErr = (err as Error).message;
        }
        const verdict = buildDbDumpUploadVerdict({
          projectLabel: `${name.trim()} <monorepo>`,
          dumpFileName: dbDumpFileName,
          upload: uploadOk
            ? { ok: true, gcsUri: gcsDbDumpUri ?? null, error: null }
            : { ok: false, gcsUri: null, error: uploadErr },
          persist: null, // pre-createProject (per-sibling): URI folded into createProject below
        });
        logDbDumpUploadVerdict(verdict);
        if (verdict.kind === 'upload-failed') {
          return reply.status(502).send(
            uploadError('db_dump_upload', 'db_dump_upload_failed', verdict.message, {
              detail: { errorCode: verdict.errorCode, dumpFileName: dbDumpFileName, monorepo: true },
              retryable: true,
              legacyError: verdict.uploadError,
            }),
          );
        }
      }

      // Classify services: 'backend' deploys first, 'frontend' deploys after
      const classifyService = (dirName: string, serviceDir: string): 'backend' | 'frontend' => {
        const lower = dirName.toLowerCase();
        if (lower.includes('backend') || lower.includes('api') || lower.includes('server')) return 'backend';
        if (lower.includes('frontend') || lower.includes('web') || lower.includes('client') || lower.includes('app')) return 'frontend';
        // Heuristic: check for known backend files
        if (existsSync(join(serviceDir, 'requirements.txt')) || existsSync(join(serviceDir, 'go.mod'))) return 'backend';
        // Check for known frontend indicators
        if (existsSync(join(serviceDir, 'vite.config.ts')) || existsSync(join(serviceDir, 'next.config.js')) ||
            existsSync(join(serviceDir, 'next.config.ts')) || existsSync(join(serviceDir, 'next.config.mjs'))) return 'frontend';
        // Check package.json for framework hints
        try {
          const pkg = JSON.parse(readFileSync(join(serviceDir, 'package.json'), 'utf8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.next || deps.nuxt || deps.vite || deps['@sveltejs/kit'] || deps.react) return 'frontend';
          if (deps.express || deps.fastify || deps.hono || deps.koa) return 'backend';
        } catch { /* ignore */ }
        return 'backend'; // default to backend
      };

      const siblings = servicesWithDockerfile.map(d => ({
        dirName: d,
        role: classifyService(d, join(projectDir, d)),
        projectName: `${name.trim()}-${d}`,
      }));

      // Sort: backends deploy first so frontend can resolve the backend URL
      siblings.sort((a, b) => (a.role === 'backend' ? -1 : 1) - (b.role === 'backend' ? -1 : 1));

      const failedServices: Array<{ name: string; error: string }> = [];

      // Create all project records first (fast), then do GCS uploads in background
      for (const svc of siblings) {
        try {
          const serviceDir = join(projectDir, svc.dirName);

          const project = await createProject({
            name: svc.projectName,
            sourceType: 'upload',
            sourceUrl: serviceDir,
            config: {
              deployTarget: 'cloud_run',
              customDomain: customDomain.trim()
                ? (svc.role === 'frontend' ? customDomain.trim() : `api.${customDomain.trim()}`)
                : undefined,
              forceDomain,
              allowUnauthenticated,
              envVars: Object.keys(userEnvVars).length > 0 ? userEnvVars : undefined,
              gcsDbDumpUri: svc.role === 'backend' ? gcsDbDumpUri : undefined,
              dbDumpFileName: svc.role === 'backend' ? (dbDumpFileName || undefined) : undefined,
              projectGroup: groupId,
              groupName: name.trim(),
              serviceRole: svc.role,
              serviceDirName: svc.dirName,
              siblings: siblings.map(s => ({ name: s.projectName, role: s.role, dirName: s.dirName })),
            },
            // RBAC Phase 1: stamp owner from auth context (multipart monorepo sibling).
            ownerId: request.auth.user?.id ?? null,
          });

          await transitionProject(project.id, 'scanning', 'system', { trigger: 'auto' });
          const scanReport = await createScanReport(project.id);

          createdProjects.push({
            project: { ...project, status: 'scanning' },
            scanReport,
          });
        } catch (err) {
          const msg = (err as Error).message;
          console.error(`[Upload] Failed to create monorepo service "${svc.projectName}": ${msg}`);
          failedServices.push({ name: svc.projectName, error: msg });
        }
      }

      console.log(`[Upload] Monorepo group ${groupId}: created ${createdProjects.length} projects, ${failedServices.length} failed`);

      // ── Return response immediately — GCS upload + pipeline run in background ──
      reply.status(201).send({
        monorepo: true,
        groupId,
        services: createdProjects,
        failedServices: failedServices.length > 0 ? failedServices : undefined,
        uploadedFile: fileName,
      });

      // Background: upload source to GCS + start pipeline for each service
      for (const svc of siblings) {
        const serviceDir = join(projectDir, svc.dirName);
        const svcSlug = svc.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        const created = createdProjects.find(
          (c) => (c.project as { name: string }).name === svc.projectName,
        );
        if (!created) continue;
        const projectId = (created.project as { id: string }).id;

        (async () => {
          const verdict = await uploadAndPersistSourceWithVerdict({
            projectLabel: `${name}/${svc.projectName}`,
            runUpload: () => uploadSourceToGcs(svcSlug, serviceDir),
            runPersist: async (gcsSourceUri) => {
              const current = await getProject(projectId);
              await updateProjectConfig(projectId, { ...(current?.config ?? {}), gcsSourceUri });
            },
          });
          if (verdict.kind === 'upload-failed') {
            try {
              await transitionProject(projectId, 'failed', 'system', {
                error: verdict.uploadError,
                errorCode: verdict.errorCode,
                failedStep: 'background source upload (multipart monorepo sibling)',
              });
            } catch (txErr) {
              console.error(`[Upload] transition to failed also threw: ${(txErr as Error).message}`);
            }
            return;
          }
          runPipeline(projectId, serviceDir).catch((err) => {
            console.error(`[Pipeline] Async dispatch failed for ${projectId}:`, (err as Error).message);
          });
        })();
      }
      return; // monorepo handled — don't fall through to single-service path
    }

    // ── Single-service project (original flow) ──
    // Create project record FIRST, then do heavy I/O in background
    const userEnvVars = parseEnvVarsText(envVarsRaw);

    const project = await createProject({
      name: name.trim(),
      sourceType: 'upload',
      sourceUrl: projectDir,
      config: {
        deployTarget: 'cloud_run',
        customDomain: customDomain.trim() || undefined,
        forceDomain,
        allowUnauthenticated,
        envVars: Object.keys(userEnvVars).length > 0 ? userEnvVars : undefined,
      },
      // RBAC Phase 1: stamp owner from auth context (multipart single-service path).
      ownerId: request.auth.user?.id ?? null,
    });

    await transitionProject(project.id, 'scanning', 'system', { trigger: 'auto' });
    const scanReport = await createScanReport(project.id);

    // ── Return response immediately — GCS upload + pipeline run in background ──
    reply.status(201).send({
      project: { ...project, status: 'scanning' },
      scanReport,
      uploadedFile: fileName,
      extractedTo: projectDir,
    });

    // Background: upload source + DB dump to GCS, then start pipeline.
    // Round 22: source upload routed through verdict so failures transition
    // project to 'failed' rather than running a misleading green pipeline.
    // DB dump upload remains a separate try/catch — it's optional and a
    // failure there doesn't break the deploy (deploy-engine handles missing
    // dump gracefully).
    (async () => {
      const verdict = await uploadAndPersistSourceWithVerdict({
        projectLabel: project.name,
        runUpload: () => uploadSourceToGcs(projectSlug, projectDir),
        runPersist: async (gcsSourceUri) => {
          const current = await getProject(project.id);
          if (current) await updateProjectConfig(project.id, { ...current.config, gcsSourceUri });
        },
      });
      if (verdict.kind === 'upload-failed') {
        try {
          await transitionProject(project.id, 'failed', 'system', {
            error: verdict.uploadError,
            errorCode: verdict.errorCode,
            failedStep: 'background source upload (multipart single service)',
          });
        } catch (txErr) {
          console.error(`[Upload] transition to failed also threw: ${(txErr as Error).message}`);
        }
        return; // skip dump upload + pipeline — no source means deploy will fail
      }

      // Round 23: route DB dump upload through verdict so an upload failure
      // transitions the project to 'failed' instead of silently running a
      // pipeline whose deploy will boot against an empty DB and 500 every
      // API call 30+ minutes later. Persist failure (URI in GCS but config
      // write blew up) does NOT block the pipeline — operator can patch
      // config.gcsDbDumpUri before deploy approval.
      if (dbDumpBuffer && dbDumpFileName) {
        const dumpVerdict = await uploadAndPersistDbDumpWithVerdict({
          projectLabel: project.name,
          dumpFileName: dbDumpFileName,
          runUpload: () => uploadDbDumpToGcs(projectSlug, dbDumpBuffer, dbDumpFileName),
          runPersist: async (gcsDbDumpUri) => {
            const currentForDump = await getProject(project.id);
            if (currentForDump) {
              await updateProjectConfig(project.id, { ...currentForDump.config, gcsDbDumpUri, dbDumpFileName });
            }
          },
        });
        if (dumpVerdict.kind === 'upload-failed') {
          try {
            await transitionProject(project.id, 'failed', 'system', {
              error: dumpVerdict.uploadError,
              errorCode: dumpVerdict.errorCode,
              failedStep: 'background db dump upload (multipart single service)',
            });
          } catch (txErr) {
            console.error(`[Upload] transition to failed (db dump) also threw: ${(txErr as Error).message}`);
          }
          return; // skip pipeline — without dump, deploy will boot empty DB
        }
      }

      runPipeline(project.id, projectDir).catch((err) => {
        console.error(`[Pipeline] Async dispatch failed for ${project.id}:`, (err as Error).message);
      });
    })();
  });

  // Get latest scan report for project
  app.get<{ Params: { id: string } }>('/api/projects/:id/scan', async (request, reply) => {
    const report = await getLatestScanReport(request.params.id);
    if (!report) return reply.status(404).send({ error: 'No scan report found' });
    return { report };
  });

  // Download detailed scan report as Markdown (for senior engineers to review unfixed issues)
  app.get<{ Params: { id: string } }>('/api/projects/:id/scan/report', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const report = await getLatestScanReport(project.id);
    if (!report) return reply.status(404).send({ error: 'No scan report found' });

    const now = new Date().toISOString().slice(0, 10);
    const filename = `${project.slug}-security-report-${now}.md`;

    // ── Group findings by severity ──
    type SeverityKey = 'critical' | 'high' | 'medium' | 'low' | 'info';
    const severityOrder: SeverityKey[] = ['critical', 'high', 'medium', 'low', 'info'];
    const severityEmoji: Record<SeverityKey, string> = {
      critical: '\u{1F534}', high: '\u{1F7E0}', medium: '\u{1F7E1}', low: '\u{1F535}', info: '\u26AA',
    };
    const grouped: Record<SeverityKey, typeof report.findings> = {
      critical: [], high: [], medium: [], low: [], info: [],
    };
    for (const f of report.findings) {
      const sev = (f.severity ?? 'info') as SeverityKey;
      (grouped[sev] ?? grouped.info).push(f);
    }

    // ── Build auto-fix lookup ──
    const fixedIds = new Set<string>();
    const unfixedFindings: typeof report.findings = [];
    for (const fix of report.autoFixes) {
      if (fix.applied && fix.findingId) fixedIds.add(fix.findingId);
    }
    for (const f of report.findings) {
      if (!fixedIds.has(f.id)) unfixedFindings.push(f);
    }

    // ── Markdown report ──
    const lines: string[] = [];
    lines.push(`# Security Scan Report — ${project.name}`);
    lines.push('');
    lines.push(`| Item | Value |`);
    lines.push(`|------|-------|`);
    lines.push(`| Project | ${project.name} (\`${project.slug}\`) |`);
    lines.push(`| Language | ${project.detectedLanguage ?? 'unknown'} |`);
    lines.push(`| Framework | ${project.detectedFramework ?? 'none'} |`);
    lines.push(`| Scan Date | ${report.createdAt.toISOString().slice(0, 19).replace('T', ' ')} UTC |`);
    lines.push(`| Report Version | v${report.version} |`);
    lines.push('');

    // Summary counts
    const total = report.findings.length;
    const fixed = fixedIds.size;
    const remaining = unfixedFindings.length;
    lines.push(`## Summary`);
    lines.push('');
    lines.push(`| Severity | Count |`);
    lines.push(`|----------|-------|`);
    for (const sev of severityOrder) {
      if (grouped[sev].length > 0) {
        lines.push(`| ${severityEmoji[sev]} **${sev.toUpperCase()}** | ${grouped[sev].length} |`);
      }
    }
    lines.push(`| **Total** | **${total}** |`);
    lines.push(`| Auto-fixed | ${fixed} |`);
    lines.push(`| Requires manual review | **${remaining}** |`);
    lines.push('');

    // Auto-fixes applied
    if (report.autoFixes.length > 0) {
      lines.push(`## Auto-Fixes Applied`);
      lines.push('');
      const appliedFixes = report.autoFixes.filter(f => f.applied);
      if (appliedFixes.length === 0) {
        lines.push('No auto-fixes were successfully applied.');
      } else {
        for (const fix of appliedFixes) {
          lines.push(`### \u2705 ${fix.filePath ?? 'unknown'}`);
          lines.push('');
          lines.push(fix.explanation);
          if (fix.diff) {
            lines.push('');
            lines.push('```diff');
            lines.push(fix.diff);
            lines.push('```');
          }
          lines.push('');
        }
      }
      lines.push('');
    }

    // Findings requiring manual review (grouped by severity)
    lines.push(`## Findings Requiring Manual Review`);
    lines.push('');
    if (remaining === 0) {
      lines.push('All findings have been auto-fixed. No manual action required.');
    } else {
      let idx = 1;
      for (const sev of severityOrder) {
        const sevFindings = grouped[sev].filter(f => !fixedIds.has(f.id));
        if (sevFindings.length === 0) continue;

        lines.push(`### ${severityEmoji[sev]} ${sev.toUpperCase()} (${sevFindings.length})`);
        lines.push('');

        for (const f of sevFindings) {
          lines.push(`#### ${idx}. ${f.title}`);
          lines.push('');
          lines.push(`| Field | Detail |`);
          lines.push(`|-------|--------|`);
          lines.push(`| Severity | **${f.severity}** |`);
          lines.push(`| Category | ${f.category} |`);
          lines.push(`| Tool | ${f.tool} |`);
          lines.push(`| File | \`${f.filePath}\` |`);
          lines.push(`| Lines | L${f.lineStart}${f.lineEnd !== f.lineStart ? `–L${f.lineEnd}` : ''} |`);
          lines.push('');
          lines.push(`> ${f.description}`);
          lines.push('');
          idx++;
        }
      }
    }

    // Threat summary (LLM-generated)
    if (report.threatSummary) {
      lines.push(`## Threat Analysis`);
      lines.push('');
      lines.push(report.threatSummary);
      lines.push('');
    }

    // Cost estimate
    if (report.costEstimate) {
      lines.push(`## Estimated Monthly Cost (GCP Cloud Run)`);
      lines.push('');
      lines.push(`| Resource | Cost (USD) |`);
      lines.push(`|----------|-----------|`);
      lines.push(`| Compute | $${report.costEstimate.breakdown.compute.toFixed(2)} |`);
      lines.push(`| Storage | $${report.costEstimate.breakdown.storage.toFixed(2)} |`);
      lines.push(`| Networking | $${report.costEstimate.breakdown.networking.toFixed(2)} |`);
      lines.push(`| SSL | $${report.costEstimate.breakdown.ssl.toFixed(2)} |`);
      lines.push(`| **Total** | **$${report.costEstimate.monthlyTotal.toFixed(2)}** |`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated by Wave Deploy Agent on ${now}*`);

    const markdown = lines.join('\n');

    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(markdown);
  });

  // Get full project detail: project + scan report + deployments + timeline
  app.get<{ Params: { id: string } }>('/api/projects/:id/detail', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const [scanReport, deployments] = await Promise.all([
      getLatestScanReport(project.id),
      getDeploymentsByProject(project.id),
    ]);

    // Get state transitions (timeline)
    const { query: dbQuery } = await import('../db/index');
    const transitions = await dbQuery(
      `SELECT * FROM state_transitions WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id]
    );

    return {
      project,
      scanReport,
      deployments,
      timeline: transitions.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        fromState: r.from_state,
        toState: r.to_state,
        triggeredBy: r.triggered_by,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    };
  });

  // Re-run LLM analysis on the latest failed transition (backfill for old failures that predate the LLM path)
  app.post<{ Params: { id: string } }>('/api/projects/:id/reanalyze-failure', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: reanalyze burns LLM budget — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'reanalyze-failure');
    if (!owner.ok) return;

    const { query: dbQuery } = await import('../db/index');
    const latestFailed = await dbQuery(
      `SELECT * FROM state_transitions
       WHERE project_id = $1 AND to_state = 'failed'
       ORDER BY created_at DESC LIMIT 1`,
      [project.id],
    );
    if (latestFailed.rows.length === 0) {
      return reply.status(404).send({ error: 'No failed transition found for this project' });
    }

    const transition = latestFailed.rows[0] as { id: string; metadata: Record<string, unknown> };
    const meta = transition.metadata ?? {};
    const errorMessage = typeof meta.error === 'string' ? meta.error : 'Unknown error';
    const failedStep = typeof meta.failedStep === 'string' ? meta.failedStep : 'Unknown step';

    // Extract Cloud Build ID from error string (if any) and re-fetch log
    let buildLog = '';
    let logFetchNote: string | null = null;
    const buildIdMatch = errorMessage.match(/builds\/([a-f0-9-]{36})/i);
    if (buildIdMatch) {
      const buildId = buildIdMatch[1];
      const gcpProject = process.env.GCP_PROJECT ?? 'wave-deploy-agent';
      try {
        const metaUrl = `https://cloudbuild.googleapis.com/v1/projects/${gcpProject}/builds/${buildId}`;
        const metaRes = await gcpFetch(metaUrl);
        if (metaRes.ok) {
          const metaJson = await metaRes.json() as { logsBucket?: string };
          if (metaJson.logsBucket) {
            const bucket = metaJson.logsBucket.replace('gs://', '');
            // Try standard path first
            const tryPaths = [`log-${buildId}.txt`, `${buildId}.log`];
            for (const objPath of tryPaths) {
              const logUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objPath)}?alt=media`;
              const logRes = await gcpFetch(logUrl);
              if (logRes.ok) {
                buildLog = await logRes.text();
                console.log(`[Reanalyze] Fetched build log: ${buildLog.length} chars (${bucket}/${objPath})`);
                break;
              }
              if (logRes.status === 403) {
                logFetchNote = `bucket ${bucket} 拒絕讀取（HTTP 403）— 這是 Google managed cloudbuild-logs bucket，部署 agent 沒有讀權限`;
                console.warn(`[Reanalyze] ${logFetchNote}`);
                break;
              }
              console.warn(`[Reanalyze] Build log fetch returned HTTP ${logRes.status} for ${objPath}`);
              logFetchNote = `log fetch HTTP ${logRes.status}`;
            }
          } else {
            logFetchNote = 'Cloud Build metadata 沒有 logsBucket 欄位';
          }
        } else {
          logFetchNote = `Cloud Build metadata HTTP ${metaRes.status}`;
          console.warn(`[Reanalyze] Build metadata HTTP ${metaRes.status} for ${buildId}`);
        }
      } catch (err) {
        logFetchNote = `log fetch 例外：${(err as Error).message}`;
        console.warn(`[Reanalyze] Build log fetch threw: ${(err as Error).message}`);
      }
    } else {
      logFetchNote = 'error 訊息中找不到 Cloud Build ID（不是 build step 失敗 / 格式不符）';
    }

    // Try to read source context (from tarball in GCS since projectDir is long gone by now)
    const { readSourceContextFromGcs } = await import('../services/source-reader');
    const gcsUriForCtx = (project.config?.gcsFixedSourceUri as string | undefined)
      ?? (project.config?.gcsSourceUri as string | undefined);
    const sourceContext = await readSourceContextFromGcs(gcsUriForCtx, buildLog);
    if (sourceContext) {
      console.log(`[Reanalyze] Source context: ${sourceContext.stats.filesReadNearError} snippets + ${sourceContext.stats.fingerprintFiles} fingerprint files`);
    } else {
      console.log('[Reanalyze] No source context available (no GCS tarball or fetch failed)');
    }

    // Run LLM analysis
    const { analyzeDeployFailure } = await import('../services/llm-analyzer');
    const diagnosis = await analyzeDeployFailure(failedStep, errorMessage, buildLog, project.name, sourceContext);
    console.log(`[Reanalyze] Diagnosis: [${diagnosis.category}] ${diagnosis.summary} (provider=${diagnosis.provider})`);

    // Merge buildDiagnosis into the existing transition's metadata
    await dbQuery(
      `UPDATE state_transitions
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          buildDiagnosis: {
            category: diagnosis.category,
            ownership: diagnosis.ownership,
            summary: diagnosis.summary,
            userFacingMessage: diagnosis.userFacingMessage,
            adminFacingMessage: diagnosis.adminFacingMessage,
            userActionable: diagnosis.userActionable,
            platformActionable: diagnosis.platformActionable,
            rootCause: diagnosis.rootCause,
            suggestedFix: diagnosis.suggestedFix,
            errorLocation: diagnosis.errorLocation,
            errorSnippet: diagnosis.errorSnippet,
            extraObservations: diagnosis.extraObservations,
            step: diagnosis.step,
            provider: diagnosis.provider,
            reanalyzedAt: new Date().toISOString(),
          },
        }),
        transition.id,
      ],
    );

    return { diagnosis, logFetched: buildLog.length > 0, logBytes: buildLog.length, logFetchNote };
  });

  // Resubmit/retry project (from needs_revision or failed) — re-triggers pipeline
  app.post<{ Params: { id: string } }>('/api/projects/:id/resubmit', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: only owner OR admin may resubmit a project (re-triggers pipeline + spend).
    const owner = await requireOwnerOrAdmin(request, reply, project, 'resubmit');
    if (!owner.ok) return;

    if (project.status !== 'needs_revision' && project.status !== 'failed' && project.status !== 'live') {
      return reply.status(400).send({ error: `Cannot retry from status: ${project.status}` });
    }

    // Reset to submitted, then scanning
    await transitionProject(project.id, 'submitted', 'user', { action: 'retry' });
    await transitionProject(project.id, 'scanning', 'system', { trigger: 'retry' });

    // Create a new scan report
    const scanReport = await createScanReport(project.id);

    // Re-trigger pipeline using the existing source
    const projectDir = project.sourceUrl ?? '';
    if (projectDir) {
      runPipeline(project.id, projectDir).catch((err) => {
        console.error(`[Pipeline] Retry dispatch failed for ${project.id}:`, (err as Error).message);
      });
    }

    return { project: { ...project, status: 'scanning' }, scanReport };
  });

  // Force-fail a stuck project (e.g. scanning timeout)
  app.post<{ Params: { id: string } }>('/api/projects/:id/force-fail', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: force-fail bypasses normal lifecycle — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'force-fail');
    if (!owner.ok) return;

    if (project.status !== 'scanning' && project.status !== 'deploying') {
      return reply.status(400).send({ error: `Project is not stuck (status: ${project.status})` });
    }

    await transitionProject(project.id, 'failed', 'admin', {
      reason: 'Force-failed by admin (stuck pipeline)',
    });

    return { project: { ...project, status: 'failed' } };
  });

  // Skip scan and go directly to review_pending (for stuck pipelines)
  app.post<{ Params: { id: string } }>('/api/projects/:id/skip-scan', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: skip-scan bypasses security gate — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'skip-scan');
    if (!owner.ok) return;

    if (project.status !== 'scanning' && project.status !== 'failed') {
      return reply.status(400).send({ error: `Cannot skip scan from status: ${project.status}` });
    }

    // Create scan report if missing, then transition to review_pending
    let scanReport = await getLatestScanReport(project.id);
    if (!scanReport) {
      scanReport = await createScanReport(project.id);
    }
    await updateScanReport(scanReport.id, { status: 'completed' });
    await transitionProject(project.id, 'review_pending', 'admin', {
      reason: 'Scan skipped by admin',
    });
    await createReview(scanReport.id);

    return { project: { ...project, status: 'review_pending' }, scanReport };
  });

  // Delete project and tear down all GCP resources.
  //
  // Round 15: this used to unconditionally `await deleteProjectFromDb` after
  // best-effort GCP cleanup, even when one or more GCP steps errored. Result
  // was permanent billed orphans (Cloud Run service / domain mapping /
  // Cloudflare CNAME / Artifact Registry image) plus zero audit trail to
  // debug from. The Redis allocation row was ALSO never released because
  // nobody called releaseProjectRedis (and the table has no FK CASCADE).
  //
  // Now: collect each step's outcome into a structured array, classify via
  // buildTeardownVerdict, and refuse to touch the DB if any orphan exists.
  // Operator gets a 500 with errorCode='project_teardown_orphans' + the
  // orphan list so they can clean up manually then retry — with the DB row
  // and audit trail still intact.
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: only owner OR admin may delete a project.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'delete');
    if (!owner.ok) return;

    const gcpProject = project.config?.gcpProject || process.env.GCP_PROJECT || '';
    const gcpRegion = project.config?.gcpRegion || process.env.GCP_REGION || 'asia-east1';

    const outcomes: TeardownStepOutcome[] = [];

    // 1. Per-deployment cleanup: Cloud Run service, domain mapping, Cloudflare DNS.
    const deployments = await getDeploymentsByProject(project.id);
    for (const deploy of deployments) {
      if (deploy.cloudRunService && gcpProject) {
        const delRes = await deleteService(gcpProject, gcpRegion, deploy.cloudRunService);
        outcomes.push({
          kind: 'cloud_run_service',
          reference: deploy.cloudRunService,
          ok: delRes.ok,
          alreadyGone: delRes.alreadyGone,
          error: delRes.error,
        });
      }

      if (deploy.customDomain && gcpProject) {
        try {
          await deleteDomainMapping(gcpProject, gcpRegion, deploy.customDomain);
          outcomes.push({ kind: 'domain_mapping', reference: deploy.customDomain, ok: true, error: null });
        } catch (err) {
          outcomes.push({
            kind: 'domain_mapping',
            reference: deploy.customDomain,
            ok: false,
            error: (err as Error).message,
          });
        }

        const cfToken = process.env.CLOUDFLARE_TOKEN || '';
        const cfZoneId = process.env.CLOUDFLARE_ZONE_ID || '';
        const cfZoneName = process.env.CLOUDFLARE_ZONE_NAME || '';
        if (cfToken && cfZoneId && cfZoneName) {
          const subdomain = deploy.customDomain.replace(`.${cfZoneName}`, '');
          try {
            const result = await deleteCname({ cloudflareToken: cfToken, zoneId: cfZoneId, subdomain, zoneName: cfZoneName });
            outcomes.push({
              kind: 'cloudflare_dns',
              reference: deploy.customDomain,
              ok: result.success,
              error: result.error ?? null,
            });
          } catch (err) {
            outcomes.push({
              kind: 'cloudflare_dns',
              reference: deploy.customDomain,
              ok: false,
              error: (err as Error).message,
            });
          }
        }
      }
    }

    // 2. Container images from Artifact Registry.
    if (gcpProject && gcpRegion) {
      try {
        await deleteContainerImage(gcpProject, gcpRegion, project.slug);
        outcomes.push({ kind: 'container_image', reference: project.slug, ok: true, error: null });
      } catch (err) {
        outcomes.push({
          kind: 'container_image',
          reference: project.slug,
          ok: false,
          error: (err as Error).message,
        });
      }
    }

    // 3. Redis allocation row (round 15: previously orphaned forever — no FK CASCADE).
    try {
      await releaseProjectRedis(project.id);
      outcomes.push({ kind: 'redis_allocation', reference: project.id, ok: true, error: null });
    } catch (err) {
      outcomes.push({
        kind: 'redis_allocation',
        reference: project.id,
        ok: false,
        error: (err as Error).message,
      });
    }

    const verdict = buildTeardownVerdict(outcomes);
    const teardownLog = outcomes.map(outcomeToLogEntry);

    if (verdict.kind === 'partial-orphans') {
      // CRITICAL — refuse to delete DB row. Operator must clean up GCP
      // manually then retry. Project + audit trail stay intact.
      request.log.error(
        {
          projectId: project.id,
          projectName: project.name,
          orphans: verdict.orphans.map((o) => ({ kind: o.kind, reference: o.reference, error: o.error })),
        },
        '[CRITICAL][teardown] GCP cleanup failed; DB row preserved to keep audit trail; manual cleanup required',
      );
      return reply.status(500).send({
        error: `GCP cleanup failed for ${verdict.orphans.length} resource(s). Project DB row preserved so you can retry. Clean up manually in the GCP console, then DELETE again.`,
        errorCode: verdict.errorCode,
        requiresManualCleanup: true,
        orphans: verdict.orphans.map((o) => ({
          kind: o.kind,
          reference: o.reference,
          error: o.error,
        })),
        teardownLog,
        project: { id: project.id, name: project.name },
      });
    }

    // clean-teardown OR nothing-to-delete → safe to drop the DB row.
    await deleteProjectFromDb(project.id);
    teardownLog.push({ step: 'Delete database records', status: 'ok' });

    request.log.info(
      { projectId: project.id, projectName: project.name, kind: verdict.kind, steps: outcomes.length },
      '[teardown] project deleted cleanly',
    );

    return { success: true, project: { id: project.id, name: project.name }, teardownLog };
  });

  // Get environment variable keys (values masked) for a deployed project
  app.get<{ Params: { id: string } }>('/api/projects/:id/env-vars', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: env-var keys leak per-project secret shape — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'read-env-vars');
    if (!owner.ok) return;

    // Try to read live env vars from Cloud Run service first
    const deployments = await getDeploymentsByProject(project.id);
    const activeDeployment = deployments.find((d) => d.cloudRunService);

    let envVars: Record<string, string> = {};

    if (activeDeployment?.cloudRunService) {
      const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
      const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';
      if (gcpProject) {
        try {
          envVars = await getServiceEnvVars(gcpProject, gcpRegion, activeDeployment.cloudRunService);
        } catch {
          // Fallback to DB
          envVars = (project.config?.envVars as Record<string, string>) ?? {};
        }
      }
    } else {
      // No deployment — use DB config
      envVars = (project.config?.envVars as Record<string, string>) ?? {};
    }

    const maskedVars = Object.entries(envVars).map(([key, value]) => ({
      key,
      maskedValue: value.length > 3 ? value.slice(0, 3) + '***' : '***',
    }));

    return { projectId: project.id, envVars: maskedVars };
  });

  // Update environment variables for a deployed project (no rebuild)
  app.patch<{ Params: { id: string } }>('/api/projects/:id/env-vars', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // RBAC Phase 1: PATCH env-vars writes to live service — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'update-env-vars');
    if (!owner.ok) return;

    // Validate request body
    const body = request.body as { envVars?: Record<string, string> };
    if (!body.envVars || typeof body.envVars !== 'object') {
      return reply.status(400).send({ error: 'Request body must include envVars object' });
    }

    // Find a deployment with a Cloud Run service
    const deployments = await getDeploymentsByProject(project.id);
    const activeDeployment = deployments.find((d) => d.cloudRunService);
    if (!activeDeployment || !activeDeployment.cloudRunService) {
      return reply.status(400).send({ error: 'No active Cloud Run deployment found for this project' });
    }

    const gcpProject = (project.config?.gcpProject as string) || process.env.GCP_PROJECT || '';
    const gcpRegion = (project.config?.gcpRegion as string) || process.env.GCP_REGION || 'asia-east1';

    if (!gcpProject) {
      return reply.status(400).send({ error: 'GCP project not configured' });
    }

    // Round 14: split-write between Cloud Run and DB. We compute the merge plan
    // up-front, attempt the two writes, then ask interpretEnvVarsUpdateResult to
    // classify the (cloudRun, db) outcome. The dangerous case is
    // `db-failed-after-cloud-run` — Cloud Run got the new values but the DB row
    // still shows the old ones. The dashboard's natural refresh would render
    // stale data, so we surface a machine-readable `env_vars_db_drift` error
    // code that the dashboard uses to switch to live-read mode.
    const existingEnvVars: Record<string, string> = (project.config?.envVars as Record<string, string>) ?? {};
    const plan = planEnvVarsUpdate(existingEnvVars, body.envVars);

    // Noop short-circuit: nothing to write.
    if (plan.changed.length === 0 && plan.cleared.length === 0) {
      const verdict = interpretEnvVarsUpdateResult({ plan, cloudRun: null, db: null });
      request.log.info({ projectId: project.id, kind: verdict.kind }, '[env-vars] noop PATCH (no diff)');
      return {
        success: true,
        projectId: project.id,
        updatedKeys: Object.keys(plan.merged),
        noop: true,
      };
    }

    // Phase 1: Cloud Run.
    const cloudRunResult = await updateServiceEnvVars(
      gcpProject,
      gcpRegion,
      activeDeployment.cloudRunService,
      plan.merged,
    );
    const cloudRun = { success: cloudRunResult.success, error: cloudRunResult.error ?? null };

    // Phase 2: DB write — only attempted if Cloud Run succeeded. Captured in
    // try/catch so the verdict planner can see the error rather than letting
    // it bubble as an unhandled 500 (which would lose the cloud-run-already-updated
    // signal the dashboard needs).
    let db: { ok: boolean; error: string | null } | null = null;
    if (cloudRun.success) {
      const updatedConfig = { ...(project.config ?? {}), envVars: plan.merged };
      try {
        await updateProjectConfig(project.id, updatedConfig as Record<string, unknown>);
        db = { ok: true, error: null };
      } catch (err) {
        db = { ok: false, error: (err as Error).message };
      }
    }

    const verdict = interpretEnvVarsUpdateResult({ plan, cloudRun, db });

    switch (verdict.kind) {
      case 'success':
        request.log.info(
          { projectId: project.id, changed: verdict.changed, cleared: verdict.cleared },
          '[env-vars] update OK (Cloud Run + DB)',
        );
        return {
          success: true,
          projectId: project.id,
          updatedKeys: Object.keys(plan.merged),
          changed: verdict.changed,
          cleared: verdict.cleared,
        };

      case 'success-noop':
        // Already handled above, but kept for exhaustiveness.
        return { success: true, projectId: project.id, updatedKeys: Object.keys(plan.merged), noop: true };

      case 'cloud-run-failed':
        request.log.warn(
          { projectId: project.id, cloudRunError: verdict.cloudRunError },
          '[env-vars] Cloud Run rejected PATCH; DB untouched',
        );
        return reply.status(500).send({
          error: `Failed to update env vars: ${verdict.cloudRunError}`,
        });

      case 'db-failed-with-cloud-run-failed-too':
        request.log.warn(
          { projectId: project.id, cloudRunError: verdict.cloudRunError, dbError: verdict.dbError },
          '[env-vars] both Cloud Run and DB failed (DB untouched in practice)',
        );
        return reply.status(500).send({
          error: `Failed to update env vars: ${verdict.cloudRunError}`,
        });

      case 'db-failed-after-cloud-run':
        // CRITICAL — split-write divergence. Cloud Run is authoritative now.
        // Dashboard reads `errorCode === 'env_vars_db_drift'` and refuses to
        // show DB-cached values, falling back to live read via GET /env-vars.
        request.log.error(
          {
            projectId: project.id,
            cloudRunService: activeDeployment.cloudRunService,
            dbError: verdict.dbError,
            cloudRunValues: Object.keys(verdict.cloudRunValues),
            changed: verdict.changed,
            cleared: verdict.cleared,
          },
          '[CRITICAL][env-vars] DB write failed after Cloud Run succeeded — DB drift; manual reconcile required',
        );
        return reply.status(500).send({
          error: `Cloud Run was updated, but persisting to the database failed. The deployed service has the new values; the dashboard will read live from Cloud Run. Manual reconcile required. DB error: ${verdict.dbError}`,
          errorCode: verdict.errorCode,
          requiresManualReconcile: true,
          cloudRunValues: verdict.cloudRunValues,
          changed: verdict.changed,
          cleared: verdict.cleared,
        });
    }
  });

  // Stop a single project's Cloud Run service (delete service, keep image)
  app.post<{ Params: { id: string } }>('/api/projects/:id/stop', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: stopping deletes the running Cloud Run service — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'project_stop');
    if (!owner.ok) return;

    const result = await stopProjectService(request.params.id, 'api-user');
    if (!result.success) return reply.status(400).send({ error: result.message });
    return result;
  });

  // Start a stopped project (redeploy from cached Artifact Registry image)
  app.post<{ Params: { id: string } }>('/api/projects/:id/start', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: starting redeploys live traffic — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'project_start');
    if (!owner.ok) return;

    const result = await startProjectService(request.params.id, 'api-user');
    if (!result.success) return reply.status(400).send({ error: result.message });
    return result;
  });

  // Download the project's source tarball (proxies GCS through service account)
  app.get<{ Params: { id: string } }>('/api/projects/:id/source-download', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: source tarball may contain secrets — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'project_source_download');
    if (!owner.ok) return;

    const gcsUri = project.config?.gcsSourceUri as string | undefined;
    if (!gcsUri) return reply.status(404).send({ error: 'No source archive on record for this project' });

    // gs://bucket/path/to/object.tar.gz
    const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) return reply.status(500).send({ error: `Malformed GCS URI: ${gcsUri}` });
    const [, bucket, object] = match;

    // GCS JSON API: ?alt=media streams the object bytes.
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
    const gcsResp = await gcpFetch(url);
    if (!gcsResp.ok) {
      const errText = await gcsResp.text();
      return reply.status(gcsResp.status).send({ error: `GCS fetch failed: ${errText}` });
    }

    const filename = object.split('/').pop() ?? `${project.slug}-source.tar.gz`;
    reply
      .header('Content-Type', gcsResp.headers.get('content-type') ?? 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${filename}"`);
    const len = gcsResp.headers.get('content-length');
    if (len) reply.header('Content-Length', len);

    // Stream the body to the client
    return reply.send(gcsResp.body);
  });

  // Retry custom domain setup for a project that previously failed domain mapping
  app.post<{ Params: { id: string } }>('/api/projects/:id/retry-domain', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: domain mapping touches DNS + Cloud Run — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'project_retry_domain');
    if (!owner.ok) return;

    const customDomain = project.config?.customDomain as string | undefined;
    if (!customDomain) return reply.status(400).send({ error: 'No customDomain configured for this project' });

    // Determine the Cloud Run service name (da-{slug})
    const deployments = await getDeploymentsByProject(project.id);
    const latestDeploy = deployments[0];
    const serviceName = latestDeploy?.cloudRunService ?? `da-${project.slug}`;

    const cfToken = process.env.CLOUDFLARE_TOKEN || '';
    const cfZoneId = process.env.CLOUDFLARE_ZONE_ID || '';
    const cfZoneName = process.env.CLOUDFLARE_ZONE_NAME || 'punwave.com';

    if (!cfToken || !cfZoneId) {
      return reply.status(500).send({ error: 'Cloudflare not configured on server' });
    }

    // Build the subdomain (customDomain may be "luca2-app" or "api.luca2")
    const subdomain = customDomain.replace(`.${cfZoneName}`, '');

    const dnsConfig: DnsConfig = {
      cloudflareToken: cfToken,
      zoneId: cfZoneId,
      subdomain,
      zoneName: cfZoneName,
    };

    const forceDomain = Boolean(project.config?.forceDomain);
    console.log(`[retry-domain] Retrying domain for ${project.slug}: ${subdomain}.${cfZoneName} → service ${serviceName}`);

    const domainResult = await setupCustomDomainWithDns(
      dnsConfig,
      latestDeploy?.cloudRunUrl ?? '',
      GCP_PROJECT,
      GCP_REGION,
      serviceName,
      { force: forceDomain }
    );

    if (domainResult.success) {
      const fqdn = `${subdomain}.${cfZoneName}`;
      // Clear domain error and update deployment
      const updatedConfig = { ...project.config };
      delete (updatedConfig as Record<string, unknown>).domainError;
      delete (updatedConfig as Record<string, unknown>).domainErrorAt;
      await updateProjectConfig(project.id, updatedConfig as Record<string, unknown>);

      if (latestDeploy) {
        await updateDeployment(latestDeploy.id, { customDomain: fqdn, sslStatus: 'provisioning' });
      }

      return {
        success: true,
        fqdn,
        customUrl: domainResult.customUrl,
        message: `Domain ${fqdn} mapped successfully. SSL will provision in 5-15 minutes.`,
      };
    } else {
      return reply.status(500).send({
        success: false,
        error: domainResult.error,
        conflict: domainResult.conflict,
      });
    }
  });

  // ─── GitHub Webhook Settings (Versioning Phase 3) ───

  // Configure GitHub webhook for auto-deploy
  app.post<{ Params: { id: string } }>('/api/projects/:id/github-webhook', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: webhook config grants push→deploy authority — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'github_webhook_configure');
    if (!owner.ok) return;

    const body = (request.body ?? {}) as {
      repoUrl?: string;
      branch?: string;
      autoDeployEnabled?: boolean;
    };

    if (!body.repoUrl) {
      return reply.status(400).send({ error: 'repoUrl is required' });
    }

    // Validate it looks like a GitHub URL
    if (!body.repoUrl.includes('github.com/')) {
      return reply.status(400).send({ error: 'repoUrl must be a GitHub repository URL' });
    }

    // Normalize URL: remove trailing .git and trailing slash
    const normalizedUrl = body.repoUrl.replace(/\.git$/, '').replace(/\/$/, '');

    // Generate a random webhook secret
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const branch = body.branch || 'main';
    const autoDeployEnabled = body.autoDeployEnabled !== false; // default true

    // Store in DB
    await query(
      `UPDATE projects
       SET github_repo_url = $1,
           github_webhook_secret = $2,
           github_branch = $3,
           auto_deploy = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [normalizedUrl, webhookSecret, branch, autoDeployEnabled, project.id]
    );

    const apiBase = process.env.API_BASE_URL || 'https://wave-deploy-agent-api.punwave.com';
    const webhookUrl = `${apiBase}/api/webhooks/github`;

    return {
      configured: true,
      webhookUrl,
      webhookSecret,
      repoUrl: normalizedUrl,
      branch,
      autoDeployEnabled,
      message: '請將 Webhook URL 和 Secret 設定到 GitHub repository 的 Webhooks 設定中',
      instructions: {
        url: webhookUrl,
        contentType: 'application/json',
        secret: webhookSecret,
        events: ['push'],
      },
    };
  });

  // Remove GitHub webhook config
  app.delete<{ Params: { id: string } }>('/api/projects/:id/github-webhook', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: removing webhook stops auto-deploy — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'github_webhook_remove');
    if (!owner.ok) return;

    await query(
      `UPDATE projects
       SET github_repo_url = NULL,
           github_webhook_secret = NULL,
           github_branch = 'main',
           auto_deploy = false,
           updated_at = NOW()
       WHERE id = $1`,
      [project.id]
    );

    return { removed: true, message: '已移除 GitHub Webhook 設定' };
  });

  // Get webhook config (mask secret)
  app.get<{ Params: { id: string } }>('/api/projects/:id/github-webhook', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: response includes a partial secret (first 8 chars) — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'github_webhook_read');
    if (!owner.ok) return;

    const row = await query(
      `SELECT github_repo_url, github_webhook_secret, github_branch, auto_deploy FROM projects WHERE id = $1`,
      [project.id]
    );

    if (row.rows.length === 0) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const data = row.rows[0];
    const repoUrl = data.github_repo_url as string | null;
    const secret = data.github_webhook_secret as string | null;
    const branch = data.github_branch as string;
    const autoDeploy = data.auto_deploy as boolean;

    if (!repoUrl || !secret) {
      return { configured: false };
    }

    const apiBase = process.env.API_BASE_URL || 'https://wave-deploy-agent-api.punwave.com';

    return {
      configured: true,
      repoUrl,
      branch,
      autoDeployEnabled: autoDeploy,
      webhookUrl: `${apiBase}/api/webhooks/github`,
      // Mask secret: show first 8 chars + asterisks
      maskedSecret: secret.slice(0, 8) + '••••••••••••••••',
    };
  });

  // Toggle auto-deploy on/off (without reconfiguring webhook)
  app.patch<{ Params: { id: string } }>('/api/projects/:id/github-webhook', async (request, reply) => {
    const project = await getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    // RBAC Phase 1: toggling auto-deploy controls push→deploy authority — owner OR admin only.
    const owner = await requireOwnerOrAdmin(request, reply, project, 'github_webhook_toggle');
    if (!owner.ok) return;

    const body = (request.body ?? {}) as { autoDeployEnabled?: boolean; branch?: string };

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (body.autoDeployEnabled !== undefined) {
      sets.push(`auto_deploy = $${idx++}`);
      params.push(body.autoDeployEnabled);
    }
    if (body.branch !== undefined) {
      sets.push(`github_branch = $${idx++}`);
      params.push(body.branch);
    }

    params.push(project.id);
    await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${idx}`, params);

    return {
      updated: true,
      autoDeployEnabled: body.autoDeployEnabled,
      branch: body.branch,
    };
  });

  // Versioning routes moved to ./versioning.ts for reliability
  // (intermittent 404 when defined at end of this 1600+ line plugin)
}
