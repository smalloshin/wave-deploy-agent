/**
 * Source upload verdict — round 22.
 *
 * Why this is its own file:
 *   routes/projects.ts had FOUR copies of this background-IIFE pattern:
 *
 *     (async () => {
 *       try {
 *         const gcsSourceUri = await uploadSourceToGcs(...);
 *         const current = await getProject(projectId);
 *         await updateProjectConfig(projectId, { ...(current?.config ?? {}), gcsSourceUri });
 *       } catch (err) {
 *         console.error(`[GCS Submit] Background GCS repack failed:`, ...);
 *       }
 *       runPipeline(projectId, projectDir).catch(...); // ← runs UNCONDITIONALLY
 *     })();
 *
 *   Locations:
 *     - routes/projects.ts:606-617 — submit-gcs monorepo path (per sibling)
 *     - routes/projects.ts:656-667 — submit-gcs single-service path
 *     - routes/projects.ts:1024-1035 — multipart upload monorepo path (per sibling)
 *     - routes/projects.ts:1069-1092 — multipart upload single-service path
 *
 *   Bug: when uploadSourceToGcs throws (network blip, GCS quota, auth blip,
 *   GCS 5xx) OR when updateProjectConfig throws (DB blip), the only signal
 *   is one console.error line. THEN the pipeline still runs because
 *   runPipeline is OUTSIDE the catch.
 *
 *   End-user failure chain:
 *     1. User submits project → 201 with project ID, status='scanning'
 *     2. Background IIFE: uploadSourceToGcs throws
 *     3. console.error logged (drowned in noise, no DB write)
 *     4. project.config.gcsSourceUri stays undefined
 *     5. runPipeline kicks off anyway — scanner runs against the local
 *        /tmp/<extracted> dir which still exists, scan_report writes OK
 *        with status='completed'
 *     6. Reviewer sees green, approves deploy
 *     7. deploy-engine looks up project.config.gcsSourceUri to feed Cloud
 *        Build → it's undefined → Cloud Build fails with cryptic
 *        "source URI required" error 30+ minutes after the original upload blip
 *     8. User: "deploy is broken" — root cause was at minute 0, surfaced
 *        as a deploy error at minute 30+
 *
 *   Fix mirrors prior rounds: pure-function verdict captures (upload, persist)
 *   outcomes; an orchestration helper threads the verdict and decides whether
 *   to kick the pipeline. Three kinds:
 *
 *     1. `upload-and-persist-ok` — both succeeded. info. Pipeline proceeds.
 *
 *     2. `upload-failed` — uploadSourceToGcs threw or returned no URI.
 *        Bytes never landed in GCS. logLevel=critical,
 *        errorCode='source_upload_failed', requiresOperatorAction=true,
 *        blockPipeline=true. Caller MUST transition project to a 'failed'
 *        state and skip runPipeline (otherwise the user gets the misleading
 *        scan_report → reviewer approval → deploy-engine cryptic failure
 *        chain described above).
 *
 *     3. `upload-ok-persist-failed` — bytes ARE in GCS at the carried
 *        gcsUri but updateProjectConfig threw. Recoverable: operator can
 *        UPDATE projects SET config = jsonb_set(config, '{gcsSourceUri}', ...)
 *        without re-uploading. logLevel=critical,
 *        errorCode='source_upload_persist_drift', requiresOperatorAction=true,
 *        blockPipeline=false. Pipeline scanner runs against /tmp anyway,
 *        and the verdict carries the recoverable URI so an operator can
 *        repair config in <1 minute (similar to round 20's
 *        fixed_source_db_drift recovery).
 *
 *   Crucial design decision (mirrors round 20 blockApproval): the verdict
 *   has `blockPipeline: true` on `upload-failed` only. This is the second
 *   verdict that affects user-facing flow control. Round 20 gates reviewer
 *   approval; round 22 gates whether the pipeline even starts. The reason
 *   to gate the pipeline (not just emit a critical log) is that pipeline
 *   completion + scan_report status='completed' is what triggers reviewer
 *   notification — without gating, the misleading green light still goes
 *   out.
 *
 *   Why `upload-ok-persist-failed` does NOT block: bytes are in GCS,
 *   pipeline scanner runs against /tmp regardless, and deploy-engine has
 *   a recoverable path (operator can patch project.config from the verdict
 *   payload before deploy approval). Different recovery surface than
 *   `upload-failed`.
 */

/** Outcome of the uploadSourceToGcs call (the GCS PUT). */
export interface SourceUploadOutcome {
  ok: boolean;
  /** GCS URI like `gs://wave-deploy-agent_cloudbuild/sources/<slug>-<ts>.tgz`
   *  when ok=true. null when ok=false. */
  gcsUri: string | null;
  /** Error message when ok=false. null on success. */
  error: string | null;
}

/** Outcome of the updateProjectConfig DB write. */
export interface SourcePersistOutcome {
  ok: boolean;
  error: string | null;
}

export type SourceUploadVerdict =
  | {
      kind: 'upload-and-persist-ok';
      logLevel: 'info';
      gcsUri: string;
      message: string;
    }
  | {
      kind: 'upload-failed';
      logLevel: 'critical';
      uploadError: string;
      errorCode: 'source_upload_failed';
      requiresOperatorAction: true;
      /** Pipeline must NOT start — without GCS source the deploy will fail
       *  cryptically 30+ minutes later. Caller transitions project to
       *  'failed' and skips runPipeline. */
      blockPipeline: true;
      message: string;
    }
  | {
      kind: 'upload-ok-persist-failed';
      logLevel: 'critical';
      /** Recoverable: operator can patch project.config to point at this
       *  URI without re-uploading. */
      gcsUri: string;
      persistError: string;
      errorCode: 'source_upload_persist_drift';
      requiresOperatorAction: true;
      /** Pipeline scanner runs against the local /tmp source either way;
       *  not blocking lets the user see the scan result while the operator
       *  patches config in parallel. */
      blockPipeline: false;
      message: string;
    };

export interface BuildSourceUploadVerdictInput {
  /** Project label for log messages (project name, or "<monorepo>/<service>"
   *  for monorepo siblings). */
  projectLabel: string;
  upload: SourceUploadOutcome;
  /** null when upload failed (we don't attempt persist if there's no URI
   *  to persist). */
  persist: SourcePersistOutcome | null;
}

export function buildSourceUploadVerdict(
  input: BuildSourceUploadVerdictInput
): SourceUploadVerdict {
  const { projectLabel, upload, persist } = input;

  // Upload failure dominates — bytes never reached GCS.
  if (!upload.ok || !upload.gcsUri) {
    const err = upload.error ?? 'upload outcome reported !ok with no error';
    return {
      kind: 'upload-failed',
      logLevel: 'critical',
      uploadError: err,
      errorCode: 'source_upload_failed',
      requiresOperatorAction: true,
      blockPipeline: true,
      message:
        `Source upload for "${projectLabel}" FAILED: ${err}. ` +
        `No bytes in GCS — pipeline must not run because the eventual ` +
        `deploy will fail cryptically with "source URI required" 30+ ` +
        `minutes from now. Project transitions to 'failed'; user must re-upload.`,
    };
  }

  // Upload OK but persist failed (or wasn't attempted).
  if (!persist || !persist.ok) {
    const err = persist?.error ?? 'persist not attempted';
    return {
      kind: 'upload-ok-persist-failed',
      logLevel: 'critical',
      gcsUri: upload.gcsUri,
      persistError: err,
      errorCode: 'source_upload_persist_drift',
      requiresOperatorAction: true,
      blockPipeline: false,
      message:
        `Source upload for "${projectLabel}" succeeded ` +
        `(bytes at ${upload.gcsUri}) but persisting gcsSourceUri to ` +
        `project.config FAILED: ${err}. Recover with: UPDATE projects SET ` +
        `config = jsonb_set(config, '{gcsSourceUri}', '"${upload.gcsUri}"'::jsonb) ` +
        `WHERE id = '<projectId>'. Pipeline will continue against the local ` +
        `extracted source so the user sees scan progress; operator must ` +
        `patch config before deploy approval.`,
    };
  }

  return {
    kind: 'upload-and-persist-ok',
    logLevel: 'info',
    gcsUri: upload.gcsUri,
    message:
      `Source upload for "${projectLabel}" OK ` +
      `(${upload.gcsUri}, gcsSourceUri persisted)`,
  };
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Critical verdicts use console.error with `[CRITICAL errorCode=X]`
 *  prefix that operators can grep on Cloud Run logs. */
export function logSourceUploadVerdict(verdict: SourceUploadVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Upload] ${verdict.message}`);
      return;
    case 'critical': {
      const errorCode =
        verdict.kind === 'upload-failed'
          ? verdict.errorCode
          : verdict.kind === 'upload-ok-persist-failed'
            ? verdict.errorCode
            : '';
      console.error(`[Upload] [CRITICAL errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
  }
}

/**
 * Orchestration helper to dedupe the four IIFE call sites in routes/projects.ts.
 *
 * Performs:
 *   1. Calls `runUpload` and captures the SourceUploadOutcome.
 *   2. If upload OK, calls `runPersist(gcsUri)` and captures the SourcePersistOutcome.
 *   3. Builds the verdict and logs it.
 *   4. Returns the verdict so the caller can branch on `blockPipeline`.
 *
 * The caller (each former IIFE) then does:
 *
 *     const verdict = await uploadAndPersistSourceWithVerdict({
 *       projectLabel,
 *       runUpload: () => uploadSourceToGcs(slug, dir),
 *       runPersist: (gcsUri) => persistGcsUri(projectId, gcsUri),
 *     });
 *     if (verdict.kind === 'upload-failed') {
 *       await transitionProject(projectId, 'failed', 'system', { error: verdict.uploadError, errorCode: verdict.errorCode });
 *       return;  // do NOT runPipeline
 *     }
 *     runPipeline(projectId, dir).catch(...);
 */
export async function uploadAndPersistSourceWithVerdict(args: {
  projectLabel: string;
  runUpload: () => Promise<string>;
  runPersist: (gcsUri: string) => Promise<void>;
}): Promise<SourceUploadVerdict> {
  let upload: SourceUploadOutcome = { ok: false, gcsUri: null, error: 'upload not attempted' };
  let persist: SourcePersistOutcome | null = null;

  try {
    const gcsUri = await args.runUpload();
    upload = { ok: true, gcsUri, error: null };
  } catch (err) {
    upload = { ok: false, gcsUri: null, error: (err as Error).message };
  }

  if (upload.ok && upload.gcsUri) {
    try {
      await args.runPersist(upload.gcsUri);
      persist = { ok: true, error: null };
    } catch (err) {
      persist = { ok: false, error: (err as Error).message };
    }
  }

  const verdict = buildSourceUploadVerdict({
    projectLabel: args.projectLabel,
    upload,
    persist,
  });
  logSourceUploadVerdict(verdict);
  return verdict;
}
