/**
 * Post-deploy secondary-writes verdict — round 18.
 *
 * Why this is its own file:
 *   runDeployPipeline in deploy-worker.ts:843-878 used to do two
 *   secondary IO sequences after the main Cloud Run deploy succeeded,
 *   each wrapped in a try/catch that ONLY emitted `console.warn` and
 *   silently allowed the deploy to be reported as success:
 *
 *     // (1) captureDeployedSource: upload tarball → DB write
 *     try {
 *       const capture = await captureDeployedSource(...);
 *       await updateDeployment(deployment.id, { deployedSourceGcsUri: capture.gcsUri });
 *     } catch (captureErr) {
 *       console.warn(`Deployed-source capture failed (non-fatal): ...`);
 *     }
 *
 *     // (2) lastDeployedImage cache → enables /start without rebuild
 *     try {
 *       await updateProjectConfig(project.id, {
 *         ...(project.config ?? {}),
 *         lastDeployedImage: buildResult.imageUri,
 *       });
 *     } catch (err) {
 *       console.warn(`Failed to cache lastDeployedImage: ...`);
 *     }
 *
 *   Failure modes silenced:
 *
 *     A. captureDeployedSource throws (or its DB write throws):
 *        Either the tarball never uploaded (small impact) OR the tarball
 *        IS in `gs://wave-deploy-agent-deployed/<slug>/v<n>.tgz` but
 *        deployment row has no `deployedSourceGcsUri` reference. The
 *        bucket has a 365-day lifecycle so the object eventually goes
 *        away on its own. User-visible impact: dashboard's "download
 *        deployed source" returns "Source unavailable" because
 *        versioning.ts checks for `target.deployedSourceGcsUri`. Slow
 *        leak, low severity, but still drift the operator can't see
 *        without log-grepping.
 *
 *     B. updateProjectConfig({ lastDeployedImage }) throws:
 *        THIS IS THE PRIMARY ROUND-18 TARGET. The deploy was successful,
 *        Cloud Run is serving traffic on a new revision, but the cache
 *        used by `/api/projects/:id/start` to restart a stopped service
 *        is missing. When the operator stops the service later (a
 *        normal flow — saving billing on idle services) and tries to
 *        start it again, service-lifecycle.ts:184-197 reads
 *        `project.config?.lastDeployedImage` (missing), tries to fall
 *        back to `getServiceImage(service)` (returns null because the
 *        service was deleted on stop), and returns:
 *          "No cached image — redeploy via /resubmit instead"
 *        The user has to do a FULL REBUILD AND REDEPLOY of the same
 *        code that just deployed seconds ago. Concrete user pain. The
 *        `console.warn` is invisible in practice. Severity: MID.
 *
 *   The fix mirrors round 13/14/15/16/17: pure verdict module returns a
 *   discriminated union, the orchestrator captures each step's outcome
 *   structurally and asks the planner what verdict to surface. This
 *   round we don't change the deploy's overall success/failure (the
 *   service IS up — these are post-deploy degradations, not deploy
 *   failures) but we DO surface critical drift via:
 *     - structured logs with errorCode the dashboard can grep on
 *     - logLevel=critical with `[CRITICAL]` prefix when image cache is
 *       missing (the user-facing one)
 *     - logLevel=warn for the source-capture leak (slow, dashboard-only)
 */

/** Outcome of step 1: captureDeployedSource + its updateDeployment write
 *  (both wrapped together because either one failing leaves a degraded
 *  state, and the legacy try/catch wrapped them as a unit). */
export interface DeployedSourceCaptureOutcome {
  /** True iff both the GCS upload AND the deployment-row write succeeded.
   *  When false we don't know which one failed — the legacy code wrapped
   *  them together — so the verdict treats this as a single "no
   *  downloadable source snapshot" condition. */
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

/** Outcome of step 2: updateProjectConfig({ lastDeployedImage }). */
export interface ImageCacheWriteOutcome {
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

/**
 * Four verdict kinds. The deploy's overall success is NOT changed by any
 * of these — Cloud Run is serving traffic regardless. The verdict's job
 * is to surface DEGRADATIONS the operator otherwise wouldn't see.
 *
 *   1. `success` — both secondary writes OK. Nothing to surface.
 *
 *   2. `success-with-source-leak` — captureDeployedSource failed but
 *      image cache OK. Dashboard's "download deployed source" will say
 *      "Source unavailable" for this version. Low severity (GCS
 *      lifecycle eventually cleans up). logLevel=warn,
 *      errorCode='deployed_source_orphan'.
 *
 *   3. `image-cache-missing` — imageCacheWrite failed but source capture
 *      OK. THIS IS THE PRIMARY ROUND-18 TARGET. Next stop/start cycle
 *      will hit "No cached image — redeploy via /resubmit instead",
 *      forcing the user into a full rebuild of code that just deployed.
 *      logLevel=critical, errorCode='image_cache_drift',
 *      requiresOperatorAction=true.
 *
 *   4. `multiple-post-deploy-failures` — both failed. logLevel=critical
 *      (image cache being missing dominates), errorCode='post_deploy_drift',
 *      requiresOperatorAction=true. Carries both error strings so the
 *      operator can debug both failures.
 */
export type PostDeployVerdict =
  | {
      kind: 'success';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'success-with-source-leak';
      logLevel: 'warn';
      sourceCaptureError: string;
      errorCode: 'deployed_source_orphan';
      requiresOperatorAction: false;
      message: string;
    }
  | {
      kind: 'image-cache-missing';
      logLevel: 'critical';
      imageCacheError: string;
      errorCode: 'image_cache_drift';
      requiresOperatorAction: true;
      message: string;
    }
  | {
      kind: 'multiple-post-deploy-failures';
      logLevel: 'critical';
      sourceCaptureError: string;
      imageCacheError: string;
      errorCode: 'post_deploy_drift';
      requiresOperatorAction: true;
      message: string;
    };

export interface BuildPostDeployVerdictInput {
  /** Service name / version label for log messages — e.g. "kol-studio v3". */
  deployLabel: string;
  deployedSourceCapture: DeployedSourceCaptureOutcome;
  imageCacheWrite: ImageCacheWriteOutcome;
}

export function buildPostDeployVerdict(
  input: BuildPostDeployVerdictInput
): PostDeployVerdict {
  const { deployLabel, deployedSourceCapture, imageCacheWrite } = input;
  const sourceOk = deployedSourceCapture.ok;
  const cacheOk = imageCacheWrite.ok;

  // Both OK — happy path.
  if (sourceOk && cacheOk) {
    return {
      kind: 'success',
      logLevel: 'info',
      message: `Post-deploy: ${deployLabel} secondary writes OK (source captured, image cache persisted)`,
    };
  }

  // Both failed — the worst case. Image cache failure dominates because
  // it has user-visible impact (forced rebuild on next /start), so this
  // is critical and carries the catch-all errorCode.
  if (!sourceOk && !cacheOk) {
    return {
      kind: 'multiple-post-deploy-failures',
      logLevel: 'critical',
      sourceCaptureError: deployedSourceCapture.error ?? 'unknown source-capture error',
      imageCacheError: imageCacheWrite.error ?? 'unknown image-cache error',
      errorCode: 'post_deploy_drift',
      requiresOperatorAction: true,
      message:
        `Post-deploy: ${deployLabel} BOTH secondary writes failed. ` +
        `Source capture: ${deployedSourceCapture.error ?? 'unknown'}. ` +
        `Image cache: ${imageCacheWrite.error ?? 'unknown'}. ` +
        `Service is live but the next stop/start cycle will require a ` +
        `full rebuild, and the deployed source snapshot is unavailable.`,
    };
  }

  // Only image cache failed — primary round-18 target. User-facing
  // impact: next /start will demand a redeploy.
  if (sourceOk && !cacheOk) {
    return {
      kind: 'image-cache-missing',
      logLevel: 'critical',
      imageCacheError: imageCacheWrite.error ?? 'unknown image-cache error',
      errorCode: 'image_cache_drift',
      requiresOperatorAction: true,
      message:
        `Post-deploy: ${deployLabel} image cache write failed: ` +
        `${imageCacheWrite.error ?? 'unknown'}. ` +
        `Service is live now, but next stop/start cycle will hit ` +
        `"No cached image — redeploy via /resubmit instead". ` +
        `Re-run the deploy to repopulate the cache, or manually update ` +
        `project.config.lastDeployedImage.`,
    };
  }

  // Only source capture failed — slow leak / dashboard-only.
  return {
    kind: 'success-with-source-leak',
    logLevel: 'warn',
    sourceCaptureError: deployedSourceCapture.error ?? 'unknown source-capture error',
    errorCode: 'deployed_source_orphan',
    requiresOperatorAction: false,
    message:
      `Post-deploy: ${deployLabel} source-capture failed: ` +
      `${deployedSourceCapture.error ?? 'unknown'}. ` +
      `Service is live and image cache is OK. ` +
      `"Download deployed source" for this version will be unavailable.`,
  };
}

/**
 * Side-effect helper: log the verdict at the appropriate level. Returns
 * void because the verdict doesn't change the deploy's success — it just
 * needs to be surfaced. Critical verdicts use console.error with a
 * `[CRITICAL]` prefix that operators can grep for in Cloud Run logs.
 */
export function logPostDeployVerdict(verdict: PostDeployVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Deploy] ${verdict.message}`);
      return;
    case 'warn':
      console.warn(
        `[Deploy] [WARN errorCode=${
          verdict.kind === 'success-with-source-leak' ? verdict.errorCode : ''
        }] ${verdict.message}`
      );
      return;
    case 'critical': {
      const errorCode =
        verdict.kind === 'image-cache-missing'
          ? verdict.errorCode
          : verdict.kind === 'multiple-post-deploy-failures'
            ? verdict.errorCode
            : '';
      console.error(`[Deploy] [CRITICAL errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
  }
}
