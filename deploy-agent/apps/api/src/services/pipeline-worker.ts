// Pipeline Worker — runs the full scan → analyze → auto-fix → review pipeline
// Triggered when a project is submitted. Runs asynchronously (non-blocking).

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getProject,
  transitionProject,
  updateScanReport,
  getLatestScanReport,
  createReview,
  submitReview,
} from './orchestrator';
import { runDeployPipeline } from './deploy-worker';
import { getRuntimeSettings } from './settings-service';
import { detectProject } from './project-detector';
import { generateDockerfile } from './dockerfile-gen';
import { patchDockerfileForPrisma } from './prisma-fixer';
import {
  isStrictnessFlip,
  detectNextMajorVersion,
  stripEslintFromNextConfig,
  NEXT_CONFIG_FILES,
} from './next-config-fixer';
import { notifyReviewNeeded } from './discord-notifier';
import { runSemgrep, runTrivy } from './scanner';
import { analyzeThreatModel, generateReviewReport } from './llm-analyzer';
import { analyzeResources } from './resource-analyzer';
import { estimateMonthlyCost, formatCostEstimate } from './cost-estimator';
import {
  normalizeExtractedPaths,
  descendIntoWrapperDir,
  sanitizeRelativePath,
} from './archive-normalizer';
import type { ScanFinding, AutoFixResult } from '@deploy-agent/shared';

// Timeout utility — prevents pipeline from hanging indefinitely
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Keep-alive: ping self to prevent Cloud Run idle instance shutdown during long pipelines
function startKeepAlive(): () => void {
  const selfUrl = process.env.K_SERVICE
    ? `http://localhost:${process.env.PORT || 4000}/api/projects`
    : null;
  if (!selfUrl) return () => {};
  const interval = setInterval(async () => {
    try { await fetch(selfUrl); } catch { /* ignore */ }
  }, 30_000); // ping every 30s
  return () => clearInterval(interval);
}

// File extensions worth scanning
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.php',
  '.env', '.yml', '.yaml', '.json', '.toml',
  '.sql', '.sh', '.bash', '.dockerfile',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '__pycache__', '.venv', 'vendor', 'target',
]);

export async function runPipeline(
  projectId: string,
  projectDir: string
): Promise<void> {
  console.log(`\n[Pipeline] Starting for project ${projectId}`);
  console.log(`[Pipeline] Project dir: ${projectDir}`);

  let currentStep = '';
  const stopKeepAlive = startKeepAlive();

  // Round 44f (2026-04-30): track wrapper-dir name so the AI fix step can
  // strip it when the LLM echoes it back in fix.filePath. Set during the
  // GCS-source re-extract path below; remains undefined on the warm path
  // (where submit-gcs / new-version already descended before extracting).
  let wrapperDirName: string | undefined;

  try {
    // ─── Step 0: Ensure source files are available ───
    // On Cloud Run, /tmp is ephemeral — source may be gone after revision change.
    // If so, download from GCS.
    if (!existsSync(projectDir)) {
      currentStep = 'Step 0: Download source from GCS';
      console.log(`[Pipeline] ${currentStep}...`);
      const project = await getProject(projectId);
      const gcsUri = project?.config?.gcsSourceUri as string | undefined;
      if (!gcsUri || !gcsUri.startsWith('gs://')) {
        throw new Error(`Source dir ${projectDir} does not exist and no GCS URI found`);
      }

      // Download via GCP metadata server auth + REST API
      const withoutPrefix = gcsUri.slice(5);
      const slashIdx = withoutPrefix.indexOf('/');
      const bucket = withoutPrefix.slice(0, slashIdx);
      const object = withoutPrefix.slice(slashIdx + 1);
      const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;

      let authHeaders: Record<string, string> = {};
      try {
        const tokenResp = await fetch(
          'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
          { headers: { 'Metadata-Flavor': 'Google' } }
        );
        const tokenData = await tokenResp.json() as { access_token: string };
        authHeaders = { Authorization: `Bearer ${tokenData.access_token}` };
      } catch {
        console.warn('[Pipeline]   No metadata server (local dev?), trying without auth');
      }

      const resp = await fetch(downloadUrl, { headers: authHeaders });
      if (!resp.ok) throw new Error(`Failed to download from GCS: ${resp.status} ${resp.statusText}`);

      // Save tgz and extract
      const tgzBuffer = Buffer.from(await resp.arrayBuffer());
      mkdirSync(projectDir, { recursive: true });
      const tgzPath = `${projectDir}.tgz`;
      const { writeFileSync: wfs } = await import('node:fs');
      wfs(tgzPath, tgzBuffer);
      // Round 44e (2026-04-28): timeout 30s → 600s. Same root cause as R44b
      // — large source bundles (legal-flow: 426 MB zip → ~300 MB tgz) take
      // far longer than 30s to extract on Cloud Run, especially under memory
      // pressure. R44b only fixed the async (execFileAsync) path in
      // routes/projects.ts; this is the sync (execFileSync) twin in the
      // pipeline worker that R44b didn't sweep.
      execFileSync('tar', ['xzf', tgzPath, '-C', projectDir], { timeout: 600_000, maxBuffer: 100 * 1024 * 1024 });
      console.log(`[Pipeline]   Downloaded and extracted GCS source to ${projectDir}`);

      // Round 44f (2026-04-30): replicate the normalize + wrapper-dir descent
      // that submit-gcs / new-version do inline. Without this, the GCS re-
      // extract path leaves backslash-laden filenames AND a `legal_flow/`
      // wrapper subdir, both of which break downstream detection.
      try {
        const normResult = await normalizeExtractedPaths(projectDir);
        if (normResult.renamed > 0) {
          console.log(
            `[Pipeline]   Normalized ${normResult.renamed} backslash filenames` +
            (normResult.collisions ? ` (${normResult.collisions} collisions)` : '') +
            (normResult.blocked ? ` (${normResult.blocked} blocked)` : ''),
          );
        }
      } catch (err) {
        console.warn(`[Pipeline]   normalizeExtractedPaths failed (non-fatal): ${(err as Error).message}`);
      }

      const descended = descendIntoWrapperDir(projectDir);
      if (descended !== projectDir) {
        wrapperDirName = basename(descended);
        console.log(`[Pipeline]   Detected wrapper dir '${wrapperDirName}', descending`);
        projectDir = descended;
      }
    }

    // ─── Step 1: Project Detection ───
    currentStep = 'Step 1: Project Detection';
    console.log(`[Pipeline] ${currentStep}...`);
    const detection = detectProject(projectDir);
    console.log(`[Pipeline]   ${detection.framework} (${detection.language}), port ${detection.port}`);

    // Update project with detected info (including port in config)
    const { query: dbQuery } = await import('../db/index');
    await dbQuery(
      `UPDATE projects SET detected_language = $1, detected_framework = $2,
       config = config || $3::jsonb, updated_at = NOW() WHERE id = $4`,
      [detection.language, detection.framework, JSON.stringify({ detectedPort: detection.port }), projectId]
    );

    // ─── Step 2: Dockerfile Generation (if missing) ───
    currentStep = 'Step 2: Dockerfile Generation';
    console.log(`[Pipeline] ${currentStep}...`);
    if (!detection.hasDockerfile) {
      const dockerfile = generateDockerfile(detection);
      const { writeFileSync: wfs } = await import('node:fs');
      wfs(join(projectDir, 'Dockerfile'), dockerfile);
      console.log(
        `[Pipeline]   Generated Dockerfile${detection.hasPrisma ? ' (with prisma generate)' : ''}`,
      );
    } else {
      console.log('[Pipeline]   Existing Dockerfile found');
      // R44g: Prisma projects fail at `next build` if `prisma generate` hasn't run.
      // User Dockerfiles routinely miss this. Patch in builder stage before build.
      if (detection.hasPrisma) {
        try {
          const dockerfilePath = join(projectDir, 'Dockerfile');
          const original = readFileSync(dockerfilePath, 'utf-8');
          const result = patchDockerfileForPrisma(original);
          if (result.changed) {
            const { writeFileSync: wfs } = await import('node:fs');
            wfs(dockerfilePath, result.next);
            console.log(`[Pipeline]   R44g: patched user Dockerfile — ${result.reason}`);
          } else {
            console.log(`[Pipeline]   R44g: Prisma detected, skipped patch — ${result.reason}`);
          }
        } catch (err) {
          console.warn(
            `[Pipeline]   R44g: Prisma patch failed (non-fatal): ${(err as Error).message}`,
          );
        }
      }
    }

    // R44h-2 (2026-04-30): Next.js 16 dropped the `eslint` key from NextConfig.
    // Vibe-coded projects (legal-flow being canonical) still ship a stale
    // `eslint: { ignoreDuringBuilds: true }` block. With strict type-check,
    // tsc errors on `'eslint' does not exist in type 'NextConfig'`. Auto-strip
    // when Next major ≥ 16. Defense-in-depth — also helps when AI fix step
    // already flipped some other strictness flag exposing the latent error.
    try {
      const nextMajor = detectNextMajorVersion(projectDir);
      if (nextMajor !== null && nextMajor >= 16) {
        for (const name of NEXT_CONFIG_FILES) {
          const cfgPath = join(projectDir, name);
          if (!existsSync(cfgPath)) continue;
          const original = readFileSync(cfgPath, 'utf-8');
          const result = stripEslintFromNextConfig(original);
          if (result.changed) {
            writeFileSync(cfgPath, result.next);
            console.log(
              `[Pipeline]   R44h: stripped deprecated eslint{} from ${name} (Next ${nextMajor}) — ${result.reason}`,
            );
            break; // Next resolves only the first match; no point checking the rest.
          }
        }
      }
    } catch (err) {
      console.warn(
        `[Pipeline]   R44h: next.config eslint-strip failed (non-fatal): ${(err as Error).message}`,
      );
    }

    // ─── Step 3: Security Scanning (Semgrep + Trivy) ───
    currentStep = 'Step 3: Security Scanning (Semgrep + Trivy)';
    console.log(`[Pipeline] ${currentStep}...`);
    // Run scans sequentially to avoid OOM (Semgrep + Trivy together exceed 2GB)
    const semgrepResult = await runSemgrep(projectDir).catch((err) => {
      console.warn(`[Pipeline]   Semgrep failed: ${(err as Error).message}`);
      return { tool: 'semgrep' as const, findings: [] as ScanFinding[], rawOutput: '', duration: 0 };
    });
    const trivyResult = await runTrivy(projectDir).catch((err) => {
      console.warn(`[Pipeline]   Trivy failed: ${(err as Error).message}`);
      return { tool: 'trivy' as const, findings: [] as ScanFinding[], rawOutput: '', duration: 0 };
    });

    const scannerFindings = [...semgrepResult.findings, ...trivyResult.findings];
    console.log(`[Pipeline]   Semgrep: ${semgrepResult.findings.length} findings (${semgrepResult.duration}ms)`);
    console.log(`[Pipeline]   Trivy: ${trivyResult.findings.length} findings (${trivyResult.duration}ms)`);

    // Update scan report with scanner results
    const scanReport = await getLatestScanReport(projectId);
    if (scanReport) {
      await updateScanReport(scanReport.id, {
        semgrepFindings: semgrepResult.findings,
        trivyFindings: trivyResult.findings,
      });
    }

    // ─── Step 4: LLM Threat Analysis (90s timeout) ───
    currentStep = 'Step 4: LLM Threat Analysis';
    console.log(`[Pipeline] ${currentStep}...`);
    const sourceFiles = collectSourceFiles(projectDir);
    console.log(`[Pipeline]   Collected ${sourceFiles.size} source files`);

    let threatAnalysis: Awaited<ReturnType<typeof analyzeThreatModel>>;
    try {
      threatAnalysis = await withTimeout(
        analyzeThreatModel(sourceFiles, scannerFindings),
        90_000,
        'LLM Threat Analysis',
      );
      console.log(`[Pipeline]   Provider: ${threatAnalysis.provider}`);
      console.log(`[Pipeline]   LLM findings: ${threatAnalysis.findings.length}`);
      console.log(`[Pipeline]   Auto-fix suggestions: ${threatAnalysis.autoFixes.length}`);
    } catch (err) {
      console.warn(`[Pipeline]   LLM analysis failed/timed out: ${(err as Error).message}`);
      threatAnalysis = { summary: `LLM analysis skipped: ${(err as Error).message}`, findings: [], autoFixes: [], provider: 'fallback' };
    }

    if (scanReport) {
      await updateScanReport(scanReport.id, {
        llmAnalysis: threatAnalysis,
        threatSummary: threatAnalysis.summary,
      });
    }

    // ─── Step 5: Auto-Fix Application ───
    currentStep = 'Step 5: Auto-Fix Application';
    console.log(`[Pipeline] ${currentStep}...`);
    const autoFixResults: AutoFixResult[] = [];
    const pushSkipped = (reason: string, logMsg?: string): void => {
      autoFixResults.push({ applied: false, diff: '', explanation: reason, verificationPassed: null });
      if (logMsg) console.warn(`[Pipeline]   ${logMsg}`);
    };

    for (const fix of threatAnalysis.autoFixes) {
      try {
        // Round 44f (2026-04-30): sanitize LLM-emitted file path before join.
        // GPT-5.5 / Claude can echo back Windows-style backslashes
        // (`legal_flow\src\auth.ts`) or the wrapper-dir prefix
        // (`legal_flow/src/auth.ts` after we already descended into it).
        // Without this, `join(projectDir, raw)` either creates a literal-
        // backslash file at projectDir root (POSIX doesn't recognize `\` as
        // separator) or path-traverses out of projectDir.
        const sanitized = sanitizeRelativePath(fix.filePath, { wrapperDirName });
        if (!sanitized) {
          pushSkipped(
            `Rejected unsafe filePath: ${fix.filePath}`,
            `Rejected unsafe filePath: ${fix.filePath}`,
          );
          continue;
        }
        const filePath = join(projectDir, sanitized);
        const original = readFileSync(filePath, 'utf8');

        if (!original.includes(fix.originalCode)) {
          pushSkipped(`Could not find original code in ${sanitized}`);
          continue;
        }

        // R44h (2026-04-30): Block AI auto-fixes that flip
        // ignoreBuildErrors / ignoreDuringBuilds from true → false. The LLM
        // doesn't have full type-check context — flipping these flags
        // exposes latent type/eslint errors that were intentionally hidden
        // on a vibe-coded project. legal-flow's redeploy after R44g died
        // exactly this way.
        const flip = isStrictnessFlip(fix.originalCode, fix.fixedCode);
        if (flip.isFlip) {
          pushSkipped(
            `Skipped (R44h): refused to flip ${flip.key} true→false — would expose latent errors not covered by this fix. Original explanation: ${fix.explanation}`,
            `R44h: skipped strictness flip on ${sanitized} (${flip.key} true→false)`,
          );
          continue;
        }

        const fixed = original.replace(fix.originalCode, fix.fixedCode);
        writeFileSync(filePath, fixed);
        autoFixResults.push({
          applied: true,
          diff: `--- ${sanitized}\n+++ ${sanitized}\n-${fix.originalCode}\n+${fix.fixedCode}`,
          explanation: fix.explanation,
          verificationPassed: null, // will be set after re-scan
        });
        console.log(`[Pipeline]   Fixed: ${sanitized} — ${fix.explanation}`);
      } catch (err) {
        pushSkipped(`Error applying fix: ${(err as Error).message}`);
      }
    }

    const appliedCount = autoFixResults.filter((r) => r.applied).length;
    console.log(`[Pipeline]   Applied ${appliedCount}/${threatAnalysis.autoFixes.length} fixes`);

    if (scanReport) {
      await updateScanReport(scanReport.id, { autoFixes: autoFixResults });
    }

    // ─── Step 6: Verification Scan (re-scan after fixes) ───
    if (appliedCount > 0) {
      currentStep = 'Step 6: Verification Scan';
      console.log(`[Pipeline] ${currentStep}...`);
      const [verifySemgrep, verifyTrivy] = await Promise.all([
        runSemgrep(projectDir).catch(() => ({ findings: [] as ScanFinding[] })),
        runTrivy(projectDir).catch(() => ({ findings: [] as ScanFinding[] })),
      ]);
      const verifyFindings = [...verifySemgrep.findings, ...verifyTrivy.findings];
      console.log(`[Pipeline]   Post-fix findings: ${verifyFindings.length} (was ${scannerFindings.length})`);

      if (scanReport) {
        await updateScanReport(scanReport.id, { verificationResults: verifyFindings });
      }
    }

    // ─── Step 6a: Re-upload fixed projectDir to GCS (audit-safe) ───
    // pipeline-worker modifies files in-place (Dockerfile + AI fixes); without this
    // re-upload, deploy-engine would fetch the ORIGINAL gcsSourceUri and none of the
    // fixes would land in the Docker image. We write to a separate `sources-fixed/`
    // path and store the URI in project.config.gcsFixedSourceUri — the original
    // gcsSourceUri is left intact for audit.
    //
    // ROUND 20: this used to swallow into console.warn, which let the reviewer
    // approve a "fix" that never made it into the deploy artifact. Now we
    // capture both sub-outcomes (tarball+upload, db persist) and feed them
    // through the verdict module. On critical verdict we mark the scan_report
    // status='failed' so the reviewer dashboard blocks approval — see step 7
    // below where we set fixedSourceUploadCritical.
    currentStep = 'Step 6a: Upload fixed source to GCS';
    console.log(`[Pipeline] ${currentStep}...`);
    let projectLabel = projectId;
    let tarballAndUploadOutcome: { ok: boolean; gcsUri: string | null; bytes: number; error: string | null } = {
      ok: false,
      gcsUri: null,
      bytes: 0,
      error: 'tarball/upload not attempted',
    };
    let dbPersistOutcome: { ok: boolean; error: string | null } | null = null;

    try {
      const project = await getProject(projectId);
      projectLabel = project?.slug || project?.name || projectId;
      const slug = project?.slug || projectId;
      const gcpProject = process.env.GCP_PROJECT || 'wave-deploy-agent';
      const bucket = `${gcpProject}_cloudbuild`;
      const objectName = `sources-fixed/${slug}-${Date.now()}.tgz`;
      const tarballPath = `/tmp/${slug}-fixed-${Date.now()}.tgz`;

      // tar (sub-step a)
      // Round 44e (2026-04-28): timeout 60s → 600s + maxBuffer 100MB. legal-flow
      // (post-fix projectDir ~300+ MB) hit `spawnSync tar ETIMEDOUT` at exactly
      // 60s here — fixed-source upload critical, pipeline marked FAILED before
      // reviewer could approve. R44b fixed the async unzip/tar timeouts in
      // routes/projects.ts but this sync sibling in the pipeline worker (same
      // 60s default) was the next to bite. See also extract-side fix above.
      try {
        execFileSync('tar', ['-czf', tarballPath, '-C', projectDir, '.'], { timeout: 600_000, maxBuffer: 100 * 1024 * 1024 });
      } catch (tarErr) {
        throw new Error(`tar-failed: ${(tarErr as Error).message}`);
      }

      const { readFileSync: rfs, unlinkSync: ufs, statSync: sfs } = await import('node:fs');
      const tarball = rfs(tarballPath);
      const bytes = sfs(tarballPath).size;

      // Use the same auth path as deploy-engine (gcpFetch from gcp-auth)
      const { gcpFetch } = await import('./gcp-auth');
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
      const uploadRes = await gcpFetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip' },
        body: tarball,
      });
      try { ufs(tarballPath); } catch { /* ignore */ }
      if (!uploadRes.ok) {
        const errBody = await uploadRes.text().catch(() => '<no body>');
        throw new Error(`upload-failed: GCS HTTP ${uploadRes.status}: ${errBody}`);
      }

      const gcsFixedSourceUri = `gs://${bucket}/${objectName}`;
      console.log(`[Pipeline]   Fixed source uploaded (${bytes} bytes): ${gcsFixedSourceUri}`);
      tarballAndUploadOutcome = {
        ok: true,
        gcsUri: gcsFixedSourceUri,
        bytes,
        error: null,
      };

      // Merge into project.config (preserves other fields) — separate try/catch
      // because db-persist failure is recoverable (bytes already in GCS).
      try {
        await dbQuery(
          `UPDATE projects SET config = config || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ gcsFixedSourceUri }), projectId],
        );
        dbPersistOutcome = { ok: true, error: null };
      } catch (dbErr) {
        dbPersistOutcome = { ok: false, error: (dbErr as Error).message };
      }
    } catch (err) {
      // Tarball / getProject / upload failure path
      tarballAndUploadOutcome = {
        ok: false,
        gcsUri: null,
        bytes: 0,
        error: (err as Error).message,
      };
      dbPersistOutcome = null; // didn't attempt
    }

    // Build verdict and surface it (critical verdicts use console.error
    // with [CRITICAL errorCode=...] for grep-ability)
    const { buildFixedSourceUploadVerdict, logFixedSourceUploadVerdict } = await import(
      './fixed-source-upload-verdict'
    );
    // Step 6a is applicable when projectDir was mutated. The pipeline always
    // applies Step 2 (Dockerfile gen) and Step 5 (AI fixes). We treat
    // applicable=true when EITHER of these would have changed projectDir:
    //   - !detection.hasDockerfile  (we wrote a new Dockerfile in step 2), OR
    //   - any autoFixResults entry has applied=true
    const dockerfileWasGenerated = !detection.hasDockerfile;
    const anyFixApplied = autoFixResults.some((r) => r.applied);
    const applicable = dockerfileWasGenerated || anyFixApplied;

    const fixedSourceVerdict = buildFixedSourceUploadVerdict({
      applicable,
      projectLabel,
      // When not-applicable we still pass through what we observed (tarball
      // step ran above unconditionally in the legacy code; verdict ignores
      // these inputs when applicable=false).
      tarballAndUpload: applicable ? tarballAndUploadOutcome : null,
      dbPersist: applicable ? dbPersistOutcome : null,
    });
    logFixedSourceUploadVerdict(fixedSourceVerdict);

    // If the verdict says blockApproval, persist the failure into the
    // scan_report so the reviewer dashboard sees a red flag instead of
    // a green "completed" status. This is what prevents the lie.
    const fixedSourceUploadCritical =
      fixedSourceVerdict.kind === 'tarball-or-upload-failed' ||
      fixedSourceVerdict.kind === 'db-persist-failed-after-upload';

    // ─── Step 6.5: Resource Plan Analysis (LLM) ───
    currentStep = 'Step 6.5: Resource Plan Analysis';
    console.log(`[Pipeline] ${currentStep}...`);
    try {
      // Gather env var references from source to feed the analyzer
      const referencedEnvVars = collectReferencedEnvVars(projectDir, detection.language);
      const project = await getProject(projectId);
      const userEnvVars = (project?.config?.envVars as Record<string, string>) ?? {};
      const resourcePlan = await withTimeout(
        analyzeResources({
          projectDir,
          language: detection.language,
          framework: detection.framework,
          referencedEnvVars: Array.from(referencedEnvVars),
          resolvedEnvVars: userEnvVars,
        }),
        60_000,
        'Resource Plan Analysis',
      );
      console.log(`[Pipeline]   Provider: ${resourcePlan.provider}`);
      console.log(`[Pipeline]   Requirements: ${resourcePlan.requirements.length} (${resourcePlan.requirements.map((r) => `${r.type}:${r.strategy}`).join(', ')})`);
      console.log(`[Pipeline]   Can auto-deploy: ${resourcePlan.canAutoDeploy}`);
      if (scanReport) {
        await updateScanReport(scanReport.id, { resourcePlan });
      }
    } catch (err) {
      console.warn(`[Pipeline]   Resource analysis skipped: ${(err as Error).message}`);
    }

    // ─── Step 7: Cost Estimation ───
    currentStep = 'Step 7: Cost Estimation';
    console.log(`[Pipeline] ${currentStep}...`);
    const costEstimate = estimateMonthlyCost({
      cpu: 1,
      memoryMB: 512,
      avgRequestsPerDay: 100,
      avgRequestDurationMs: 200,
      avgResponseSizeKB: 50,
      minInstances: 0,
    });
    console.log(`[Pipeline]   Estimated: $${costEstimate.monthlyTotal}/month`);

    if (scanReport) {
      // ROUND 20: when fixed-source upload critical, mark scan_report
      // status='failed' so the reviewer dashboard does NOT show this as
      // approvable. The reviewer would otherwise be approving fixes that
      // never made it into the deploy artifact (security flagship lie).
      const scanStatus: 'completed' | 'failed' = fixedSourceUploadCritical ? 'failed' : 'completed';
      await updateScanReport(scanReport.id, { costEstimate, status: scanStatus });
    }

    // ─── Step 8: Generate Review Report (60s timeout) ───
    currentStep = 'Step 8: Generate Review Report';
    console.log(`[Pipeline] ${currentStep}...`);
    const allFindings = [...scannerFindings, ...threatAnalysis.findings];
    let reviewReport = '';
    try {
      reviewReport = await withTimeout(
        generateReviewReport(projectId, threatAnalysis, scannerFindings, autoFixResults, costEstimate),
        60_000,
        'Review Report Generation',
      );
      console.log(`[Pipeline]   Report generated (${reviewReport.length} chars)`);
    } catch (err) {
      console.warn(`[Pipeline]   Report generation failed/timed out: ${(err as Error).message}`);
      reviewReport = `Report generation skipped: ${(err as Error).message}`;
    }

    // ROUND 20: when fixed-source upload was critical, prepend a clear
    // notice to the threatSummary so anyone reading the report understands
    // why the project transitioned to failed instead of review_pending.
    const finalThreatSummary = fixedSourceUploadCritical
      ? `[CRITICAL] Fixed-source upload failed — deploy would have used the original UNFIXED source. ` +
        `Verdict: ${fixedSourceVerdict.message}\n\n---\n\n${reviewReport}`
      : reviewReport;

    if (scanReport) {
      await updateScanReport(scanReport.id, {
        threatSummary: finalThreatSummary,
      });
    }

    // ─── Step 9: Transition to review_pending OR failed (round 20) ───
    if (fixedSourceUploadCritical) {
      // Don't let the operator approve a non-existent fix. Transition
      // straight to failed with the verdict's errorCode in the metadata.
      currentStep = 'Step 9: Transition to failed (fixed-source upload critical)';
      console.log(`[Pipeline] ${currentStep}...`);
      const errorCode =
        fixedSourceVerdict.kind === 'tarball-or-upload-failed' ||
        fixedSourceVerdict.kind === 'db-persist-failed-after-upload'
          ? fixedSourceVerdict.errorCode
          : 'unknown';
      await transitionProject(projectId, 'failed', 'pipeline-worker', {
        error: 'Fixed-source upload failed — deploy would use original unfixed source',
        errorCode,
        failedStep: 'Step 6a: Upload fixed source to GCS',
        verdict: fixedSourceVerdict.kind,
        verdictMessage: fixedSourceVerdict.message,
        totalFindings: allFindings.length,
        criticalFindings: allFindings.filter((f) => f.severity === 'critical').length,
        autoFixesApplied: appliedCount,
      });

      console.log(`[Pipeline] ✗ Pipeline marked FAILED for project ${projectId} due to fixed-source upload critical`);
      console.log(`[Pipeline]   errorCode=${errorCode} — operator must re-run the pipeline`);
      stopKeepAlive();
      return;
    }

    // ─── Step 9: Transition to review_pending, then optionally auto-approve ───
    // The `requireReview` operator setting controls whether the human review
    // gate runs. Defaults true. When false, the pipeline still creates the
    // scan report + review record (audit trail) but stamps the review as
    // auto-approved by `system` and triggers the deploy worker immediately.
    currentStep = 'Step 9: Transition to review_pending';
    console.log(`[Pipeline] ${currentStep}...`);
    await transitionProject(projectId, 'review_pending', 'pipeline-worker', {
      totalFindings: allFindings.length,
      criticalFindings: allFindings.filter((f) => f.severity === 'critical').length,
      autoFixesApplied: appliedCount,
      costEstimate: costEstimate.monthlyTotal,
    });

    const settings = await getRuntimeSettings();

    // Create review entry — needed by both branches (audit trail in either path).
    let reviewId: string | null = null;
    if (scanReport) {
      const review = await createReview(scanReport.id);
      reviewId = review.id;
    }

    if (settings.requireReview) {
      // Human gate: notify Discord, leave project in review_pending.
      if (reviewId && scanReport) {
        const proj = await getProject(projectId);
        if (proj) {
          notifyReviewNeeded(proj.name, proj.slug, reviewId).catch(() => {});
        }
      }
      console.log(`[Pipeline] ✓ Complete for project ${projectId}`);
      console.log(`[Pipeline]   Findings: ${allFindings.length} total, ${appliedCount} auto-fixed`);
      console.log(`[Pipeline]   Status: review_pending — awaiting human approval`);
    } else if (reviewId) {
      // Auto-approve and dispatch deploy. Mirrors what
      // routes/reviews.ts:104-160 does on a manual approve.
      currentStep = 'Step 9b: Auto-approve (review gate disabled)';
      console.log(`[Pipeline] ${currentStep}...`);
      await submitReview(reviewId, 'approved', 'system', 'auto-approved (review disabled)');
      await transitionProject(projectId, 'approved', 'system', {
        reviewId,
        autoApproved: true,
      });
      runDeployPipeline(projectId, reviewId).catch((err) => {
        console.error(
          `[Pipeline] Deploy dispatch (auto-approved) failed for ${projectId}:`,
          (err as Error).message,
        );
      });
      console.log(`[Pipeline] ✓ Complete for project ${projectId} (auto-approved)`);
      console.log(`[Pipeline]   Findings: ${allFindings.length} total, ${appliedCount} auto-fixed`);
      console.log(`[Pipeline]   Status: approved → deploy dispatched`);
    } else {
      // No scanReport means we couldn't even start the security pipeline; fall
      // back to the human gate so an operator can investigate. This branch is
      // mostly defensive — earlier steps short-circuit before reaching here
      // when scanReport is null.
      console.warn(`[Pipeline] requireReview=false but no scanReport; leaving in review_pending`);
    }
    stopKeepAlive();

  } catch (err) {
    const error = err as Error;
    const errorDetail = [
      `Pipeline failed at: ${currentStep}`,
      `Error: ${error.message}`,
      error.stack ? `Stack: ${error.stack.split('\n').slice(0, 5).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    console.error(`[Pipeline] ✗ Failed for project ${projectId}:\n${errorDetail}`);
    try {
      await transitionProject(projectId, 'failed', 'pipeline-worker', {
        error: error.message,
        failedStep: currentStep,
        stack: error.stack?.split('\n').slice(0, 5).join(' → ') ?? '',
      });
    } catch (transitionErr) {
      console.error('[Pipeline] Could not transition to failed:', (transitionErr as Error).message);
    }
    stopKeepAlive();
  }
}

// ─── Collect env var names referenced in source (for resource analyzer) ───

function collectReferencedEnvVars(projectDir: string, language: string | null): Set<string> {
  const refs = new Set<string>();
  const extensions = language === 'python' ? new Set(['.py'])
    : language === 'go' ? new Set(['.go'])
    : new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
    /os\.(?:environ\.get|getenv|environ\[)\(?['"]([A-Z_][A-Z0-9_]*)['"]\)?/g,
    /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g,
  ];

  function walk(dir: string, depth = 0): void {
    if (depth > 5) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (stat.isFile() && extensions.has(extname(entry).toLowerCase()) && stat.size <= 50 * 1024) {
          const content = readFileSync(full, 'utf8');
          for (const p of patterns) {
            let m;
            while ((m = p.exec(content)) !== null) refs.add(m[1]);
          }
        }
      } catch { /* ignore */ }
    }
  }
  walk(projectDir);
  return refs;
}

// ─── Collect source files for LLM analysis ───

function collectSourceFiles(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  let totalSize = 0;
  const MAX_TOTAL_SIZE = 500 * 1024; // 500KB max total to send to LLM

  function walk(currentDir: string, currentPrefix: string) {
    if (totalSize >= MAX_TOTAL_SIZE) return;

    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      if (totalSize >= MAX_TOTAL_SIZE) break;

      const fullPath = join(currentDir, entry);
      const relativePath = currentPrefix ? `${currentPrefix}/${entry}` : entry;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, relativePath);
        } else if (stat.isFile() && SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) {
          if (stat.size > 50 * 1024) continue; // Skip files > 50KB
          const content = readFileSync(fullPath, 'utf8');
          files.set(relativePath, content);
          totalSize += content.length;
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  walk(dir, prefix);
  return files;
}
