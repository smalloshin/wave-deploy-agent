/**
 * Monorepo backend→frontend URL propagation verdict — round 19.
 *
 * Why this is its own file:
 *   runDeployPipeline in deploy-worker.ts:902-966 had a notification
 *   block that ran ONLY for monorepo backend deploys. The block did
 *   three things, each of which silently swallowed errors:
 *
 *     try {                                                // OUTER try
 *       await updateProjectConfig(project.id, {            // (1) write
 *         resolvedBackendUrl: deployResult.serviceUrl,
 *         lastDeployedImage: buildResult.imageUri,
 *       });
 *
 *       const allProjects = await listProjects();          // (2) discovery
 *       const frontendSiblings = allProjects.filter(...);
 *
 *       for (const frontend of frontendSiblings) {         // (3) per-sibling
 *         const liveFrontend = ...;
 *         if (liveFrontend?.cloudRunService) {
 *           try {                                          // INNER try
 *             const svcRes = await gcpFetch(updateUrl);
 *             if (svcRes.ok) {
 *               // ... build env vars ...
 *               const patchRes = await gcpFetch(updateUrl, { method:'PATCH', ...});
 *               if (patchRes.ok) console.log("OK");
 *               else console.warn("Frontend env update failed");  // silent miss
 *             }
 *             // If svcRes.ok is false: NO log at all — completely silent miss
 *           } catch (patchErr) {
 *             console.warn(`Frontend hot-update failed: ...`);   // per-sibling silent
 *           }
 *         }
 *       }
 *     } catch (err) {
 *       console.warn(`Backend→frontend notification failed: ...`); // outer silent
 *     }
 *
 *   Failure modes silenced:
 *
 *     A. (1) updateProjectConfig throws — backend's `resolvedBackendUrl`
 *        never gets stored. CRITICAL. Future frontend siblings that
 *        haven't deployed yet won't find the backend URL on cold lookup
 *        when their first deploy runs. Operator deploys a new frontend
 *        sibling expecting it to wire up to the backend automatically;
 *        the wire-up silently doesn't happen and the frontend points at
 *        nothing (or a stale fallback URL hardcoded in env vars).
 *
 *     B. (2) listProjects or per-frontend getDeploymentsByProject throws
 *        — backend URL IS stored, but no live siblings get notified.
 *        Less critical: their next own-deploy will pick up the URL
 *        from backend's config. Warn.
 *
 *     C. (3) Per-frontend PATCH fails (svcRes !ok, patchRes !ok, or
 *        throw) — that specific sibling has stale runtime env vars.
 *        Other siblings might be OK. Per-sibling tracking needed so the
 *        operator knows WHICH siblings are stale. The svcRes-not-ok
 *        case was particularly bad in the legacy code: it skipped the
 *        PATCH silently with NO log line at all.
 *
 *   The fix mirrors round 13/14/15/16/17/18: pure verdict captures all
 *   the outcomes structurally, the orchestrator collects them, and the
 *   verdict planner classifies into a discriminated union with logLevel
 *   + errorCode for dashboard contracts.
 */

/** Outcome of step 1: writing the backend's own config. */
export interface BackendConfigWriteOutcome {
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

/** Outcome of step 2: listing projects + filtering for siblings. Combined
 *  because the legacy code wrapped them together; either failure produces
 *  the same effect (no siblings can be notified). */
export interface SiblingDiscoveryOutcome {
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
  /** Total siblings found (regardless of whether they were live). 0 when
   *  ok=false. */
  totalSiblings: number;
  /** Subset that had a live cloudRunService and were eligible for PATCH.
   *  0 when ok=false. */
  liveSiblings: number;
}

/** Outcome of one per-sibling PATCH attempt. */
export interface SiblingUpdateOutcome {
  /** Project id of the sibling. Used by dashboards to link directly. */
  siblingId: string;
  /** Project name of the sibling. Used in operator-facing messages. */
  siblingName: string;
  ok: boolean;
  /** Error message when ok=false. Includes the failure mode discriminator
   *  ('svc-fetch-failed', 'patch-failed', 'throw'). */
  error: string | null;
}

/**
 * Six verdict kinds covering the (applicable, backend, discovery,
 * sibling-list) outcome lattice:
 *
 *   1. `not-applicable` — not a monorepo backend deploy. Nothing to do,
 *      no log spam. The orchestrator can call this for every deploy and
 *      the verdict tells it whether anything happened.
 *
 *   2. `success` — backend config OK + discovery OK + every live sibling
 *      PATCH OK. Includes count for the log line.
 *
 *   3. `success-no-live-siblings` — backend config OK + discovery OK +
 *      no live siblings to update. This is fine: future sibling deploys
 *      will pick up the backend URL on their cold lookup. Info, not warn.
 *
 *   4. `backend-config-failed` — THIS IS A ROUND-19 CRITICAL TARGET.
 *      The backend's resolvedBackendUrl never got stored. Future frontend
 *      siblings won't find the backend URL on cold lookup. We didn't
 *      attempt sibling discovery because the source-of-truth write
 *      failed. errorCode='monorepo_backend_url_not_stored',
 *      requiresOperatorAction=true.
 *
 *   5. `sibling-discovery-failed` — Backend config IS stored
 *      (cold-lookup will work), but listing/per-sibling-deployment-fetch
 *      threw. No siblings notified. Warn (not critical) because the
 *      cold-lookup path still works.
 *      errorCode='monorepo_sibling_discovery_failed'.
 *
 *   6. `partial-sibling-update-failures` — Backend config + discovery OK,
 *      but >=1 live sibling PATCH failed. Carries the lists of OK and
 *      failed siblings so the operator knows which frontends are stale.
 *      Warn (not critical): the failed siblings are still serving with
 *      their previous env vars; the new URL won't propagate until they
 *      next deploy. errorCode='monorepo_sibling_url_drift'.
 */
export type MonorepoLinkVerdict =
  | {
      kind: 'not-applicable';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'success';
      logLevel: 'info';
      backendName: string;
      backendUrl: string;
      siblingsUpdated: number;
      message: string;
    }
  | {
      kind: 'success-no-live-siblings';
      logLevel: 'info';
      backendName: string;
      backendUrl: string;
      message: string;
    }
  | {
      kind: 'backend-config-failed';
      logLevel: 'critical';
      backendName: string;
      backendUrl: string;
      backendConfigError: string;
      errorCode: 'monorepo_backend_url_not_stored';
      requiresOperatorAction: true;
      message: string;
    }
  | {
      kind: 'sibling-discovery-failed';
      logLevel: 'warn';
      backendName: string;
      backendUrl: string;
      discoveryError: string;
      errorCode: 'monorepo_sibling_discovery_failed';
      message: string;
    }
  | {
      kind: 'partial-sibling-update-failures';
      logLevel: 'warn';
      backendName: string;
      backendUrl: string;
      successfulSiblings: Array<{ id: string; name: string }>;
      failedSiblings: Array<{ id: string; name: string; error: string }>;
      errorCode: 'monorepo_sibling_url_drift';
      requiresOperatorAction: false;
      message: string;
    };

export interface BuildMonorepoLinkVerdictInput {
  /** True when this deploy is a monorepo backend with a serviceUrl. When
   *  false, the verdict short-circuits to `not-applicable` regardless of
   *  the other inputs. */
  applicable: boolean;
  /** Backend project name. Only meaningful when applicable=true. */
  backendName: string;
  /** Backend's Cloud Run URL. Only meaningful when applicable=true. */
  backendUrl: string;
  /** null when applicable=false. */
  backendConfigWrite: BackendConfigWriteOutcome | null;
  /** null when applicable=false OR when backend config failed (we don't
   *  attempt discovery on a failed config write). */
  siblingDiscovery: SiblingDiscoveryOutcome | null;
  /** Empty when no siblings were updated for any reason. */
  siblingUpdates: SiblingUpdateOutcome[];
}

export function buildMonorepoLinkVerdict(
  input: BuildMonorepoLinkVerdictInput
): MonorepoLinkVerdict {
  const { applicable, backendName, backendUrl } = input;

  if (!applicable) {
    return {
      kind: 'not-applicable',
      logLevel: 'info',
      message: 'Monorepo backend→frontend link: not applicable (not a monorepo backend deploy or no serviceUrl)',
    };
  }

  // Backend config write failed → critical. We don't classify by
  // discovery/sibling status because if the source-of-truth write failed,
  // we shouldn't have attempted sibling notifications in the first place.
  if (!input.backendConfigWrite || !input.backendConfigWrite.ok) {
    const err = input.backendConfigWrite?.error ?? 'backend config write not attempted';
    return {
      kind: 'backend-config-failed',
      logLevel: 'critical',
      backendName,
      backendUrl,
      backendConfigError: err,
      errorCode: 'monorepo_backend_url_not_stored',
      requiresOperatorAction: true,
      message:
        `Monorepo backend "${backendName}" deployed to ${backendUrl}, but ` +
        `the backend's resolvedBackendUrl could not be stored in project config: ${err}. ` +
        `Future frontend siblings will not find the backend URL on cold lookup. ` +
        `Re-run the deploy or manually set project.config.resolvedBackendUrl.`,
    };
  }

  // Sibling discovery failed → warn. Backend URL is stored, cold lookup
  // works, just couldn't notify currently-live siblings.
  if (!input.siblingDiscovery || !input.siblingDiscovery.ok) {
    const err = input.siblingDiscovery?.error ?? 'sibling discovery not attempted';
    return {
      kind: 'sibling-discovery-failed',
      logLevel: 'warn',
      backendName,
      backendUrl,
      discoveryError: err,
      errorCode: 'monorepo_sibling_discovery_failed',
      message:
        `Monorepo backend "${backendName}" deployed to ${backendUrl}. ` +
        `Backend config stored OK, but sibling discovery failed: ${err}. ` +
        `Currently-live frontend siblings were not notified; their next own-deploy ` +
        `will pick up the new URL from backend config.`,
    };
  }

  // Discovery OK but no live siblings → info. Future cold lookups will
  // wire up correctly.
  if (input.siblingDiscovery.liveSiblings === 0) {
    return {
      kind: 'success-no-live-siblings',
      logLevel: 'info',
      backendName,
      backendUrl,
      message:
        `Monorepo backend "${backendName}" deployed to ${backendUrl}. ` +
        `Backend config stored. No live frontend siblings to notify (will wire up on cold lookup).`,
    };
  }

  // Live siblings exist — classify by per-sibling update outcomes.
  const successful = input.siblingUpdates.filter(s => s.ok).map(s => ({ id: s.siblingId, name: s.siblingName }));
  const failed = input.siblingUpdates
    .filter(s => !s.ok)
    .map(s => ({ id: s.siblingId, name: s.siblingName, error: s.error ?? 'unknown sibling update error' }));

  if (failed.length > 0) {
    return {
      kind: 'partial-sibling-update-failures',
      logLevel: 'warn',
      backendName,
      backendUrl,
      successfulSiblings: successful,
      failedSiblings: failed,
      errorCode: 'monorepo_sibling_url_drift',
      requiresOperatorAction: false,
      message:
        `Monorepo backend "${backendName}" deployed to ${backendUrl}. ` +
        `Backend config stored. Sibling updates: ${successful.length} OK, ${failed.length} failed (` +
        `${failed.map(f => `"${f.name}": ${f.error}`).join('; ')}). ` +
        `Failed siblings are still serving with their previous env vars; the new URL ` +
        `will propagate when they next deploy.`,
    };
  }

  return {
    kind: 'success',
    logLevel: 'info',
    backendName,
    backendUrl,
    siblingsUpdated: successful.length,
    message:
      `Monorepo backend "${backendName}" deployed to ${backendUrl}. ` +
      `Backend config stored, ${successful.length} frontend sibling(s) hot-updated with new URL.`,
  };
}

/** Side-effect helper: log the verdict at the appropriate level. */
export function logMonorepoLinkVerdict(verdict: MonorepoLinkVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Deploy] ${verdict.message}`);
      return;
    case 'warn': {
      const errorCode =
        verdict.kind === 'sibling-discovery-failed'
          ? verdict.errorCode
          : verdict.kind === 'partial-sibling-update-failures'
            ? verdict.errorCode
            : '';
      console.warn(`[Deploy] [WARN errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
    case 'critical': {
      const errorCode = verdict.kind === 'backend-config-failed' ? verdict.errorCode : '';
      console.error(`[Deploy] [CRITICAL errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
  }
}
