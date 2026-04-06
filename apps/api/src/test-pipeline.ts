import 'dotenv/config';
import { detectProject } from './services/project-detector';
import { generateDockerfile, generateDockerignore } from './services/dockerfile-gen';
import { runSemgrep, runTrivy } from './services/scanner';
import { estimateMonthlyCost, formatCostEstimate } from './services/cost-estimator';
import { generateTerraform } from './services/iac-generator';

const PROJECT_DIR = process.argv[2] || '/tmp/kol-studio';

async function main() {
  console.log('='.repeat(60));
  console.log('DEPLOY AGENT — PIPELINE TEST');
  console.log(`Project: ${PROJECT_DIR}`);
  console.log('='.repeat(60));

  // Step 1: Project Detection
  console.log('\n--- STEP 1: Project Detection ---');
  const detection = detectProject(PROJECT_DIR);
  console.log(`  Language: ${detection.language}`);
  console.log(`  Framework: ${detection.framework}`);
  console.log(`  Package Manager: ${detection.packageManager}`);
  console.log(`  Entrypoint: ${detection.entrypoint}`);
  console.log(`  Port: ${detection.port}`);
  console.log(`  Has Dockerfile: ${detection.hasDockerfile}`);
  console.log(`  Has Docker Compose: ${detection.hasDockerCompose}`);
  console.log(`  Env Vars (${detection.envVars.length}): ${detection.envVars.slice(0, 5).join(', ')}${detection.envVars.length > 5 ? '...' : ''}`);

  // Step 2: Dockerfile Generation (only if missing)
  console.log('\n--- STEP 2: Dockerfile Generation ---');
  if (detection.hasDockerfile) {
    console.log('  Dockerfile already exists, skipping generation.');
    console.log('  (Agent would validate the existing Dockerfile instead)');
  } else {
    const dockerfile = generateDockerfile(detection);
    console.log('  Generated Dockerfile:');
    console.log(dockerfile.split('\n').map(l => `    ${l}`).join('\n'));
  }

  // Step 2b: Dockerignore
  const dockerignore = generateDockerignore(detection);
  console.log(`  .dockerignore (${dockerignore.split('\n').length} entries)`);

  // Step 3: Security Scanning (SAST)
  console.log('\n--- STEP 3: SAST Scan (Semgrep) ---');
  const semgrepResult = await runSemgrep(PROJECT_DIR);
  console.log(`  Duration: ${semgrepResult.duration}ms`);
  console.log(`  Findings: ${semgrepResult.findings.length}`);
  if (semgrepResult.findings.length > 0) {
    for (const f of semgrepResult.findings.slice(0, 10)) {
      console.log(`    [${f.severity}] ${f.title} — ${f.filePath}:${f.lineStart} (${f.action})`);
    }
    if (semgrepResult.findings.length > 10) {
      console.log(`    ... and ${semgrepResult.findings.length - 10} more`);
    }
  } else {
    console.log('  (Semgrep may not be installed — check raw output)');
    console.log(`  Raw output (first 200 chars): ${semgrepResult.rawOutput.slice(0, 200)}`);
  }

  // Step 4: Security Scanning (SCA)
  console.log('\n--- STEP 4: SCA Scan (Trivy) ---');
  const trivyResult = await runTrivy(PROJECT_DIR);
  console.log(`  Duration: ${trivyResult.duration}ms`);
  console.log(`  Findings: ${trivyResult.findings.length}`);
  if (trivyResult.findings.length > 0) {
    for (const f of trivyResult.findings.slice(0, 10)) {
      console.log(`    [${f.severity}] ${f.title} — ${f.filePath} (${f.action})`);
    }
    if (trivyResult.findings.length > 10) {
      console.log(`    ... and ${trivyResult.findings.length - 10} more`);
    }
  } else {
    console.log('  (Trivy may not be installed — check raw output)');
    console.log(`  Raw output (first 200 chars): ${trivyResult.rawOutput.slice(0, 200)}`);
  }

  // Step 5: Cost Estimation
  console.log('\n--- STEP 5: Cost Estimation ---');
  const costEstimate = estimateMonthlyCost({
    cpu: 2,
    memoryMB: 1024, // kol-studio needs 1GB for Puppeteer
    avgRequestsPerDay: 500,
    avgRequestDurationMs: 300,
    avgResponseSizeKB: 100,
    minInstances: 0,
  });
  console.log(formatCostEstimate(costEstimate));

  // Step 6: IaC Generation (Terraform)
  console.log('\n--- STEP 6: IaC Generation (Terraform) ---');
  const terraform = generateTerraform({
    projectSlug: 'kol-studio',
    gcpProject: 'for-joe-testing',
    gcpRegion: 'asia-east1',
    imageName: 'kol-studio',
    imageTag: 'latest',
    envVars: {
      DATABASE_URL: '$(SECRET_DATABASE_URL)',
      NEXTAUTH_SECRET: '$(SECRET_NEXTAUTH_SECRET)',
      GEMINI_API_KEY: '$(SECRET_GEMINI_API_KEY)',
    },
    memory: '1Gi',
    cpu: '2',
    port: 3000,
    allowUnauthenticated: false,
  });
  console.log(`  Generated ${terraform.split('\n').length} lines of Terraform`);
  console.log('  Resources: google_cloud_run_v2_service, google_artifact_registry_repository');

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('PIPELINE TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Project: ${detection.framework} (${detection.language})`);
  console.log(`  Dockerfile: ${detection.hasDockerfile ? 'EXISTS' : 'GENERATED'}`);
  console.log(`  SAST Findings: ${semgrepResult.findings.length}`);
  console.log(`  SCA Findings: ${trivyResult.findings.length}`);
  console.log(`  Total Findings: ${semgrepResult.findings.length + trivyResult.findings.length}`);
  console.log(`  Auto-fixable: ${[...semgrepResult.findings, ...trivyResult.findings].filter(f => f.action === 'auto_fix').length}`);
  console.log(`  Report-only: ${[...semgrepResult.findings, ...trivyResult.findings].filter(f => f.action === 'report_only').length}`);
  console.log(`  Estimated Cost: $${costEstimate.monthlyTotal}/month`);
  console.log(`  Terraform: GENERATED`);
  console.log(`  Deploy Target: Cloud Run (asia-east1)`);
  console.log('='.repeat(60));

  // Check what's missing for full deployment
  console.log('\n--- DEPLOYMENT READINESS ---');
  const missing: string[] = [];
  if (!process.env.GCP_PROJECT) missing.push('GCP_PROJECT env var');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY (for LLM analysis)');
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN (for PR creation)');

  // Check if gcloud is available
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('gcloud', ['--version'], { timeout: 5000 });
    console.log('  gcloud CLI: AVAILABLE');
  } catch {
    missing.push('gcloud CLI (for Cloud Run deploy)');
  }

  if (missing.length === 0) {
    console.log('  ALL REQUIREMENTS MET — ready for full deployment');
  } else {
    console.log('  Missing for full deployment:');
    for (const m of missing) {
      console.log(`    ✗ ${m}`);
    }
  }
}

main().catch(console.error);
