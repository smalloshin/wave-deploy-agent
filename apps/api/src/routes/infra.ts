// Infra overview — GCP resource health for the agent itself.
//
// Read-only + one manual "cleanup orphans" trigger. Lifecycle policies handle
// time-based cleanup; this endpoint handles "project was deleted but its
// GCS tarball / AR package still exists" case.

import type { FastifyInstance } from 'fastify';
import { gcpFetch } from '../services/gcp-auth';
import { listProjects } from '../services/orchestrator';

const GCP_PROJECT = process.env.GCP_PROJECT || 'wave-deploy-agent';
const GCP_REGION = process.env.GCP_REGION || 'asia-east1';
const AR_REPO = 'deploy-agent';
const GCS_BUCKET = process.env.CLOUD_BUILD_BUCKET || `${GCP_PROJECT}_cloudbuild`;
const GCS_SOURCES_PREFIX = 'sources/';

// Packages that belong to the agent itself (never treat as orphans)
const AGENT_OWN_PACKAGES = new Set(['api', 'web']);

interface ArObject {
  name: string;          // full resource name
  sizeBytes?: string;
  updateTime?: string;
  createTime?: string;
  tags?: string[];
}

interface ArPackage {
  name: string;          // full resource name: projects/.../packages/<pkg>
  createTime?: string;
  updateTime?: string;
}

interface GcsObject {
  name: string;
  size?: string;
  timeCreated?: string;
}

interface CloudRunService {
  name: string;
  uri?: string;
  terminalCondition?: { type: string; state: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractSlugFromTarball(objectName: string): string | null {
  // sources/<slug>-<timestamp>.tgz
  const base = objectName.replace(GCS_SOURCES_PREFIX, '').replace(/\.tgz$/, '');
  const m = base.match(/^(.+)-\d+$/);
  return m ? m[1] : null;
}

function shortName(fullResourceName: string): string {
  const parts = fullResourceName.split('/');
  return parts[parts.length - 1];
}

async function fetchAllPages<T>(
  url: string,
  itemsKey: string,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const u = pageToken
      ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${pageToken}`
      : url;
    const res = await gcpFetch(u);
    if (!res.ok) throw new Error(`GCP API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const items = (data[itemsKey] as T[]) ?? [];
    out.push(...items);
    pageToken = data.nextPageToken as string | undefined;
  } while (pageToken);
  return out;
}

// ─── Collectors ──────────────────────────────────────────────────────

async function getArtifactRegistry() {
  const repoName = `projects/${GCP_PROJECT}/locations/${GCP_REGION}/repositories/${AR_REPO}`;
  const repoUrl = `https://artifactregistry.googleapis.com/v1/${repoName}`;

  // Repo details (sizeBytes + cleanupPolicies)
  const repoRes = await gcpFetch(repoUrl);
  if (!repoRes.ok) throw new Error(`AR repo fetch ${repoRes.status}: ${await repoRes.text()}`);
  const repo = (await repoRes.json()) as {
    sizeBytes?: string;
    cleanupPolicies?: Record<string, unknown>;
  };

  // List packages
  const packagesUrl = `https://artifactregistry.googleapis.com/v1/${repoName}/packages?pageSize=200`;
  const packages = await fetchAllPages<ArPackage>(packagesUrl, 'packages');

  // Per-package version count (parallel)
  const withCounts = await Promise.all(
    packages.map(async (pkg) => {
      const versionsUrl = `https://artifactregistry.googleapis.com/v1/${pkg.name}/versions?pageSize=100`;
      try {
        const versions = await fetchAllPages<ArObject>(versionsUrl, 'versions');
        return {
          name: shortName(pkg.name),
          fullName: pkg.name,
          versionCount: versions.length,
          updateTime: pkg.updateTime ?? null,
        };
      } catch {
        return { name: shortName(pkg.name), fullName: pkg.name, versionCount: 0, updateTime: null };
      }
    }),
  );

  return {
    repoName: AR_REPO,
    region: GCP_REGION,
    sizeBytes: Number(repo.sizeBytes ?? 0),
    cleanupPolicyCount: Object.keys(repo.cleanupPolicies ?? {}).length,
    packages: withCounts.sort((a, b) => b.versionCount - a.versionCount),
  };
}

async function getGcsSources() {
  // Bucket metadata + lifecycle
  const bucketUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}?fields=lifecycle`;
  const bucketRes = await gcpFetch(bucketUrl);
  if (!bucketRes.ok) throw new Error(`GCS bucket ${bucketRes.status}: ${await bucketRes.text()}`);
  const bucket = (await bucketRes.json()) as {
    lifecycle?: { rule?: Array<unknown> };
  };

  // List objects under sources/
  const listUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o?prefix=${encodeURIComponent(GCS_SOURCES_PREFIX)}&fields=items(name,size,timeCreated),nextPageToken`;
  const objects = await fetchAllPages<GcsObject>(listUrl, 'items');

  const totalBytes = objects.reduce((s, o) => s + Number(o.size ?? 0), 0);

  return {
    bucket: GCS_BUCKET,
    prefix: GCS_SOURCES_PREFIX,
    objectCount: objects.length,
    totalBytes,
    lifecycleRuleCount: bucket.lifecycle?.rule?.length ?? 0,
    objects: objects.map((o) => ({
      name: o.name,
      sizeBytes: Number(o.size ?? 0),
      timeCreated: o.timeCreated ?? null,
      slug: extractSlugFromTarball(o.name),
    })),
  };
}

async function getCloudRunServices() {
  const parent = `projects/${GCP_PROJECT}/locations/${GCP_REGION}`;
  const url = `https://run.googleapis.com/v2/${parent}/services?pageSize=100`;
  const services = await fetchAllPages<CloudRunService & { uri?: string; updateTime?: string }>(url, 'services');

  return services
    .map((s) => ({
      name: shortName(s.name),
      url: s.uri ?? null,
      ready: s.terminalCondition?.state === 'CONDITION_SUCCEEDED',
      region: GCP_REGION,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Orphan detection ────────────────────────────────────────────────

async function findOrphans() {
  const [projects, arData, gcsData] = await Promise.all([
    listProjects(),
    getArtifactRegistry(),
    getGcsSources(),
  ]);
  const liveSlugs = new Set(projects.map((p) => p.slug));

  const orphanTarballs = gcsData.objects.filter(
    (o) => o.slug && !liveSlugs.has(o.slug),
  );
  const orphanPackages = arData.packages.filter(
    (p) => !AGENT_OWN_PACKAGES.has(p.name) && !liveSlugs.has(p.name),
  );

  return {
    orphanTarballs,
    orphanPackages,
    orphanTarballBytes: orphanTarballs.reduce((s, o) => s + o.sizeBytes, 0),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────

export async function infraRoutes(app: FastifyInstance) {
  // Check if a custom domain is already mapped to another Cloud Run service.
  // Used by the deploy form UI to warn before creating a conflicting mapping.
  //
  // Query: ?domain=luca-app.punwave.com (full FQDN)
  //        OR ?subdomain=luca-app&zone=punwave.com
  // Response:
  //   { available: true }                                     — no conflict
  //   { available: false, existingRoute: "da-luca-frontend" } — conflict
  app.get('/api/infra/check-domain', async (req, reply) => {
    const q = req.query as { domain?: string; subdomain?: string; zone?: string };
    let fqdn = q.domain?.trim() ?? '';
    if (!fqdn && q.subdomain && q.zone) {
      fqdn = `${q.subdomain.trim()}.${q.zone.trim()}`;
    }
    if (!fqdn) {
      return reply.status(400).send({ error: 'domain or (subdomain + zone) required' });
    }

    try {
      const url = `https://${GCP_REGION}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${GCP_PROJECT}/domainmappings/${fqdn}`;
      const res = await gcpFetch(url);
      if (res.status === 404) {
        return { available: true, fqdn };
      }
      if (!res.ok) {
        return reply.status(500).send({ error: `domain mapping lookup failed: HTTP ${res.status}` });
      }
      const body = await res.json() as { spec?: { routeName?: string } };
      const existingRoute = body.spec?.routeName ?? null;
      return {
        available: false,
        fqdn,
        existingRoute,
      };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Full overview (used by /infra page)
  app.get('/api/infra/overview', async (_req, reply) => {
    try {
      const [artifactRegistry, gcsSources, cloudRun, orphans] = await Promise.all([
        getArtifactRegistry(),
        getGcsSources(),
        getCloudRunServices(),
        findOrphans(),
      ]);
      return {
        artifactRegistry,
        gcsSources,
        cloudRun,
        orphans: {
          tarballCount: orphans.orphanTarballs.length,
          tarballBytes: orphans.orphanTarballBytes,
          packageCount: orphans.orphanPackages.length,
          tarballs: orphans.orphanTarballs.slice(0, 50),
          packages: orphans.orphanPackages.map((p) => ({ name: p.name, versionCount: p.versionCount })),
        },
      };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Dry-run orphan preview (no deletion)
  app.get('/api/infra/orphans', async (_req, reply) => {
    try {
      const orphans = await findOrphans();
      return {
        tarballs: orphans.orphanTarballs,
        tarballBytes: orphans.orphanTarballBytes,
        packages: orphans.orphanPackages.map((p) => ({ name: p.name, versionCount: p.versionCount })),
      };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Delete orphans (GCS tarballs + AR packages for projects no longer in DB)
  app.post('/api/infra/cleanup-orphans', async (_req, reply) => {
    try {
      const orphans = await findOrphans();
      const log: Array<{ kind: string; name: string; status: string }> = [];
      let freedBytes = 0;

      // Delete GCS tarballs
      for (const obj of orphans.orphanTarballs) {
        const url = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(obj.name)}`;
        try {
          const res = await gcpFetch(url, { method: 'DELETE' });
          if (res.ok || res.status === 404) {
            log.push({ kind: 'gcs_tarball', name: obj.name, status: 'ok' });
            freedBytes += obj.sizeBytes;
          } else {
            log.push({ kind: 'gcs_tarball', name: obj.name, status: `error: ${res.status}` });
          }
        } catch (err) {
          log.push({ kind: 'gcs_tarball', name: obj.name, status: `error: ${(err as Error).message}` });
        }
      }

      // Delete AR packages
      for (const pkg of orphans.orphanPackages) {
        const url = `https://artifactregistry.googleapis.com/v1/${pkg.fullName}`;
        try {
          const res = await gcpFetch(url, { method: 'DELETE' });
          if (res.ok || res.status === 404) {
            log.push({ kind: 'ar_package', name: pkg.name, status: 'ok' });
          } else {
            log.push({ kind: 'ar_package', name: pkg.name, status: `error: ${res.status}` });
          }
        } catch (err) {
          log.push({ kind: 'ar_package', name: pkg.name, status: `error: ${(err as Error).message}` });
        }
      }

      return {
        deletedTarballs: log.filter((l) => l.kind === 'gcs_tarball' && l.status === 'ok').length,
        deletedPackages: log.filter((l) => l.kind === 'ar_package' && l.status === 'ok').length,
        freedBytes,
        log,
      };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
