/**
 * IAM policy verdict — round 21.
 *
 * Why this is its own file:
 *   deploy-engine.ts:401-425 had this pattern:
 *
 *     if (config.allowUnauthenticated) {
 *       const iamRes = await gcpFetch(iamUrl, { method: 'POST', ... });
 *       if (!iamRes.ok) {
 *         const iamErr = await iamRes.text();
 *         console.error(`[Deploy]   IAM policy failed (${iamRes.status}): ${iamErr}`);
 *         // Don't throw — service is deployed, just not public yet
 *       } else {
 *         console.log(`[Deploy]   IAM policy set: public access enabled`);
 *       }
 *     }
 *
 *   Author confession: "Don't throw — service is deployed, just not public yet"
 *
 *   That comment is a LIE about what happens next. The user explicitly set
 *   allowUnauthenticated=true (it's the schema DEFAULT — `z.boolean().default(true)`
 *   in routes/projects.ts:196), and the SQL backfill in db/schema.sql:107-112
 *   forces every project to public-by-default. The user wants public.
 *
 *   End-user impact when IAM setIamPolicy returns !ok (transient 5xx, missing
 *   `roles/run.admin` on the deploy SA, propagation delay, network blip):
 *
 *     1. Cloud Run create/update operation succeeded → service is live
 *     2. deployToCloudRun returns `{success: true, serviceUrl: 'https://...run.app'}`
 *     3. deploy-worker writes serviceUrl to deployments row, transitions to 'live'
 *     4. Post-deploy verdict shows green
 *     5. Discord bot sends "Deploy succeeded! ${serviceUrl}"
 *     6. User clicks the URL → 403 Forbidden (allUsers binding never landed)
 *     7. User: "you said it deployed"
 *
 *   The error log line at 420 is the ONLY signal, drowned among hundreds of
 *   noise lines and not surfaced to dashboard or notifier.
 *
 *   Round 21 design: capture iam outcome on DeployResult, build pure verdict
 *   in this module. Three kinds:
 *
 *     1. `not-applicable` — config.allowUnauthenticated=false. Service is
 *        intended to be private. No IAM call attempted. info.
 *
 *     2. `success` — public service requested AND IAM set OK. info.
 *
 *     3. `iam-policy-failed-public-deploy` — public service requested but
 *        setIamPolicy returned !ok. Service is LIVE but PRIVATE. End-user
 *        impact: 403 on the URL the system just told them is live.
 *        logLevel=critical, errorCode='iam_policy_drift',
 *        requiresOperatorAction=true. Verdict carries serviceName, gcpProject,
 *        gcpRegion so the recovery message includes a runnable gcloud command:
 *
 *          gcloud run services add-iam-policy-binding ${serviceName} \
 *            --member=allUsers --role=roles/run.invoker \
 *            --region=${gcpRegion} --project=${gcpProject}
 *
 *        Crucial difference from rounds 13-19: deploy-worker should NOT roll
 *        back the deploy. The service IS live. The user's URL just doesn't
 *        work yet. Operator can fix in <1 minute via gcloud. So we surface
 *        critical log + (future) dashboard banner, but don't transition to
 *        'failed'. Different from round 20 where blockApproval gates
 *        scan_report status — here the deploy succeeded, just incomplete.
 *
 *   Note on the line 1078 second deployToCloudRun call (deploy-worker post-
 *   deploy URL env-var redeploy): it currently discards the entire DeployResult
 *   (`await deployToCloudRun(...)` no assignment). That's a separate silent
 *   bug for a future round. Round 21 wires the verdict on the primary call
 *   site (line 778) only.
 */

/** Outcome captured by deploy-engine after the setIamPolicy POST.
 *  Always present on DeployResult when allowUnauthenticated was true; null
 *  when allowUnauthenticated was false (no IAM call attempted). */
export interface IamPolicyOutcome {
  /** True when setIamPolicy returned 2xx. */
  ok: boolean;
  /** HTTP status from the setIamPolicy response, or null when the fetch
   *  itself threw before getting a response. */
  httpStatus: number | null;
  /** Error body text when ok=false. null on success. */
  error: string | null;
}

/**
 * Three verdict kinds covering the (allowUnauthenticated, iamOutcome) lattice:
 *
 *   1. `not-applicable` — allowUnauthenticated=false. info.
 *   2. `success` — public requested AND IAM OK. info.
 *   3. `iam-policy-failed-public-deploy` — public requested but IAM failed.
 *      Service is live but returns 403 to all users.
 *      logLevel=critical, errorCode='iam_policy_drift',
 *      requiresOperatorAction=true.
 */
export type IamPolicyVerdict =
  | {
      kind: 'not-applicable';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'success';
      logLevel: 'info';
      serviceName: string;
      message: string;
    }
  | {
      kind: 'iam-policy-failed-public-deploy';
      logLevel: 'critical';
      serviceName: string;
      gcpProject: string;
      gcpRegion: string;
      serviceUrl: string | null;
      httpStatus: number | null;
      iamError: string;
      errorCode: 'iam_policy_drift';
      requiresOperatorAction: true;
      /** Runnable gcloud command to fix the drift without re-deploying. */
      recoveryCommand: string;
      message: string;
    };

export interface BuildIamPolicyVerdictInput {
  /** True iff the user wanted public access (config.allowUnauthenticated).
   *  When false, the verdict short-circuits to `not-applicable`. */
  allowUnauthenticated: boolean;
  /** Cloud Run service name (e.g. `da-myapp`). */
  serviceName: string;
  /** GCP project ID for recovery command. */
  gcpProject: string;
  /** GCP region for recovery command. */
  gcpRegion: string;
  /** Cloud Run service URL (https://...run.app), null when it couldn't
   *  be fetched. Threaded through for the critical message. */
  serviceUrl: string | null;
  /** Outcome of the setIamPolicy call. null when allowUnauthenticated=false
   *  (no call attempted). */
  iamOutcome: IamPolicyOutcome | null;
}

export function buildIamPolicyVerdict(
  input: BuildIamPolicyVerdictInput
): IamPolicyVerdict {
  const { allowUnauthenticated, serviceName, gcpProject, gcpRegion, serviceUrl, iamOutcome } = input;

  if (!allowUnauthenticated) {
    return {
      kind: 'not-applicable',
      logLevel: 'info',
      message:
        `IAM policy: not applicable for "${serviceName}" ` +
        `(allowUnauthenticated=false; service is private by design, no IAM binding required)`,
    };
  }

  // Public access requested. Inspect IAM outcome.
  // Treat null iamOutcome as a failure too — public was requested but no
  // outcome was reported (engine bug or skipped call). Same end-user impact
  // (private service when public was wanted), so same verdict kind.
  if (!iamOutcome || !iamOutcome.ok) {
    const status = iamOutcome?.httpStatus ?? null;
    const err = iamOutcome?.error ?? 'IAM outcome not reported by deploy engine';
    const recoveryCommand =
      `gcloud run services add-iam-policy-binding ${serviceName} ` +
      `--member=allUsers --role=roles/run.invoker ` +
      `--region=${gcpRegion} --project=${gcpProject}`;
    return {
      kind: 'iam-policy-failed-public-deploy',
      logLevel: 'critical',
      serviceName,
      gcpProject,
      gcpRegion,
      serviceUrl,
      httpStatus: status,
      iamError: err,
      errorCode: 'iam_policy_drift',
      requiresOperatorAction: true,
      recoveryCommand,
      message:
        `IAM policy for "${serviceName}" FAILED (HTTP ${status ?? 'n/a'}): ${err}. ` +
        `Cloud Run service IS LIVE at ${serviceUrl ?? '(URL unknown)'} but ` +
        `allUsers binding was not applied — every request will return 403 ` +
        `Forbidden. The deploy notification claims success but the URL is ` +
        `broken for end users. Recover with: ${recoveryCommand}`,
    };
  }

  return {
    kind: 'success',
    logLevel: 'info',
    serviceName,
    message:
      `IAM policy for "${serviceName}" OK ` +
      `(allUsers → roles/run.invoker; service is publicly accessible)`,
  };
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Critical verdicts use console.error with `[CRITICAL errorCode=X]`
 *  prefix that operators can grep on Cloud Run logs. */
export function logIamPolicyVerdict(verdict: IamPolicyVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Deploy] ${verdict.message}`);
      return;
    case 'critical':
      console.error(`[Deploy] [CRITICAL errorCode=${verdict.errorCode}] ${verdict.message}`);
      return;
  }
}
