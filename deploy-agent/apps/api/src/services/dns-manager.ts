// Cloudflare DNS + Cloud Run domain mapping
// Flow: Deploy to Cloud Run → domain mapping (ghs.googlehosted.com) → CNAME in Cloudflare

import { gcpFetch } from './gcp-auth';
import {
  buildDomainSetupVerdict,
  verdictToSetupResult,
  type CleanupOutcome,
  type DnsOutcome as VerdictDnsOutcome,
  type MappingOutcome,
} from './domain-setup-verdict';

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface DnsConfig {
  cloudflareToken: string;
  zoneId: string;
  subdomain: string;    // e.g. "kol-studio"
  zoneName: string;     // e.g. "punwave.com"
}

export interface DnsResult {
  success: boolean;
  fqdn: string;         // e.g. "kol-studio.punwave.com"
  recordId: string | null;
  error: string | null;
}

interface CfResponse<T = unknown> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

async function cfFetch<T = unknown>(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<CfResponse<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res.json() as Promise<CfResponse<T>>;
}

// ─── List zones accessible by token ───

export async function listZones(token: string): Promise<{ id: string; name: string }[]> {
  const data = await cfFetch<{ id: string; name: string }[]>('/zones', token);
  if (!data.success) throw new Error(`Cloudflare zones error: ${data.errors[0]?.message}`);
  return data.result;
}

// ─── Find existing DNS record ───

async function findRecord(
  config: DnsConfig,
  fqdn: string
): Promise<{ id: string; content: string } | null> {
  const data = await cfFetch<{ id: string; content: string }[]>(
    `/zones/${config.zoneId}/dns_records?type=CNAME&name=${fqdn}`,
    config.cloudflareToken
  );
  if (!data.success || data.result.length === 0) return null;
  return data.result[0];
}

// ─── Create or update CNAME record (DNS-only, no proxy) ───

export async function upsertCname(
  config: DnsConfig,
  target: string,
  proxied = false
): Promise<DnsResult> {
  const fqdn = `${config.subdomain}.${config.zoneName}`;

  try {
    const existing = await findRecord(config, fqdn);

    if (existing) {
      if (existing.content === target) {
        console.log(`  DNS: ${fqdn} already points to ${target}`);
        return { success: true, fqdn, recordId: existing.id, error: null };
      }

      const data = await cfFetch<{ id: string }>(
        `/zones/${config.zoneId}/dns_records/${existing.id}`,
        config.cloudflareToken,
        {
          method: 'PATCH',
          body: JSON.stringify({
            type: 'CNAME',
            name: config.subdomain,
            content: target,
            proxied,
            ttl: 1,
          }),
        }
      );
      if (!data.success) {
        return { success: false, fqdn, recordId: null, error: data.errors[0]?.message ?? 'Update failed' };
      }
      console.log(`  DNS: Updated ${fqdn} → ${target}`);
      return { success: true, fqdn, recordId: data.result.id, error: null };
    }

    const data = await cfFetch<{ id: string }>(
      `/zones/${config.zoneId}/dns_records`,
      config.cloudflareToken,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'CNAME',
          name: config.subdomain,
          content: target,
          proxied,
          ttl: 1,
        }),
      }
    );
    if (!data.success) {
      return { success: false, fqdn, recordId: null, error: data.errors[0]?.message ?? 'Create failed' };
    }
    console.log(`  DNS: Created ${fqdn} → ${target}`);
    return { success: true, fqdn, recordId: data.result.id, error: null };
  } catch (err) {
    return { success: false, fqdn, recordId: null, error: (err as Error).message };
  }
}

// ─── Delete DNS record ───

export async function deleteCname(config: DnsConfig): Promise<{ success: boolean; error: string | null }> {
  const fqdn = `${config.subdomain}.${config.zoneName}`;
  try {
    const existing = await findRecord(config, fqdn);
    if (!existing) {
      return { success: true, error: null };
    }

    const data = await cfFetch(
      `/zones/${config.zoneId}/dns_records/${existing.id}`,
      config.cloudflareToken,
      { method: 'DELETE' }
    );
    if (!data.success) {
      return { success: false, error: data.errors[0]?.message ?? 'Delete failed' };
    }
    console.log(`  DNS: Deleted ${fqdn}`);
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Cloud Run domain mapping ───

/**
 * Look up an existing domain mapping. Returns the routeName it points to,
 * or null if no mapping exists for this domain.
 */
async function getDomainMapping(
  gcpProject: string,
  gcpRegion: string,
  domain: string
): Promise<{ routeName: string | null; exists: boolean }> {
  const url = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
  const res = await gcpFetch(url);
  if (res.status === 404) return { routeName: null, exists: false };
  if (!res.ok) return { routeName: null, exists: false };
  const body = await res.json() as { spec?: { routeName?: string } };
  return { routeName: body.spec?.routeName ?? null, exists: true };
}

async function createDomainMapping(
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  domain: string,
  opts: { force?: boolean } = {}
): Promise<{ success: boolean; error: string | null; conflict?: { existingRoute: string } }> {
  try {
    // Pre-check: is this domain already mapped to a different service?
    const existing = await getDomainMapping(gcpProject, gcpRegion, domain);
    if (existing.exists && existing.routeName && existing.routeName !== serviceName) {
      if (!opts.force) {
        return {
          success: false,
          error: `Domain ${domain} is already mapped to service "${existing.routeName}". ` +
                 `Pass force=true to replace with "${serviceName}".`,
          conflict: { existingRoute: existing.routeName },
        };
      }
      // Force: delete the old mapping first
      console.log(`  [domain] Force-replacing ${domain}: ${existing.routeName} → ${serviceName}`);
      const deleteUrl = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
      const delRes = await gcpFetch(deleteUrl, { method: 'DELETE' });
      if (!delRes.ok && delRes.status !== 404) {
        const body = await delRes.text();
        return { success: false, error: `Failed to delete existing mapping: HTTP ${delRes.status}: ${body}` };
      }
    } else if (existing.exists && existing.routeName === serviceName) {
      // Already mapped to the same service — nothing to do
      return { success: true, error: null };
    }

    const url = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings`;
    const res = await gcpFetch(url, {
      method: 'POST',
      body: JSON.stringify({
        apiVersion: 'domains.cloudrun.com/v1',
        kind: 'DomainMapping',
        metadata: { name: domain, namespace: gcpProject },
        spec: { routeName: serviceName },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (body.includes('already mapped') || body.includes('already exists') || res.status === 409) {
        return { success: true, error: null };
      }
      return { success: false, error: `HTTP ${res.status}: ${body}` };
    }

    // Mapping created — but check conditions for async errors like PermissionDenied.
    // GCP returns 200 even when domain ownership isn't verified; the failure shows
    // up as a condition on the mapping object.
    try {
      // Brief delay to let GCP populate conditions
      await new Promise(r => setTimeout(r, 3000));
      const checkUrl = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
      const checkRes = await gcpFetch(checkUrl);
      if (checkRes.ok) {
        const mapping = await checkRes.json() as {
          status?: { conditions?: Array<{ type: string; status: string; reason?: string; message?: string }> }
        };
        const conditions = mapping.status?.conditions ?? [];
        const denied = conditions.find(c => c.reason === 'PermissionDenied');
        if (denied) {
          // Clean up the broken mapping. We don't fail the parent flow if this
          // DELETE fails — the caller already returns success:false with a
          // user-actionable error — but we DO want to log it. A silent .catch(() => {})
          // here would hide a slow leak: every retry leaves a stale broken
          // mapping behind, eventually exhausting the GCP project's domain-mapping
          // quota or — worse — leaving DNS pointing at a stale Cloud Run service.
          const deleteUrl = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
          await gcpFetch(deleteUrl, { method: 'DELETE' }).catch(err => {
            console.warn(
              `[dns-manager] failed to clean up broken domain mapping for ${domain}: ${(err as Error).message}`,
            );
          });
          return {
            success: false,
            error: `Domain ownership not verified: ${domain}. Verify ownership of "${domain.split('.').slice(-2).join('.')}" in Google Search Console (https://search.google.com/search-console), then re-deploy.`,
          };
        }
      }
    } catch {
      // Non-fatal: if we can't check conditions, proceed optimistically
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Full custom domain setup ───
// 1. Cloud Run domain mapping → tells GCP to accept traffic for this hostname
// 2. Cloudflare CNAME → ghs.googlehosted.com (Google's domain mapping endpoint)
// 3. Google provisions SSL cert automatically

/**
 * Best-effort cleanup of an orphan Cloud Run domain mapping. Called when
 * Cloud Run mapping succeeded but Cloudflare DNS subsequently failed —
 * leaving the mapping pointing at a domain with no CNAME record.
 *
 * Returns ok=true iff the DELETE succeeded or the mapping was already gone
 * (404). Any other failure is captured in the error field; the caller can
 * surface it to the operator via the dns-failed-after-mapping verdict's
 * cleanupError, errorCode='domain_mapping_orphan' and
 * requiresManualCleanup=true.
 */
async function cleanupOrphanMapping(
  gcpProject: string,
  gcpRegion: string,
  domain: string
): Promise<CleanupOutcome> {
  try {
    const url = `https://${gcpRegion}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${gcpProject}/domainmappings/${domain}`;
    const res = await gcpFetch(url, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      return { ok: true, error: null };
    }
    const body = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${body}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function setupCustomDomainWithDns(
  config: DnsConfig,
  _cloudRunUrl: string,
  gcpProject: string,
  gcpRegion: string,
  serviceName: string,
  opts: { force?: boolean } = {}
): Promise<{ success: boolean; customUrl: string; error: string | null; conflict?: { existingRoute: string } }> {
  const fqdn = `${config.subdomain}.${config.zoneName}`;

  console.log(`\n  Setting up custom domain: ${fqdn}`);

  // Step 1: Cloud Run domain mapping (with conflict detection).
  // Capture as MappingOutcome so the verdict planner sees a structured shape
  // rather than the legacy {success, error, conflict?} ad-hoc object.
  console.log('  Step 1: Cloud Run domain mapping...');
  const mappingResult = await createDomainMapping(gcpProject, gcpRegion, serviceName, fqdn, opts);
  const mappingOutcome: MappingOutcome = {
    ok: mappingResult.success,
    error: mappingResult.error,
    conflict: mappingResult.conflict ?? null,
  };

  if (!mappingOutcome.ok) {
    // Fail fast — nothing was created on GCP, no cleanup needed.
    const verdict = buildDomainSetupVerdict({
      fqdn,
      mapping: mappingOutcome,
      dns: null,
      cleanup: null,
    });
    console.warn(`  [domain-setup] ${verdict.kind}: ${verdict.message}`);
    return verdictToSetupResult(verdict);
  }
  console.log('  Domain mapping: OK');

  // Step 2: Cloudflare CNAME → ghs.googlehosted.com (DNS-only, no proxy).
  // Cloud Run handles SSL via managed Google certs. Cloudflare proxy must
  // be OFF so Google can verify domain ownership and provision the cert.
  console.log('  Step 2: Cloudflare CNAME → ghs.googlehosted.com...');
  const dnsResult = await upsertCname(config, 'ghs.googlehosted.com', false);
  const dnsOutcome: VerdictDnsOutcome = {
    ok: dnsResult.success,
    fqdn: dnsResult.fqdn,
    recordId: dnsResult.recordId,
    error: dnsResult.error,
  };

  if (!dnsOutcome.ok) {
    // Mapping succeeded but DNS failed → ORPHAN. Best-effort cleanup of
    // the mapping. Whether or not the cleanup succeeds, we surface it via
    // the verdict so the operator (or dashboard) knows what happened.
    console.warn(
      `  [domain-setup] DNS failed for ${fqdn} after mapping succeeded. ` +
      `Attempting cleanup of orphan Cloud Run mapping...`
    );
    const cleanup = await cleanupOrphanMapping(gcpProject, gcpRegion, fqdn);
    if (cleanup.ok) {
      console.warn(`  [domain-setup] Orphan mapping cleanup: OK. Safe to retry.`);
    } else {
      console.error(
        `  [domain-setup] CRITICAL: Orphan mapping cleanup FAILED for ${fqdn}: ${cleanup.error}. ` +
        `Manual cleanup required (Cloud Run console > Domain mappings > delete ${fqdn}).`
      );
    }

    const verdict = buildDomainSetupVerdict({
      fqdn,
      mapping: mappingOutcome,
      dns: dnsOutcome,
      cleanup,
    });
    return verdictToSetupResult(verdict);
  }

  // Both succeeded.
  console.log(`  ${fqdn} → ghs.googlehosted.com (DNS-only, SSL by Google managed cert)`);
  console.log('  Note: SSL cert provisioning takes 5-15 minutes on first setup');

  const verdict = buildDomainSetupVerdict({
    fqdn,
    mapping: mappingOutcome,
    dns: dnsOutcome,
    cleanup: null,
  });
  return verdictToSetupResult(verdict);
}
