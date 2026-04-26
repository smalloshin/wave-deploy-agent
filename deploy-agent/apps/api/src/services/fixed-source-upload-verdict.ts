/**
 * Fixed-source upload verdict — round 20.
 *
 * Why this is its own file (and why this is the most important verdict yet):
 *   pipeline-worker.ts:264-301 had Step 6a wrapped in a try/catch that
 *   ONLY emitted console.warn:
 *
 *     try {
 *       // tar projectDir → GCS upload → set project.config.gcsFixedSourceUri
 *       const tarball = ...;
 *       const uploadRes = await gcpFetch(uploadUrl, ...);
 *       if (!uploadRes.ok) throw new Error(`GCS upload failed (${uploadRes.status}): ...`);
 *       await dbQuery(`UPDATE projects SET config = config || $1::jsonb ...`, ...);
 *     } catch (err) {
 *       console.warn(`Fixed source re-upload failed (non-fatal): ${...}`);
 *       console.warn(`Deploy will fall back to original gcsSourceUri (AI fixes will NOT be in Docker image)`);
 *     }
 *
 *   The author wrote a confession comment — they KNEW this was wrong but
 *   marked it `non-fatal` and moved on.
 *
 *   Why this is the security flagship lie of the entire product:
 *
 *     wave-deploy-agent's whole pitch is "vibe-coded safety gate" —
 *     scan + AI auto-fix + reviewer approval before deploy. The pipeline
 *     mutates `projectDir` in-place (Step 2 generates a Dockerfile if
 *     missing, Step 5 applies AI security fixes via string replacement).
 *     Step 6a re-uploads the MUTATED projectDir to a separate GCS path
 *     `sources-fixed/...` and writes that path into
 *     `project.config.gcsFixedSourceUri`. deploy-engine reads
 *     `gcsFixedSourceUri` (preferred) OR falls back to `gcsSourceUri`
 *     (original, untouched bytes from upload).
 *
 *     If Step 6a's try/catch swallows:
 *       1. scan_report still gets status='completed' (line 346) — reviewer
 *          dashboard shows green
 *       2. autoFixes log shows `appliedCount/N fixes applied`
 *       3. verificationResults shows reduced findings (post-fix scan)
 *       4. Reviewer sees all of the above, approves deploy
 *       5. deploy-engine has no `gcsFixedSourceUri` → falls back to
 *          `gcsSourceUri` (ORIGINAL VULNERABLE CODE)
 *       6. Cloud Run deploys the unfixed image with the CVE/security
 *          finding still in it
 *
 *     The reviewer approved a fix that didn't ship. The product LIED
 *     about its core function.
 *
 *   Two distinct sub-failure modes:
 *
 *     A. tar/getProject/auth/GCS-upload failed (or returned !ok):
 *        Bytes never made it to GCS. Recovery: re-run pipeline.
 *        errorCode='fixed_source_upload_failed'.
 *
 *     B. GCS upload succeeded but `UPDATE projects SET config = ...`
 *        threw: bytes ARE in `gs://wave-deploy-agent_cloudbuild/sources-fixed/...`
 *        but `project.config.gcsFixedSourceUri` is empty. End-user impact
 *        is identical (deploy uses original). Recovery is different:
 *        operator can manually set project.config.gcsFixedSourceUri to
 *        the recoverable URI without re-running the whole pipeline.
 *        errorCode='fixed_source_db_drift'.
 *
 *   The fix mirrors round 13/14/15/16/17/18/19: pure verdict module
 *   captures both outcomes structurally; the orchestrator (pipeline-worker)
 *   uses the verdict to decide whether to mark scan_report status='completed'
 *   or status='failed', AND surfaces the verdict via critical logs with
 *   errorCode for dashboard contracts.
 *
 *   Crucial difference from prior rounds: this verdict carries
 *   `blockApproval: true` on both critical kinds, telling the
 *   orchestrator that scan_report MUST NOT be marked status='completed'
 *   (because then the reviewer would approve a non-existent fix). This
 *   is the FIRST verdict that affects user-facing flow control, not just
 *   logs.
 */

/** Outcome of step 6a parts 1-3: getProject + tar + GCS upload bundled
 *  together because the legacy try/catch wrapped them as a unit and
 *  any one of them failing has the same end effect (no fixed bytes
 *  uploaded). */
export interface TarballAndUploadOutcome {
  ok: boolean;
  /** GCS URI like `gs://wave-deploy-agent_cloudbuild/sources-fixed/<slug>-<ts>.tgz`
   *  when ok=true. null when ok=false. */
  gcsUri: string | null;
  /** Bytes uploaded when ok=true. 0 when ok=false. */
  bytes: number;
  /** Error message when ok=false. Should include a failure-mode discriminator
   *  prefix ('get-project-failed:', 'tar-failed:', 'upload-failed:') so
   *  operators can grep which step blew up. */
  error: string | null;
}

/** Outcome of step 6a part 4: persisting gcsFixedSourceUri to
 *  project.config via dbQuery UPDATE. */
export interface DbPersistOutcome {
  ok: boolean;
  /** Error message when ok=false. */
  error: string | null;
}

/**
 * Four verdict kinds covering the (applicable, tarball, db) outcome lattice:
 *
 *   1. `not-applicable` — Step 6a has nothing to do because nothing in
 *      projectDir was mutated (no Dockerfile generated AND no AI fixes
 *      applied). The original gcsSourceUri is correct as-is. info.
 *
 *   2. `success` — tarball + upload OK + DB persist OK. info.
 *
 *   3. `tarball-or-upload-failed` — bytes never made it to GCS.
 *      THIS IS A ROUND-20 CRITICAL TARGET. Reviewer would otherwise
 *      approve a "fix" that doesn't exist in any deployable artifact.
 *      logLevel=critical, errorCode='fixed_source_upload_failed',
 *      requiresOperatorAction=true, blockApproval=true.
 *
 *   4. `db-persist-failed-after-upload` — bytes ARE in GCS but
 *      project.config doesn't point at them. Same end-user impact
 *      (deploy uses original unfixed source) but recoverable by manually
 *      setting project.config.gcsFixedSourceUri to the carried gcsUri.
 *      logLevel=critical, errorCode='fixed_source_db_drift',
 *      requiresOperatorAction=true, blockApproval=true.
 *      The verdict carries gcsUri so the recovery script knows what URI
 *      to set without searching the bucket.
 */
export type FixedSourceUploadVerdict =
  | {
      kind: 'not-applicable';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'success';
      logLevel: 'info';
      gcsUri: string;
      bytes: number;
      message: string;
    }
  | {
      kind: 'tarball-or-upload-failed';
      logLevel: 'critical';
      tarballError: string;
      errorCode: 'fixed_source_upload_failed';
      requiresOperatorAction: true;
      /** Tells the orchestrator: do NOT mark scan_report status='completed'
       *  because the reviewer would approve a non-existent fix. */
      blockApproval: true;
      message: string;
    }
  | {
      kind: 'db-persist-failed-after-upload';
      logLevel: 'critical';
      /** Recoverable URI — operator can set project.config.gcsFixedSourceUri
       *  to this without re-running the pipeline. */
      gcsUri: string;
      bytes: number;
      dbError: string;
      errorCode: 'fixed_source_db_drift';
      requiresOperatorAction: true;
      blockApproval: true;
      message: string;
    };

export interface BuildFixedSourceUploadVerdictInput {
  /** True when projectDir was mutated and a re-upload is required.
   *  When false, the verdict short-circuits to `not-applicable` regardless
   *  of the other inputs (mutation-free pipeline runs are common — existing
   *  Dockerfile + zero AI fixes applied). */
  applicable: boolean;
  /** Project slug/name for log messages. */
  projectLabel: string;
  /** null when applicable=false. */
  tarballAndUpload: TarballAndUploadOutcome | null;
  /** null when applicable=false OR when tarballAndUpload failed (we don't
   *  attempt DB persist if there's no URI to persist). */
  dbPersist: DbPersistOutcome | null;
}

export function buildFixedSourceUploadVerdict(
  input: BuildFixedSourceUploadVerdictInput
): FixedSourceUploadVerdict {
  const { applicable, projectLabel } = input;

  if (!applicable) {
    return {
      kind: 'not-applicable',
      logLevel: 'info',
      message:
        `Fixed-source upload: not applicable for "${projectLabel}" ` +
        `(no Dockerfile generated and no AI fixes applied; original ` +
        `gcsSourceUri is sufficient)`,
    };
  }

  // Tarball/upload failure dominates. Either the orchestrator never tried
  // (null) or the bundled outcome reports !ok.
  if (!input.tarballAndUpload || !input.tarballAndUpload.ok) {
    const err = input.tarballAndUpload?.error ?? 'tarball/upload not attempted';
    return {
      kind: 'tarball-or-upload-failed',
      logLevel: 'critical',
      tarballError: err,
      errorCode: 'fixed_source_upload_failed',
      requiresOperatorAction: true,
      blockApproval: true,
      message:
        `Fixed-source upload for "${projectLabel}" FAILED: ${err}. ` +
        `The pipeline mutated projectDir (Dockerfile and/or AI fixes) but ` +
        `the mutated bytes were never uploaded to GCS. ` +
        `If the reviewer approves and deploys, Cloud Run will run the ` +
        `ORIGINAL UNFIXED source. Mark scan report as failed and re-run ` +
        `the pipeline.`,
    };
  }

  // Tarball OK but DB persist failed (or wasn't attempted with no signal).
  if (!input.dbPersist || !input.dbPersist.ok) {
    const err = input.dbPersist?.error ?? 'db persist not attempted';
    return {
      kind: 'db-persist-failed-after-upload',
      logLevel: 'critical',
      gcsUri: input.tarballAndUpload.gcsUri ?? '',
      bytes: input.tarballAndUpload.bytes,
      dbError: err,
      errorCode: 'fixed_source_db_drift',
      requiresOperatorAction: true,
      blockApproval: true,
      message:
        `Fixed-source upload for "${projectLabel}" succeeded ` +
        `(${input.tarballAndUpload.bytes} bytes at ${input.tarballAndUpload.gcsUri}) ` +
        `but persisting gcsFixedSourceUri to project.config FAILED: ${err}. ` +
        `Bytes are recoverable — manually set project.config.gcsFixedSourceUri = ` +
        `'${input.tarballAndUpload.gcsUri}' to unblock deploy. ` +
        `Otherwise the deploy will use the ORIGINAL UNFIXED source.`,
    };
  }

  return {
    kind: 'success',
    logLevel: 'info',
    gcsUri: input.tarballAndUpload.gcsUri ?? '',
    bytes: input.tarballAndUpload.bytes,
    message:
      `Fixed-source upload for "${projectLabel}" OK ` +
      `(${input.tarballAndUpload.bytes} bytes → ${input.tarballAndUpload.gcsUri}, ` +
      `gcsFixedSourceUri persisted)`,
  };
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Critical verdicts use console.error with `[CRITICAL errorCode=X]`
 *  prefix that operators can grep on Cloud Run logs. */
export function logFixedSourceUploadVerdict(verdict: FixedSourceUploadVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Pipeline] ${verdict.message}`);
      return;
    case 'critical': {
      const errorCode =
        verdict.kind === 'tarball-or-upload-failed'
          ? verdict.errorCode
          : verdict.kind === 'db-persist-failed-after-upload'
            ? verdict.errorCode
            : '';
      console.error(`[Pipeline] [CRITICAL errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
  }
}
