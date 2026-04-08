import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detectProject } from './services/project-detector';
import { runSemgrep, runTrivy } from './services/scanner';
import { analyzeThreatModel, generateReviewReport } from './services/llm-analyzer';
import { estimateMonthlyCost, formatCostEstimate } from './services/cost-estimator';

const PROJECT_DIR = process.argv[2] || '/tmp/kol-studio';

function collectSourceFiles(dir: string, base: string): Map<string, string> {
  const files = new Map<string, string>();
  const SKIP = ['node_modules', '.next', '.git', 'dist', 'build', '.cache'];
  const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.env', '.yml', '.yaml', 'Dockerfile'];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const rel = relative(base, full);
      if (SKIP.some((s) => rel.includes(s))) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (EXTS.some((e) => entry.endsWith(e)) && stat.size < 50_000) {
        files.set(rel, readFileSync(full, 'utf-8'));
      }
    }
  }

  walk(dir);
  return files;
}

async function main() {
  console.log('='.repeat(60));
  console.log('DEPLOY AGENT — FULL LLM ANALYSIS TEST');
  console.log(`Project: ${PROJECT_DIR}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log('='.repeat(60));

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  // Step 1: Detect project
  console.log('\n--- STEP 1: Project Detection ---');
  const detection = detectProject(PROJECT_DIR);
  console.log(`  ${detection.framework} (${detection.language}), port ${detection.port}`);

  // Step 2: Collect source files
  console.log('\n--- STEP 2: Collecting Source Files ---');
  const sourceFiles = collectSourceFiles(PROJECT_DIR, PROJECT_DIR);
  console.log(`  Found ${sourceFiles.size} source files`);
  const topFiles = Array.from(sourceFiles.keys()).slice(0, 15);
  for (const f of topFiles) console.log(`    ${f}`);
  if (sourceFiles.size > 15) console.log(`    ... and ${sourceFiles.size - 15} more`);

  // Step 3: Security scans
  console.log('\n--- STEP 3: Security Scanning ---');
  const [semgrep, trivy] = await Promise.all([
    runSemgrep(PROJECT_DIR),
    runTrivy(PROJECT_DIR),
  ]);
  const scannerFindings = [...semgrep.findings, ...trivy.findings];
  console.log(`  Semgrep: ${semgrep.findings.length} findings (${semgrep.duration}ms)`);
  console.log(`  Trivy: ${trivy.findings.length} findings (${trivy.duration}ms)`);
  console.log(`  Total scanner findings: ${scannerFindings.length}`);

  // Step 4: LLM Threat Analysis
  console.log('\n--- STEP 4: LLM Threat Analysis (Claude API) ---');
  console.log('  Sending to Claude for analysis... (may take 30-60 seconds)');
  const startLlm = Date.now();
  const threatAnalysis = await analyzeThreatModel(sourceFiles, scannerFindings);
  const llmDuration = Date.now() - startLlm;
  console.log(`  Duration: ${llmDuration}ms`);
  console.log(`  Summary: ${threatAnalysis.summary.slice(0, 200)}...`);
  console.log(`  LLM Findings: ${threatAnalysis.findings.length}`);
  for (const f of threatAnalysis.findings.slice(0, 10)) {
    console.log(`    [${f.severity}] ${f.title} — ${f.filePath}:${f.lineStart} (${f.action})`);
  }
  console.log(`  Auto-fix suggestions: ${threatAnalysis.autoFixes.length}`);
  for (const fix of threatAnalysis.autoFixes.slice(0, 5)) {
    console.log(`    Fix: ${fix.explanation.slice(0, 80)}...`);
  }

  // Step 5: Cost estimation
  console.log('\n--- STEP 5: Cost Estimation ---');
  const costEstimate = estimateMonthlyCost({
    cpu: 2,
    memoryMB: 1024,
    avgRequestsPerDay: 500,
    avgRequestDurationMs: 300,
    avgResponseSizeKB: 100,
    minInstances: 0,
  });
  console.log(formatCostEstimate(costEstimate));

  // Step 6: Generate review report
  console.log('\n--- STEP 6: Review Report Generation ---');
  console.log('  Generating report via Claude...');
  const startReport = Date.now();
  const report = await generateReviewReport(
    'kol-studio',
    threatAnalysis,
    scannerFindings,
    threatAnalysis.autoFixes.map((fix) => ({
      findingId: fix.findingId,
      applied: true,
      explanation: fix.explanation,
      diff: `- ${fix.originalCode.slice(0, 50)}...\n+ ${fix.fixedCode.slice(0, 50)}...`,
      verificationPassed: null,
    })),
    costEstimate,
  );
  const reportDuration = Date.now() - startReport;
  console.log(`  Duration: ${reportDuration}ms`);
  console.log('\n' + '='.repeat(60));
  console.log('GENERATED REVIEW REPORT');
  console.log('='.repeat(60));
  console.log(report);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('FULL PIPELINE SUMMARY');
  console.log('='.repeat(60));
  const allFindings = [...scannerFindings, ...threatAnalysis.findings];
  console.log(`  Total findings: ${allFindings.length}`);
  console.log(`    Scanner: ${scannerFindings.length}`);
  console.log(`    LLM: ${threatAnalysis.findings.length}`);
  console.log(`  Auto-fix suggestions: ${threatAnalysis.autoFixes.length}`);
  console.log(`  Estimated cost: $${costEstimate.monthlyTotal}/month`);
  console.log(`  LLM analysis time: ${llmDuration}ms`);
  console.log(`  Report generation time: ${reportDuration}ms`);
  console.log('='.repeat(60));
}

main().catch(console.error);
