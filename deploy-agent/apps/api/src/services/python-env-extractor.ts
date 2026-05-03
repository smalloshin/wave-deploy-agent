/**
 * Python env-var extractor (R49)
 *
 * env-detector.ts already extracts simple `os.environ.get(...)` / `os.getenv(...)`
 * references for any language. But two production failure modes slipped past it
 * because env-detector was designed to find references — not to know which ones
 * are *required* (will crash the app if missing):
 *
 *   1. `os.environ["X"]` — KeyError on missing. luca-optimizer-kb's auth.py
 *      did exactly this with LUCA_JWT_SECRET; the container imported app.main,
 *      raised KeyError at module load time, and Cloud Run health-checked for
 *      4 minutes before failing the deploy. We waste Cloud Build minutes + GCS
 *      storage + Cloud Run quota every time.
 *
 *   2. Pydantic `BaseSettings` with no default — wavenet-ai-gateway-backend's
 *      Settings() constructor raised RuntimeError when erp-jwt-secret wasn't
 *      available. Same 4-minute health-check timeout.
 *
 *   3. Google Secret Manager calls — `client.access_secret_version(name=
 *      "projects/.../secrets/JWT_SECRET/...")`. The variable name lives in a
 *      string literal but represents a hard requirement.
 *
 * This module is the data-extraction layer for the env-gate decider. Pure
 * function: input projectDir → list of refs. No DB, no network, no fs writes.
 *
 * Conservative on `required`: false-negative (missing a required var) is OK —
 * the deploy will fail like before, no worse. False-positive (calling a
 * not-actually-required var required) blocks a deploy that would have worked.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PythonEnvRef {
  name: string;
  required: boolean;
  source: 'os.environ' | 'os.getenv' | 'pydantic-settings' | 'secret-manager';
  /** File:line for the first occurrence — for error messages. */
  location?: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'venv', '.venv',
  'dist', 'build', '.tox', 'site-packages', 'env',
]);

// 50KB matches the convention used in pipeline-worker.ts:752 and the LLM
// source-collector. Files larger than this are almost always generated /
// vendored / data dumps.
const MAX_FILE_BYTES = 50 * 1024;

/** Recursion depth limit. Matches env-detector.walkFiles. */
const MAX_DEPTH = 8;

/**
 * Extract all required env-var references from a Python project tree.
 *
 * Deduplication: returns one entry per unique name, with `required = true`
 * winning over `required = false` (so if `os.environ.get("X")` AND
 * `os.environ["X"]` both appear, we mark X required). The `source` and
 * `location` reflect the FIRST seen occurrence of the winning required tier.
 */
export function extractPythonEnvVars(projectDir: string): PythonEnvRef[] {
  if (typeof projectDir !== 'string' || !projectDir) return [];

  // Map<name, PythonEnvRef> — we keep the strongest signal.
  const found = new Map<string, PythonEnvRef>();

  walkPyFiles(projectDir, (absPath) => {
    let content: string;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return;
      if (stat.size > MAX_FILE_BYTES) return;
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      // Permission / vanished file / encoding — skip silently.
      return;
    }

    const relPath = path.relative(projectDir, absPath) || path.basename(absPath);
    const refs = scanPythonContent(content, relPath);
    for (const ref of refs) {
      const existing = found.get(ref.name);
      if (!existing) {
        found.set(ref.name, ref);
        continue;
      }
      // Upgrade required=false → required=true if we see a stronger signal.
      if (!existing.required && ref.required) {
        found.set(ref.name, ref);
      }
    }
  });

  return Array.from(found.values());
}

// ─── Per-file scanning ──────────────────────────────────────────────

/**
 * Pure: scan one Python source file and return refs found in it.
 * Exported for unit testing without touching the filesystem.
 */
export function scanPythonContent(content: string, locationLabel: string): PythonEnvRef[] {
  if (typeof content !== 'string' || !content) return [];

  // We strip line-comments only (NOT string contents — our patterns READ
  // env-var names from inside string literals like `os.environ["X"]`).
  //
  // To suppress matches WITHIN a string (e.g. a docstring describing
  // os.environ usage), we compute a mask of "is char at pos inside a string"
  // and skip any pattern hit whose `os.environ` / `os.getenv` token starts
  // INSIDE a string. The env-var-name capture is allowed to be inside a
  // string (that's the whole point) — we only check the call SITE.
  const lines = content.split('\n');
  const cleanedLines = lines.map((l) => stripCommentsOnly(l));
  const stringMasks = computeStringMask(cleanedLines);
  const tripleMasks = computeTripleQuoteMask(cleanedLines);
  // A position is "inside a string-like region" if either single/double-quoted
  // or inside a triple-quoted block.
  const insideMasks: boolean[][] = cleanedLines.map((l, i) => {
    const out = new Array(l.length).fill(false);
    for (let j = 0; j < l.length; j++) {
      out[j] = stringMasks[i][j] || tripleMasks[i][j];
    }
    return out;
  });

  const refs: PythonEnvRef[] = [];
  const seenInFile = new Map<string, PythonEnvRef>();

  // Pattern 1: os.environ["X"] or os.environ['X']
  // KeyError on missing → required=true.
  const subscriptPattern = /\bos\.environ\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g;
  matchAllWithMask(subscriptPattern, cleanedLines, insideMasks, (name, lineIdx) => {
    upsert(seenInFile, {
      name,
      required: true,
      source: 'os.environ',
      location: `${locationLabel}:${lineIdx + 1}`,
    });
  });

  // Pattern 2: os.environ.get("X") or os.getenv("X")
  // Returns None on missing → required=false unless we see a guard.
  const getPattern = /\bos\.(?:environ\.get|getenv)\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;
  matchAllWithMask(getPattern, cleanedLines, insideMasks, (name, lineIdx) => {
    const required = isGuardedRaise(lines, lineIdx, name);
    upsert(seenInFile, {
      name,
      required,
      source: 'os.getenv',
      location: `${locationLabel}:${lineIdx + 1}`,
    });
  });

  // Pattern 3: Pydantic BaseSettings — class body fields without defaults.
  // Only consider lines NOT inside a triple-quoted block (otherwise a
  // docstring `"""class Settings(BaseSettings): ..."""` would trigger).
  const codeOnlyLines = cleanedLines.map((l, i) => {
    // If the entire line is inside a triple-quote, blank it.
    const allInside = l.length > 0 && tripleMasks[i].every((b) => b);
    if (allInside) return '';
    return l;
  });
  for (const cls of findPydanticSettingsClasses(codeOnlyLines)) {
    for (const field of cls.fields) {
      // Pydantic env-var name is the field name uppercased by default
      // (some apps set env_prefix or alias, we intentionally don't try to
      //  parse those — false negatives are OK).
      const envName = field.name.toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) continue;
      upsert(seenInFile, {
        name: envName,
        required: field.required,
        source: 'pydantic-settings',
        location: `${locationLabel}:${field.lineIdx + 1}`,
      });
    }
  }

  // Pattern 4: Google Secret Manager — secret name embedded in path string.
  // Common forms:
  //   client.access_secret_version(name=f"projects/X/secrets/JWT_SECRET/versions/latest")
  //   client.access_secret_version(request={"name": "projects/X/secrets/erp-jwt-secret/versions/latest"})
  // We require `access_secret_version` to appear OUTSIDE a string (mask
  // check on its start position), then read the secret name from the
  // path-string parameter.
  // R52: GCP Secret Manager allows `[a-zA-Z][a-zA-Z0-9_-]*` (mixed case +
  // hyphens + underscores). Old regex `[A-Z_][A-Z0-9_]*` only matched
  // SCREAMING_SNAKE — missed wavenet-ai-gateway-backend's `erp-jwt-secret`
  // (lowercase + hyphens, common GCP convention). Widen.
  const secretManagerPattern = /access_secret_version[^\n]*?secrets\/([a-zA-Z][a-zA-Z0-9_-]*)\/versions/g;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!cleanedLines[i].includes('access_secret_version')) continue;
    // The call site (`access_secret_version` token) must be outside a string.
    const callStart = cleanedLines[i].indexOf('access_secret_version');
    if (callStart >= 0 && insideMasks[i][callStart]) continue;
    let m: RegExpExecArray | null;
    secretManagerPattern.lastIndex = 0;
    while ((m = secretManagerPattern.exec(rawLine)) !== null) {
      upsert(seenInFile, {
        name: m[1],
        required: true,
        source: 'secret-manager',
        location: `${locationLabel}:${i + 1}`,
      });
    }
  }

  for (const ref of seenInFile.values()) refs.push(ref);
  return refs;
}

// ─── Pattern helpers ────────────────────────────────────────────────

/**
 * Run a /g regex over an array of lines, calling cb(name, lineIdx) per match.
 * Skips matches whose START position is inside a string literal (per `mask`).
 */
function matchAllWithMask(
  pattern: RegExp,
  lines: string[],
  mask: boolean[][],
  cb: (name: string, lineIdx: number) => void,
): void {
  for (let i = 0; i < lines.length; i++) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(lines[i])) !== null) {
      const startIdx = m.index;
      if (mask[i] && mask[i][startIdx]) {
        // Match started inside a string literal → false positive.
        if (m[0].length === 0) pattern.lastIndex++;
        continue;
      }
      cb(m[1], i);
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
}

/**
 * Per-char string-mask for single/double-quoted strings WITHIN a single line.
 * Triple-quoted blocks are handled by computeTripleQuoteMask separately.
 *
 * The opening + closing quotes themselves ARE marked as inside-string. This
 * matches our intent: an `os.environ` token immediately AFTER a quote that
 * closes a string is NOT inside that string and should match.
 */
function computeStringMask(lines: string[]): boolean[][] {
  return lines.map((line) => {
    const mask = new Array(line.length).fill(false);
    let inStr: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inStr) {
        mask[i] = true;
        if (ch === '\\' && i + 1 < line.length) {
          mask[i + 1] = true;
          i++;
          continue;
        }
        if (ch === inStr) {
          inStr = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch as '"' | "'";
        mask[i] = true;
      }
    }
    return mask;
  });
}

/**
 * Look at the next few non-blank lines after an `os.environ.get(name)` /
 * `os.getenv(name)` call. If the immediate next non-blank line is a guard
 * like `if not <var>: raise` or `if <var> is None: raise`, treat as required.
 * Conservative: only matches simple inline forms; multi-line `if` blocks or
 * upstream-bound checks are not detected (false-negative is OK per spec).
 */
function isGuardedRaise(originalLines: string[], lineIdx: number, name: string): boolean {
  // Heuristic 1: `varname = os.environ.get("NAME") or raise ...`  isn't valid
  // Python, but `... or sys.exit(...)` is a common pattern. We look for the
  // assigned variable name on this line, then scan the next 3 non-blank lines
  // for `if not <var>:` or `if <var> is None:` followed by raise/sys.exit.
  const sameLine = originalLines[lineIdx];
  // Extract LHS variable: `<lhs> = os.environ.get(...)`. Default to env-name
  // lowercased if no LHS (e.g. used as expression).
  const assignMatch = sameLine.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]/);
  const lhsCandidates = new Set<string>();
  if (assignMatch) lhsCandidates.add(assignMatch[1]);
  lhsCandidates.add(name);                 // some code names variable identically to env
  lhsCandidates.add(name.toLowerCase());
  // Common idiom: `if not os.environ.get("NAME"): raise` on the same line.
  if (/\bif\s+not\s+os\.(?:environ\.get|getenv)\s*\(\s*['"]/.test(sameLine) &&
      /\b(?:raise|sys\.exit|assert\s+False)\b/.test(sameLine)) {
    return true;
  }

  let scanned = 0;
  for (let i = lineIdx + 1; i < originalLines.length && scanned < 3; i++) {
    const trimmed = originalLines[i].trim();
    if (trimmed === '') continue;
    scanned++;

    // `if not VAR:` / `if VAR is None:` / `assert VAR` / `if VAR == "":`
    // followed by raise / sys.exit / RuntimeError on the same OR next line.
    let guardMatched = false;
    for (const lhs of lhsCandidates) {
      const escaped = lhs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const guardRegex = new RegExp(
        `^if\\s+(?:not\\s+${escaped}\\b|${escaped}\\s+is\\s+None\\b|${escaped}\\s*==\\s*['"]['"])`,
      );
      const assertRegex = new RegExp(`^assert\\s+${escaped}\\b`);
      if (guardRegex.test(trimmed) || assertRegex.test(trimmed)) {
        guardMatched = true;
        break;
      }
    }
    if (!guardMatched) continue;

    // Look for raise/sys.exit on this line OR the next non-blank line.
    if (/\b(?:raise|sys\.exit|os\._exit)\b/.test(trimmed)) return true;
    for (let j = i + 1; j < originalLines.length; j++) {
      const t = originalLines[j].trim();
      if (t === '') continue;
      if (/^(?:raise|sys\.exit|os\._exit)\b/.test(t)) return true;
      break; // body of `if` is single-line; if not raise → not a guard
    }
    return false;
  }
  return false;
}

interface PydanticField {
  name: string;
  required: boolean;
  lineIdx: number;
}

interface PydanticClass {
  name: string;
  fields: PydanticField[];
}

/**
 * Find class definitions whose base list mentions BaseSettings (any module
 * path: `pydantic_settings.BaseSettings`, `BaseSettings`, etc.). Walk the
 * indented body and collect type-annotated fields.
 *
 * Conservative: stops at the first dedent. Does not handle:
 *   - Conditional class bodies inside `if TYPE_CHECKING:` (fine — those
 *     wouldn't be loaded at runtime anyway)
 *   - Multi-line class definitions with weird indentation (rare)
 */
function findPydanticSettingsClasses(cleanedLines: string[]): PydanticClass[] {
  const classes: PydanticClass[] = [];
  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i];
    // class Foo(...BaseSettings...):
    const m = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/);
    if (!m) continue;
    const baseIndent = m[1].length;
    const className = m[2];
    const bases = m[3];
    if (!/\bBaseSettings\b/.test(bases)) continue;

    // Walk forward through the class body.
    const fields: PydanticField[] = [];
    for (let j = i + 1; j < cleanedLines.length; j++) {
      const bodyLine = cleanedLines[j];
      if (bodyLine.trim() === '') continue;
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyIndent <= baseIndent) break; // dedented — class body over

      // Skip nested class / def / decorator / model_config / Config inner class.
      const trimmed = bodyLine.trim();
      if (trimmed.startsWith('def ') || trimmed.startsWith('async def ') ||
          trimmed.startsWith('class ') || trimmed.startsWith('@') ||
          trimmed.startsWith('model_config') || trimmed === 'Config:' ||
          trimmed.startsWith('Config:')) continue;

      // Field: `name: type` or `name: type = default` or `name = default`
      // We only treat fields with type annotation as Pydantic settings —
      // bare `x = 1` would be a class-level constant, not a settings field.
      const fieldMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^=]+?)(\s*=\s*(.+))?\s*$/);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2].trim();
      const hasDefault = fieldMatch[3] !== undefined;
      const defaultValue = (fieldMatch[4] ?? '').trim();

      // Skip private/dunder fields and pydantic config fields.
      if (fieldName.startsWith('_')) continue;
      if (fieldName === 'model_config') continue;

      // Required if no default. Optional[X] without `= None` is still
      // technically required by Pydantic v2 unless you give it None.
      let required = !hasDefault;
      if (hasDefault && (defaultValue === 'None' || defaultValue === '...')) {
        // `= ...` is Pydantic Field required marker (Pydantic v1 + v2).
        // `= None` makes it optional.
        if (defaultValue === '...') required = true;
        else required = false;
      }
      // Field(default=..., ...) — required if default is `...` or omitted.
      if (hasDefault && /^Field\s*\(/.test(defaultValue)) {
        // Match `Field(...)` / `Field(default=...)` / `Field(...,` — required marker.
        // Anything else (Field(default="x"), Field(default=None)) → optional.
        if (/Field\s*\(\s*\.\.\.[\s,)]/.test(defaultValue) ||
            /Field\s*\(\s*default\s*=\s*\.\.\.[\s,)]/.test(defaultValue)) {
          required = true;
        } else {
          required = false;
        }
      }
      // Optional[X] hint without explicit `= None` — leave required as-is
      // (Pydantic v2 treats it as required unless default given).
      void fieldType;

      fields.push({ name: fieldName, required, lineIdx: j });
    }
    if (fields.length > 0) classes.push({ name: className, fields });
  }
  return classes;
}

// ─── String / comment stripping ─────────────────────────────────────

/**
 * Strip line comments only (`# ...` to EOL), preserving string literals.
 * `#` inside a string literal is NOT treated as a comment.
 *
 * We deliberately do NOT strip string contents because our patterns NEED to
 * read env-var names from inside string literals (`os.environ["X"]`,
 * `os.getenv("X")`, secret-manager paths).
 *
 * Length-preserving so line offsets stay valid for downstream patterns.
 */
function stripCommentsOnly(line: string): string {
  let out = '';
  let i = 0;
  let inStr: '"' | "'" | null = null;
  while (i < line.length) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < line.length) {
        out += ch + line[i + 1];
        i += 2;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '#') {
      // Pad to EOL with spaces to keep length stable.
      out += ' '.repeat(line.length - i);
      break;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch as '"' | "'";
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Compute a per-line mask: for each char index in each line, is that char
 * INSIDE a triple-quoted string (`"""..."""` or `'''...'''`)? Triple-quoted
 * blocks span lines and are commonly used as docstrings — we want to suppress
 * pattern matches inside them so docstrings describing `os.environ["FAKE"]`
 * don't trigger false positives.
 */
function computeTripleQuoteMask(lines: string[]): boolean[][] {
  const masks: boolean[][] = lines.map((l) => new Array(l.length).fill(false));
  let inTriple: '"""' | "'''" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      if (inTriple) {
        // Inside a triple-quoted block: mark as inside.
        // Check for closing triple.
        if (line.substr(j, 3) === inTriple) {
          // The closing triple itself is ALSO part of the string; mark it.
          masks[i][j] = true;
          masks[i][j + 1] = true;
          masks[i][j + 2] = true;
          inTriple = null;
          j += 3;
          continue;
        }
        masks[i][j] = true;
        j++;
        continue;
      }
      // Not in triple: check for an opening triple.
      const triple = line.substr(j, 3);
      if (triple === '"""' || triple === "'''") {
        // Mark the opening triple as inside-string.
        masks[i][j] = true;
        masks[i][j + 1] = true;
        masks[i][j + 2] = true;
        inTriple = triple as '"""' | "'''";
        j += 3;
        continue;
      }
      j++;
    }
  }
  return masks;
}

// ─── Filesystem walk ───────────────────────────────────────────────

function walkPyFiles(dir: string, cb: (absPath: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // Skip hidden dirs/files (.git, .venv, .env, ...) — we already
      // include the common ones in SKIP_DIRS but this catches the long tail.
      if (entry.isDirectory()) continue;
      // Allow .py files at top level even if hidden? Unlikely. Skip to be safe.
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkPyFiles(path.join(dir, entry.name), cb, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      cb(path.join(dir, entry.name));
    }
  }
}

// ─── Internal Map upsert ───────────────────────────────────────────

function upsert(map: Map<string, PythonEnvRef>, ref: PythonEnvRef): void {
  const existing = map.get(ref.name);
  if (!existing) {
    map.set(ref.name, ref);
    return;
  }
  if (!existing.required && ref.required) {
    map.set(ref.name, ref);
  }
}
