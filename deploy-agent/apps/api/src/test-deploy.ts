import 'dotenv/config';
import { detectProject } from './services/project-detector';
import { generateDockerfile } from './services/dockerfile-gen';
import { buildAndPushImage, deployToCloudRun } from './services/deploy-engine';
import { setupCustomDomainWithDns, listZones } from './services/dns-manager';
import { estimateMonthlyCost, formatCostEstimate } from './services/cost-estimator';
import { writeFileSync, existsSync } from 'node:fs';

// ─── Config ───

const PROJECT_DIR = process.argv[2] || '/tmp/kol-studio';
const CUSTOM_DOMAIN = process.argv[3] || '';  // e.g. "kol-studio" → kol-studio.punwave.com

const GCP_PROJECT = process.env.GCP_PROJECT || 'wave-deploy-agent';
const GCP_REGION = process.env.GCP_REGION || 'asia-east1';
const CF_TOKEN = process.env.CLOUDFLARE_TOKEN || '';
const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '';
const CF_ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || '';

function fatal(msg: string): never {
  console.error(`\n  FATAL: ${msg}`);
  process.exit(1);
}

async function main() {
  const startTotal = Date.now();
  console.log('='.repeat(60));
  console.log('DEPLOY AGENT — FULL DEPLOYMENT PIPELINE TEST');
  console.log(`Project: ${PROJECT_DIR}`);
  console.log(`GCP: ${GCP_PROJECT} / ${GCP_REGION}`);
  console.log(`Custom domain: ${CUSTOM_DOMAIN || '(none)'}`);
  console.log('='.repeat(60));

  // ─── Step 1: Project Detection ───
  console.log('\n--- STEP 1: Project Detection ---');
  const detection = detectProject(PROJECT_DIR);
  console.log(`  ${detection.framework} (${detection.language})`);
  console.log(`  Port: ${detection.port}`);
  console.log(`  Has Dockerfile: ${detection.hasDockerfile}`);

  const projectSlug = PROJECT_DIR.split('/').pop() || 'app';
  const imageTag = `deploy-${Date.now()}`;

  // ─── Step 2: Dockerfile ───
  console.log('\n--- STEP 2: Dockerfile ---');
  if (detection.hasDockerfile) {
    console.log('  Using existing Dockerfile');
  } else {
    console.log('  Generating Dockerfile...');
    const dockerfile = generateDockerfile(detection);
    writeFileSync(`${PROJECT_DIR}/Dockerfile`, dockerfile);
    console.log('  Dockerfile generated and written');
  }

  // ─── Step 3: Cloud Build ───
  console.log('\n--- STEP 3: Cloud Build (Docker image) ---');
  console.log(`  Image: ${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/deploy-agent/${projectSlug}:${imageTag}`);
  console.log('  Building... (this may take 3-5 minutes)');

  const startBuild = Date.now();
  const buildResult = await buildAndPushImage(PROJECT_DIR, {
    projectSlug,
    gcpProject: GCP_PROJECT,
    gcpRegion: GCP_REGION,
    imageName: projectSlug,
    imageTag,
    envVars: {},
  });
  const buildDuration = Date.now() - startBuild;

  if (!buildResult.success) {
    fatal(`Cloud Build failed: ${buildResult.error}`);
  }
  console.log(`  Build SUCCESS (${Math.round(buildDuration / 1000)}s)`);
  console.log(`  Image URI: ${buildResult.imageUri}`);

  // ─── Step 4: Deploy to Cloud Run ───
  console.log('\n--- STEP 4: Deploy to Cloud Run ---');
  const envVars: Record<string, string> = {
    NODE_ENV: 'production',
  };

  // Pass through common env vars if set
  for (const key of detection.envVars) {
    const val = process.env[key];
    if (val && !key.includes('KEY') && !key.includes('SECRET') && !key.includes('TOKEN') && !key.includes('PASSWORD')) {
      envVars[key] = val;
    }
  }

  // Always set dummy values for required build-time vars so the app starts
  envVars.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://placeholder';
  envVars.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'deploy-agent-test';

  console.log(`  Service: da-${projectSlug}`);
  console.log(`  Env vars: ${Object.keys(envVars).join(', ')}`);
  console.log('  Deploying...');

  const deployResult = await deployToCloudRun(
    {
      projectSlug,
      gcpProject: GCP_PROJECT,
      gcpRegion: GCP_REGION,
      imageName: projectSlug,
      imageTag,
      envVars,
      memory: '1Gi',
      cpu: '2',
      port: detection.port,
      minInstances: 0,
      maxInstances: 3,
      allowUnauthenticated: true,
    },
    buildResult.imageUri
  );

  if (!deployResult.success) {
    fatal(`Deploy failed: ${deployResult.error}`);
  }
  console.log(`  Deploy SUCCESS (${Math.round(deployResult.duration / 1000)}s)`);
  console.log(`  Service URL: ${deployResult.serviceUrl}`);

  // ─── Step 5: Health Check ───
  console.log('\n--- STEP 5: Health Check ---');
  if (deployResult.serviceUrl) {
    const healthStart = Date.now();
    try {
      const res = await fetch(deployResult.serviceUrl, { redirect: 'manual' });
      const healthDuration = Date.now() - healthStart;
      const ok = res.status >= 200 && res.status < 400;
      console.log(`  HTTP ${res.status} (${healthDuration}ms) ${ok ? '✓' : '✗'}`);

      if (res.status >= 300 && res.status < 400) {
        console.log(`  Redirect → ${res.headers.get('location')}`);
      }
    } catch (err) {
      console.error(`  Health check failed: ${(err as Error).message}`);
    }
  }

  // ─── Step 6: Custom Domain (Cloudflare) ───
  let customUrl = '';
  if (CUSTOM_DOMAIN && CF_TOKEN) {
    console.log('\n--- STEP 6: Custom Domain (Cloudflare DNS) ---');

    let zoneId = CF_ZONE_ID;
    let zoneName = CF_ZONE_NAME;

    // Auto-detect zone if not configured
    if (!zoneId || !zoneName) {
      console.log('  Auto-detecting Cloudflare zone...');
      const zones = await listZones(CF_TOKEN);
      if (zones.length === 0) {
        console.error('  No Cloudflare zones found for this token');
      } else {
        zoneId = zones[0].id;
        zoneName = zones[0].name;
        console.log(`  Zone: ${zoneName} (${zoneId})`);
      }
    }

    if (zoneId && zoneName && deployResult.serviceUrl) {
      const dnsResult = await setupCustomDomainWithDns(
        {
          cloudflareToken: CF_TOKEN,
          zoneId,
          subdomain: CUSTOM_DOMAIN,
          zoneName,
        },
        deployResult.serviceUrl,
        GCP_PROJECT,
        GCP_REGION,
        deployResult.serviceName
      );

      if (dnsResult.success) {
        customUrl = dnsResult.customUrl;
        console.log(`  Custom URL: ${customUrl}`);

        // Verify custom domain resolves
        console.log('  Waiting 5s for DNS propagation...');
        await new Promise((r) => setTimeout(r, 5000));

        try {
          const res = await fetch(customUrl, { redirect: 'manual' });
          console.log(`  Custom domain check: HTTP ${res.status} ✓`);
        } catch (err) {
          console.log(`  Custom domain not yet resolving (may take up to 60s): ${(err as Error).message}`);
        }
      } else {
        console.error(`  DNS setup failed: ${dnsResult.error}`);
      }
    }
  } else if (CUSTOM_DOMAIN && !CF_TOKEN) {
    console.log('\n--- STEP 6: Custom Domain (SKIPPED) ---');
    console.log('  CLOUDFLARE_TOKEN not set, skipping DNS setup');
  }

  // ─── Step 7: Cost Estimate ───
  console.log('\n--- STEP 7: Cost Estimate ---');
  const costEstimate = estimateMonthlyCost({
    cpu: 2,
    memoryMB: 1024,
    avgRequestsPerDay: 500,
    avgRequestDurationMs: 300,
    avgResponseSizeKB: 100,
    minInstances: 0,
  });
  console.log(formatCostEstimate(costEstimate));

  // ─── Summary ───
  const totalDuration = Date.now() - startTotal;
  console.log('\n' + '='.repeat(60));
  console.log('DEPLOYMENT PIPELINE — SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Project:        ${detection.framework} (${detection.language})`);
  console.log(`  Dockerfile:     ${detection.hasDockerfile ? 'EXISTING' : 'GENERATED'}`);
  console.log(`  Cloud Build:    SUCCESS (${Math.round(buildDuration / 1000)}s)`);
  console.log(`  Cloud Run:      SUCCESS (${Math.round(deployResult.duration / 1000)}s)`);
  console.log(`  Service URL:    ${deployResult.serviceUrl}`);
  console.log(`  Custom Domain:  ${customUrl || '(none)'}`);
  console.log(`  Estimated Cost: $${costEstimate.monthlyTotal}/month`);
  console.log(`  Total Duration: ${Math.round(totalDuration / 1000)}s`);
  console.log('='.repeat(60));

  return {
    serviceUrl: deployResult.serviceUrl,
    customUrl,
    buildDuration,
    deployDuration: deployResult.duration,
    totalDuration,
  };
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err);
  process.exit(1);
});
