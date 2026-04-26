/**
 * setupCustomDomainWithDns verdict — round 17.
 *
 * Why this is its own file:
 *   setupCustomDomainWithDns in dns-manager.ts used to do two IO calls in
 *   sequence with NO cleanup if the second failed:
 *
 *     const mappingResult = await createDomainMapping(...);  // creates GCP
 *                                                            // domain mapping
 *     if (!mappingResult.success) {
 *       return { success: false, ... };
 *     }
 *
 *     const dnsResult = await upsertCname(config, 'ghs.googlehosted.com', false);
 *     if (!dnsResult.success) {
 *       return { success: false, ..., error: `DNS failed: ${dnsResult.error}` };
 *       // ^^^ BUG: Cloud Run domain mapping is now an ORPHAN.
 *     }
 *
 *   Failure mode silenced:
 *
 *     Cloud Run mapping created successfully → Cloudflare API call fails
 *     (token expired, zone misconfigured, rate limit, network blip, whatever).
 *     The Cloud Run domain mapping is now bound to the service, but no DNS
 *     CNAME points at ghs.googlehosted.com. The next time the operator
 *     retries:
 *       (a) createDomainMapping pre-check finds the existing mapping
 *           bound to this service → returns success (idempotent).
 *       (b) But if the operator switched services or the service was
 *           recreated, the pre-check finds the mapping bound to a DIFFERENT
 *           service → returns the conflict error
 *           "Domain X is already mapped to service Y. Pass force=true ..."
 *
 *     Either way the orphan eats domain-mapping quota and confuses dashboard
 *     state. Worse: if the operator never retries, the orphan leaks forever
 *     because we have no reconciler for domain mappings.
 *
 *   The fix mirrors the round 13/15/16 pattern: the planner returns a
 *   discriminated verdict, and the orchestrator (setupCustomDomainWithDns)
 *   captures each step's outcome, attempts cleanup of the orphan mapping
 *   when DNS fails after mapping, and asks the planner what verdict to
 *   return. Cleanup is best-effort — if we can't delete the orphan, the
 *   verdict carries enough information for the operator to do it manually
 *   and the errorCode lets the dashboard surface the drift.
 */

/** Outcome of step 1: createDomainMapping. */
export interface MappingOutcome {
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
  /** Conflict info when the existing mapping points at a different service.
   *  Carried through to the verdict so route-level callers can surface it
   *  as a structured field rather than parsing the error string. */
  conflict: { existingRoute: string } | null;
}

/** Outcome of step 2: upsertCname. */
export interface DnsOutcome {
  ok: boolean;
  /** FQDN we tried to write. */
  fqdn: string;
  /** Cloudflare record id when ok=true. */
  recordId: string | null;
  /** Error message when ok=false. */
  error: string | null;
}

/** Outcome of the best-effort cleanup attempted when DNS fails after mapping.
 *  null when cleanup wasn't attempted (because mapping never succeeded). */
export interface CleanupOutcome {
  /** True iff the orphan mapping was successfully deleted. */
  ok: boolean;
  /** Error message when ok=false (we couldn't clean up, the operator will
   *  have to). */
  error: string | null;
}

/**
 * Four verdict kinds matching the (mapping, dns, cleanup) outcome lattice:
 *
 *   1. `success` — mapping + dns both succeeded. Custom domain is live.
 *
 *   2. `mapping-failed` — createDomainMapping rejected. Nothing to clean up
 *      because no mapping was created. Carries the conflict field when the
 *      reason was "already mapped to different service" so the route can
 *      surface that as a structured response field.
 *
 *   3. `dns-failed-after-mapping` — THIS IS THE ROUND-17 PRIMARY TARGET.
 *      Mapping succeeded, DNS failed. The orchestrator attempted cleanup of
 *      the orphan mapping. Two sub-cases:
 *        - cleanup.ok=true: orphan removed. Operator can retry safely.
 *          logLevel=warn.
 *        - cleanup.ok=false: orphan remains in GCP. logLevel=critical,
 *          errorCode='domain_mapping_orphan', requiresManualCleanup=true.
 *
 *   4. `mapping-and-dns-both-failed` — defensively included for the case
 *      where the orchestrator runs DNS even though mapping failed. In the
 *      current flow this is unreachable (we early-return on mapping failure
 *      before touching DNS) but the planner accepts the input and returns a
 *      sensible verdict so future orchestrator changes can't silently
 *      regress this. Maps to mapping-failed since DNS is moot when the
 *      mapping isn't there.
 */
export type DomainSetupVerdict =
  | {
      kind: 'success';
      logLevel: 'info';
      fqdn: string;
      customUrl: string;
      message: string;
    }
  | {
      kind: 'mapping-failed';
      logLevel: 'warn';
      fqdn: string;
      mappingError: string;
      conflict: { existingRoute: string } | null;
      message: string;
    }
  | {
      kind: 'dns-failed-after-mapping';
      logLevel: 'warn' | 'critical';
      fqdn: string;
      dnsError: string;
      cleanupOk: boolean;
      cleanupError: string | null;
      /** Only set when cleanupOk=false. Lets the dashboard treat orphan
       *  mappings as a distinct drift category. */
      errorCode: 'domain_mapping_orphan' | null;
      /** Literal `true` when cleanup failed so the dashboard can branch on
       *  the discriminator. */
      requiresManualCleanup: boolean;
      message: string;
    }
  | {
      kind: 'mapping-and-dns-both-failed';
      logLevel: 'warn';
      fqdn: string;
      mappingError: string;
      dnsError: string;
      conflict: { existingRoute: string } | null;
      message: string;
    };

export interface BuildDomainSetupVerdictInput {
  fqdn: string;
  mapping: MappingOutcome;
  /** null when DNS wasn't attempted (because mapping failed). */
  dns: DnsOutcome | null;
  /** null when cleanup wasn't attempted (because mapping never succeeded
   *  OR because DNS succeeded). */
  cleanup: CleanupOutcome | null;
}

export function buildDomainSetupVerdict(
  input: BuildDomainSetupVerdictInput
): DomainSetupVerdict {
  const { fqdn, mapping, dns, cleanup } = input;

  // Phase 1: mapping. If it failed AND dns wasn't attempted (the normal
  // case), surface as mapping-failed.
  if (!mapping.ok && (!dns || !dns.ok)) {
    if (dns && !dns.ok) {
      // Defensive — orchestrator ran DNS despite mapping failure.
      return {
        kind: 'mapping-and-dns-both-failed',
        logLevel: 'warn',
        fqdn,
        mappingError: mapping.error ?? 'unknown mapping error',
        dnsError: dns.error ?? 'unknown dns error',
        conflict: mapping.conflict,
        message:
          `Custom domain ${fqdn} setup failed at both Cloud Run mapping ` +
          `and Cloudflare DNS. Mapping: ${mapping.error ?? 'unknown'}. ` +
          `DNS: ${dns.error ?? 'unknown'}.`,
      };
    }
    return {
      kind: 'mapping-failed',
      logLevel: 'warn',
      fqdn,
      mappingError: mapping.error ?? 'unknown mapping error',
      conflict: mapping.conflict,
      message: `Domain mapping failed: ${mapping.error ?? 'unknown mapping error'}`,
    };
  }

  // Phase 2: DNS after successful mapping. If DNS failed, this is the
  // critical orphan case — classify by cleanup result.
  if (mapping.ok && (!dns || !dns.ok)) {
    const cleanupOk = cleanup?.ok ?? false;
    const cleanupError = cleanup?.error ?? 'cleanup not attempted';
    if (cleanupOk) {
      return {
        kind: 'dns-failed-after-mapping',
        logLevel: 'warn',
        fqdn,
        dnsError: dns?.error ?? 'unknown dns error',
        cleanupOk: true,
        cleanupError: null,
        errorCode: null,
        requiresManualCleanup: false,
        message:
          `DNS failed for ${fqdn}: ${dns?.error ?? 'unknown'}. ` +
          `Orphan Cloud Run mapping was cleaned up successfully. Safe to retry.`,
      };
    }
    return {
      kind: 'dns-failed-after-mapping',
      logLevel: 'critical',
      fqdn,
      dnsError: dns?.error ?? 'unknown dns error',
      cleanupOk: false,
      cleanupError,
      errorCode: 'domain_mapping_orphan',
      requiresManualCleanup: true,
      message:
        `DNS failed for ${fqdn}: ${dns?.error ?? 'unknown'}. ` +
        `Cloud Run domain mapping was created but DNS could not be set up, ` +
        `and automatic cleanup of the orphan mapping ALSO failed: ${cleanupError}. ` +
        `Manually delete the domain mapping for ${fqdn} in Cloud Run console ` +
        `before retrying.`,
    };
  }

  // Phase 3: both succeeded.
  if (mapping.ok && dns && dns.ok) {
    return {
      kind: 'success',
      logLevel: 'info',
      fqdn,
      customUrl: `https://${fqdn}`,
      message: `Custom domain ${fqdn} live (Cloud Run mapping + Cloudflare CNAME both OK)`,
    };
  }

  // Defensive — every input combination is covered above. If we hit this,
  // the input was internally inconsistent (e.g. mapping.ok=false with
  // dns.ok=true and cleanup.ok=true, which the orchestrator would never
  // produce). Treat as mapping-failed because DNS is moot without the
  // mapping.
  return {
    kind: 'mapping-failed',
    logLevel: 'warn',
    fqdn,
    mappingError: mapping.error ?? 'inconsistent verdict input',
    conflict: mapping.conflict,
    message: `Domain mapping failed: ${mapping.error ?? 'inconsistent verdict input'}`,
  };
}

/**
 * Map the verdict back to the legacy return shape that callers of
 * setupCustomDomainWithDns expect. Convention:
 *   - success: success=true, customUrl set, error=null
 *   - everything else: success=false, customUrl='', error from verdict
 *   - conflict carried through from mapping-failed and
 *     mapping-and-dns-both-failed
 */
export function verdictToSetupResult(verdict: DomainSetupVerdict): {
  success: boolean;
  customUrl: string;
  error: string | null;
  conflict?: { existingRoute: string };
} {
  switch (verdict.kind) {
    case 'success':
      return {
        success: true,
        customUrl: verdict.customUrl,
        error: null,
      };
    case 'mapping-failed': {
      const out: {
        success: boolean;
        customUrl: string;
        error: string | null;
        conflict?: { existingRoute: string };
      } = {
        success: false,
        customUrl: '',
        error: verdict.message,
      };
      if (verdict.conflict) out.conflict = verdict.conflict;
      return out;
    }
    case 'dns-failed-after-mapping':
      return {
        success: false,
        customUrl: '',
        error: verdict.message,
      };
    case 'mapping-and-dns-both-failed': {
      const out: {
        success: boolean;
        customUrl: string;
        error: string | null;
        conflict?: { existingRoute: string };
      } = {
        success: false,
        customUrl: '',
        error: verdict.message,
      };
      if (verdict.conflict) out.conflict = verdict.conflict;
      return out;
    }
  }
}
