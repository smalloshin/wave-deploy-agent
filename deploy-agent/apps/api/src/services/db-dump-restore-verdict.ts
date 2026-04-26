/**
 * DB dump restore verdict — round 23 (restore phase, deploy-worker).
 *
 * Why this is its own file (split from db-dump-upload-verdict.ts):
 *   The upload phase happens at submit-time across 4 routes call sites; the
 *   restore phase happens once, mid-deploy, in services/deploy-worker.ts.
 *   Different control-flow shape, different gating semantics: upload-failed
 *   blocks the pipeline (round 22 pattern), but restore-failed can NOT block
 *   the deploy because the service is already mid-deploy and about to live —
 *   blocking would orphan a half-built Cloud Run revision. Splitting keeps
 *   each module short and the discriminated unions readable.
 *
 *   Pre-round-23 swallow at deploy-worker.ts:551-617:
 *
 *     try {
 *       // ... download dump from GCS, find dbUrl ...
 *       const restoreResult = await restoreDbDump({ ... });
 *       if (restoreResult.success) {
 *         console.log(`[Deploy]   DB dump restored successfully (...)`);
 *       } else {
 *         console.warn(`[Deploy]   ⚠ DB dump restore had errors: ${restoreResult.error}`);
 *         console.warn(`[Deploy]   Continuing deployment — the app may need manual DB setup`);
 *       }
 *       // dbRestoreResult written to project.config (best-effort, swallowed)
 *     } catch (err) {
 *       console.error(`[Deploy]   DB dump restore failed: ${(err as Error).message}`);
 *       console.warn(`[Deploy]   Continuing deployment without DB restore`);
 *     }
 *
 *   Two failure modes, both silent at the dashboard level:
 *
 *   A) Inner failure (`restoreResult.success === false`):
 *      psql / pg_restore returned non-zero (foreign-key violations, syntax
 *      errors in dump, partial table truncation, etc.). DB is in a HALF-
 *      LOADED state — some tables present, some empty, some half-imported
 *      with broken foreign keys. The app boots, immediately starts hitting
 *      foreign-key violations on every write, every API request 500s. User
 *      sees "deploy succeeded" + green status + a service URL that returns
 *      500 the moment any user tries to use it.
 *
 *   B) Outer catch (download / dbUrl-missing / pre-restore failures):
 *      GCS download failed (5xx, auth blip), or the project's DATABASE_URL
 *      didn't make it into finalEnvVars (db-provisioner blip), or temp file
 *      write threw. DB never touched. App boots against an empty database,
 *      every API call 500s. Same visible symptom as the upload-failed bug
 *      from the upload phase, but surfacing 30+ minutes later in the deploy
 *      timeline.
 *
 *   Three verdict kinds:
 *
 *     1. `not-applicable` — no `gcsDbDumpUri` on project.config OR
 *        needsCloudSql=false. info, no-op. Mirrors the existing line-553
 *        guard, but moved into the verdict module for symmetry with
 *        db-dump-upload-verdict's `not-applicable` kind.
 *
 *     2. `restore-ok` — restoreDbDump returned success=true. info. Carries
 *        format / durationMs / bytesRestored for the existing dashboard
 *        config write.
 *
 *     3. `restore-failed` — restoreDbDump returned success=false OR the
 *        outer try/catch fired (download / dbUrl-missing / pre-restore).
 *        logLevel=critical, errorCode='db_dump_restore_drift',
 *        requiresOperatorAction=true. Carries `gcsDbDumpUri` + `dumpFileName`
 *        + `connectionStringHint` so the operator can re-run the restore
 *        manually via psql / pg_restore (recovery command pre-formatted in
 *        the message similar to round 21's recoveryCommand).
 *
 *   Crucial design decision: restore-failed has NO `blockDeploy` field.
 *   Round 20 introduced `blockApproval`, round 22 introduced `blockPipeline`,
 *   round 23 deliberately does NOT introduce `blockDeploy` because:
 *     - The deploy is mid-flight at this point — the Cloud Run service has
 *       already been built/pushed, the IAM binding is being set, the URL is
 *       almost public. Bailing out here would orphan a half-built revision.
 *     - The user's intent was "ship this code"; restore-failed means "ship
 *       went OK but DB isn't ready" — partial success that the operator can
 *       manually finish.
 *     - Existing `dbRestoreResult` config field already surfaces the failure
 *       in the dashboard (best-effort write that's been there pre-round-23);
 *       round 23 just promotes the LOG signal from console.warn to
 *       console.error with the [CRITICAL errorCode=db_dump_restore_drift]
 *       prefix that operators can grep + alert on.
 *
 *   Compare with round 21's iam-policy-verdict: same pattern (critical log
 *   but does NOT block) — both are surface-only flow-control flags, leaving
 *   the deploy live for the operator to finish manually. Three flow-control
 *   spectra now:
 *     - blockApproval (round 20) — gate scan_report → reviewer notification
 *     - blockPipeline (round 22) — gate whether the pipeline starts at all
 *     - surface-only (round 21, round 23) — critical log, no gate
 */

/** Outcome of the restoreDbDump call (or the outer-catch failure mode). */
export interface DbDumpRestoreOutcome {
  /** true when restoreDbDump returned success=true. */
  success: boolean;
  /** Detected dump format. 'unknown' for outer-catch (we never got far enough
   *  to detect format). */
  format: 'sql' | 'custom' | 'sql_gz' | 'unknown';
  /** Wall time. 0 for outer-catch (we never started the restore). */
  durationMs: number;
  /** Bytes restored. 0 for outer-catch. */
  bytesRestored: number;
  /** Error message when success=false. null on success. */
  error: string | null;
}

export type DbDumpRestoreVerdict =
  | {
      kind: 'not-applicable';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'restore-ok';
      logLevel: 'info';
      gcsDbDumpUri: string;
      dumpFileName: string;
      format: 'sql' | 'custom' | 'sql_gz' | 'unknown';
      durationMs: number;
      bytesRestored: number;
      message: string;
    }
  | {
      kind: 'restore-failed';
      logLevel: 'critical';
      gcsDbDumpUri: string;
      dumpFileName: string;
      connectionStringHint: string;
      restoreError: string;
      format: 'sql' | 'custom' | 'sql_gz' | 'unknown';
      errorCode: 'db_dump_restore_drift';
      requiresOperatorAction: true;
      /** Pre-formatted shell hint the operator can adapt. Uses the dump's
       *  GCS URI and the connection string hint (DATABASE_URL with secrets
       *  redacted to `***`). Mirrors round 21's recoveryCommand pattern. */
      recoveryCommand: string;
      message: string;
    };

export interface BuildDbDumpRestoreVerdictInput {
  /** Project label for log messages (project name or slug). */
  projectLabel: string;
  /** GCS URI from project.config.gcsDbDumpUri. null when no dump configured
   *  (verdict short-circuits to `not-applicable`). */
  gcsDbDumpUri: string | null;
  /** Whether the deploy actually needs Cloud SQL. false short-circuits to
   *  `not-applicable` (matches existing deploy-worker.ts:553 guard). */
  needsCloudSql: boolean;
  /** Original dump filename ("production-2026-04-25.sql.gz"). Defaults
   *  empty string from caller (deploy-worker uses 'dump.sql' default at
   *  line 572). */
  dumpFileName: string;
  /** Connection string the restore was attempted against. Caller should
   *  redact passwords before passing in (e.g. replace `:secret@` with
   *  `:***@`). null when outer-catch fired before dbUrl was found. */
  connectionStringHint: string | null;
  /** Restore outcome. null when no restore was attempted (not-applicable). */
  restore: DbDumpRestoreOutcome | null;
}

export function buildDbDumpRestoreVerdict(
  input: BuildDbDumpRestoreVerdictInput
): DbDumpRestoreVerdict {
  const { projectLabel, gcsDbDumpUri, needsCloudSql, dumpFileName, connectionStringHint, restore } = input;

  // Short-circuit: no dump configured OR no Cloud SQL needed.
  if (!gcsDbDumpUri || !needsCloudSql) {
    const reason = !gcsDbDumpUri
      ? 'no gcsDbDumpUri on project.config'
      : 'needsCloudSql=false';
    return {
      kind: 'not-applicable',
      logLevel: 'info',
      message: `DB dump restore for "${projectLabel}" not applicable — ${reason}; skipping`,
    };
  }

  // Restore not attempted (caller bug or outer-catch with no outcome built).
  // Treat as restore-failed defensively.
  if (!restore) {
    return {
      kind: 'restore-failed',
      logLevel: 'critical',
      gcsDbDumpUri,
      dumpFileName,
      connectionStringHint: connectionStringHint ?? '<unknown>',
      restoreError: 'restore not attempted — deploy-worker bug or pre-restore failure with no outcome captured',
      format: 'unknown',
      errorCode: 'db_dump_restore_drift',
      requiresOperatorAction: true,
      recoveryCommand: buildRecoveryCommand(gcsDbDumpUri, connectionStringHint, 'unknown'),
      message:
        `DB dump restore for "${projectLabel}" was NOT attempted (defensive ` +
        `verdict — caller bug). Service may have shipped against an empty ` +
        `database — check Cloud Run logs for 500s. Re-run the restore manually.`,
    };
  }

  // Restore failed (inner failure or outer-catch funneled in via
  // success=false).
  if (!restore.success) {
    const err = restore.error && restore.error.length > 0
      ? restore.error
      : 'restore reported failure with no error message';
    return {
      kind: 'restore-failed',
      logLevel: 'critical',
      gcsDbDumpUri,
      dumpFileName,
      connectionStringHint: connectionStringHint ?? '<unknown>',
      restoreError: err,
      format: restore.format,
      errorCode: 'db_dump_restore_drift',
      requiresOperatorAction: true,
      recoveryCommand: buildRecoveryCommand(gcsDbDumpUri, connectionStringHint, restore.format),
      message:
        `DB dump restore for "${projectLabel}" FAILED: ${err}. ` +
        `The Cloud Run service IS live (deploy continued) but the database ` +
        `is in a half-loaded or empty state — every API call that touches ` +
        `the DB will 500 until the operator manually re-runs the restore. ` +
        `Dump still in GCS at ${gcsDbDumpUri} (file "${dumpFileName}"). ` +
        `Recover by running on the operator workstation: ${buildRecoveryCommand(gcsDbDumpUri, connectionStringHint, restore.format)}`,
    };
  }

  // Happy path.
  return {
    kind: 'restore-ok',
    logLevel: 'info',
    gcsDbDumpUri,
    dumpFileName,
    format: restore.format,
    durationMs: restore.durationMs,
    bytesRestored: restore.bytesRestored,
    message:
      `DB dump restore for "${projectLabel}" OK ` +
      `(format=${restore.format}, ${(restore.bytesRestored / 1024 / 1024).toFixed(1)}MB ` +
      `restored in ${restore.durationMs}ms from ${gcsDbDumpUri})`,
  };
}

/** Build the operator-runnable recovery command for restore-failed verdicts.
 *  The connection string hint is interpolated as-is (caller redacts secrets). */
function buildRecoveryCommand(
  gcsDbDumpUri: string,
  connectionStringHint: string | null,
  format: 'sql' | 'custom' | 'sql_gz' | 'unknown',
): string {
  const conn = connectionStringHint ?? '<DATABASE_URL>';
  const tool =
    format === 'custom' ? 'pg_restore' :
    format === 'sql_gz' ? 'gunzip -c <local-dump> | psql' :
    'psql -f <local-dump>';
  return (
    `gsutil cp ${gcsDbDumpUri} <local-dump> && ` +
    `${tool} '${conn}'`
  );
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Critical verdicts use console.error with `[CRITICAL errorCode=X]`
 *  prefix that operators can grep on Cloud Run logs. */
export function logDbDumpRestoreVerdict(verdict: DbDumpRestoreVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[DbDumpRestore] ${verdict.message}`);
      return;
    case 'critical': {
      const errorCode = verdict.kind === 'restore-failed' ? verdict.errorCode : '';
      console.error(`[DbDumpRestore] [CRITICAL errorCode=${errorCode}] ${verdict.message}`);
      return;
    }
  }
}
