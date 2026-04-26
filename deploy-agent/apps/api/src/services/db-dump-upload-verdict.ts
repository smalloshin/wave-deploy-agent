/**
 * DB dump upload verdict — round 23 (upload phase, 4 sites).
 *
 * Why this is its own file:
 *   The user can attach a Postgres dump (.sql / .dump / .sql.gz) to a project
 *   submission. We upload that dump to GCS at submit-time and persist
 *   `gcsDbDumpUri` (and `dbDumpFileName`) into project.config so the deploy-
 *   worker can later download + restore it into the freshly-provisioned
 *   Cloud SQL database.
 *
 *   Pre-round-23, FOUR copies of this swallow pattern existed:
 *
 *     try {
 *       gcsDbDumpUri = await uploadDbDumpToGcs(slug, buf, fileName);
 *     } catch (err) {
 *       console.error(`[Upload] DB dump upload failed:`, (err as Error).message);
 *     }
 *     // ... carry on with createProject / runPipeline anyway
 *
 *   Locations:
 *     - routes/projects.ts:783-792  — submit (git path, pre-createProject)
 *     - routes/projects.ts:953-961  — submit (multipart monorepo, pre-createProject)
 *     - routes/projects.ts:1141-1148 — submit (multipart single-service background IIFE,
 *                                       AFTER createProject — uses updateProjectConfig)
 *     - routes/mcp.ts:194-212        — MCP submit_project (pre-createProject)
 *
 *   Bug: when uploadDbDumpToGcs throws (GCS quota / 5xx / auth blip / DB blip
 *   on the post-create persist call), the only signal is one console.error
 *   line. Then:
 *
 *     1. createProject (or the existing project) gets gcsDbDumpUri = undefined
 *     2. Pipeline runs (round 22 protected this from a separate bug)
 *     3. scan_report green, reviewer approves deploy
 *     4. deploy-worker Step 2c-2 (services/deploy-worker.ts:551-617) reads
 *        project.config.gcsDbDumpUri → undefined → SKIPS DB restore entirely
 *     5. App ships, boots against an EMPTY freshly-provisioned database,
 *        every API call returns 500 because the schema isn't there
 *     6. User: "deploy succeeded but the app is broken" — the upload failure
 *        at minute 0 surfaces as a 500-storm 30+ minutes later
 *
 *   Fix mirrors round 22's source-upload-verdict: pure-function verdict
 *   captures (upload, persist) outcomes, with FOUR kinds:
 *
 *     1. `not-applicable` — no dump provided. info, no-op.
 *
 *     2. `upload-and-persist-ok` — both succeeded. info. Pipeline proceeds.
 *
 *     3. `upload-failed` — uploadDbDumpToGcs threw or returned no URI.
 *        Bytes never landed in GCS. logLevel=critical,
 *        errorCode='db_dump_upload_failed', requiresOperatorAction=true,
 *        blockPipeline=true. Caller MUST transition project to a 'failed'
 *        state and skip runPipeline (or skip createProject, depending on
 *        site). Without the dump, the deployed app boots against an empty
 *        DB and 500s on every read — better to fail loudly at submit.
 *
 *     4. `upload-ok-persist-failed` — bytes ARE in GCS at the carried
 *        gcsUri but updateProjectConfig threw. Recoverable: operator can
 *        UPDATE projects SET config = jsonb_set(...) without re-uploading.
 *        logLevel=critical, errorCode='db_dump_persist_drift',
 *        requiresOperatorAction=true, blockPipeline=false. Pipeline runs
 *        anyway (deploy-worker reads config later, so an operator can patch
 *        in parallel before the deploy approval).
 *
 *   Crucial design decision (mirrors round 22 blockPipeline): the verdict
 *   has `blockPipeline: true` on `upload-failed` only — this is the same
 *   third flow-control flag round 22 introduced. The pre-createProject sites
 *   (3 of 4) interpret blockPipeline=true as "do NOT call createProject /
 *   return 4xx to the caller", and the post-createProject site interprets
 *   it as "transitionProject(id, 'failed') + skip runPipeline" — the SAME
 *   flag drives different control-flow choices appropriate to the site.
 *
 *   Why `upload-ok-persist-failed` does NOT block: bytes are in GCS, deploy-
 *   worker reads `gcsDbDumpUri` from project.config much later, and the
 *   verdict carries the URI so an operator can patch config in <1 minute
 *   before deploy approval (similar to round 22's source persist drift).
 *
 *   Pre-createProject sites (git, multipart-monorepo, MCP) currently fold
 *   the dump URI into createProject's config arg — they have no separate
 *   persist step. For those sites we call `buildDbDumpUploadVerdict` directly
 *   with `persist: null` after the upload outcome is known; the helper
 *   `uploadAndPersistDbDumpWithVerdict` is for the post-createProject IIFE
 *   only (line 1141), where a real updateProjectConfig persist step exists.
 */

/** Outcome of the uploadDbDumpToGcs call (the GCS PUT). */
export interface DbDumpUploadOutcome {
  ok: boolean;
  /** GCS URI like `gs://wave-deploy-agent_cloudbuild/db-dumps/<slug>-<ts>-<file>`
   *  when ok=true. null when ok=false. */
  gcsUri: string | null;
  /** Error message when ok=false. null on success. */
  error: string | null;
}

/** Outcome of the updateProjectConfig DB write (post-createProject site only). */
export interface DbDumpPersistOutcome {
  ok: boolean;
  error: string | null;
}

export type DbDumpUploadVerdict =
  | {
      kind: 'not-applicable';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'upload-and-persist-ok';
      logLevel: 'info';
      gcsUri: string;
      dumpFileName: string;
      message: string;
    }
  | {
      kind: 'upload-failed';
      logLevel: 'critical';
      uploadError: string;
      dumpFileName: string;
      errorCode: 'db_dump_upload_failed';
      requiresOperatorAction: true;
      /** Pipeline must NOT start (post-create) / project must NOT be created
       *  (pre-create) — without the dump in GCS the deployed app will boot
       *  against an empty database and 500 on every API call 30+ minutes
       *  later. Caller transitions project to 'failed' (post-create) or
       *  returns a 4xx to the user (pre-create) and skips downstream. */
      blockPipeline: true;
      message: string;
    }
  | {
      kind: 'upload-ok-persist-failed';
      logLevel: 'critical';
      /** Recoverable: operator can patch project.config to point at this
       *  URI without re-uploading. */
      gcsUri: string;
      dumpFileName: string;
      persistError: string;
      errorCode: 'db_dump_persist_drift';
      requiresOperatorAction: true;
      /** Bytes are in GCS; deploy-worker reads config later. Not blocking
       *  lets the user see scan progress while the operator patches config
       *  in parallel before deploy approval. */
      blockPipeline: false;
      message: string;
    };

export interface BuildDbDumpUploadVerdictInput {
  /** Project label for log messages (project name, slug, or "<group>/<service>"
   *  for monorepo siblings). */
  projectLabel: string;
  /** Original dump filename (e.g. "production-2026-04-25.sql.gz"). Empty
   *  string when no dump was provided — verdict short-circuits to
   *  `not-applicable` in that case. */
  dumpFileName: string;
  /** null when no dump provided (short-circuits to not-applicable). */
  upload: DbDumpUploadOutcome | null;
  /** null when upload failed (we don't attempt persist if there's no URI
   *  to persist) OR when the site folds the URI into createProject (3 of 4
   *  sites). */
  persist: DbDumpPersistOutcome | null;
}

export function buildDbDumpUploadVerdict(
  input: BuildDbDumpUploadVerdictInput
): DbDumpUploadVerdict {
  const { projectLabel, dumpFileName, upload, persist } = input;

  // No dump provided — nothing to upload, nothing to surface.
  if (!upload) {
    return {
      kind: 'not-applicable',
      logLevel: 'info',
      message: `No DB dump provided for "${projectLabel}" — skipping dump upload`,
    };
  }

  // Upload failure dominates — bytes never reached GCS.
  if (!upload.ok || !upload.gcsUri) {
    const err = upload.error ?? 'upload outcome reported !ok with no error';
    return {
      kind: 'upload-failed',
      logLevel: 'critical',
      uploadError: err,
      dumpFileName,
      errorCode: 'db_dump_upload_failed',
      requiresOperatorAction: true,
      blockPipeline: true,
      message:
        `DB dump upload for "${projectLabel}" FAILED: ${err}. ` +
        `Dump file "${dumpFileName}" never reached GCS — pipeline must not ` +
        `proceed because the deployed app will boot against an empty database ` +
        `and 500 on every API call 30+ minutes from now. Project transitions ` +
        `to 'failed' (or submission returns 4xx); user must re-submit with the dump.`,
    };
  }

  // Upload OK but persist failed (or wasn't attempted by a post-create site).
  if (!persist || !persist.ok) {
    const err = persist?.error ?? 'persist not attempted';
    return {
      kind: 'upload-ok-persist-failed',
      logLevel: 'critical',
      gcsUri: upload.gcsUri,
      dumpFileName,
      persistError: err,
      errorCode: 'db_dump_persist_drift',
      requiresOperatorAction: true,
      blockPipeline: false,
      message:
        `DB dump upload for "${projectLabel}" succeeded ` +
        `(bytes at ${upload.gcsUri}, file "${dumpFileName}") but persisting ` +
        `gcsDbDumpUri to project.config FAILED: ${err}. Recover with: ` +
        `UPDATE projects SET config = jsonb_set(config, '{gcsDbDumpUri}', ` +
        `'"${upload.gcsUri}"'::jsonb) WHERE id = '<projectId>'. Pipeline ` +
        `will continue so the user sees scan progress; operator MUST patch ` +
        `config before deploy approval, otherwise the deploy will boot ` +
        `against an empty DB and 500.`,
    };
  }

  return {
    kind: 'upload-and-persist-ok',
    logLevel: 'info',
    gcsUri: upload.gcsUri,
    dumpFileName,
    message:
      `DB dump upload for "${projectLabel}" OK ` +
      `(${upload.gcsUri}, file "${dumpFileName}", gcsDbDumpUri persisted)`,
  };
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Critical verdicts use console.error with `[CRITICAL errorCode=X]`
 *  prefix that operators can grep on Cloud Run logs. */
export function logDbDumpUploadVerdict(verdict: DbDumpUploadVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[DbDumpUpload] ${verdict.message}`);
      return;
    case 'critical': {
      const errorCode =
        verdict.kind === 'upload-failed'
          ? verdict.errorCode
          : verdict.kind === 'upload-ok-persist-failed'
            ? verdict.errorCode
            : '';
      console.error(`[DbDumpUpload] [CRITICAL errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
  }
}

/**
 * Orchestration helper for the post-createProject IIFE site
 * (routes/projects.ts:1141-1148 — multipart single-service background IIFE).
 *
 * Performs:
 *   1. Calls `runUpload` and captures the DbDumpUploadOutcome.
 *   2. If upload OK, calls `runPersist(gcsUri)` and captures the DbDumpPersistOutcome.
 *   3. Builds the verdict and logs it.
 *   4. Returns the verdict so the caller can branch on `blockPipeline`.
 *
 * The caller (the former IIFE) then does:
 *
 *     const verdict = await uploadAndPersistDbDumpWithVerdict({
 *       projectLabel,
 *       dumpFileName,
 *       runUpload: () => uploadDbDumpToGcs(slug, buf, fileName),
 *       runPersist: (gcsUri) => updateProjectConfig(projectId, {
 *         ...(current.config ?? {}), gcsDbDumpUri: gcsUri, dbDumpFileName: fileName,
 *       }),
 *     });
 *     if (verdict.kind === 'upload-failed') {
 *       await transitionProject(projectId, 'failed', 'system', {
 *         error: verdict.uploadError,
 *         errorCode: verdict.errorCode,
 *         failedStep: 'background db dump upload',
 *       });
 *       return;  // do NOT runPipeline
 *     }
 *     runPipeline(projectId, dir).catch(...);
 *
 * The 3 pre-createProject sites do NOT use this helper — they call
 * `buildDbDumpUploadVerdict` directly with `persist: null` because the URI
 * is folded into the createProject({ config }) call.
 */
export async function uploadAndPersistDbDumpWithVerdict(args: {
  projectLabel: string;
  dumpFileName: string;
  runUpload: () => Promise<string>;
  runPersist: (gcsUri: string) => Promise<void>;
}): Promise<DbDumpUploadVerdict> {
  let upload: DbDumpUploadOutcome = { ok: false, gcsUri: null, error: 'upload not attempted' };
  let persist: DbDumpPersistOutcome | null = null;

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

  const verdict = buildDbDumpUploadVerdict({
    projectLabel: args.projectLabel,
    dumpFileName: args.dumpFileName,
    upload,
    persist,
  });
  logDbDumpUploadVerdict(verdict);
  return verdict;
}
