/**
 * startProjectService verdict — mirror of stop-verdict.ts (round 13) for the
 * start path. Same lying-state pattern, different IO sequence.
 *
 * Why this is its own file:
 *   startProjectService used to do four IO calls in a row with NO error
 *   handling on the middle two, plus a swallowed `try { } catch { /* ignore *\/ }`
 *   on the fourth:
 *
 *     const result = await deployToCloudRun(...);   // heavy: new revision
 *     if (!result.success) { return failure }
 *     if (latest) {
 *       await updateDeployment(latest.id, ...);     // (1) NO try/catch
 *     }
 *     await updateProjectConfig(projectId, ...);    // (2) NO try/catch
 *     try {
 *       await transitionProject(...);               // (3) catch SWALLOWS
 *     } catch { /* ignore *\/ }
 *     return { success: true, ... };
 *
 *   Failure modes silenced:
 *
 *     A. deployToCloudRun OK, updateDeployment THROWS:
 *        Cloud Run is serving the new revision, but deployment row still
 *        shows cloudRunUrl='' and healthStatus='unknown' (left over from
 *        the prior stop). Dashboard says service is stopped while it's
 *        actually running and billing. Operator clicks "Start" again →
 *        another deployToCloudRun → wasted build, possibly traffic split,
 *        depending on min-instances.
 *
 *     B. updateDeployment OK, updateProjectConfig THROWS:
 *        Cloud Run is serving the new revision and deployment row is
 *        correct, but lastDeployedImage didn't get re-cached in
 *        project.config. Next stop/start cycle has no cached image and
 *        falls into the "redeploy via /resubmit instead" error path.
 *        Operator thinks the project is broken when it's just missing
 *        a config snapshot. Soft partial.
 *
 *     C. updateDeployment+updateProjectConfig OK, transitionProject FAILS:
 *        Cloud Run + deployment row + config all correct, but
 *        project.status is still 'stopped' (or wherever it was). The
 *        round-10 reconciler will fix this on the next cycle (it sees
 *        live traffic and flips state). Soft partial — surface as warn,
 *        not critical.
 *
 *   The fix mirrors round 13: pure planner returns a discriminated
 *   verdict; orchestrator captures each step's outcome into structured
 *   form and asks the planner what to do.
 */

export interface DeployOutcome {
  /** True iff deployToCloudRun returned success. */
  ok: boolean;
  /** Service name when ok=true. */
  serviceName: string | null;
  /** Service URL when ok=true. */
  serviceUrl: string | null;
  /** Error message when ok=false. */
  error: string | null;
}

export interface DbWriteOutcome {
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

export interface TransitionOutcome {
  ok: boolean;
  /** Error name (Error.name) when ok=false — used to distinguish state-machine
   *  expected rejections (Invalid/ConcurrentTransitionError) from real errors. */
  errorName: string | null;
  error: string | null;
}

/**
 * Five verdict kinds matching the (deploy, deploymentRow, projectConfig, transition)
 * outcome lattice. The reconciler can fix some of these on its own (B, C);
 * critical ones (A) need operator awareness because the dashboard would
 * otherwise show wrong state until the reconciler runs.
 *
 *   1. `success` — every write succeeded. Service live, DB matches.
 *
 *   2. `deploy-failed` — deployToCloudRun rejected. No DB writes attempted.
 *      Project still in its prior state (stopped). Operator can retry safely.
 *
 *   3. `partial-deployment-row-mismatch` — CR succeeded, but the deployment
 *      row update failed. THIS IS THE ROUND-16 PRIMARY TARGET. CRITICAL.
 *      Service is live and billing, but dashboard shows stopped/unknown.
 *      Carries the live serviceName + serviceUrl so the operator can verify
 *      out-of-band, and the dbError so they can debug.
 *
 *   4. `partial-config-not-persisted` — CR + deployment row OK, but
 *      project.config write (lastDeployedImage cache) failed. Soft partial:
 *      service works now, but next stop/start cycle falls back to the
 *      live-service image read instead of the cache. Warn, not critical.
 *
 *   5. `partial-transition-failed` — CR + DB OK, but transitionProject
 *      threw. Round-10 reconciler will fix on next cycle by observing
 *      live traffic. Soft partial. Warn.
 */
export type StartVerdict =
  | {
      kind: 'success';
      logLevel: 'info';
      serviceName: string;
      serviceUrl: string | null;
      message: string;
    }
  | {
      kind: 'deploy-failed';
      logLevel: 'warn';
      deployError: string;
      message: string;
    }
  | {
      kind: 'partial-deployment-row-mismatch';
      logLevel: 'critical';
      serviceName: string;
      serviceUrl: string | null;
      dbError: string;
      requiresManualReconcile: true;
      errorCode: 'start_deployment_row_drift';
      message: string;
    }
  | {
      kind: 'partial-config-not-persisted';
      logLevel: 'warn';
      serviceName: string;
      serviceUrl: string | null;
      configError: string;
      message: string;
    }
  | {
      kind: 'partial-transition-failed';
      logLevel: 'warn';
      serviceName: string;
      serviceUrl: string | null;
      transitionError: string;
      transitionErrorName: string | null;
      message: string;
    };

export interface BuildStartVerdictInput {
  deploy: DeployOutcome;
  deploymentRow: DbWriteOutcome | null;
  projectConfig: DbWriteOutcome | null;
  transition: TransitionOutcome | null;
  /** True when there's no `latest` deployment row to update — start path
   *  legitimately skips the deployment-row write. Distinguishes "skipped"
   *  from "failed". */
  deploymentRowSkipped: boolean;
}

export function buildStartVerdict(input: BuildStartVerdictInput): StartVerdict {
  // Phase 1: deploy. If it failed, nothing else was attempted.
  if (!input.deploy.ok) {
    return {
      kind: 'deploy-failed',
      logLevel: 'warn',
      deployError: input.deploy.error ?? 'unknown deploy error',
      message: `Restart failed: ${input.deploy.error ?? 'unknown deploy error'}`,
    };
  }

  // Defensive — ok=true should always carry a service name. If it doesn't,
  // treat it as a deploy failure (we don't have anything to point the
  // operator at).
  const serviceName = input.deploy.serviceName ?? '<unknown>';
  const serviceUrl = input.deploy.serviceUrl;

  // Phase 2: deployment row. If we had one to update and it failed, that's
  // the critical case — dashboard now lies about service state.
  if (!input.deploymentRowSkipped && (!input.deploymentRow || !input.deploymentRow.ok)) {
    return {
      kind: 'partial-deployment-row-mismatch',
      logLevel: 'critical',
      serviceName,
      serviceUrl,
      dbError: input.deploymentRow?.error ?? 'deployment row write not attempted',
      requiresManualReconcile: true,
      errorCode: 'start_deployment_row_drift',
      message: `Service ${serviceName} is live at ${serviceUrl ?? '(no URL)'}, but the deployment row failed to update. Dashboard will show stale state until reconciled.`,
    };
  }

  // Phase 3: project config (lastDeployedImage cache). Soft partial.
  if (!input.projectConfig || !input.projectConfig.ok) {
    return {
      kind: 'partial-config-not-persisted',
      logLevel: 'warn',
      serviceName,
      serviceUrl,
      configError: input.projectConfig?.error ?? 'project config write not attempted',
      message: `Service ${serviceName} restarted, but lastDeployedImage cache didn't persist. Next stop/start may fall back to live-service image read.`,
    };
  }

  // Phase 4: transition. Soft partial — reconciler will fix.
  if (!input.transition || !input.transition.ok) {
    return {
      kind: 'partial-transition-failed',
      logLevel: 'warn',
      serviceName,
      serviceUrl,
      transitionError: input.transition?.error ?? 'transition not attempted',
      transitionErrorName: input.transition?.errorName ?? null,
      message: `Service ${serviceName} restarted, but project status didn't transition. Reconciler will fix on next cycle.`,
    };
  }

  return {
    kind: 'success',
    logLevel: 'info',
    serviceName,
    serviceUrl,
    message: `Restarted ${serviceName}`,
  };
}

/**
 * Map the verdict back to the LifecycleResult shape the route returns.
 *
 * Convention (mirroring stop-verdict):
 *   - success: success=true
 *   - deploy-failed: success=false (operator should see error)
 *   - partial-deployment-row-mismatch: success=false (CRITICAL — operator
 *     must know dashboard is wrong)
 *   - partial-config-not-persisted: success=true (service is up; cache
 *     is the only thing wrong)
 *   - partial-transition-failed: success=true (service is up; reconciler
 *     will fix status on its own)
 */
export function verdictToLifecycleResult(verdict: StartVerdict): {
  success: boolean;
  message: string;
  serviceName?: string;
  serviceUrl?: string;
} {
  switch (verdict.kind) {
    case 'success':
      return {
        success: true,
        message: verdict.message,
        serviceName: verdict.serviceName,
        serviceUrl: verdict.serviceUrl ?? undefined,
      };
    case 'deploy-failed':
      return { success: false, message: verdict.message };
    case 'partial-deployment-row-mismatch':
      return {
        success: false,
        message: verdict.message,
        serviceName: verdict.serviceName,
        serviceUrl: verdict.serviceUrl ?? undefined,
      };
    case 'partial-config-not-persisted':
      return {
        success: true,
        message: verdict.message,
        serviceName: verdict.serviceName,
        serviceUrl: verdict.serviceUrl ?? undefined,
      };
    case 'partial-transition-failed':
      return {
        success: true,
        message: verdict.message,
        serviceName: verdict.serviceName,
        serviceUrl: verdict.serviceUrl ?? undefined,
      };
  }
}
