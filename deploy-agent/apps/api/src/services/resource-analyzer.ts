// Resource Analyzer — LLM-based detection of external services a project needs.
//
// Examines package.json / requirements.txt / source code imports and env var
// usage patterns, then asks an LLM to classify what external resources
// (Redis, Postgres, object storage, SMTP, external APIs) the project depends
// on, and whether we can auto-provision them or need user input.
//
// Output: ResourcePlan { requirements[], missingUserEnvVars[], canAutoDeploy, blockers[] }

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ResourcePlan, ResourceRequirement } from '@deploy-agent/shared';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

const SYSTEM_PROMPT = `You are a deployment architect analyzing an app being deployed to GCP Cloud Run.
Your job: identify every external service the app depends on at RUNTIME (not build-time), and classify how to provision each.

Rules:
1. Only flag services the app actually needs to START and RUN (don't flag build tools or test-only deps).
2. Infer from: package.json imports (bullmq → Redis), env var patterns (REDIS_URL → Redis), source code usage.
3. Prefer auto_provision for Redis, Postgres, MySQL (we can host these on shared GCP infra).
4. Use user_provided for external APIs (Stripe, OpenAI, Gemini, SendGrid) — user must supply keys.
5. Use already_configured if the env var is already present in user-supplied env vars.
6. Use skip if the dependency is optional and the app works without it.
7. Write reasoning and summary in bilingual format: Traditional Chinese (繁體中文) first, then English, separated by " / ".
8. Respond ONLY with a JSON object matching the schema. No markdown code fences.`;

export interface AnalyzeResourcesInput {
  projectDir: string;
  language: string | null;
  framework: string | null;
  /** Env vars referenced in source code (from env-detector) */
  referencedEnvVars: string[];
  /** Env vars already detected/resolved (user + auto) */
  resolvedEnvVars: Record<string, string>;
}

export async function analyzeResources(
  input: AnalyzeResourcesInput,
): Promise<ResourcePlan> {
  if (!anthropic && !openai) {
    console.warn('[ResourceAnalyzer] No LLM API keys — falling back to heuristic detection');
    return heuristicFallback(input);
  }

  // ─── Gather evidence ───
  const evidence = gatherEvidence(input.projectDir);

  const userMessage = `Analyze this project and identify external runtime service dependencies.

Language: ${input.language ?? 'unknown'}
Framework: ${input.framework ?? 'unknown'}

package.json dependencies (key ones):
${evidence.dependencies.slice(0, 30).join(', ') || '(none)'}

Python/requirements dependencies:
${evidence.pyDeps.slice(0, 30).join(', ') || '(none)'}

Env vars referenced in source code:
${input.referencedEnvVars.join(', ') || '(none)'}

Env vars already resolved (present):
${Object.keys(input.resolvedEnvVars).join(', ') || '(none)'}

Resource-related imports/usage found:
${evidence.importHints.slice(0, 20).join('\n') || '(none)'}

Known fallback URLs in source (e.g. "redis://localhost:6379" fallbacks):
${evidence.fallbackUrls.slice(0, 10).join('\n') || '(none)'}

Respond with JSON only:
{
  "summary": "One-paragraph bilingual deployment plan summary (繁體中文 first, then English)",
  "requirements": [
    {
      "type": "redis|postgres|mysql|mongodb|object_storage|smtp|external_api|unknown",
      "useCase": "cache|queue|pubsub|session_store|primary_database|rate_limiting|file_storage|email|payment|ai_llm|other",
      "required": true,
      "reasoning": "bilingual reasoning",
      "evidence": ["bullmq import in src/queue.ts", "REDIS_URL env var referenced"],
      "strategy": "auto_provision|user_provided|already_configured|skip",
      "envVars": [
        {"key":"REDIS_URL","description":"Redis connection URL","required":true,"example":"redis://host:6379"}
      ],
      "sizing": "shared|small|medium"
    }
  ],
  "missingUserEnvVars": [
    {"key":"STRIPE_SECRET_KEY","description":"Stripe API key for payments","example":"sk_live_..."}
  ],
  "canAutoDeploy": true,
  "blockers": ["bilingual blocker description"]
}`;

  let text = '';
  let provider: 'claude' | 'openai' | 'fallback' = 'fallback';
  try {
    const result = await callLLM(SYSTEM_PROMPT, userMessage, 4000);
    text = result.text;
    provider = result.provider;
  } catch (err) {
    console.error('[ResourceAnalyzer] LLM call failed:', (err as Error).message);
    return heuristicFallback(input);
  }

  // Parse JSON
  let parsed: Record<string, unknown> | null = null;
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { parsed = JSON.parse(codeBlockMatch[1].trim()); } catch { /* next */ }
  }
  if (!parsed) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* give up */ }
    }
  }

  if (!parsed) {
    console.error('[ResourceAnalyzer] No parseable JSON:', text.slice(0, 500));
    return heuristicFallback(input);
  }

  const requirements = Array.isArray(parsed.requirements)
    ? (parsed.requirements as ResourceRequirement[])
    : [];
  const missingUserEnvVars = Array.isArray(parsed.missingUserEnvVars)
    ? (parsed.missingUserEnvVars as ResourcePlan['missingUserEnvVars'])
    : [];

  return {
    summary: (parsed.summary as string) ?? '',
    requirements,
    missingUserEnvVars,
    provider,
    canAutoDeploy: typeof parsed.canAutoDeploy === 'boolean' ? parsed.canAutoDeploy : requirements.every((r) => r.strategy !== 'user_provided' || !r.required),
    blockers: Array.isArray(parsed.blockers) ? (parsed.blockers as string[]) : [],
  };
}

// ─── LLM call (Claude primary, OpenAI fallback) ───

async function callLLM(system: string, user: string, maxTokens: number): Promise<{ text: string; provider: 'claude' | 'openai' }> {
  if (anthropic) {
    try {
      const resp = await anthropic.messages.create({
        model: process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { text, provider: 'claude' };
    } catch (err) {
      console.warn('[ResourceAnalyzer] Claude failed, trying OpenAI:', (err as Error).message.slice(0, 150));
    }
  }
  if (openai) {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return { text: resp.choices[0]?.message?.content ?? '', provider: 'openai' };
  }
  throw new Error('No LLM providers available');
}

// ─── Evidence gathering (dependencies, imports, fallback URLs) ───

interface Evidence {
  dependencies: string[];
  pyDeps: string[];
  importHints: string[];
  fallbackUrls: string[];
}

function gatherEvidence(projectDir: string): Evidence {
  const ev: Evidence = { dependencies: [], pyDeps: [], importHints: [], fallbackUrls: [] };

  // package.json
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      ev.dependencies = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    } catch { /* ignore */ }
  }

  // requirements.txt / pyproject.toml
  const reqPath = path.join(projectDir, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    try {
      const lines = fs.readFileSync(reqPath, 'utf-8').split('\n');
      ev.pyDeps = lines.map((l) => l.split(/[=<>!]/)[0].trim()).filter(Boolean);
    } catch { /* ignore */ }
  }

  // Scan source files for resource hints (limited to first 200 files, 50KB each)
  const hintPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /from ['"](ioredis|redis|bullmq|bull)['"]|require\(['"](ioredis|redis|bullmq|bull)['"]\)/g, label: 'Redis client' },
    { pattern: /from ['"](pg|mysql2?|mongodb|mongoose|prisma)['"]|require\(['"](pg|mysql2?|mongodb|mongoose|@prisma\/client)['"]\)/g, label: 'DB client' },
    { pattern: /from ['"]nodemailer['"]|from ['"]@sendgrid\/mail['"]|import smtplib/g, label: 'Email/SMTP' },
    { pattern: /from ['"]@google-cloud\/storage['"]|from ['"]@aws-sdk\/client-s3['"]|boto3\.client\(['"]s3['"]\)/g, label: 'Object storage' },
    { pattern: /from ['"]stripe['"]|from ['"]@stripe\/[^'"]+['"]/g, label: 'Stripe' },
    { pattern: /from ['"]openai['"]|import openai|from ['"]@anthropic-ai\/sdk['"]|from ['"]@google\/generative-ai['"]/g, label: 'LLM API' },
  ];

  const fallbackUrlPattern = /['"]((redis|postgres|postgresql|mysql|mongodb):\/\/[^'"\s]+)['"]/g;

  let scanned = 0;
  walkSource(projectDir, (filePath) => {
    if (scanned >= 200) return false;
    scanned++;
    const content = safeRead(filePath);
    if (!content) return true;
    const rel = path.relative(projectDir, filePath);
    for (const { pattern, label } of hintPatterns) {
      let m;
      while ((m = pattern.exec(content)) !== null) {
        ev.importHints.push(`${label} (${rel}): ${m[0].slice(0, 80)}`);
      }
    }
    let m;
    while ((m = fallbackUrlPattern.exec(content)) !== null) {
      ev.fallbackUrls.push(`${rel}: ${m[1].slice(0, 100)}`);
    }
    return true;
  });

  // Deduplicate
  ev.importHints = Array.from(new Set(ev.importHints));
  ev.fallbackUrls = Array.from(new Set(ev.fallbackUrls));
  return ev;
}

function walkSource(dir: string, callback: (filePath: string) => boolean, depth = 0): void {
  if (depth > 5) return;
  const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.turbo']);
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go']);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walkSource(path.join(dir, entry.name), callback, depth + 1);
      } else if (exts.has(path.extname(entry.name))) {
        const shouldContinue = callback(path.join(dir, entry.name));
        if (!shouldContinue) return;
      }
    }
  } catch { /* ignore */ }
}

function safeRead(p: string): string | null {
  try {
    const stat = fs.statSync(p);
    if (stat.size > 50 * 1024) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch { return null; }
}

// ─── Heuristic fallback (when no LLM available) ───

function heuristicFallback(input: AnalyzeResourcesInput): ResourcePlan {
  const ev = gatherEvidence(input.projectDir);
  const requirements: ResourceRequirement[] = [];

  const depsStr = [...ev.dependencies, ...ev.pyDeps].join(' ');
  const envStr = input.referencedEnvVars.join(' ');

  const needsRedis =
    /\bioredis\b|\bbullmq\b|\bbull\b|\bredis\b/i.test(depsStr) ||
    /REDIS_URL|REDIS_HOST/.test(envStr) ||
    ev.fallbackUrls.some((u) => u.includes('redis://'));

  if (needsRedis) {
    const alreadyConfigured = !!input.resolvedEnvVars['REDIS_URL'];
    requirements.push({
      type: 'redis',
      useCase: /bullmq|bull/i.test(depsStr) ? 'queue' : 'cache',
      required: true,
      reasoning: '偵測到 Redis client 或 REDIS_URL 環境變數 / Detected Redis client or REDIS_URL env var',
      evidence: [
        ...ev.importHints.filter((h) => h.startsWith('Redis')),
        ...ev.fallbackUrls.filter((u) => u.includes('redis://')),
      ],
      strategy: alreadyConfigured ? 'already_configured' : 'auto_provision',
      envVars: [{ key: 'REDIS_URL', description: 'Redis connection URL', required: true, example: 'redis://host:6379' }],
      sizing: 'shared',
    });
  }

  return {
    summary: '使用 heuristic fallback 偵測（無 LLM）/ Using heuristic fallback detection (no LLM available)',
    requirements,
    missingUserEnvVars: [],
    provider: 'fallback',
    canAutoDeploy: requirements.every((r) => r.strategy !== 'user_provided' || !r.required),
    blockers: [],
  };
}
