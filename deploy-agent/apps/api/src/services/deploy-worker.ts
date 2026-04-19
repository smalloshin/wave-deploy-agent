// Deploy Worker — runs the full build → deploy → DNS → SSL → canary pipeline
// Triggered when a project is approved. Runs asynchronously (non-blocking).

import {
  getProject,
  listProjects,
  transitionProject,
  createDeployment,
  updateDeployment,
  getDeploymentsByProject,
  getLatestScanReport,
  updateProjectConfig,
  getNextDeploymentVersion,
  publishDeployment,
} from './orchestrator';
import { buildAndPushImage, deployToCloudRun, tagRevision, publishRevision, deleteRevision } from './deploy-engine';
import { setupCustomDomainWithDns, type DnsConfig } from './dns-manager';
import { monitorSsl } from './ssl-monitor';
import { runCanaryChecks } from './canary-monitor';
import { detectProject } from './project-detector';
import { detectEnvVars, mergeEnvVars } from './env-detector';
import { classifyEnvWithLLM, analyzeDeployFailure, type EnvClassificationContext } from './llm-analyzer';
import { provisionProjectDatabase } from './db-provisioner';
import { provisionProjectRedis } from './redis-provisioner';
import { restoreDbDump } from './db-restore';
import { notifyDeployComplete, notifyCanaryFailed, notifyDeployFailed } from './discord-notifier';
import { captureDeployedSource } from './deployed-source-capture';

export async function runDeployPipeline(
  projectId: string,
  reviewId: string
): Promise<void> {
  let currentStep = '';

  try {
    const project = await getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const gcpProject = project.config?.gcpProject || process.env.GCP_PROJECT || '';
    const gcpRegion = project.config?.gcpRegion || process.env.GCP_REGION || 'asia-east1';
    const projectDir = project.sourceUrl ?? '';
    const gcsOriginalSourceUri = project.config?.gcsSourceUri as string | undefined;
    // Prefer post-fix source (written by pipeline-worker Step 6a after AI fixes
    // and Dockerfile generation); fall back to original upload if missing.
    const gcsFixedSourceUri = project.config?.gcsFixedSourceUri as string | undefined;
    const gcsSourceUri = gcsFixedSourceUri ?? gcsOriginalSourceUri;
    if (gcsFixedSourceUri) {
      console.log(`[Deploy]   Using fixed source (post AI-fix + generated Dockerfile): ${gcsFixedSourceUri}`);
    } else if (gcsOriginalSourceUri) {
      console.log(`[Deploy]   Using original source (no gcsFixedSourceUri yet): ${gcsOriginalSourceUri}`);
    }

    if (!gcpProject) throw new Error('GCP project not configured');
    if (!projectDir && !gcsSourceUri) throw new Error('No source directory or GCS URI found for project');

    // ─── Step 1: Transition to deploying ───
    currentStep = 'Step 1: Transition to deploying';
    console.log(`[Deploy] ${currentStep} for ${project.name}`);
    await transitionProject(projectId, 'deploying', 'deploy-worker', { trigger: 'auto-after-approval' });

    // Create deployment record with auto-incrementing version
    const deployVersion = await getNextDeploymentVersion(projectId);
    const deployment = await createDeployment(projectId, reviewId, deployVersion);
    console.log(`[Deploy]   Version: v${deployVersion}`);

    // ─── Step 2: Detect project settings + env vars ───
    currentStep = 'Step 2: Detect project settings';
    console.log(`[Deploy] ${currentStep}...`);
    let port = 3000;
    let detectedFramework: string | null = project.detectedFramework ?? null;
    let detectedLanguage = project.detectedLanguage ?? 'unknown';
    try {
      const detection = detectProject(projectDir);
      port = detection.port;
      detectedFramework = detection.framework;
      detectedLanguage = detection.language;
      console.log(`[Deploy]   Detected: ${detectedLanguage}/${detectedFramework ?? 'none'}, port: ${port}`);
    } catch {
      // projectDir may not exist (ephemeral /tmp after revision change)
      // Fall back to DB-stored detection + port saved during pipeline scan
      const savedPort = project.config?.detectedPort as number | undefined;
      if (savedPort) {
        port = savedPort;
      } else {
        const frameworkPortMap: Record<string, number> = {
          nextjs: 3000, nuxt: 3000, sveltekit: 5173,
          express: 3000, fastify: 3000, hono: 3000,
          django: 8000, fastapi: 8000, flask: 5000,
          static: 8080,
        };
        if (detectedFramework && frameworkPortMap[detectedFramework]) {
          port = frameworkPortMap[detectedFramework];
        } else if (detectedLanguage === 'python') {
          port = 8000;
        } else if (detectedLanguage === 'go') {
          port = 8080;
        } else {
          // Last resort: extract Dockerfile from GCS source to check EXPOSE.
          // Prefer fixed source — that's where pipeline-worker wrote the generated Dockerfile.
          const gcsUri = (project.config?.gcsFixedSourceUri as string | undefined)
            ?? (project.config?.gcsSourceUri as string | undefined);
          if (gcsUri && gcsUri.startsWith('gs://')) {
            try {
              const withoutPrefix = gcsUri.slice(5);
              const slashIdx = withoutPrefix.indexOf('/');
              const bucket = withoutPrefix.slice(0, slashIdx);
              const object = withoutPrefix.slice(slashIdx + 1);
              // Download tgz via GCS REST API
              const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
              // Get access token from GCP metadata server (available on Cloud Run)
              const tokenResp = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
              const tokenData = await tokenResp.json() as { access_token: string };
              const resp = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
              if (resp.ok) {
                const { writeFileSync: wfs, readFileSync: rfs, existsSync: efs, mkdirSync } = await import('node:fs');
                const { execSync } = await import('node:child_process');
                const tmpExtract = `/tmp/deploy-port-check-${project.id}`;
                mkdirSync(tmpExtract, { recursive: true });
                const buf = Buffer.from(await resp.arrayBuffer());
                wfs(`${tmpExtract}/src.tgz`, buf);
                execSync(`tar xzf ${tmpExtract}/src.tgz -C ${tmpExtract} 2>/dev/null || true`, { timeout: 10000 });
                const dfPaths = [`${tmpExtract}/Dockerfile`, `${tmpExtract}/source/Dockerfile`];
                for (const dfPath of dfPaths) {
                  if (efs(dfPath)) {
                    const dockerContent = rfs(dfPath, 'utf8');
                    // Priority: ENV PORT=X > EXPOSE Y > nginx default
                    // ENV PORT is what the app actually listens on at runtime
                    const envPortMatch = dockerContent.match(/^ENV\s+PORT[=\s]+(\d+)/m);
                    if (envPortMatch) {
                      port = parseInt(envPortMatch[1], 10);
                      console.log(`[Deploy]   Port from GCS Dockerfile ENV PORT: ${port}`);
                    } else {
                      const exposeMatch = dockerContent.match(/^EXPOSE\s+(\d+)/m);
                      if (exposeMatch) {
                        port = parseInt(exposeMatch[1], 10);
                        console.log(`[Deploy]   Port from GCS Dockerfile EXPOSE: ${port}`);
                      } else if (dockerContent.match(/FROM\s+nginx/i)) {
                        port = 80;
                        console.log(`[Deploy]   Port from GCS Dockerfile (nginx): ${port}`);
                      }
                    }
                    break;
                  }
                }
                execSync(`rm -rf ${tmpExtract}`, { timeout: 5000 });
              }
            } catch (gcsErr) {
              console.warn(`[Deploy]   Could not extract port from GCS source: ${(gcsErr as Error).message}`);
            }
          }
        }
      }
      console.log(`[Deploy]   Using DB-stored detection: ${detectedLanguage}/${detectedFramework ?? 'none'}, port: ${port}`);
    }

    // Compute custom domain FQDN for env detection
    const customDomainSubdomain = project.config?.customDomain;
    const cfZoneName = process.env.CLOUDFLARE_ZONE_NAME || '';
    const customDomainFqdn = customDomainSubdomain && cfZoneName
      ? `${customDomainSubdomain}.${cfZoneName}`
      : undefined;

    // Auto-detect env vars from source code
    currentStep = 'Step 2b: Auto-detect environment variables';
    console.log(`[Deploy] ${currentStep}...`);
    const envDetection = detectEnvVars({
      projectDir,
      framework: detectedFramework,
      language: detectedLanguage,
      customDomain: customDomainFqdn,
      gcpProject,
      gcpRegion,
      projectSlug: project.slug,
      port,
    });

    for (const note of envDetection.notes) {
      console.log(`[Deploy]   ENV: ${note}`);
    }
    if (envDetection.warnings.length > 0) {
      for (const w of envDetection.warnings) {
        console.warn(`[Deploy]   ⚠ ${w.type}: ${w.variable} in ${w.file}:${w.line} — ${w.recommendation}`);
      }
    }
    if (envDetection.missing.length > 0) {
      console.warn(`[Deploy]   ENV missing (user can inject post-deploy): ${envDetection.missing.join(', ')}`);
    }

    // Merge: auto-detected + user-provided (user values take priority)
    const userEnvVars = (project.config?.envVars as Record<string, string>) ?? {};
    const finalEnvVars = mergeEnvVars(envDetection.detected, userEnvVars);
    console.log(`[Deploy]   ENV total: ${Object.keys(finalEnvVars).length} vars (${Object.keys(envDetection.detected).length} auto + ${Object.keys(userEnvVars).length} user)`);

    // ── Step 2b-2: Provision infrastructure BEFORE LLM classification ──
    // DB and Redis provisioning runs first so we can pass connection strings to LLM as context.
    const dbVarKeys = Object.keys(finalEnvVars).filter(k =>
      k === 'DATABASE_URL' || k.endsWith('_DATABASE_URL') || k === 'DB_URL'
    );
    const needsCloudSql = dbVarKeys.length > 0;
    const cloudSqlInstance = needsCloudSql
      ? `${gcpProject}:${gcpRegion}:deploy-agent-db`
      : undefined;

    let dbResult: { dbName: string; dbUser: string; connectionString: string; created: boolean } | undefined;
    if (needsCloudSql && gcpProject && gcpRegion) {
      currentStep = 'Step 2c: Provision project database';
      console.log(`[Deploy] ${currentStep}...`);
      try {
        dbResult = await provisionProjectDatabase(project.slug, gcpProject, gcpRegion);
        console.log(`[Deploy]   DB: ${dbResult.dbName} (user: ${dbResult.dbUser}, created: ${dbResult.created})`);
      } catch (err) {
        console.error(`[Deploy]   DB provisioning failed: ${(err as Error).message}`);
        console.warn(`[Deploy]   Continuing without project DB — LLM may flag DATABASE_URL as needs_user_input`);
      }
    }

    // Check if Redis is needed and provisioned
    const redisVarKeys = Object.keys(finalEnvVars).filter(k =>
      k === 'REDIS_URL' || k === 'REDIS_URI' || k.toUpperCase().includes('REDIS')
    );
    let provisionedRedisUrl: string | undefined;
    if (redisVarKeys.length > 0) {
      try {
        const redisResult = await provisionProjectRedis(project.id, project.slug);
        if (redisResult?.redisUrl) {
          provisionedRedisUrl = redisResult.redisUrl;
          console.log(`[Deploy]   Redis provisioned: ${provisionedRedisUrl.slice(0, 30)}...`);
        }
      } catch {
        console.warn(`[Deploy]   Redis provisioning not available, LLM will handle`);
      }
    }

    // ── Step 2b-3: LLM-powered env var classification ──
    // LLM judges every env var and returns an action verdict (keep/replace/generate/delete/needs_user_input)
    currentStep = 'Step 2b-3: LLM env intelligence';
    console.log(`[Deploy] ${currentStep}...`);
    try {
      const classificationCtx: EnvClassificationContext = {
        framework: detectedFramework,
        language: detectedLanguage,
        cloudSqlInstance,
        dbName: dbResult?.dbName,
        dbUser: dbResult?.dbUser,
        dbConnectionString: dbResult?.connectionString,
        redisUrl: provisionedRedisUrl,
        userProvidedKeys: Object.keys(userEnvVars),
      };

      const classification = await classifyEnvWithLLM(finalEnvVars, classificationCtx);
      console.log(`[Deploy]   LLM env summary: ${classification.summary}`);
      console.log(`[Deploy]   Provider: ${classification.provider} | Auto: ${classification.autoActionCount} | Needs user: ${classification.needsUserCount}`);

      // Execute LLM verdicts
      for (const verdict of classification.verdicts) {
        if (verdict.action === 'keep') continue;

        console.log(`[Deploy]   ${verdict.variable}: ${verdict.action} (${verdict.confidence.toFixed(1)}) — ${verdict.reason}`);

        switch (verdict.action) {
          case 'replace_with_cloudsql':
            if (dbResult?.connectionString) {
              finalEnvVars[verdict.variable] = dbResult.connectionString;
              console.log(`[Deploy]     → Cloud SQL: ${dbResult.dbName}`);
            } else {
              envDetection.missing.push(verdict.variable);
              console.warn(`[Deploy]     → No Cloud SQL available, marked as missing`);
            }
            break;

          case 'replace_with_redis':
            if (provisionedRedisUrl) {
              finalEnvVars[verdict.variable] = provisionedRedisUrl;
              console.log(`[Deploy]     → Redis: ${provisionedRedisUrl.slice(0, 30)}...`);
            } else {
              // Keep existing value if it's a real internal IP, otherwise mark missing
              const val = finalEnvVars[verdict.variable] ?? '';
              if (/^redis:\/\/:?\w+@10\./.test(val) || /^redis:\/\/:?\w+@172\./.test(val)) {
                console.log(`[Deploy]     → Keeping existing internal Redis URL`);
              } else {
                envDetection.missing.push(verdict.variable);
                console.warn(`[Deploy]     → No Redis available, marked as missing`);
              }
            }
            break;

          case 'generate_secret':
            if (verdict.suggestedValue) {
              finalEnvVars[verdict.variable] = verdict.suggestedValue;
              console.log(`[Deploy]     → Generated strong secret (${verdict.suggestedValue.length} chars)`);
            }
            break;

          case 'delete':
            delete finalEnvVars[verdict.variable];
            console.log(`[Deploy]     → Deleted (placeholder value)`);
            break;

          case 'needs_user_input':
            if (!envDetection.missing.includes(verdict.variable)) {
              envDetection.missing.push(verdict.variable);
            }
            console.warn(`[Deploy]     → Needs user input`);
            break;
        }
      }

      // Store classification in project config for dashboard visibility
      try {
        await updateProjectConfig(project.id, {
          ...(project.config ?? {}),
          envAnalysis: {
            verdicts: classification.verdicts,
            summary: classification.summary,
            provider: classification.provider,
            autoActionCount: classification.autoActionCount,
            needsUserCount: classification.needsUserCount,
          },
        });
      } catch { /* non-critical */ }
    } catch (err) {
      console.warn(`[Deploy]   LLM env classification failed: ${(err as Error).message}`);
      console.warn(`[Deploy]   Falling back to legacy rule-based replacement...`);
      // Legacy fallback: replace localhost DATABASE_URLs directly
      if (dbResult) {
        for (const key of dbVarKeys) {
          const val = finalEnvVars[key] ?? '';
          if (/localhost|127\.0\.0\.1|host\.docker\.internal|password@/.test(val) && !userEnvVars[key]) {
            finalEnvVars[key] = dbResult.connectionString;
            console.log(`[Deploy]   Fallback: replaced ${key} with Cloud SQL credentials`);
          }
        }
      }
    }

    // ── Monorepo: inject sibling backend URLs for frontend services ──
    const projectGroup = project.config?.projectGroup as string | undefined;
    const serviceRole = project.config?.serviceRole as string | undefined;
    if (projectGroup && serviceRole === 'frontend') {
      currentStep = 'Step 2d: Wait for backend siblings & resolve URLs';
      console.log(`[Deploy] ${currentStep}...`);

      // Wait for backend siblings to finish deploying (they were submitted first)
      const maxWaitMs = 8 * 60 * 1000; // 8 minutes
      const pollIntervalMs = 10_000;   // 10 seconds
      const startWait = Date.now();
      let backendUrl: string | undefined;

      while (Date.now() - startWait < maxWaitMs) {
        try {
          const allProjects = await listProjects();
          const backendSiblings = allProjects.filter(p =>
            (p.config?.projectGroup as string) === projectGroup &&
            p.id !== project.id &&
            (p.config?.serviceRole as string) === 'backend'
          );

          let allBackendsReady = true;
          for (const backend of backendSiblings) {
            // Check if backend stored its URL in config (set by backend's post-deploy hook)
            const resolvedUrl = backend.config?.resolvedBackendUrl as string | undefined;
            if (resolvedUrl) {
              backendUrl = resolvedUrl;
              console.log(`[Deploy]   Backend "${backend.name}" ready: ${resolvedUrl}`);
              continue;
            }
            // Fallback: check deployment records
            const deploys = await getDeploymentsByProject(backend.id);
            const liveDeploy = deploys.find(d => d.cloudRunUrl);
            if (liveDeploy?.cloudRunUrl) {
              backendUrl = liveDeploy.cloudRunUrl;
              console.log(`[Deploy]   Backend "${backend.name}" ready: ${liveDeploy.cloudRunUrl}`);
              continue;
            }
            allBackendsReady = false;
            break;
          }

          if (allBackendsReady && backendSiblings.length > 0) break;
          if (backendSiblings.length === 0) break;

        } catch (err) {
          console.warn(`[Deploy]   Backend poll error: ${(err as Error).message}`);
        }

        const elapsed = Math.round((Date.now() - startWait) / 1000);
        console.log(`[Deploy]   Waiting for backend siblings... (${elapsed}s / ${maxWaitMs / 1000}s)`);
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      if (backendUrl) {
        // Also check for custom domain override
        try {
          const allProjects = await listProjects();
          const backendSibling = allProjects.find(p =>
            (p.config?.projectGroup as string) === projectGroup &&
            p.id !== project.id &&
            (p.config?.serviceRole as string) === 'backend'
          );
          if (backendSibling) {
            const siblingCustomDomain = backendSibling.config?.customDomain as string | undefined;
            if (siblingCustomDomain && cfZoneName) {
              backendUrl = `https://${siblingCustomDomain}.${cfZoneName}`;
            }
          }
        } catch { /* use Cloud Run URL */ }

        console.log(`[Deploy]   Injecting backend URL into frontend env vars: ${backendUrl}`);
        const apiUrlKeys = ['VITE_API_URL', 'NEXT_PUBLIC_API_URL', 'REACT_APP_API_URL',
                            'NUXT_PUBLIC_API_URL', 'API_URL', 'BACKEND_URL', 'API_BASE_URL'];
        for (const key of apiUrlKeys) {
          const { existsSync: efs } = await import('node:fs');
          const sourceUnavailable = !projectDir || !efs(projectDir);
          if (!userEnvVars[key] && (finalEnvVars[key] !== undefined || envDetection.missing.includes(key) || sourceUnavailable)) {
            finalEnvVars[key] = backendUrl;
            console.log(`[Deploy]   Injected ${key} = ${backendUrl}`);
          }
        }
      } else {
        console.warn(`[Deploy]   ⚠ No backend sibling URL found after waiting — frontend API calls may fail`);
      }
    }

    // ── Step 2c-2: Restore DB dump if user provided one ──
    const gcsDbDumpUri = project.config?.gcsDbDumpUri as string | undefined;
    if (gcsDbDumpUri && needsCloudSql) {
      currentStep = 'Step 2c-2: Restore database dump';
      console.log(`[Deploy] ${currentStep}...`);

      try {
        // Download dump from GCS to local temp file
        const withoutPrefix = gcsDbDumpUri.slice(5); // remove "gs://"
        const slashIdx = withoutPrefix.indexOf('/');
        const bucket = withoutPrefix.slice(0, slashIdx);
        const object = withoutPrefix.slice(slashIdx + 1);
        const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;

        const { gcpFetch } = await import('./gcp-auth');
        const resp = await gcpFetch(downloadUrl);
        if (!resp.ok) {
          throw new Error(`GCS download failed (${resp.status}): ${await resp.text()}`);
        }

        const { writeFileSync, unlinkSync } = await import('node:fs');
        const dumpFileName = (project.config?.dbDumpFileName as string) || 'dump.sql';
        const dumpLocalPath = `/tmp/db-dump-${project.id}-${dumpFileName}`;
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(dumpLocalPath, buf);
        console.log(`[Deploy]   Downloaded dump: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

        // Find the project's DATABASE_URL (set by db-provisioner in the step above)
        const dbUrl = dbVarKeys.map(k => finalEnvVars[k]).find(v => v && v.includes('/cloudsql/'));
        if (!dbUrl) {
          throw new Error('No Cloud SQL DATABASE_URL found — cannot restore dump without a provisioned database');
        }

        const restoreResult = await restoreDbDump({
          dumpFilePath: dumpLocalPath,
          connectionString: dbUrl,
          instanceConnectionName: cloudSqlInstance!,
        });

        if (restoreResult.success) {
          console.log(`[Deploy]   DB dump restored successfully (${restoreResult.format}, ${restoreResult.durationMs}ms)`);
        } else {
          console.warn(`[Deploy]   ⚠ DB dump restore had errors: ${restoreResult.error}`);
          console.warn(`[Deploy]   Continuing deployment — the app may need manual DB setup`);
        }

        // Store result in project config for dashboard visibility
        try {
          const configUpdate = {
            ...(project.config ?? {}),
            dbRestoreResult: {
              success: restoreResult.success,
              format: restoreResult.format,
              durationMs: restoreResult.durationMs,
              bytesRestored: restoreResult.bytesRestored,
              error: restoreResult.error,
            },
          };
          await updateProjectConfig(project.id, configUpdate);
        } catch { /* non-critical */ }

        // Cleanup temp file
        try { unlinkSync(dumpLocalPath); } catch { /* ignore */ }
      } catch (err) {
        console.error(`[Deploy]   DB dump restore failed: ${(err as Error).message}`);
        console.warn(`[Deploy]   Continuing deployment without DB restore`);
      }
    }

    // Track whether we auto-provisioned VPC-internal resources (for VPC egress)
    let needsVpcEgress = false;

    // ── Step 2d: Provision auto-provisioned resources from ResourcePlan ──
    // Looks at the LLM-generated resource plan and spins up Redis (or other
    // shared services) the app needs, injecting the connection details into
    // finalEnvVars so the app can reach them at runtime.
    try {
      const scanReport = await getLatestScanReport(projectId);
      const resourcePlan = scanReport?.resourcePlan;
      if (resourcePlan && resourcePlan.requirements.length > 0) {
        currentStep = 'Step 2d: Provision resource plan';
        console.log(`[Deploy] ${currentStep}...`);
        for (const req of resourcePlan.requirements) {
          if (req.strategy !== 'auto_provision') {
            console.log(`[Deploy]   ${req.type} (${req.useCase}): strategy=${req.strategy} — skipping auto-provision`);
            continue;
          }
          if (req.type === 'redis') {
            try {
              const redisResult = await provisionProjectRedis(project.id, project.slug);
              // Only inject if not user-provided
              if (!userEnvVars['REDIS_URL']) {
                finalEnvVars['REDIS_URL'] = redisResult.redisUrl;
                needsVpcEgress = true; // shared Redis lives on internal VPC
                console.log(`[Deploy]   Redis provisioned: ${redisResult.providerInfo} (${redisResult.created ? 'new' : 'reused'})`);
                console.log(`[Deploy]   Injected REDIS_URL (db${redisResult.dbIndex})`);
              } else {
                console.log(`[Deploy]   Redis: user supplied REDIS_URL, keeping user value`);
              }
            } catch (err) {
              console.warn(`[Deploy]   Redis provision failed: ${(err as Error).message}`);
            }
          } else {
            console.log(`[Deploy]   ${req.type}: auto-provision not yet implemented, skipping`);
          }
        }
      }
    } catch (err) {
      console.warn(`[Deploy]   Resource provisioning step failed: ${(err as Error).message}`);
    }

    // ─── Step 3: Build and push Docker image ───
    currentStep = 'Step 3: Build Docker image (Cloud Build)';
    console.log(`[Deploy] ${currentStep}...`);
    const buildResult = await buildAndPushImage(projectDir, {
      projectSlug: project.slug,
      gcpProject,
      gcpRegion,
      imageName: project.slug,
      imageTag: `v${Date.now()}`,
      envVars: finalEnvVars,
      port,
    }, gcsSourceUri);

    if (!buildResult.success) {
      // LLM 分析 build 失敗原因。無論 buildLog 有沒有拿到，都呼叫 LLM —
      // 就算只有 error message，LLM 仍能從 Cloud Build API 的文字中判斷大方向。
      let buildDiagnosis: Awaited<ReturnType<typeof analyzeDeployFailure>> | null = null;
      try {
        const logLen = buildResult.buildLog?.length ?? 0;
        console.log(`[Deploy]   Analyzing build failure with LLM (${logLen} chars log)...`);
        buildDiagnosis = await analyzeDeployFailure(
          'Step 3: Build Docker image (Cloud Build)',
          buildResult.error ?? 'Unknown build error',
          buildResult.buildLog ?? '',
          project.name,
        );
        console.log(`[Deploy]   Build diagnosis: [${buildDiagnosis.category}] ${buildDiagnosis.summary}`);
      } catch (llmErr) {
        console.warn(`[Deploy]   LLM build analysis failed: ${(llmErr as Error).message}`);
      }
      const err = new Error(`Docker build failed: ${buildResult.error}`);
      (err as Error & { buildDiagnosis?: typeof buildDiagnosis }).buildDiagnosis = buildDiagnosis;
      (err as Error & { buildLog?: string }).buildLog = buildResult.buildLog;
      throw err;
    }
    console.log(`[Deploy]   Image: ${buildResult.imageUri}`);

    // ─── Step 4: Deploy to Cloud Run ───
    currentStep = 'Step 4: Deploy to Cloud Run';
    console.log(`[Deploy] ${currentStep}...`);
    const deployResult = await deployToCloudRun({
      projectSlug: project.slug,
      gcpProject,
      gcpRegion,
      imageName: project.slug,
      imageTag: `v${Date.now()}`,
      envVars: finalEnvVars,
      memory: '512Mi',
      cpu: '1',
      minInstances: 0,
      maxInstances: 10,
      allowUnauthenticated: project.config?.allowUnauthenticated ?? true,
      port,
      cloudSqlInstance,
      vpcEgress: needsVpcEgress ? {
        network: process.env.VPC_EGRESS_NETWORK ?? 'default',
        subnet: process.env.VPC_EGRESS_SUBNET ?? 'default',
        egress: 'PRIVATE_RANGES_ONLY',
      } : undefined,
    }, buildResult.imageUri);

    if (!deployResult.success) {
      throw new Error(`Cloud Run deploy failed: ${deployResult.error}`);
    }
    console.log(`[Deploy]   Service: ${deployResult.serviceName}`);
    console.log(`[Deploy]   URL: ${deployResult.serviceUrl}`);
    if (deployResult.revisionName) {
      console.log(`[Deploy]   Revision: ${deployResult.revisionName}`);
    }

    // Tag revision for preview URL: https://v3---service.a.run.app
    let previewUrl: string | undefined;
    if (deployResult.revisionName && deployResult.serviceUrl) {
      const tag = `ver-${deployVersion}`; // Cloud Run tags must be 3-47 chars
      try {
        const tagResult = await tagRevision(gcpProject, gcpRegion, deployResult.serviceName, deployResult.revisionName, tag);
        if (tagResult.success && tagResult.taggedUrl) {
          previewUrl = tagResult.taggedUrl;
          console.log(`[Deploy]   Preview URL: ${previewUrl}`);
        } else {
          console.warn(`[Deploy]   Revision tag failed: ${tagResult.error}, using service URL`);
          previewUrl = deployResult.serviceUrl;
        }
      } catch (tagErr) {
        console.warn(`[Deploy]   Revision tag error: ${(tagErr as Error).message}, using service URL`);
        previewUrl = deployResult.serviceUrl;
      }
    }

    // Update deployment record with versioning info
    await updateDeployment(deployment.id, {
      cloudRunService: deployResult.serviceName,
      cloudRunUrl: deployResult.serviceUrl ?? undefined,
      healthStatus: 'unknown',
      deployedAt: new Date(),
      imageUri: deployResult.imageUri ?? buildResult.imageUri,
      revisionName: deployResult.revisionName,
      previewUrl,
    });

    // ── Step 4b: Capture deployed source (post-fix code + Dockerfile) ──
    // 把實際部署的 code 存到長期 bucket，讓使用者能下載回去「從安全基準繼續開發」。
    // 失敗不會中斷 deploy（只 log warning）。
    try {
      const latestScan = await getLatestScanReport(projectId);
      const autoFixCount = Array.isArray(latestScan?.autoFixes)
        ? (latestScan.autoFixes as Array<{ applied: boolean }>).filter((f) => f.applied).length
        : 0;
      const capture = await captureDeployedSource(
        {
          projectName: project.name,
          projectSlug: project.slug,
          version: deployVersion,
          cloudRunUrl: deployResult.serviceUrl,
          customDomain: null, // set later during SSL step if applicable
          imageUri: deployResult.imageUri ?? buildResult.imageUri,
          revisionName: deployResult.revisionName ?? null,
          deployedAt: new Date(),
          autoFixesApplied: autoFixCount,
        },
        projectDir,
        gcsSourceUri,
      );
      await updateDeployment(deployment.id, { deployedSourceGcsUri: capture.gcsUri });
      console.log(`[Deploy]   Captured deployed source: ${capture.gcsUri} (${capture.sourceBytes} bytes, from ${capture.capturedFrom})`);
    } catch (captureErr) {
      console.warn(`[Deploy]   Deployed-source capture failed (non-fatal): ${(captureErr as Error).message}`);
    }

    // Cache last-deployed image so /start can restart the service without rebuilding
    try {
      const updatedConfig = { ...(project.config ?? {}), lastDeployedImage: buildResult.imageUri };
      await updateProjectConfig(project.id, updatedConfig);
    } catch (err) {
      console.warn(`[Deploy]   Failed to cache lastDeployedImage: ${(err as Error).message}`);
    }

    // ── Monorepo: backend notifies frontend siblings of its URL ──
    if (projectGroup && serviceRole === 'backend' && deployResult.serviceUrl) {
      try {
        // Store our URL in config so frontend siblings can find it
        const backendConfig = {
          ...(project.config ?? {}),
          resolvedBackendUrl: deployResult.serviceUrl,
          lastDeployedImage: buildResult.imageUri,
        };
        await updateProjectConfig(project.id, backendConfig);
        console.log(`[Deploy]   Stored resolvedBackendUrl for frontend siblings: ${deployResult.serviceUrl}`);

        // If a frontend sibling already deployed, hot-update its runtime env vars
        const allProjects = await listProjects();
        const frontendSiblings = allProjects.filter(p =>
          (p.config?.projectGroup as string) === projectGroup &&
          p.id !== project.id &&
          (p.config?.serviceRole as string) === 'frontend'
        );
        for (const frontend of frontendSiblings) {
          const frontendDeploys = await getDeploymentsByProject(frontend.id);
          const liveFrontend = frontendDeploys.find(d => d.cloudRunService);
          if (liveFrontend?.cloudRunService) {
            console.log(`[Deploy]   Hot-updating frontend "${frontend.name}" runtime env vars with backend URL`);
            // Update runtime env vars (helps server-side rendering; client-side NEXT_PUBLIC_* needs rebuild)
            try {
              const updateUrl = `https://run.googleapis.com/v2/projects/${gcpProject}/locations/${gcpRegion}/services/${liveFrontend.cloudRunService}`;
              const svcRes = await (await import('./gcp-auth')).gcpFetch(updateUrl);
              if (svcRes.ok) {
                const svc = await svcRes.json() as { template?: { containers?: Array<{ env?: Array<{ name: string; value: string }> }> } };
                const existingEnv = svc.template?.containers?.[0]?.env ?? [];
                const urlKeys = ['API_URL', 'BACKEND_URL', 'NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'REACT_APP_API_URL'];
                const updatedEnv = existingEnv.map(e =>
                  urlKeys.includes(e.name) ? { ...e, value: deployResult.serviceUrl! } : e
                );
                // Also add keys that don't exist yet
                for (const key of urlKeys) {
                  if (!updatedEnv.find(e => e.name === key)) {
                    updatedEnv.push({ name: key, value: deployResult.serviceUrl! });
                  }
                }
                const patchRes = await (await import('./gcp-auth')).gcpFetch(updateUrl, {
                  method: 'PATCH',
                  body: JSON.stringify({
                    template: {
                      ...svc.template,
                      containers: [{ ...svc.template?.containers?.[0], env: updatedEnv }],
                    },
                  }),
                });
                if (patchRes.ok) {
                  console.log(`[Deploy]   Frontend "${frontend.name}" env vars updated with backend URL`);
                } else {
                  console.warn(`[Deploy]   Frontend env update failed: HTTP ${patchRes.status}`);
                }
              }
            } catch (patchErr) {
              console.warn(`[Deploy]   Frontend hot-update failed: ${(patchErr as Error).message}`);
            }
          }
        }
      } catch (err) {
        console.warn(`[Deploy]   Backend→frontend notification failed: ${(err as Error).message}`);
      }
    }

    // Post-deploy: update URL-based env vars now that Cloud Run URL is known
    // If no custom domain, URL-based vars (NEXTAUTH_URL, APP_URL etc.) should use Cloud Run URL
    if (deployResult.serviceUrl && !customDomainFqdn) {
      const urlVarsToUpdate: Record<string, string> = {};
      const urlKeys = ['NEXTAUTH_URL', 'APP_URL', 'BASE_URL', 'SITE_URL', 'PUBLIC_URL'];
      for (const key of urlKeys) {
        if (finalEnvVars[key] && (finalEnvVars[key].includes('localhost') || finalEnvVars[key] === '')) {
          urlVarsToUpdate[key] = deployResult.serviceUrl;
        }
      }
      if (Object.keys(urlVarsToUpdate).length > 0) {
        console.log(`[Deploy]   Updating URL env vars with Cloud Run URL: ${Object.keys(urlVarsToUpdate).join(', ')}`);
        Object.assign(finalEnvVars, urlVarsToUpdate);
        // Re-deploy with corrected env vars (quick update, same image)
        await deployToCloudRun({
          projectSlug: project.slug,
          gcpProject,
          gcpRegion,
          imageName: project.slug,
          imageTag: `v${Date.now()}`,
          envVars: finalEnvVars,
          memory: '512Mi',
          cpu: '1',
          minInstances: 0,
          maxInstances: 10,
          allowUnauthenticated: project.config?.allowUnauthenticated ?? true,
          port,
          cloudSqlInstance,
        }, buildResult.imageUri);
      }
    }

    await transitionProject(projectId, 'deployed', 'deploy-worker', {
      serviceName: deployResult.serviceName,
      serviceUrl: deployResult.serviceUrl,
      duration: `${(deployResult.duration / 1000).toFixed(1)}s`,
      envVarsSet: Object.keys(finalEnvVars),
      envVarsMissing: envDetection.missing,
      envWarnings: envDetection.warnings.length,
    });

    // ─── Step 5: Custom domain setup (if configured) ───
    if (customDomainSubdomain) {
      currentStep = 'Step 5: Custom domain & DNS setup';
      console.log(`[Deploy] ${currentStep}...`);

      const cfToken = process.env.CLOUDFLARE_TOKEN || '';
      const cfZoneId = process.env.CLOUDFLARE_ZONE_ID || '';

      if (cfToken && cfZoneId && cfZoneName) {
        const dnsConfig: DnsConfig = {
          cloudflareToken: cfToken,
          zoneId: cfZoneId,
          subdomain: customDomainSubdomain,
          zoneName: cfZoneName,
        };

        const forceDomain = Boolean(project.config?.forceDomain);
        const domainResult = await setupCustomDomainWithDns(
          dnsConfig,
          deployResult.serviceUrl ?? '',
          gcpProject,
          gcpRegion,
          deployResult.serviceName,
          { force: forceDomain }
        );

        if (domainResult.success) {
          const fqdn = `${customDomainSubdomain}.${cfZoneName}`;
          await updateDeployment(deployment.id, {
            customDomain: fqdn,
            sslStatus: 'provisioning',
          });

          await transitionProject(projectId, 'ssl_provisioning', 'deploy-worker', {
            customDomain: fqdn,
          });

          // ─── Step 6: SSL monitoring ───
          currentStep = 'Step 6: SSL certificate provisioning';
          console.log(`[Deploy] ${currentStep}...`);

          try {
            const sslResult = await monitorSsl(deployment.id, projectId, {
              gcpProject,
              gcpRegion,
              domain: fqdn,
              maxChecks: 20,      // 20 checks × 30s = 10 minutes max
              intervalMs: 30000,
            });

            if (sslResult.allReady) {
              await updateDeployment(deployment.id, { sslStatus: 'active' });
              console.log(`[Deploy]   SSL active for ${fqdn}`);
            } else {
              // SSL not ready yet — this is normal, can take up to 15 minutes
              // Don't fail, just continue the pipeline
              console.warn(`[Deploy]   SSL still provisioning for ${fqdn}, continuing pipeline`);
              await updateDeployment(deployment.id, { sslStatus: 'provisioning' });
            }
          } catch (sslErr) {
            console.warn(`[Deploy]   SSL monitoring error: ${(sslErr as Error).message}, continuing`);
          }
        } else {
          const domainError = domainResult.conflict
            ? `DOMAIN CONFLICT: ${customDomainSubdomain}.${cfZoneName} is already mapped to "${domainResult.conflict.existingRoute}". Re-deploy with force_domain=true to override.`
            : `Domain setup failed: ${domainResult.error}`;
          console.warn(`[Deploy]   ⚠ ${domainError}`);
          // Record domain error in project config so it's visible in dashboard
          try {
            await updateProjectConfig(project.id, {
              ...project.config,
              domainError,
              domainErrorAt: new Date().toISOString(),
            });
          } catch { /* non-fatal */ }
          // Continue without custom domain
        }
      } else {
        console.warn('[Deploy]   Cloudflare not configured, skipping custom domain');
      }
    }

    // ─── Step 7: Canary checks ───
    currentStep = 'Step 7: Canary health checks';
    console.log(`[Deploy] ${currentStep}...`);

    // Transition to canary_check from whatever current state
    const currentProject = await getProject(projectId);
    const currentState = currentProject?.status ?? 'deployed';
    if (currentState === 'deployed') {
      // No custom domain path: deployed → ssl_provisioning → canary_check
      await transitionProject(projectId, 'ssl_provisioning', 'deploy-worker', { note: 'no custom domain, skipped' });
      await transitionProject(projectId, 'canary_check', 'deploy-worker', { trigger: 'auto' });
    } else if (currentState === 'ssl_provisioning') {
      await transitionProject(projectId, 'canary_check', 'deploy-worker', { trigger: 'auto' });
    }

    // Use the custom domain URL if available, otherwise the Cloud Run URL
    const customDomainUrl = customDomainFqdn
      ? `https://${customDomainFqdn}`
      : null;
    // For canary, prefer Cloud Run URL (always accessible with auth) over custom domain (may not have SSL yet)
    const targetUrl = deployResult.serviceUrl ?? '';
    if (targetUrl) {
      // Use identity token for .run.app URLs since the service may require auth
      const canaryResult = await runCanaryChecks(targetUrl, {
        checks: 3,          // reduce from 5 to speed up
        intervalMs: 5000,   // 5s between checks
      });
      await updateDeployment(deployment.id, {
        canaryResults: canaryResult,
        healthStatus: canaryResult.passed ? 'healthy' : 'unhealthy',
      });

      if (canaryResult.passed) {
        // ─── Step 8: Go live + auto-publish ───
        currentStep = 'Step 8: Go live';
        console.log(`[Deploy] ${currentStep}...`);
        const liveUrl = customDomainUrl || deployResult.serviceUrl;

        // Auto-publish unless deploy is locked
        const freshProject = await getProject(projectId);
        const isLocked = freshProject?.config?.deployLocked === true;
        if (!isLocked) {
          await publishDeployment(projectId, deployment.id);
          console.log(`[Deploy]   Auto-published v${deployVersion}`);
        } else {
          console.log(`[Deploy]   Deploy locked — v${deployVersion} deployed but NOT published`);
        }

        try {
          await transitionProject(projectId, 'live', 'deploy-worker', {
            serviceUrl: liveUrl,
            cloudRunUrl: deployResult.serviceUrl,
            canaryPassed: true,
            version: deployVersion,
            autoPublished: !isLocked,
          });
        } catch (transErr) {
          // Reconciler may have already pushed to 'live' — that's fine, skip
          if ((transErr as Error).message?.includes('Invalid state transition')) {
            console.warn(`[Deploy]   State already live (reconciler race) — continuing`);
          } else {
            throw transErr;
          }
        }
        console.log(`[Deploy] ✓ Project ${project.name} v${deployVersion} is LIVE at ${liveUrl}`);
        notifyDeployComplete(project.name, deployVersion, liveUrl ?? '', previewUrl, true).catch(() => {});
      } else {
        // Canary failed — auto-rollback to previous published version
        const failedChecks = canaryResult.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.type}: ${c.value} (threshold: ${c.threshold})`)
          .join(', ');
        console.warn(`[Deploy]   Canary FAILED: ${failedChecks}`);

        // Find previous published deployment to rollback to
        const allDeploys = await getDeploymentsByProject(projectId);
        const previousPublished = allDeploys.find(
          (d) => d.id !== deployment.id && d.revisionName && d.isPublished
        );

        if (previousPublished?.revisionName && previousPublished.cloudRunService) {
          // Auto-rollback: route traffic back to previous version
          console.warn(`[Deploy]   Auto-rolling back to v${previousPublished.version} (${previousPublished.revisionName})`);
          const rollbackResult = await publishRevision(
            gcpProject, gcpRegion,
            previousPublished.cloudRunService,
            previousPublished.revisionName
          );
          if (rollbackResult.success) {
            console.log(`[Deploy]   Rollback successful — traffic on v${previousPublished.version}`);
            // Don't publish the new deployment in DB — keep previous as published
          } else {
            console.error(`[Deploy]   Rollback failed: ${rollbackResult.error}`);
          }

          const liveUrl = customDomainUrl || deployResult.serviceUrl;
          await transitionProject(projectId, 'live', 'deploy-worker', {
            serviceUrl: liveUrl,
            cloudRunUrl: deployResult.serviceUrl,
            canaryFailed: true,
            canaryWarnings: failedChecks,
            rolledBackTo: `v${previousPublished.version}`,
            version: deployVersion,
            autoPublished: false,
          });
          console.warn(`[Deploy] ⚠ v${deployVersion} deployed but canary failed — rolled back to v${previousPublished.version}`);
          notifyCanaryFailed(project.name, deployVersion, failedChecks, `v${previousPublished.version}`).catch(() => {});
        } else {
          // No previous version to rollback to — first deploy, go live with warning
          console.warn(`[Deploy]   No previous version to rollback to — going live with warnings`);
          currentStep = 'Step 8: Go live (canary warning)';
          const liveUrl = customDomainUrl || deployResult.serviceUrl;

          const freshProject = await getProject(projectId);
          const isLocked = freshProject?.config?.deployLocked === true;
          if (!isLocked) {
            await publishDeployment(projectId, deployment.id);
          }

          await transitionProject(projectId, 'live', 'deploy-worker', {
            serviceUrl: liveUrl,
            cloudRunUrl: deployResult.serviceUrl,
            canaryWarnings: failedChecks,
            version: deployVersion,
            autoPublished: !isLocked,
          });
          console.log(`[Deploy] ✓ Project ${project.name} v${deployVersion} is LIVE at ${liveUrl} (with canary warnings, no rollback target)`);
        }
      }
    } else {
      // No URL to check, just go live
      const freshProject = await getProject(projectId);
      const isLocked = freshProject?.config?.deployLocked === true;
      if (!isLocked) {
        await publishDeployment(projectId, deployment.id);
      }
      await transitionProject(projectId, 'live', 'deploy-worker', {
        serviceUrl: 'unknown',
        canarySkipped: true,
      });
    }

    // ─── Step 9: Version retention (keep last N) ───
    const MAX_VERSIONS = 5;
    try {
      const allVersions = await getDeploymentsByProject(projectId);
      if (allVersions.length > MAX_VERSIONS) {
        const toCleanup = allVersions.slice(MAX_VERSIONS); // oldest versions beyond limit
        for (const old of toCleanup) {
          if (old.isPublished) continue; // never delete published version
          if (old.revisionName) {
            console.log(`[Deploy]   Cleaning up old revision: ${old.revisionName} (v${old.version})`);
            await deleteRevision(gcpProject, gcpRegion, old.revisionName);
          }
        }
        console.log(`[Deploy]   Version retention: kept ${MAX_VERSIONS}, cleaned ${toCleanup.filter(d => !d.isPublished && d.revisionName).length} old revisions`);
      }
    } catch (retentionErr) {
      console.warn(`[Deploy]   Version retention cleanup failed (non-fatal): ${(retentionErr as Error).message}`);
    }

  } catch (err) {
    const error = err as Error;
    // 優先用已附著的 buildDiagnosis（Step 3 build 失敗路徑會帶），否則現場呼叫 LLM
    let buildDiagnosis = (error as Error & { buildDiagnosis?: Awaited<ReturnType<typeof analyzeDeployFailure>> }).buildDiagnosis ?? null;
    const attachedLog = (error as Error & { buildLog?: string }).buildLog ?? '';

    if (!buildDiagnosis) {
      try {
        console.log(`[Deploy]   Analyzing failure with LLM at ${currentStep}...`);
        const projectName = (await getProject(projectId))?.name ?? 'unknown';
        buildDiagnosis = await analyzeDeployFailure(
          currentStep,
          error.message,
          attachedLog,
          projectName,
        );
        console.log(`[Deploy]   Diagnosis: [${buildDiagnosis.category}] ${buildDiagnosis.summary}`);
      } catch (llmErr) {
        console.warn(`[Deploy]   LLM failure analysis failed: ${(llmErr as Error).message}`);
      }
    }

    console.error(`[Deploy] ✗ Failed for project ${projectId} at ${currentStep}:\n${error.message}`);
    if (buildDiagnosis) {
      console.error(`[Deploy]   Diagnosis: [${buildDiagnosis.category}] ${buildDiagnosis.rootCause}`);
    }
    notifyDeployFailed(projectId, error.message, currentStep, buildDiagnosis ?? undefined).catch(() => {});
    try {
      await transitionProject(projectId, 'failed', 'deploy-worker', {
        error: error.message,
        failedStep: currentStep,
        stack: error.stack?.split('\n').slice(0, 5).join(' → ') ?? '',
        ...(buildDiagnosis ? {
          buildDiagnosis: {
            category: buildDiagnosis.category,
            summary: buildDiagnosis.summary,
            rootCause: buildDiagnosis.rootCause,
            suggestedFix: buildDiagnosis.suggestedFix,
            errorLocation: buildDiagnosis.errorLocation,
            errorSnippet: buildDiagnosis.errorSnippet,
            extraObservations: buildDiagnosis.extraObservations,
            step: buildDiagnosis.step,
            provider: buildDiagnosis.provider,
          },
        } : {}),
      });
    } catch (transitionErr) {
      console.error('[Deploy] Could not transition to failed:', (transitionErr as Error).message);
    }
  }
}
