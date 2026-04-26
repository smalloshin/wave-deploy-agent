// Deploy Engine — Cloud Build + Cloud Run via REST APIs (no gcloud CLI dependency)

import { gcpFetch } from './gcp-auth';

export interface DeployConfig {
  projectSlug: string;
  gcpProject: string;
  gcpRegion: string;
  imageName: string;
  imageTag: string;
  envVars: Record<string, string>;
  memory?: string;
  cpu?: string;
  minInstances?: number;
  maxInstances?: number;
  allowUnauthenticated?: boolean;
  port?: number;
  cloudSqlInstance?: string;  // CloudSQL instance connection name for annotation
  vpcEgress?: {
    network: string;   // e.g. "default"
    subnet: string;    // e.g. "default"
    egress?: 'ALL_TRAFFIC' | 'PRIVATE_RANGES_ONLY';
  };
  /**
   * Optional pre-flight check. When set, Cloud Build runs a lightweight
   * language-specific check (tsc --noEmit for TS projects) BEFORE the Docker
   * build step. TypeScript errors surface with clean stderr instead of being
   * hidden inside `next build` output, so LLM diagnosis can name the bad line.
   */
  preflight?: {
    language: 'typescript' | 'javascript';
    packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun';
    hasTypescript: boolean;
  };
}

export interface DeployResult {
  success: boolean;
  serviceUrl: string | null;
  serviceName: string;
  error: string | null;
  duration: number;
  // Versioning: captured after deploy for immutable deploy model
  revisionName?: string;
  imageUri?: string;
}

// ─── Cloud Build: build and push image ───
// Accepts either a GCS URI (gs://bucket/object) or a local directory path.
// GCS URI is preferred since Cloud Run /tmp is ephemeral.

/**
 * Optional build-time hooks. The `onBuildStarted` callback fires AS SOON AS
 * Cloud Build returns the operation metadata (i.e. before the build polls to
 * completion), so callers can spin up a live log poller against
 * `gs://{bucket}/log-{buildId}.txt`. If the callback throws, the error is
 * swallowed (logged only) — observability must never crash a deploy.
 */
export interface BuildHooks {
  onBuildStarted?: (info: { buildId: string; bucket: string }) => void;
}

export async function buildAndPushImage(
  projectDir: string,
  config: DeployConfig,
  gcsSourceUri?: string,
  hooks?: BuildHooks,
): Promise<{ success: boolean; imageUri: string; error: string | null; buildLog?: string; buildId?: string }> {
  const imageUri = `${config.gcpRegion}-docker.pkg.dev/${config.gcpProject}/deploy-agent/${config.imageName}:${config.imageTag}`;

  try {
    const bucketName = `${config.gcpProject}_cloudbuild`;
    let gcsBucket: string;
    let gcsObject: string;

    if (gcsSourceUri && gcsSourceUri.startsWith('gs://')) {
      // Use pre-uploaded GCS source directly
      const withoutPrefix = gcsSourceUri.slice(5); // remove "gs://"
      const slashIdx = withoutPrefix.indexOf('/');
      gcsBucket = withoutPrefix.slice(0, slashIdx);
      gcsObject = withoutPrefix.slice(slashIdx + 1);
      console.log(`[Deploy]   Using GCS source: ${gcsSourceUri}`);
    } else {
      // Fallback: tar local files and upload to GCS (works when source is still on same instance)
      console.log(`[Deploy]   Tarring local source: ${projectDir}`);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      gcsObject = `source/${config.projectSlug}-${config.imageTag}.tgz`;
      gcsBucket = bucketName;
      const tarballPath = `/tmp/${config.projectSlug}-${config.imageTag}.tgz`;
      await exec('tar', ['-czf', tarballPath, '-C', projectDir, '.'], { timeout: 60_000 });

      const { readFileSync, unlinkSync } = await import('node:fs');
      const tarball = readFileSync(tarballPath);
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${gcsBucket}/o?uploadType=media&name=${encodeURIComponent(gcsObject)}`;
      const uploadRes = await gcpFetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip' },
        body: tarball,
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`GCS upload failed (${uploadRes.status}): ${err}`);
      }
      try { unlinkSync(tarballPath); } catch { /* ignore */ }
    }

    // Build Cloud Build steps: optional pre-flight (tsc --noEmit) + docker build
    const preflightSteps = buildPreflightSteps(config.preflight);
    if (preflightSteps.length > 0) {
      console.log(`[Deploy]   Pre-flight enabled: ${config.preflight?.packageManager} + tsc --noEmit`);
    }

    // Trigger Cloud Build with GCS source
    const buildRequest = {
      source: {
        storageSource: {
          bucket: gcsBucket,
          object: gcsObject,
        },
      },
      steps: [
        ...preflightSteps,
        {
          name: 'gcr.io/cloud-builders/docker',
          args: [
            'build',
            // Pass env vars as build args (for Vite/React build-time injection)
            ...Object.entries(config.envVars)
              .filter(([k]) => k.startsWith('VITE_') || k.startsWith('NEXT_PUBLIC_') || k.startsWith('REACT_APP_'))
              .flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]),
            '-t', imageUri, '.',
          ],
        },
      ],
      images: [imageUri],
      timeout: '600s',
      // Write logs to our own bucket so deploy-agent SA can read them.
      // Default cloudbuild-logs bucket is Google-managed and our SA can't be granted access.
      // NOTE: logsBucket is a TOP-LEVEL Build field in REST API, NOT nested in options.
      // Putting it under options makes Cloud Build return 400 "Unknown name logsBucket".
      logsBucket: `gs://${gcsBucket}`,
      options: {
        logging: 'GCS_ONLY',
      },
    };

    const buildUrl = `https://cloudbuild.googleapis.com/v1/projects/${config.gcpProject}/builds`;
    const buildRes = await gcpFetch(buildUrl, {
      method: 'POST',
      body: JSON.stringify(buildRequest),
    });

    if (!buildRes.ok) {
      const err = await buildRes.text();
      throw new Error(`Cloud Build submit failed (${buildRes.status}): ${err}`);
    }

    const buildData = await buildRes.json() as { metadata: { build: { id: string } } };
    const buildId = buildData.metadata.build.id;
    console.log(`[Deploy]   Cloud Build started: ${buildId}`);

    // Fire the onBuildStarted hook BEFORE the polling loop so callers can
    // start streaming GCS log chunks immediately. Errors here are swallowed —
    // observability must never crash a deploy.
    if (hooks?.onBuildStarted) {
      try {
        hooks.onBuildStarted({ buildId, bucket: gcsBucket });
      } catch (err) {
        console.warn(`[Deploy]   onBuildStarted hook threw: ${(err as Error).message}`);
      }
    }

    // Poll build status
    const pollUrl = `https://cloudbuild.googleapis.com/v1/projects/${config.gcpProject}/builds/${buildId}`;
    const maxWait = 10 * 60 * 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await sleep(5000);
      const statusRes = await gcpFetch(pollUrl);
      if (!statusRes.ok) {
        throw new Error(`Cloud Build poll failed (${statusRes.status})`);
      }
      const status = await statusRes.json() as { status: string; statusDetail?: string; logUrl?: string; results?: { buildStepOutputs?: string[] }; steps?: Array<{ status: string; args?: string[] }> };

      if (status.status === 'SUCCESS') {
        return { success: true, imageUri, error: null, buildId };
      }
      if (status.status === 'FAILURE' || status.status === 'INTERNAL_ERROR' || status.status === 'TIMEOUT' || status.status === 'CANCELLED') {
        // Try to fetch build log for detailed error — failures here must NOT be silent,
        // because the downstream LLM analyzer depends on buildLog being populated.
        let detailMsg = status.statusDetail ?? 'no details';
        let fullBuildLog = '';
        try {
          const logUrl = `https://cloudbuild.googleapis.com/v1/projects/${config.gcpProject}/builds/${buildId}`;
          const logRes = await gcpFetch(logUrl);
          if (!logRes.ok) {
            console.warn(`[Deploy]   Cloud Build metadata fetch failed: HTTP ${logRes.status}`);
          } else {
            const logData = await logRes.json() as { logUrl?: string; logsBucket?: string; failureInfo?: { detail?: string; type?: string }; statusDetail?: string };
            if (logData.failureInfo?.detail) detailMsg = logData.failureInfo.detail;
            else if (logData.statusDetail) detailMsg = logData.statusDetail;
            if (logData.logUrl) detailMsg += ` | Logs: ${logData.logUrl}`;
            // Fetch full build log from GCS (Cloud Build stores logs as log-{buildId}.txt)
            if (logData.logsBucket) {
              try {
                const bucket = logData.logsBucket.replace('gs://', '');
                const logObjUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(`log-${buildId}.txt`)}?alt=media`;
                const logTextRes = await gcpFetch(logObjUrl);
                if (logTextRes.ok) {
                  fullBuildLog = await logTextRes.text();
                  console.log(`[Deploy]   Fetched build log: ${fullBuildLog.length} chars (${bucket})`);
                } else {
                  console.warn(`[Deploy]   Build log fetch failed: HTTP ${logTextRes.status} on ${bucket}/log-${buildId}.txt`);
                }
              } catch (logErr) {
                console.warn(`[Deploy]   Build log fetch threw: ${(logErr as Error).message}`);
              }
            } else {
              console.warn(`[Deploy]   Cloud Build returned no logsBucket for build ${buildId}`);
            }
          }
        } catch (metaErr) {
          console.warn(`[Deploy]   Cloud Build metadata fetch threw: ${(metaErr as Error).message}`);
        }
        // Attach build log to error for LLM analysis. Even when buildLog is empty,
        // detailMsg alone is useful — LLM can still reason about the Cloud Build API response.
        const err = new Error(`Cloud Build ${status.status}: ${detailMsg}`);
        (err as Error & { buildLog?: string }).buildLog = fullBuildLog;
        (err as Error & { buildId?: string }).buildId = buildId;
        throw err;
      }
      console.log(`[Deploy]   Cloud Build status: ${status.status}`);
    }

    const timeoutErr = new Error('Cloud Build timed out after 10 minutes');
    (timeoutErr as Error & { buildId?: string }).buildId = buildId;
    throw timeoutErr;
  } catch (err) {
    return {
      success: false,
      imageUri,
      error: (err as Error).message,
      buildLog: (err as Error & { buildLog?: string }).buildLog,
      buildId: (err as Error & { buildId?: string }).buildId,
    };
  }
}

// ─── Cloud Run: deploy service ───

export async function deployToCloudRun(config: DeployConfig, imageUri: string): Promise<DeployResult> {
  const start = Date.now();
  const serviceName = `da-${config.projectSlug}`.slice(0, 63);
  const parent = `projects/${config.gcpProject}/locations/${config.gcpRegion}`;

  try {
    // Check if service exists
    const getUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}`;
    const existsRes = await gcpFetch(getUrl);
    const serviceExists = existsRes.ok;

    // Build service spec — filter out Cloud Run reserved env vars
    const RESERVED_ENV_VARS = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);
    const envVars = Object.entries(config.envVars)
      .filter(([name]) => {
        if (RESERVED_ENV_VARS.has(name)) {
          console.log(`[Deploy]   Skipping reserved env var: ${name}`);
          return false;
        }
        return true;
      })
      .map(([name, value]) => ({ name, value }));

    // Build template annotations (e.g., CloudSQL connection)
    const templateAnnotations: Record<string, string> = {};
    const volumeMounts: Array<{ name: string; mountPath: string }> = [];
    const volumes: Array<{ name: string; cloudSqlInstance?: { instances: string[] } }> = [];

    if (config.cloudSqlInstance) {
      // Cloud Run v2: use volume mount for CloudSQL — instances must be plain string array
      const instanceStr = String(config.cloudSqlInstance);
      volumes.push({
        name: 'cloudsql',
        cloudSqlInstance: {
          instances: [instanceStr],
        },
      });
      volumeMounts.push({ name: 'cloudsql', mountPath: '/cloudsql' });
      // Belt-and-suspenders: also set the annotation (some configs need it for networking)
      templateAnnotations['run.googleapis.com/cloudsql-instances'] = instanceStr;
      console.log(`[Deploy]   CloudSQL volume: ${JSON.stringify(volumes[volumes.length - 1])}`);
      console.log(`[Deploy]   CloudSQL connection: ${instanceStr} (type: ${typeof instanceStr})`);
    }

    // Direct VPC egress — enables reaching internal VPC resources (Redis VM etc.)
    let vpcAccess: {
      networkInterfaces: Array<{ network: string; subnetwork: string }>;
      egress: string;
    } | undefined;
    if (config.vpcEgress) {
      vpcAccess = {
        networkInterfaces: [{
          network: config.vpcEgress.network,
          subnetwork: config.vpcEgress.subnet,
        }],
        egress: config.vpcEgress.egress ?? 'PRIVATE_RANGES_ONLY',
      };
      console.log(`[Deploy]   VPC egress: network=${config.vpcEgress.network} subnet=${config.vpcEgress.subnet} egress=${vpcAccess.egress}`);
    }

    const serviceSpec = {
      template: {
        annotations: Object.keys(templateAnnotations).length > 0 ? templateAnnotations : undefined,
        containers: [
          {
            image: imageUri,
            ports: [{ containerPort: config.port ?? 3000 }],
            resources: {
              limits: {
                memory: config.memory ?? '512Mi',
                cpu: config.cpu ?? '1',
              },
            },
            env: envVars.length > 0 ? envVars : undefined,
            volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined,
          },
        ],
        volumes: volumes.length > 0 ? volumes : undefined,
        vpcAccess,
        scaling: {
          minInstanceCount: config.minInstances ?? 0,
          maxInstanceCount: config.maxInstances ?? 10,
        },
      },
    };

    let operationUrl: string;

    if (serviceExists) {
      // Update existing service (PATCH)
      const updateUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}`;
      const res = await gcpFetch(updateUrl, {
        method: 'PATCH',
        body: JSON.stringify(serviceSpec),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Cloud Run update failed (${res.status}): ${err}`);
      }
      const op = await res.json() as { name: string };
      operationUrl = `https://run.googleapis.com/v2/${op.name}`;
    } else {
      // Create new service
      const createUrl = `https://run.googleapis.com/v2/${parent}/services?serviceId=${serviceName}`;
      const res = await gcpFetch(createUrl, {
        method: 'POST',
        body: JSON.stringify(serviceSpec),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Cloud Run create failed (${res.status}): ${err}`);
      }
      const op = await res.json() as { name: string };
      operationUrl = `https://run.googleapis.com/v2/${op.name}`;
    }

    // Poll operation until done
    const maxWait = 5 * 60 * 1000;
    const opStart = Date.now();
    while (Date.now() - opStart < maxWait) {
      await sleep(5000);
      const opRes = await gcpFetch(operationUrl);
      if (!opRes.ok) break;
      const op = await opRes.json() as { done?: boolean; error?: { message: string } };
      if (op.done) {
        if (op.error) throw new Error(`Cloud Run operation failed: ${op.error.message}`);
        break;
      }
    }

    // Get service URL + latest revision name
    const svcRes = await gcpFetch(getUrl);
    let serviceUrl: string | null = null;
    let latestRevision: string | undefined;
    if (svcRes.ok) {
      const svc = await svcRes.json() as {
        uri?: string;
        latestReadyRevision?: string;     // e.g. "projects/.../revisions/da-myapp-00003-abc"
      };
      serviceUrl = svc.uri ?? null;
      // Extract short revision name (last segment)
      if (svc.latestReadyRevision) {
        latestRevision = svc.latestReadyRevision.split('/').pop() ?? undefined;
      }
    }

    // Set IAM policy for unauthenticated access if needed
    if (config.allowUnauthenticated) {
      console.log(`[Deploy]   Setting IAM policy: allUsers → run.invoker for ${serviceName}`);
      const iamUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}:setIamPolicy`;
      const iamRes = await gcpFetch(iamUrl, {
        method: 'POST',
        body: JSON.stringify({
          policy: {
            bindings: [
              {
                role: 'roles/run.invoker',
                members: ['allUsers'],
              },
            ],
          },
        }),
      });
      if (!iamRes.ok) {
        const iamErr = await iamRes.text();
        console.error(`[Deploy]   IAM policy failed (${iamRes.status}): ${iamErr}`);
        // Don't throw — service is deployed, just not public yet
      } else {
        console.log(`[Deploy]   IAM policy set: public access enabled`);
      }
    }

    return {
      success: true,
      serviceUrl,
      serviceName,
      error: null,
      duration: Date.now() - start,
      revisionName: latestRevision,
      imageUri,
    };
  } catch (err) {
    return {
      success: false,
      serviceUrl: null,
      serviceName,
      error: (err as Error).message,
      duration: Date.now() - start,
    };
  }
}

// ─── Preview deploy ───

export async function deployPreview(
  config: DeployConfig,
  imageUri: string
): Promise<DeployResult> {
  const previewConfig = {
    ...config,
    projectSlug: `${config.projectSlug}-preview`,
    maxInstances: 1,
    minInstances: 0,
  };
  return deployToCloudRun(previewConfig, imageUri);
}

// ─── Delete Cloud Run service ───

/**
 * Round 13: this used to return `void` and silently log errors. That was a
 * lie to callers — `await deleteService(...)` looked like it succeeded
 * even when the GCP DELETE returned 5xx, leading stopProjectService to
 * proceed with DB updates that ended up describing a service that was in
 * fact still alive (or vice versa). Now returns a structured result so
 * callers can branch on it.
 *
 *   ok: true                   → service is GONE (either DELETE 2xx or 404 already-gone)
 *   ok: false                  → service may or may not still exist; do NOT touch DB state
 *   alreadyGone: true          → GCP returned 404 (idempotent stop)
 *   httpStatus / error         → for logging
 */
export interface DeleteServiceResult {
  ok: boolean;
  alreadyGone: boolean;
  httpStatus: number | null;
  error: string | null;
}

export async function deleteService(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string
): Promise<DeleteServiceResult> {
  try {
    const url = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;
    const res = await gcpFetch(url, { method: 'DELETE' });
    if (res.status === 404) {
      console.log(`  Cloud Run service already gone: ${serviceName}`);
      return { ok: true, alreadyGone: true, httpStatus: 404, error: null };
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`Failed to delete service ${serviceName}: HTTP ${res.status} ${errBody.slice(0, 200)}`);
      return { ok: false, alreadyGone: false, httpStatus: res.status, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }
    console.log(`  Deleted Cloud Run service: ${serviceName}`);
    return { ok: true, alreadyGone: false, httpStatus: res.status, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`Failed to delete service ${serviceName}:`, msg);
    return { ok: false, alreadyGone: false, httpStatus: null, error: msg };
  }
}

// ─── Rollback Cloud Run service ───

export async function rollbackService(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    const parent = `projects/${gcpProject}/locations/${gcpRegion}`;

    // List revisions
    const listUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}/revisions?pageSize=2`;
    const listRes = await gcpFetch(listUrl);
    if (!listRes.ok) throw new Error(`List revisions failed: HTTP ${listRes.status}`);

    const listData = await listRes.json() as { revisions?: { name: string }[] };
    const revisions = listData.revisions ?? [];
    if (revisions.length < 2) {
      return { success: false, error: 'No previous revision to roll back to' };
    }

    // Update traffic to previous revision
    const previousRevision = revisions[1].name.split('/').pop()!;
    const svcUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}`;
    const patchRes = await gcpFetch(svcUrl, {
      method: 'PATCH',
      body: JSON.stringify({
        traffic: [{
          type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
          revision: previousRevision,
          percent: 100,
        }],
      }),
    });

    if (!patchRes.ok) {
      const err = await patchRes.text();
      throw new Error(`Traffic update failed: ${err}`);
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Versioning: publish a specific revision (route 100% traffic) ───

export async function publishRevision(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  revisionName: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    const svcUrl = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}?updateMask=traffic`;
    // First, get the current service to preserve the template
    const getRes = await gcpFetch(`https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`);
    if (!getRes.ok) throw new Error(`Failed to get service: ${getRes.status}`);
    const currentService = await getRes.json() as Record<string, unknown>;
    // Update only the traffic field, keep the existing template
    const res = await gcpFetch(svcUrl, {
      method: 'PATCH',
      body: JSON.stringify({
        ...currentService,
        traffic: [{
          type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
          revision: revisionName,
          percent: 100,
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Traffic update failed (${res.status}): ${err}`);
    }
    // Wait for operation to complete
    const op = await res.json() as { name: string; done?: boolean };
    if (!op.done && op.name) {
      const opUrl = `https://run.googleapis.com/v2/${op.name}`;
      const maxWait = 60_000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        await sleep(3000);
        const opRes = await gcpFetch(opUrl);
        if (!opRes.ok) break;
        const opData = await opRes.json() as { done?: boolean; error?: { message: string } };
        if (opData.done) {
          if (opData.error) throw new Error(opData.error.message);
          break;
        }
      }
    }
    console.log(`[Deploy]   Published revision ${revisionName} for ${serviceName} (100% traffic)`);
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Read live traffic state from Cloud Run ───

/**
 * Fetch current traffic state for a service. Used by the reconciler to detect
 * Cloud-Run/DB split state (round 9 introduced the possibility: publishRevision
 * succeeds but publishDeployment fails, leaving Cloud Run serving one revision
 * while the DB says another is published).
 *
 * Cloud Run v2 exposes two fields:
 *   - `traffic`        — the *desired* allocation (set via PATCH)
 *   - `trafficStatuses` — the *observed* allocation (what's actually serving)
 *
 * For split detection we want trafficStatuses (actual truth on the wire). When
 * a PATCH is in flight or rejected, the two diverge. trafficStatuses is what
 * users hit; that's what matters.
 *
 * Returns null on any failure — caller should treat null as "unknown, skip the
 * check this round" rather than as authoritative state.
 */
export async function getServiceLiveTraffic(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string
): Promise<{
  /** Revision currently serving 100% of traffic, or null if traffic is split / no statuses returned. */
  liveRevision: string | null;
  /** Raw trafficStatuses array, in case caller wants to inspect splits. */
  statuses: Array<{ revision?: string; percent?: number; type?: string; tag?: string }>;
} | null> {
  try {
    const url = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;
    const res = await gcpFetch(url);
    if (!res.ok) return null;
    const svc = (await res.json()) as {
      trafficStatuses?: Array<{ revision?: string; percent?: number; type?: string; tag?: string }>;
    };
    const statuses = svc.trafficStatuses ?? [];
    // Find the revision with 100% traffic. Cloud Run reports tagged-but-zero-traffic
    // routes alongside the live one; we want the single 100% serving revision.
    const live = statuses.find((t) => (t.percent ?? 0) === 100 && t.revision);
    return {
      liveRevision: live?.revision ?? null,
      statuses,
    };
  } catch (err) {
    console.warn(
      `[Deploy]   getServiceLiveTraffic(${serviceName}) failed: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── Tag a revision for preview URL (v3---service.a.run.app) ───

export async function tagRevision(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  revisionName: string,
  tag: string
): Promise<{ success: boolean; taggedUrl: string | null; error: string | null }> {
  try {
    const svcPath = `projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;

    // Get current service (need existing traffic + URI)
    const getRes = await gcpFetch(`https://run.googleapis.com/v2/${svcPath}`);
    if (!getRes.ok) throw new Error(`Failed to get service: ${getRes.status}`);
    const currentService = await getRes.json() as {
      uri?: string;
      traffic?: Array<{ type?: string; revision?: string; percent?: number; tag?: string }>;
      [key: string]: unknown;
    };

    // Build traffic: keep existing 100% route, add 0% tagged route
    const existingTraffic = (currentService.traffic ?? [])
      .filter((t) => (t.percent ?? 0) > 0)
      .map((t) => {
        if (t.revision) {
          return {
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' as const,
            revision: t.revision,
            percent: t.percent,
          };
        }
        // latestRevision=true style → convert to LATEST
        return {
          type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' as const,
          percent: t.percent,
        };
      });

    const newTraffic = [
      ...existingTraffic,
      {
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' as const,
        revision: revisionName,
        percent: 0,
        tag,
      },
    ];

    const patchUrl = `https://run.googleapis.com/v2/${svcPath}?updateMask=traffic`;
    const res = await gcpFetch(patchUrl, {
      method: 'PATCH',
      body: JSON.stringify({ ...currentService, traffic: newTraffic }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Tag revision failed (${res.status}): ${err}`);
    }

    // Construct tagged URL: https://<tag>---<service-host>
    const serviceUri = currentService.uri ?? '';
    const taggedUrl = serviceUri
      ? serviceUri.replace('https://', `https://${tag}---`)
      : null;

    console.log(`[Deploy]   Tagged revision ${revisionName} as "${tag}" → ${taggedUrl}`);
    return { success: true, taggedUrl, error: null };
  } catch (err) {
    console.error(`[Deploy]   Tag revision failed:`, (err as Error).message);
    return { success: false, taggedUrl: null, error: (err as Error).message };
  }
}

// ─── Delete a Cloud Run revision ───

export async function deleteRevision(
  gcpProject: string,
  gcpRegion: string,
  revisionName: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    const url = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/-/revisions/${revisionName}`;
    const res = await gcpFetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`Delete revision failed (${res.status}): ${err}`);
    }
    console.log(`[Deploy]   Deleted revision: ${revisionName}`);
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Versioning: list Cloud Run revisions for a service ───

export interface RevisionInfo {
  name: string;           // Short name: "da-myapp-00003-abc"
  fullName: string;       // Full resource path
  image: string;          // Container image URI
  createTime: string;
  ready: boolean;
  trafficPercent: number; // 0-100
}

export async function listCloudRunRevisions(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  limit = 20
): Promise<RevisionInfo[]> {
  const parent = `projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;

  // Get service to read traffic routing
  const svcUrl = `https://run.googleapis.com/v2/${parent}`;
  const svcRes = await gcpFetch(svcUrl);
  const trafficMap = new Map<string, number>();
  if (svcRes.ok) {
    const svc = await svcRes.json() as {
      traffic?: Array<{ revision?: string; percent?: number }>;
      trafficStatuses?: Array<{ revision?: string; percent?: number }>;
    };
    for (const t of (svc.trafficStatuses ?? svc.traffic ?? [])) {
      if (t.revision) {
        const short = t.revision.split('/').pop()!;
        trafficMap.set(short, t.percent ?? 0);
      }
    }
  }

  // List revisions
  const listUrl = `https://run.googleapis.com/v2/${parent}/revisions?pageSize=${limit}`;
  const listRes = await gcpFetch(listUrl);
  if (!listRes.ok) return [];

  const data = await listRes.json() as {
    revisions?: Array<{
      name: string;
      containers?: Array<{ image?: string }>;
      createTime?: string;
      conditions?: Array<{ type?: string; state?: string }>;
    }>;
  };

  return (data.revisions ?? []).map((r) => {
    const shortName = r.name.split('/').pop()!;
    const ready = r.conditions?.some(
      (c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED'
    ) ?? false;
    return {
      name: shortName,
      fullName: r.name,
      image: r.containers?.[0]?.image ?? '',
      createTime: r.createTime ?? '',
      ready,
      trafficPercent: trafficMap.get(shortName) ?? 0,
    };
  });
}

// ─── Delete domain mapping ───

export async function deleteDomainMapping(
  gcpProject: string,
  gcpRegion: string,
  domain: string
): Promise<void> {
  try {
    // Cloud Run v1 API for domain mappings (v2 doesn't support them yet)
    const url = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
    const res = await gcpFetch(url, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      console.log(`  Deleted domain mapping: ${domain}`);
    } else {
      const err = await res.text();
      console.error(`  Failed to delete domain mapping ${domain}: ${err}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) {
      console.log(`  Domain mapping ${domain} not found (already deleted)`);
    } else {
      console.error(`  Failed to delete domain mapping ${domain}:`, msg);
    }
  }
}

// ─── Delete container image ───

export async function deleteContainerImage(
  gcpProject: string,
  gcpRegion: string,
  imageName: string
): Promise<void> {
  const repo = `projects/${gcpProject}/locations/${gcpRegion}/repositories/deploy-agent`;
  const pkg = `${repo}/packages/${imageName}`;
  try {
    // Delete the entire package (all tags/versions)
    const url = `https://artifactregistry.googleapis.com/v1/${pkg}`;
    const res = await gcpFetch(url, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      console.log(`  Deleted container image: ${imageName}`);
    } else {
      const err = await res.text();
      console.error(`  Failed to delete image ${imageName}: ${err}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) {
      console.log(`  Image ${imageName} not found (already deleted)`);
    } else {
      console.error(`  Failed to delete image ${imageName}:`, msg);
    }
  }
}

// ─── Custom domain setup (Cloud Run domain mapping via v1 API) ───

export async function setupCustomDomain(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  domain: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    const url = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings`;
    const res = await gcpFetch(url, {
      method: 'POST',
      body: JSON.stringify({
        apiVersion: 'domains.cloudrun.com/v1',
        kind: 'DomainMapping',
        metadata: {
          name: domain,
          namespace: gcpProject,
        },
        spec: {
          routeName: serviceName,
        },
      }),
    });

    if (res.ok) {
      return { success: true, error: null };
    }

    const body = await res.text();
    // Already mapped is not an error
    if (body.includes('already mapped') || body.includes('already exists') || res.status === 409) {
      return { success: true, error: null };
    }
    return { success: false, error: `HTTP ${res.status}: ${body}` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Update env vars on an existing Cloud Run service (no rebuild) ───

export async function updateServiceEnvVars(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  envVars: Record<string, string>,
): Promise<{ success: boolean; error: string | null }> {
  try {
    const parent = `projects/${gcpProject}/locations/${gcpRegion}`;
    const serviceUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}`;

    // 1. GET existing service spec
    const getRes = await gcpFetch(serviceUrl);
    if (!getRes.ok) {
      const err = await getRes.text();
      throw new Error(`Failed to get service ${serviceName} (${getRes.status}): ${err}`);
    }

    const service = await getRes.json() as {
      template: {
        containers: Array<{
          image: string;
          env?: Array<{ name: string; value: string }>;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };

    // 2. Extract current container spec
    const container = service.template?.containers?.[0];
    if (!container) {
      throw new Error(`Service ${serviceName} has no containers in its template`);
    }

    // 3. Merge new env vars with existing ones (new values override)
    const existingEnv: Record<string, string> = {};
    for (const entry of container.env ?? []) {
      existingEnv[entry.name] = entry.value;
    }
    const mergedEnv = { ...existingEnv, ...envVars };
    container.env = Object.entries(mergedEnv).map(([name, value]) => ({ name, value }));

    // 4. PATCH the service with updated template only
    const patchRes = await gcpFetch(serviceUrl, {
      method: 'PATCH',
      body: JSON.stringify({ template: service.template }),
    });

    if (!patchRes.ok) {
      const err = await patchRes.text();
      throw new Error(`Failed to update env vars on ${serviceName} (${patchRes.status}): ${err}`);
    }

    const op = await patchRes.json() as { name: string };
    const operationUrl = `https://run.googleapis.com/v2/${op.name}`;

    // 5. Poll the operation until done
    const maxWait = 3 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await sleep(3000);
      const opRes = await gcpFetch(operationUrl);
      if (!opRes.ok) break;
      const opData = await opRes.json() as { done?: boolean; error?: { message: string } };
      if (opData.done) {
        if (opData.error) {
          throw new Error(`Operation failed: ${opData.error.message}`);
        }
        break;
      }
    }

    console.log(`[Deploy] Updated env vars on ${serviceName}: ${Object.keys(envVars).join(', ')}`);
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Read env vars from a live Cloud Run service (values returned as-is). */
export async function getServiceEnvVars(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
): Promise<Record<string, string>> {
  const parent = `projects/${gcpProject}/locations/${gcpRegion}`;
  const serviceUrl = `https://run.googleapis.com/v2/${parent}/services/${serviceName}`;

  const res = await gcpFetch(serviceUrl);
  if (!res.ok) return {};

  const service = await res.json() as {
    template?: {
      containers?: Array<{ env?: Array<{ name: string; value?: string }> }>;
    };
  };

  const env: Record<string, string> = {};
  for (const entry of service.template?.containers?.[0]?.env ?? []) {
    if (entry.name && entry.value !== undefined) {
      env[entry.name] = entry.value;
    }
  }
  return env;
}

// Returns the image URI currently running on a Cloud Run service, or null
// if the service doesn't exist.
export async function getServiceImage(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
): Promise<string | null> {
  const serviceUrl = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;
  const res = await gcpFetch(serviceUrl);
  if (!res.ok) return null;
  const service = await res.json() as {
    template?: { containers?: Array<{ image?: string }> };
  };
  return service.template?.containers?.[0]?.image ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Pre-flight check builder ───
//
// 回傳要塞在 docker build 之前的 Cloud Build step。目的是「TS 錯誤 fail fast」：
// 跑 tsc --noEmit，錯誤就只是幾行 stderr 丟進 log bucket，比塞在 next build 裡
// 乾淨得多。LLM + source-reader 拿到乾淨 stderr 就能直接指出「src/app/x.ts:47」
// 具體哪一行要改。
//
// 只對 TS 專案啟用，且必須確認 `typescript` 是專案 dep（免得 npx 去遠端拉）。
// 不是 TS 專案或 preflight 未設定就回 empty array，等於沒事發生。
function buildPreflightSteps(
  preflight?: DeployConfig['preflight'],
): Array<Record<string, unknown>> {
  if (!preflight || preflight.language !== 'typescript' || !preflight.hasTypescript) {
    return [];
  }

  // Pick install command by package manager. Use frozen-lockfile equivalents
  // so the pre-flight doesn't accidentally drift from docker build's lockfile.
  let installCmd: string;
  let image: string;
  switch (preflight.packageManager) {
    case 'bun':
      image = 'oven/bun:1';
      installCmd = 'bun install --frozen-lockfile';
      break;
    case 'pnpm':
      image = 'node:22-alpine';
      // pnpm isn't in the base node image; enable via corepack
      installCmd = 'corepack enable && pnpm install --frozen-lockfile';
      break;
    case 'yarn':
      image = 'node:22-alpine';
      installCmd = 'corepack enable && yarn install --frozen-lockfile';
      break;
    case 'npm':
    default:
      image = 'node:22-alpine';
      installCmd = 'npm ci --prefer-offline --no-audit --loglevel=error';
      break;
  }

  // Use `npx --no-install tsc` so if typescript isn't installed it fails
  // loudly rather than silently fetching from npm.
  const tscCmd = preflight.packageManager === 'bun'
    ? 'bun x --bun tsc --noEmit'
    : 'npx --no-install tsc --noEmit';

  return [
    {
      name: image,
      entrypoint: 'sh',
      args: ['-c', `set -e; echo "── wave-deploy-agent pre-flight: install + tsc ──"; ${installCmd}; echo "── tsc --noEmit ──"; ${tscCmd}`],
      id: 'preflight-tsc',
    },
  ];
}
