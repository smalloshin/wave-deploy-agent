/**
 * URL env-var redeploy verdict — round 24.
 *
 * Why this is its own file:
 *   Round 21 IAM verdict's source comment ended with:
 *
 *     "Note on the line 1078 second deployToCloudRun call (deploy-worker post-
 *      deploy URL env-var redeploy): it currently discards the entire
 *      DeployResult (`await deployToCloudRun(...)` no assignment). That's a
 *      separate silent bug for a future round."
 *
 *   Round 21 partially fixed it (captures `redeployResult` and chains the IAM
 *   verdict on the success path), but `redeployResult.success === false` still
 *   only emits a console.warn at deploy-worker.ts:1158-1159:
 *
 *     if (!redeployResult.success) {
 *       console.warn(`[Deploy]   URL env-var redeploy failed: ${redeployResult.error} ` +
 *                    `(env vars not updated, but original deploy is live)`);
 *     } else { ... iam verdict on redeploy ... }
 *
 *   The trailing parenthetical is the lie. Yes, the original deploy IS live —
 *   but it's live with `NEXTAUTH_URL=http://localhost:3000`, `APP_URL=`,
 *   `BASE_URL=localhost`, etc. (whatever URL keys the user supplied with
 *   placeholder values). The whole point of the post-deploy redeploy is to
 *   inject the actual Cloud Run URL into those env vars before the service
 *   sees real traffic. When the second deploy fails:
 *
 *     1. First deployToCloudRun succeeds → service URL is e.g.
 *        https://da-myapp-xyz123-uc.a.run.app
 *     2. Worker detects `finalEnvVars.NEXTAUTH_URL === 'http://localhost:3000'`
 *        and decides to PATCH a new revision with NEXTAUTH_URL=<service URL>
 *     3. Second deployToCloudRun fails (Cloud Run quota, PATCH RPS limit
 *        because we just deployed, image-pull race, auth blip)
 *     4. Cloud Run keeps serving revision #1 — env vars are STILL localhost
 *     5. transitionProject(projectId, 'deployed', ...) runs anyway (line 1176)
 *     6. Dashboard shows status='live', notification claims success
 *     7. Canary checks (line 1272) hit `<serviceUrl>/health` — which usually
 *        doesn't read NEXTAUTH_URL — so canary passes
 *     8. End user clicks the dashboard URL:
 *        - Next.js NextAuth `/api/auth/session` reads NEXTAUTH_URL=localhost:3000
 *        - Cookie domain mismatch on prod, every request 500s or redirects
 *          to localhost
 *        - OAuth callbacks redirect to localhost from prod → infinite loop
 *        - "Deploy went green but login is permanently broken"
 *
 *   Like round 21 IAM and round 23 restore, the service is mid-flight when
 *   this happens — bailing back to 'failed' would orphan a half-built service
 *   the operator now has to clean up. Verdict is surface-only: critical log
 *   + dashboard contract + runnable recovery command.
 *
 *   Three verdict kinds:
 *
 *     1. `not-applicable` — no URL keys needed updating (the user supplied
 *        a custom domain, or none of NEXTAUTH_URL/APP_URL/BASE_URL/SITE_URL/
 *        PUBLIC_URL contained localhost). info, no-op.
 *
 *     2. `redeploy-ok` — the second deployToCloudRun returned success=true.
 *        info. Carries patchedKeys + revisionTag. Caller still chains the
 *        round-21 IAM verdict separately on this path.
 *
 *     3. `redeploy-failed` — the second deployToCloudRun returned
 *        success=false OR the redeploy outcome was null (defensive — caller
 *        bug). Service is LIVE but serving revision-1 with localhost URLs.
 *        logLevel=critical, errorCode='url_env_redeploy_drift',
 *        requiresOperatorAction=true. Carries patchedKeys + serviceUrl +
 *        gcpProject + gcpRegion so the recovery message includes a runnable
 *        gcloud command (mirrors round 21's recoveryCommand pattern):
 *
 *          gcloud run services update ${serviceName} \
 *            --region=${gcpRegion} --project=${gcpProject} \
 *            --update-env-vars=NEXTAUTH_URL=${serviceUrl},APP_URL=${serviceUrl}...
 *
 *   Crucial design decision: redeploy-failed has NO `blockDeploy` and NO
 *   `blockPipeline` field. Round 24 deliberately stays on the surface-only
 *   spectrum point because:
 *     - The first deploy already succeeded — service is live with a URL
 *     - The second deploy was a bonus polish step (env-var URL injection)
 *     - Bailing now would mean transition to 'failed' even though revision-1
 *       is still serving traffic (just with broken auth env vars)
 *     - Operator can fix in <1 min via `gcloud run services update`
 *
 *   Compare with round 23 db-dump-restore: same surface-only spectrum point
 *   for the same reason — service is mid-flight, partial success the
 *   operator can manually finish.
 */

/** Outcome of the second deployToCloudRun call (URL env-var redeploy).
 *  Always present when the redeploy was attempted; null on caller bug or
 *  when the redeploy was deliberately skipped (not-applicable). */
export interface UrlEnvRedeployOutcome {
  /** true when the second deployToCloudRun returned success=true. */
  success: boolean;
  /** Error message captured from deployToCloudRun's failure path. null on
   *  success or when caller passes null (defensive). */
  error: string | null;
}

export type UrlEnvRedeployVerdict =
  | {
      kind: 'not-applicable';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'redeploy-ok';
      logLevel: 'info';
      serviceName: string;
      patchedKeys: string[];
      message: string;
    }
  | {
      kind: 'redeploy-failed';
      logLevel: 'critical';
      serviceName: string;
      gcpProject: string;
      gcpRegion: string;
      serviceUrl: string | null;
      patchedKeys: string[];
      redeployError: string;
      errorCode: 'url_env_redeploy_drift';
      requiresOperatorAction: true;
      /** Runnable gcloud command to set the URL env vars on the live service
       *  without going through deployToCloudRun again. Mirrors round 21
       *  IAM verdict's recoveryCommand pattern. */
      recoveryCommand: string;
      message: string;
    };

export interface BuildUrlEnvRedeployVerdictInput {
  /** True iff the post-deploy URL-env-var rewrite was attempted (i.e.
   *  serviceUrl was known AND no customDomainFqdn AND at least one URL key
   *  contained localhost or empty string). When false, the verdict short-
   *  circuits to `not-applicable`. */
  applicable: boolean;
  /** Cloud Run service name (e.g. `da-myapp`). */
  serviceName: string;
  /** GCP project ID for recovery command. */
  gcpProject: string;
  /** GCP region for recovery command. */
  gcpRegion: string;
  /** Cloud Run service URL (https://...run.app) from the FIRST deploy.
   *  null when the first deploy failed to surface a URL — defensive,
   *  unlikely in practice since `applicable` requires serviceUrl truthy. */
  serviceUrl: string | null;
  /** Which URL keys were being patched (e.g. ['NEXTAUTH_URL', 'APP_URL']).
   *  Empty array when applicable=false. */
  patchedKeys: string[];
  /** Outcome of the second deployToCloudRun call. null when applicable=
   *  false (no redeploy attempted). */
  redeployOutcome: UrlEnvRedeployOutcome | null;
}

export function buildUrlEnvRedeployVerdict(
  input: BuildUrlEnvRedeployVerdictInput
): UrlEnvRedeployVerdict {
  const { applicable, serviceName, gcpProject, gcpRegion, serviceUrl, patchedKeys, redeployOutcome } = input;

  if (!applicable) {
    return {
      kind: 'not-applicable',
      logLevel: 'info',
      message:
        `URL env-var redeploy: not applicable for "${serviceName}" ` +
        `(no localhost URL keys to patch, or custom domain in use; skipping)`,
    };
  }

  // Redeploy was attempted. Inspect outcome.
  // Treat null outcome as failure too — applicable was true but no outcome
  // reported (caller bug, or deployToCloudRun never returned). End-user
  // impact identical (live service has stale localhost URLs).
  if (!redeployOutcome || !redeployOutcome.success) {
    const err = redeployOutcome?.error && redeployOutcome.error.length > 0
      ? redeployOutcome.error
      : 'redeploy outcome not reported (deployToCloudRun returned null or threw before producing a result)';
    const recoveryCommand = buildRecoveryCommand(serviceName, gcpProject, gcpRegion, serviceUrl, patchedKeys);
    return {
      kind: 'redeploy-failed',
      logLevel: 'critical',
      serviceName,
      gcpProject,
      gcpRegion,
      serviceUrl,
      patchedKeys,
      redeployError: err,
      errorCode: 'url_env_redeploy_drift',
      requiresOperatorAction: true,
      recoveryCommand,
      message:
        `URL env-var redeploy for "${serviceName}" FAILED: ${err}. ` +
        `Cloud Run service IS LIVE at ${serviceUrl ?? '(URL unknown)'} but ` +
        `revision-1 is still serving with localhost values for [${patchedKeys.join(', ')}] — ` +
        `every request that reads NEXTAUTH_URL / APP_URL (login flow, OAuth callbacks, ` +
        `cookie domain checks, server-side redirects) will hit broken state. The deploy ` +
        `notification claims success but the URL is broken for end users. ` +
        `Recover with: ${recoveryCommand}`,
    };
  }

  // Happy path.
  return {
    kind: 'redeploy-ok',
    logLevel: 'info',
    serviceName,
    patchedKeys,
    message:
      `URL env-var redeploy for "${serviceName}" OK ` +
      `(patched ${patchedKeys.length} key${patchedKeys.length === 1 ? '' : 's'}: ` +
      `[${patchedKeys.join(', ')}])`,
  };
}

/** Build the operator-runnable recovery command. Uses gcloud's `services
 *  update --update-env-vars` so the operator can patch env vars on the
 *  live service without going through deployToCloudRun again. */
function buildRecoveryCommand(
  serviceName: string,
  gcpProject: string,
  gcpRegion: string,
  serviceUrl: string | null,
  patchedKeys: string[],
): string {
  const url = serviceUrl ?? '<service-url>';
  // --update-env-vars takes comma-separated KEY=VAL pairs, all set to the
  // service URL since that's the whole point of this redeploy step.
  const envSpec = patchedKeys.length > 0
    ? patchedKeys.map((k) => `${k}=${url}`).join(',')
    : `NEXTAUTH_URL=${url}`;
  return (
    `gcloud run services update ${serviceName} ` +
    `--region=${gcpRegion} --project=${gcpProject} ` +
    `--update-env-vars=${envSpec}`
  );
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Critical verdicts use console.error with `[CRITICAL errorCode=X]`
 *  prefix that operators can grep on Cloud Run logs. */
export function logUrlEnvRedeployVerdict(verdict: UrlEnvRedeployVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Deploy] ${verdict.message}`);
      return;
    case 'critical':
      console.error(`[Deploy] [CRITICAL errorCode=${verdict.errorCode}] ${verdict.message}`);
      return;
  }
}
