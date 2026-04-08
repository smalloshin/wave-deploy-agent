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
}

export interface DeployResult {
  success: boolean;
  serviceUrl: string | null;
  serviceName: string;
  error: string | null;
  duration: number;
}

// ─── Cloud Build: build and push image ───
// Accepts either a GCS URI (gs://bucket/object) or a local directory path.
// GCS URI is preferred since Cloud Run /tmp is ephemeral.

export async function buildAndPushImage(
  projectDir: string,
  config: DeployConfig,
  gcsSourceUri?: string,
): Promise<{ success: boolean; imageUri: string; error: string | null }> {
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

    // Trigger Cloud Build with GCS source
    const buildRequest = {
      source: {
        storageSource: {
          bucket: gcsBucket,
          object: gcsObject,
        },
      },
      steps: [
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
        return { success: true, imageUri, error: null };
      }
      if (status.status === 'FAILURE' || status.status === 'INTERNAL_ERROR' || status.status === 'TIMEOUT' || status.status === 'CANCELLED') {
        // Try to fetch build log for detailed error
        let detailMsg = status.statusDetail ?? 'no details';
        try {
          const logUrl = `https://cloudbuild.googleapis.com/v1/projects/${config.gcpProject}/builds/${buildId}`;
          const logRes = await gcpFetch(logUrl);
          if (logRes.ok) {
            const logData = await logRes.json() as { logUrl?: string; failureInfo?: { detail?: string; type?: string }; statusDetail?: string };
            if (logData.failureInfo?.detail) {
              detailMsg = logData.failureInfo.detail;
            } else if (logData.statusDetail) {
              detailMsg = logData.statusDetail;
            }
            if (logData.logUrl) {
              detailMsg += ` | Logs: ${logData.logUrl}`;
            }
          }
        } catch { /* ignore log fetch errors */ }
        throw new Error(`Cloud Build ${status.status}: ${detailMsg}`);
      }
      console.log(`[Deploy]   Cloud Build status: ${status.status}`);
    }

    throw new Error('Cloud Build timed out after 10 minutes');
  } catch (err) {
    return { success: false, imageUri, error: (err as Error).message };
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

    // Get service URL
    const svcRes = await gcpFetch(getUrl);
    let serviceUrl: string | null = null;
    if (svcRes.ok) {
      const svc = await svcRes.json() as { uri?: string };
      serviceUrl = svc.uri ?? null;
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

export async function deleteService(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string
): Promise<void> {
  try {
    const url = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${serviceName}`;
    const res = await gcpFetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      console.error(`Failed to delete service ${serviceName}: HTTP ${res.status}`);
    } else {
      console.log(`  Deleted Cloud Run service: ${serviceName}`);
    }
  } catch (err) {
    console.error(`Failed to delete service ${serviceName}:`, (err as Error).message);
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
        traffic: [{ revision: previousRevision, percent: 100 }],
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
