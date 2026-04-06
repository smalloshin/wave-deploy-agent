// Environment Variable Auto-Detector
// Analyzes project source to infer required env vars and set sensible defaults for Cloud Run
//
// Strategy:
// 1. Read .env.example / .env.sample / .env.template for declared vars
// 2. Scan source code for process.env.* / os.environ.get() references
// 3. Scan Dockerfile for ENV declarations
// 4. Detect hardcoded fallbacks (process.env.KEY || 'literal')
// 5. Apply framework-specific rules (NextAuth, Prisma, etc.)
// 6. Auto-generate CloudSQL connection strings when applicable
// 7. Merge with user-provided env vars (user values take priority)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface EnvWarning {
  type: 'weak_fallback' | 'hardcoded_secret' | 'hardcoded_credential';
  file: string;
  line: number;
  variable: string;
  fallbackValue: string;
  recommendation: string;
}

export interface EnvDetectionResult {
  /** Auto-detected env vars with values */
  detected: Record<string, string>;
  /** Env vars referenced in code but no value could be inferred (user must provide) */
  missing: string[];
  /** Human-readable notes about what was detected */
  notes: string[];
  /** Security warnings about weak fallbacks and hardcoded credentials */
  warnings: EnvWarning[];
}

interface DetectionContext {
  projectDir: string;
  framework: string | null;
  language: string;
  customDomain?: string;
  cloudRunUrl?: string;
  gcpProject?: string;
  gcpRegion?: string;
  projectSlug?: string;
  port: number;
}

/** Info extracted from a hardcoded fallback in source code */
interface FallbackInfo {
  variable: string;
  fallbackValue: string;
  file: string;
  line: number;
}

// ─── Main entry ───

export function detectEnvVars(ctx: DetectionContext): EnvDetectionResult {
  const detected: Record<string, string> = {};
  const missing: string[] = [];
  const notes: string[] = [];
  const warnings: EnvWarning[] = [];

  // 1. Scan source code for process.env references
  const referenced = scanSourceForEnvRefs(ctx.projectDir, ctx.language);
  notes.push(`Found ${referenced.size} env var references in source code`);

  // 2. Read actual .env files (smart filtering: keep production-suitable, replace dev values)
  const dotEnvVars = readDotEnvFiles(ctx.projectDir);
  if (Object.keys(dotEnvVars).length > 0) {
    notes.push(`Found .env file with ${Object.keys(dotEnvVars).length} vars — applying smart filter`);
    for (const [key, val] of Object.entries(dotEnvVars)) {
      referenced.add(key);
      const classification = classifyEnvValue(key, val, ctx);
      if (classification === 'keep') {
        detected[key] = val;
        notes.push(`.env keep: ${key} (production-suitable value)`);
      } else if (classification === 'replace') {
        // Try to rewrite .run.app URLs to use custom domain (preserve path)
        if (ctx.customDomain && /\.run\.app/.test(val)) {
          try {
            const parsed = new URL(val);
            const rewritten = `https://${ctx.customDomain}${parsed.pathname}${parsed.search}`;
            detected[key] = rewritten;
            notes.push(`.env rewrite: ${key} — .run.app → ${ctx.customDomain} (kept path: ${parsed.pathname})`);
          } catch {
            notes.push(`.env replace: ${key} — "${val}" is dev/local, will auto-generate`);
          }
        } else {
          // Don't set in detected — let framework/common rules generate proper value
          notes.push(`.env replace: ${key} — "${val}" is dev/local, will auto-generate`);
        }
      } else if (classification === 'weak') {
        // Will be handled by framework rules with strong auto-generated value
        notes.push(`.env weak: ${key} — secret too weak, will auto-generate`);
        warnings.push({
          type: 'weak_fallback',
          file: '.env',
          line: 0,
          variable: key,
          fallbackValue: val,
          recommendation: `Value from .env is too weak for production — auto-generating strong replacement`,
        });
      }
    }
  }

  // 3. Read .env.example for declared vars with example values
  const exampleVars = readEnvExample(ctx.projectDir);
  for (const [key, val] of Object.entries(exampleVars)) {
    if (val && !isPlaceholder(val)) {
      // Only use if not already set from .env
      if (!detected[key]) {
        detected[key] = val;
      }
    }
  }

  // 4. Scan Dockerfile for ENV declarations
  const dockerEnvVars = scanDockerfileEnvVars(ctx.projectDir);
  for (const [key, val] of Object.entries(dockerEnvVars)) {
    // Always add to referenced so framework rules see it
    referenced.add(key);
    if (!detected[key]) {
      if (val && !isPlaceholder(val) && !isDockerBuildDummy(key, val)) {
        detected[key] = val;
        notes.push(`Dockerfile ENV: ${key}=${val}`);
      } else if (val) {
        // Placeholder value — add to referenced so it gets resolved or marked missing
        notes.push(`Dockerfile ENV: ${key} has placeholder value "${val}" — needs real value`);
      }
    }
  }

  // 5. Detect hardcoded fallbacks in source code
  const fallbacks = scanHardcodedFallbacks(ctx.projectDir, ctx.language);
  for (const fb of fallbacks) {
    referenced.add(fb.variable);
    if (isWeakSecret(fb.variable, fb.fallbackValue)) {
      warnings.push({
        type: isSecretVar(fb.variable) ? 'hardcoded_secret' : 'weak_fallback',
        file: fb.file,
        line: fb.line,
        variable: fb.variable,
        fallbackValue: fb.fallbackValue,
        recommendation: `Auto-generating strong replacement for ${fb.variable}`,
      });
      // Auto-generate a strong replacement (don't use the weak fallback)
      if (!detected[fb.variable]) {
        detected[fb.variable] = generateStrongValue(fb.variable);
        notes.push(`Auto-replaced weak fallback for ${fb.variable} (was: "${fb.fallbackValue}")`);
      }
    } else if (isUrlValue(fb.fallbackValue)) {
      // URL fallback — note it as a default
      if (!detected[fb.variable]) {
        detected[fb.variable] = fb.fallbackValue;
        notes.push(`Using URL fallback for ${fb.variable}: ${fb.fallbackValue}`);
      }
    } else if (fb.fallbackValue && !detected[fb.variable]) {
      // Other non-empty fallback — use it as default
      detected[fb.variable] = fb.fallbackValue;
      notes.push(`Using hardcoded fallback for ${fb.variable}: "${fb.fallbackValue}"`);
    }
  }

  // 6. Framework-specific detection
  if (ctx.framework === 'nextjs') {
    applyNextjsRules(ctx, detected, missing, notes, referenced);
  }

  // 7. Common patterns (any framework)
  applyCommonRules(ctx, detected, missing, notes, referenced, warnings);

  // 8. PORT — Cloud Run sets PORT automatically, do NOT include it in env vars
  // (Cloud Run rejects requests that set reserved env names like PORT)

  // 8. NODE_ENV
  if (referenced.has('NODE_ENV') || ctx.language === 'typescript' || ctx.language === 'javascript') {
    detected['NODE_ENV'] = 'production';
  }

  // 9. Collect vars referenced but not resolved
  for (const ref of referenced) {
    if (!detected[ref] && !missing.includes(ref) && !isIgnoredVar(ref)) {
      missing.push(ref);
    }
  }

  return { detected, missing, notes, warnings };
}

// ─── Merge detected + user-provided env vars ───

export function mergeEnvVars(
  detected: Record<string, string>,
  userProvided: Record<string, string>,
  existingOnService?: Record<string, string>,
): Record<string, string> {
  // Priority: userProvided > existingOnService > detected
  return {
    ...detected,
    ...(existingOnService ?? {}),
    ...userProvided,
  };
}

// ─── Source code scanning ───

function scanSourceForEnvRefs(projectDir: string, language: string): Set<string> {
  const refs = new Set<string>();
  const extensions = language === 'python'
    ? ['.py']
    : language === 'go'
      ? ['.go']
      : ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  try {
    walkFiles(projectDir, extensions, (filePath) => {
      const content = safeRead(filePath);
      if (!content) return;

      // Node.js: process.env.VAR_NAME or process.env['VAR_NAME']
      const nodePattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
      const nodeBracketPattern = /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;

      // Python: os.environ.get('VAR') or os.getenv('VAR') or os.environ['VAR']
      const pyPattern = /os\.(?:environ\.get|getenv|environ\[)\(?['"]([A-Z_][A-Z0-9_]*)['"]\)?/g;

      // Go: os.Getenv("VAR")
      const goPattern = /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g;

      for (const pattern of [nodePattern, nodeBracketPattern, pyPattern, goPattern]) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          refs.add(match[1]);
        }
      }
    });
  } catch {
    // If we can't scan (e.g., GCS-only source), return empty set
  }

  return refs;
}

// ─── Dockerfile ENV scanning ───

function scanDockerfileEnvVars(projectDir: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const dockerfiles = ['Dockerfile', 'Dockerfile.production', 'Dockerfile.prod'];

  for (const df of dockerfiles) {
    const content = safeRead(path.join(projectDir, df));
    if (!content) continue;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Match ENV KEY=value or ENV KEY value
      // Supports: ENV KEY=value, ENV KEY="value", ENV KEY='value', ENV KEY value
      const envMatch = trimmed.match(/^ENV\s+([A-Z_][A-Z0-9_]*)(?:\s*=\s*|\s+)(.+)?$/i);
      if (envMatch) {
        const key = envMatch[1];
        let val = (envMatch[2] ?? '').trim();
        // Strip surrounding quotes
        val = val.replace(/^['"]|['"]$/g, '');
        vars[key] = val;
      }
    }
    break; // Use first Dockerfile found
  }

  return vars;
}

// ─── Hardcoded fallback detection ───

function scanHardcodedFallbacks(projectDir: string, language: string): FallbackInfo[] {
  const fallbacks: FallbackInfo[] = [];

  if (language !== 'typescript' && language !== 'javascript') {
    return fallbacks;
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  try {
    walkFiles(projectDir, extensions, (filePath) => {
      const content = safeRead(filePath);
      if (!content) return;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match: process.env.KEY || 'literal'  or  process.env.KEY ?? 'literal'
        // Also: process.env.KEY || "literal"  or  process.env.KEY ?? "literal"
        const pattern = /process\.env\.([A-Z_][A-Z0-9_]*)\s*(?:\|\||&&|\?\?)\s*(?:process\.env\.[A-Z_][A-Z0-9_]*\s*(?:\|\||\?\?)\s*)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          fallbacks.push({
            variable: match[1],
            fallbackValue: match[2],
            file: path.relative(projectDir, filePath),
            line: i + 1,
          });
        }
      }
    });
  } catch {
    // Ignore errors during scanning
  }

  return fallbacks;
}

// ─── .env.example parser ───

// ─── Actual .env file reader (smart filtering) ───

function readDotEnvFiles(projectDir: string): Record<string, string> {
  // Priority 1: well-known .env files (production > local > default)
  const knownEnvFiles = ['.env.production', '.env.production.local', '.env.local', '.env'];

  // Priority 2: discover any other *.env or .env.* files in root directory
  let discoveredEnvFiles: string[] = [];
  try {
    const entries = fs.readdirSync(projectDir);
    discoveredEnvFiles = entries.filter((f: string) => {
      const lower = f.toLowerCase();
      // Match: *.env, .env.*, but exclude .env.example/.env.sample/.env.template (handled separately)
      const isEnvFile = lower.endsWith('.env') || (lower.startsWith('.env') && !lower.startsWith('.env.example') && !lower.startsWith('.env.sample') && !lower.startsWith('.env.template'));
      const isKnown = knownEnvFiles.includes(f);
      const isJunk = lower === 'next-env.d.ts' || lower.endsWith('.d.ts'); // TypeScript declaration files
      return isEnvFile && !isKnown && !isJunk;
    });
    if (discoveredEnvFiles.length > 0) {
      console.log(`[EnvDetector] Discovered additional env files: ${discoveredEnvFiles.join(', ')}`);
    }
  } catch { /* can't read directory */ }

  const allEnvFiles = [...knownEnvFiles, ...discoveredEnvFiles];
  const vars: Record<string, string> = {};

  for (const f of allEnvFiles) {
    const content = safeRead(path.join(projectDir, f));
    if (!content) continue;

    console.log(`[EnvDetector] Reading env file: ${f}`);
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      val = val.replace(/^['"]|['"]$/g, '');
      if (key && !vars[key]) vars[key] = val;  // First found wins (production > local > default)
    }
  }

  return vars;
}

/**
 * Classify a .env value for production deployment:
 * - 'keep':    Value is suitable for production (real API keys, external URLs, etc.)
 * - 'replace': Value is localhost/dev and should be replaced with production value
 * - 'weak':    Value is a secret but too weak for production
 */
function classifyEnvValue(key: string, val: string, ctx: DetectionContext): 'keep' | 'replace' | 'weak' {
  const upper = key.toUpperCase();

  // 1. Empty or placeholder → replace
  if (!val || isPlaceholder(val)) return 'replace';

  // 2. URL-type vars: replace if pointing to localhost
  const isUrlVar = ['_URL', '_HOST', '_ORIGIN', '_ENDPOINT', '_CALLBACK', '_REDIRECT'].some((p) => upper.includes(p));
  if (isUrlVar) {
    // Localhost/dev → always replace
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(val)) {
      return 'replace';
    }
    // Old Cloud Run URL for THIS app (self-referencing) → replace with custom domain
    // But keep URLs to OTHER Cloud Run services (external dependencies)
    if (ctx.customDomain && /\.run\.app/.test(val)) {
      // "Self-referencing" heuristic: the URL var name suggests it's this app's own URL
      // (NEXTAUTH_URL, REDIRECT_URI, CALLBACK_URL, APP_URL, BASE_URL, SITE_URL)
      const selfRefVars = ['NEXTAUTH_URL', 'APP_URL', 'BASE_URL', 'SITE_URL', 'PUBLIC_URL'];
      const isSelfRef = selfRefVars.includes(key);
      const isRedirectVar = upper.includes('REDIRECT') || upper.includes('CALLBACK');
      if (isSelfRef || isRedirectVar) {
        return 'replace';
      }
      // Other URLs pointing to .run.app are likely external services → keep
    }
  }

  // 3. DATABASE_URL pointing to localhost or docker → replace (we have CloudSQL)
  //    But keep real external DB connections (actual IPs, Cloud SQL proxy, etc.)
  if (upper.includes('DATABASE') || upper.includes('REDIS') || upper.includes('MONGO')) {
    if (/localhost|127\.0\.0\.1|host\.docker\.internal/.test(val)) {
      return 'replace';
    }
    if (isPlaceholder(val) || val === 'postgresql://placeholder') {
      return 'replace';
    }
    // Real external connection (has IP or hostname) → keep
    return 'keep';
  }

  // 4. Secret/key vars — check if value is strong enough for production
  //    But exclude user-facing credentials (AUTH_USERNAME, AUTH_PASSWORD etc.)
  //    which are intentionally set by users and not auto-generated secrets
  if (isSecretVar(key) && !isUserCredentialVar(key)) {
    if (isWeakSecret(key, val)) return 'weak';
  }

  // 5. NODE_ENV=development → replace
  if (upper === 'NODE_ENV' && val !== 'production') return 'replace';

  // 6. Everything else → keep (real API keys, external service URLs, user config, etc.)
  return 'keep';
}

/** Check if a variable is a user-facing credential (not a machine-generated secret) */
function isUserCredentialVar(name: string): boolean {
  const upper = name.toUpperCase();
  // These are user/admin credentials that are intentionally chosen, not auto-generated
  return /^AUTH_(USERNAME|PASSWORD|USER|EMAIL)$/.test(upper) ||
    /^ADMIN_(USERNAME|PASSWORD|USER|EMAIL)$/.test(upper) ||
    upper === 'USERNAME' || upper === 'PASSWORD';
}

// ─── .env.example parser ───

function readEnvExample(projectDir: string): Record<string, string> {
  const envFiles = ['.env.example', '.env.sample', '.env.template', '.env.local.example'];
  const vars: Record<string, string> = {};

  for (const f of envFiles) {
    const content = safeRead(path.join(projectDir, f));
    if (!content) continue;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key) vars[key] = val;
    }
    break; // Use first found
  }

  return vars;
}

// ─── Framework-specific rules ───

function applyNextjsRules(
  ctx: DetectionContext,
  detected: Record<string, string>,
  missing: string[],
  notes: string[],
  referenced: Set<string>,
) {
  const baseUrl = ctx.customDomain
    ? `https://${ctx.customDomain}`
    : ctx.cloudRunUrl ?? `http://localhost:${ctx.port}`;

  // NextAuth
  if (referenced.has('NEXTAUTH_URL') || hasNextAuth(ctx.projectDir)) {
    detected['NEXTAUTH_URL'] = baseUrl;
    notes.push(`NextAuth detected → NEXTAUTH_URL=${baseUrl}`);

    if (referenced.has('NEXTAUTH_SECRET') || referenced.has('AUTH_SECRET')) {
      // Only set if not already detected (e.g., from fallback scanning)
      if (!detected['NEXTAUTH_SECRET']) {
        const secret = crypto.randomBytes(32).toString('base64url');
        detected['NEXTAUTH_SECRET'] = secret;
        notes.push('Generated NEXTAUTH_SECRET (random 32 bytes)');
      }
      if (referenced.has('AUTH_SECRET') && !detected['AUTH_SECRET']) {
        detected['AUTH_SECRET'] = detected['NEXTAUTH_SECRET'];
      }
    }
  }

  // JWT_SECRET (common in NextAuth apps)
  if (referenced.has('JWT_SECRET') && !detected['JWT_SECRET']) {
    detected['JWT_SECRET'] = crypto.randomBytes(32).toString('base64url');
    notes.push('Generated JWT_SECRET (random 32 bytes)');
  }

  // Rewrite callback/redirect URLs from old .run.app to custom domain
  if (ctx.customDomain) {
    const redirectVars = ['GOOGLE_REDIRECT_URI', 'OAUTH_CALLBACK_URL', 'REDIRECT_URI', 'CALLBACK_URL'];
    for (const key of redirectVars) {
      if (detected[key] && /\.run\.app/.test(detected[key])) {
        const oldUrl = detected[key];
        // Extract path from old URL and prepend custom domain
        try {
          const parsed = new URL(oldUrl);
          detected[key] = `https://${ctx.customDomain}${parsed.pathname}${parsed.search}`;
          notes.push(`Rewrote ${key}: .run.app → ${ctx.customDomain}`);
        } catch {
          detected[key] = `https://${ctx.customDomain}`;
        }
      }
    }
  }

  // NEXT_PUBLIC_* — these are build-time vars, set them anyway for SSR
  for (const ref of referenced) {
    if (ref.startsWith('NEXT_PUBLIC_') && !detected[ref]) {
      // Can't auto-detect public env vars — add to missing
      if (!isIgnoredVar(ref)) {
        missing.push(ref);
      }
    }
  }
}

function hasNextAuth(projectDir: string): boolean {
  // Check package.json for next-auth dependency
  try {
    const pkgContent = safeRead(path.join(projectDir, 'package.json'));
    if (pkgContent) {
      const pkg = JSON.parse(pkgContent);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      return 'next-auth' in allDeps || '@auth/core' in allDeps;
    }
  } catch { /* ignore */ }
  return false;
}

// ─── Common rules (any framework) ───

function applyCommonRules(
  ctx: DetectionContext,
  detected: Record<string, string>,
  missing: string[],
  notes: string[],
  referenced: Set<string>,
  warnings: EnvWarning[],
) {
  // DATABASE_URL and KOL_DATABASE_URL — CloudSQL auto-detection
  // Use a single connection string for all DB vars (same instance, same DB)
  const dbVars = ['DATABASE_URL', 'KOL_DATABASE_URL'];
  const referencedDbVars = dbVars.filter((v) => referenced.has(v) && !detected[v]);
  if (referencedDbVars.length > 0) {
    if (ctx.gcpProject && ctx.gcpRegion) {
      const connectionString = buildCloudSqlConnectionString(ctx);
      for (const dbVar of referencedDbVars) {
        detected[dbVar] = connectionString;
      }
      notes.push(`${referencedDbVars.join(', ')} auto-generated with CloudSQL Unix socket connection (${ctx.gcpProject}:${ctx.gcpRegion}:deploy-agent-db)`);
    } else {
      for (const dbVar of referencedDbVars) {
        missing.push(dbVar);
      }
      notes.push(`${referencedDbVars.join(', ')} referenced but cannot be auto-detected — user must provide`);
    }
  }

  // REDIS_URL / REDIS_HOST
  for (const key of ['REDIS_URL', 'REDIS_HOST']) {
    if (referenced.has(key) && !detected[key]) {
      missing.push(key);
    }
  }

  // Google Cloud / Firebase
  if (referenced.has('GOOGLE_CLOUD_PROJECT') || referenced.has('GCP_PROJECT') || referenced.has('GCLOUD_PROJECT')) {
    const gcpProject = ctx.gcpProject ?? '';
    if (gcpProject) {
      if (referenced.has('GOOGLE_CLOUD_PROJECT')) detected['GOOGLE_CLOUD_PROJECT'] = gcpProject;
      if (referenced.has('GCP_PROJECT')) detected['GCP_PROJECT'] = gcpProject;
      if (referenced.has('GCLOUD_PROJECT')) detected['GCLOUD_PROJECT'] = gcpProject;
      notes.push(`GCP project vars auto-set to ${gcpProject}`);
    }
  }

  // API keys / secrets that we can't auto-generate — mark as missing
  const secretPatterns = [
    'API_KEY', 'API_SECRET', 'SECRET_KEY', 'ACCESS_KEY',
    'STRIPE_', 'SENDGRID_', 'TWILIO_', 'SLACK_',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
    'GOOGLE_API_KEY', 'FIREBASE_',
    'AWS_', 'AZURE_',
    'SMTP_', 'EMAIL_', 'MAIL_',
    'S3_', 'CLOUDINARY_',
  ];

  for (const ref of referenced) {
    if (detected[ref] || missing.includes(ref)) continue;
    for (const pattern of secretPatterns) {
      if (ref.includes(pattern) || ref.startsWith(pattern)) {
        missing.push(ref);
        break;
      }
    }
  }

  // HOST / HOSTNAME — set to 0.0.0.0 for Cloud Run
  if (referenced.has('HOST') && !detected['HOST']) {
    detected['HOST'] = '0.0.0.0';
  }
  if (referenced.has('HOSTNAME') && !detected['HOSTNAME']) {
    detected['HOSTNAME'] = '0.0.0.0';
  }

  // APP_URL / BASE_URL / SITE_URL
  const urlVars = ['APP_URL', 'BASE_URL', 'SITE_URL', 'PUBLIC_URL', 'VITE_API_URL'];
  const baseUrl = ctx.customDomain
    ? `https://${ctx.customDomain}`
    : ctx.cloudRunUrl ?? '';
  for (const key of urlVars) {
    if (referenced.has(key) && !detected[key] && baseUrl) {
      detected[key] = baseUrl;
      notes.push(`${key} auto-set to ${baseUrl}`);
    }
  }
}

// ─── CloudSQL connection string builder ───

function buildCloudSqlConnectionString(ctx: DetectionContext): string {
  const gcpProject = ctx.gcpProject!;
  const gcpRegion = ctx.gcpRegion!;
  const instanceConnectionName = `${gcpProject}:${gcpRegion}:deploy-agent-db`;
  const dbName = ctx.projectSlug ?? 'app';
  const password = process.env.CLOUDSQL_DEPLOY_PASSWORD || crypto.randomBytes(24).toString('base64url');

  return `postgresql://deploy_agent:${password}@/${dbName}?host=/cloudsql/${instanceConnectionName}`;
}

// ─── Helpers ───

/** Check if a Dockerfile ENV value is a build-time dummy that should be overridden */
function isDockerBuildDummy(key: string, val: string): boolean {
  // Secret-like keys with any non-URL value in Dockerfile are almost always build dummies
  if (isSecretVar(key) && !isUrlValue(val)) return true;
  // Short single-word values like "build-secret" are dummies
  if (val.includes('build') || val.includes('dummy') || val === 'http://localhost:3000') return true;
  return false;
}

function isPlaceholder(val: string): boolean {
  const lower = val.toLowerCase();
  return (
    lower === 'your_value_here' ||
    lower === 'xxx' ||
    lower === 'changeme' ||
    lower === 'change_me' ||
    lower === 'replace_me' ||
    lower === 'todo' ||
    lower === 'build' ||
    lower === 'placeholder' ||
    lower === '' ||
    lower.startsWith('your_') ||
    lower.startsWith('<') ||
    lower.endsWith('>') ||
    lower.includes('changeme') ||
    lower.includes('placeholder') ||
    lower.includes('replace-me') ||
    lower.includes('replace_me')
  );
}

/** Check whether a fallback value is a weak/insecure secret */
function isWeakSecret(variable: string, value: string): boolean {
  // If the variable name suggests it's a secret and the value is weak
  if (!isSecretVar(variable)) return false;

  // Short values are weak
  if (value.length < 16) return true;

  // Low entropy: mostly lowercase letters, digits, and dashes (predictable patterns like "my-app-secret-2026")
  // Real secrets should have mixed case, special chars, or be base64-encoded
  const hasUpperCase = /[A-Z]/.test(value);
  const hasSpecialOrBase64 = /[+/=_]/.test(value);
  const looksLikeHumanReadable = /^[a-z0-9][a-z0-9\-_.]+$/.test(value);
  if (looksLikeHumanReadable && value.length < 40) return true;

  // Common weak patterns
  const weakPatterns = [
    /^change[_-]?me$/i,
    /^secret$/i,
    /^password$/i,
    /^default$/i,
    /^test$/i,
    /^dev$/i,
    /session[_-]?secret/i,
    /change[_-]?me/i,
    /wavenet/i,
  ];
  return weakPatterns.some((p) => p.test(value));
}

/** Check whether a variable name suggests it holds a secret */
function isSecretVar(name: string): boolean {
  const secretIndicators = ['SECRET', 'PASSWORD', 'TOKEN', 'KEY', 'CREDENTIAL', 'AUTH'];
  return secretIndicators.some((ind) => name.toUpperCase().includes(ind));
}

/** Check whether a value looks like a URL */
function isUrlValue(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** Generate a strong replacement value for a given variable */
function generateStrongValue(variable: string): string {
  const upper = variable.toUpperCase();
  if (upper.includes('SECRET') || upper.includes('KEY') || upper.includes('TOKEN')) {
    return crypto.randomBytes(32).toString('base64url');
  }
  if (upper.includes('PASSWORD')) {
    return crypto.randomBytes(24).toString('base64url');
  }
  return crypto.randomBytes(32).toString('base64url');
}

function isIgnoredVar(name: string): boolean {
  // System/runtime vars that Cloud Run sets or are irrelevant
  const ignored = new Set([
    'HOME', 'PATH', 'USER', 'SHELL', 'PWD', 'LANG', 'TERM',
    'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION',
    'CLOUD_RUN_JOB', 'CLOUD_RUN_EXECUTION', 'CLOUD_RUN_TASK_INDEX',
    'PORT', // We set this explicitly
    'NODE_ENV', // We set this explicitly
    'CI', 'VERCEL', 'NETLIFY', 'HEROKU',
    'npm_package_name', 'npm_package_version',
    'NEXT_RUNTIME',
  ]);
  return ignored.has(name);
}

function walkFiles(dir: string, extensions: string[], callback: (filePath: string) => void, depth = 0): void {
  if (depth > 5) return; // Limit recursion
  const skipDirs = new Set(['node_modules', '.git', '.next', '__pycache__', 'venv', '.venv', 'dist', 'build', '.turbo', 'coverage']);

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walkFiles(path.join(dir, entry.name), extensions, callback, depth + 1);
        }
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        callback(path.join(dir, entry.name));
      }
    }
  } catch { /* ignore permission errors */ }
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
