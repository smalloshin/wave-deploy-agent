/**
 * .env file scanner (R55)
 *
 * Why this exists:
 *   R49 (required-env-gate) checks if required env vars from source code are
 *   provided by the user. Pre-R55 it ONLY looked at `project.config.envVars`
 *   (dashboard-set values). It missed `.env` files committed in source.
 *
 *   Real-world canonical: luca-v2-20260504-luca-optimizer-kb shipped with a
 *   `.env` containing `GEMINI_API_KEY=AIzaSy...`. R49 detected
 *   `os.getenv("GEMINI_API_KEY")` in the code, treated GEMINI_API_KEY as
 *   "missing" (not in dashboard envVars), and blocked at Step 2.7 — even
 *   though the user had already supplied the value via .env.
 *
 *   R55 fixes this: scan source for `.env`/`.env.local`/`.env.production`/
 *   `.env.staging`/`.env.development` (root level only), parse `KEY=VALUE`,
 *   merge keys into the gate's user-provided set. Future projects that
 *   commit env files don't get false-positive blocked.
 *
 * Bonus security feature:
 *   While we're parsing the file, look at VALUES for real secret patterns
 *   (OpenAI sk-..., Google AIza..., Meta EAA..., long hex/base64 strings)
 *   vs placeholders (`your-key-here`, `<replace>`, `xxx`). If we find real
 *   secrets, emit a warning — committing real secrets to source is a P0
 *   security mistake. Pipeline doesn't block on this (user already shipped
 *   with them; blocking now is too late), but does log loudly so operator
 *   sees it.
 *
 * Excluded files (template/example, NOT user-supplied values):
 *   .env.example, .env.sample, .env.template, .env.dist, .env.test
 *
 * Pure function: input → output. No DB, no network. Safe for zero-dep tests.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** What the scanner returns. */
export interface EnvFileScanResult {
  /** Set of env var KEYs found across all scanned files. */
  keys: Set<string>;
  /** Filenames actually read (for log / audit). Empty when no env files
   *  exist or none parse successfully. */
  filesRead: string[];
  /** Detected real-looking secrets (committed to source — security risk). */
  realSecretsDetected: Array<{
    key: string;
    file: string;
    /** Human-readable reason: which pattern matched. */
    reason: string;
  }>;
}

/** Files to READ as user-provided env values. */
const ENV_FILES_TO_READ = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.staging',
  '.env.development',
];

/** Files to SKIP (templates / examples — values are placeholders). */
const ENV_FILES_TO_SKIP = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.test',
  '.env.tpl',
]);

// Real-secret detectors. If a value matches any of these, it's a real
// secret committed to source.
// ORDER MATTERS: more specific patterns must come BEFORE more general ones
// (sk-svcacct- and sk-ant- both also match plain `sk-` so they need to be
// checked first).
const REAL_SECRET_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /^sk-svcacct-[a-zA-Z0-9_-]{20,}$/, reason: 'OpenAI service account key' },
  { regex: /^sk-ant-[a-zA-Z0-9_-]{20,}$/, reason: 'Anthropic API key' },
  { regex: /^sk-[a-zA-Z0-9_-]{20,}$/, reason: 'OpenAI API key (sk-...)' },
  { regex: /^AIza[a-zA-Z0-9_-]{30,}$/, reason: 'Google API key (AIza...)' },
  { regex: /^EAA[a-zA-Z0-9]{50,}$/, reason: 'Meta / Facebook access token (EAA...)' },
  { regex: /^ghp_[a-zA-Z0-9]{30,}$/, reason: 'GitHub personal access token' },
  { regex: /^github_pat_[a-zA-Z0-9_]{50,}$/, reason: 'GitHub fine-grained PAT' },
  { regex: /^xox[abp]-[a-zA-Z0-9-]{20,}$/, reason: 'Slack token' },
  { regex: /^GOCSPX-[a-zA-Z0-9_-]{20,}$/, reason: 'Google OAuth client secret' },
  { regex: /^[a-f0-9]{32,}$/, reason: 'long hex string (likely a secret hash)' },
  // Note: generic base64-like detection is intentionally NOT included here.
  // Too many false positives (any base64-encoded config blob would trip).
];

// Placeholders to ignore — common conventions for "fill this in".
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^your[-_]?(api[-_]?)?(key|secret|token|password)/i,
  /^<.*>$/, // <replace>, <your-key>
  /^(xxx+|placeholder|example|todo|fill[-_]me|change[-_]me|fixme)$/i,
  /^\$\{[^}]+\}$/, // ${SOMEVAR}
  /^(true|false|null|undefined|none)$/i, // boolean/null sentinels
  /^[0-9]+$/, // pure numbers (port etc.)
];

/**
 * Detect if a value looks like a REAL secret (vs placeholder).
 * Pure function. Returns matched reason or null.
 */
export function detectRealSecret(value: string): string | null {
  if (typeof value !== 'string' || value.length < 8) return null;
  // Strip surrounding quotes (common in .env)
  const v = value.replace(/^["']|["']$/g, '').trim();
  if (v.length < 8) return null;

  // Placeholder check first — short-circuit
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.test(v)) return null;
  }

  for (const { regex, reason } of REAL_SECRET_PATTERNS) {
    if (regex.test(v)) return reason;
  }
  return null;
}

/**
 * Parse a single .env file's content into a map of KEY → VALUE.
 * Pure function. Tolerates: comments (#), blank lines, quoted values,
 * `export KEY=VALUE` form, trailing whitespace. Skips malformed lines.
 *
 * Exported so tests can verify parsing without touching fs.
 */
export function parseEnvFileContent(content: string): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof content !== 'string') return out;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Strip optional `export ` prefix
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;

    const eq = stripped.indexOf('=');
    if (eq <= 0) continue; // no `=` or starts with `=`

    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // invalid identifier

    let value = stripped.slice(eq + 1).trim();
    // Strip inline comment IF the value isn't quoted (quoted values may
    // contain `#` legitimately).
    const looksQuoted = (value.startsWith('"') && value.endsWith('"')) ||
                       (value.startsWith("'") && value.endsWith("'"));
    if (!looksQuoted) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx > 0) value = value.slice(0, hashIdx).trim();
    }
    // Strip surrounding quotes
    if (looksQuoted) value = value.slice(1, -1);

    out.set(key, value);
  }

  return out;
}

/**
 * Scan a project directory for .env files (root level only — we don't recurse
 * into subdirs, since standard convention puts .env at project root).
 *
 * Best-effort: silently skips files that can't be read; never throws.
 */
export function scanEnvFiles(projectDir: string): EnvFileScanResult {
  const result: EnvFileScanResult = {
    keys: new Set<string>(),
    filesRead: [],
    realSecretsDetected: [],
  };

  if (typeof projectDir !== 'string' || !projectDir) return result;
  if (!safeIsDir(projectDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (ENV_FILES_TO_SKIP.has(entry)) continue;
    if (!ENV_FILES_TO_READ.includes(entry)) continue;

    const fullPath = join(projectDir, entry);
    if (!safeIsFile(fullPath)) continue;
    // Defensive: cap file size at 100KB. Anything larger is not a real .env.
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.size > 100_000) continue;

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const parsed = parseEnvFileContent(content);
    if (parsed.size === 0) continue;

    result.filesRead.push(entry);
    for (const [key, value] of parsed) {
      result.keys.add(key);
      const reason = detectRealSecret(value);
      if (reason) {
        result.realSecretsDetected.push({ key, file: entry, reason });
      }
    }
  }

  return result;
}

// ───────────────── internal helpers ─────────────────

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
