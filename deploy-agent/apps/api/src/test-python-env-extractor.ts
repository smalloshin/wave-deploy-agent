/**
 * Tests: python-env-extractor (R49)
 *
 * Why this matters:
 *   - luca-optimizer-kb and wavenet-ai-gateway-backend BOTH burned a 4-min
 *     Cloud Run health-check window before failing because env-detector
 *     only spotted REFERENCES — not REQUIRED references. This extractor's
 *     `required` flag is what the gate decider keys off.
 *   - False-negative (miss a required var) → deploy fails like before, no
 *     worse. False-positive (call a not-required var required) → gate blocks
 *     a deploy that would have worked. We bias toward false-negatives.
 *
 * What we lock in:
 *   - os.environ["X"] / os.environ['X']  → required=true, source=os.environ
 *   - os.environ.get("X") / os.getenv("X") → required=false (default)
 *   - os.environ.get(...) followed by `if not <var>: raise` → upgraded to required=true
 *   - Pydantic BaseSettings: typed field with no default → required=true
 *   - Pydantic BaseSettings: typed field with default value → required=false
 *   - Pydantic BaseSettings: `Field(...)` marker → required=true
 *   - Pydantic BaseSettings: `Field(default=None)` → required=false
 *   - Google Secret Manager: client.access_secret_version(name=f".../secrets/X/...") → required=true
 *   - False-positive guards:
 *     * commented-out code (`# foo = os.environ["X"]`) is ignored
 *     * docstring/string-literal text mentioning os.environ is ignored
 *     * `os.environ` inside a triple-quoted docstring? Hard to fully handle;
 *       we're conservative — single-line docstrings ARE protected.
 *   - Edge cases:
 *     * Mixed quote types
 *     * File > 50KB skipped (no false positives from build artifacts)
 *     * venv / __pycache__ / .git directories skipped
 *     * Permission errors don't crash extraction
 *
 * Run: bun run src/test-python-env-extractor.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractPythonEnvVars,
  scanPythonContent,
  type PythonEnvRef,
} from './services/python-env-extractor.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'py-env-extractor-'));
}

function rm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeFile(dir: string, name: string, content: string): void {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function findRef(refs: PythonEnvRef[], name: string): PythonEnvRef | undefined {
  return refs.find((r) => r.name === name);
}

console.log('\n=== python-env-extractor unit tests ===\n');

// ─── scanPythonContent: os.environ subscript ─────────────────

test('subscript double-quote: os.environ["X"] → required=true', () => {
  const refs = scanPythonContent('JWT = os.environ["LUCA_JWT_SECRET"]', 'auth.py');
  const r = findRef(refs, 'LUCA_JWT_SECRET');
  assert.ok(r, 'expected ref');
  assert.equal(r!.required, true);
  assert.equal(r!.source, 'os.environ');
  assert.equal(r!.location, 'auth.py:1');
});

test('subscript single-quote: os.environ[\'X\'] → required=true', () => {
  const refs = scanPythonContent("x = os.environ['DATABASE_URL']", 'a.py');
  assert.equal(findRef(refs, 'DATABASE_URL')?.required, true);
});

test('subscript with whitespace: os.environ[ "X" ] → required=true', () => {
  const refs = scanPythonContent('x = os.environ[ "WHITESPACE_KEY" ]', 'a.py');
  assert.equal(findRef(refs, 'WHITESPACE_KEY')?.required, true);
});

test('multiple subscripts on one line are both captured', () => {
  const refs = scanPythonContent('a, b = os.environ["A_KEY"], os.environ["B_KEY"]', 'a.py');
  assert.equal(findRef(refs, 'A_KEY')?.required, true);
  assert.equal(findRef(refs, 'B_KEY')?.required, true);
});

// ─── scanPythonContent: os.environ.get / os.getenv ────────────

test('os.environ.get("X") → required=false (default)', () => {
  const refs = scanPythonContent('x = os.environ.get("OPTIONAL_VAR")', 'a.py');
  const r = findRef(refs, 'OPTIONAL_VAR');
  assert.ok(r);
  assert.equal(r!.required, false);
  assert.equal(r!.source, 'os.getenv');
});

test('os.getenv("X") → required=false', () => {
  const refs = scanPythonContent('x = os.getenv("FOO")', 'a.py');
  assert.equal(findRef(refs, 'FOO')?.required, false);
});

test('os.environ.get with raise guard → upgraded to required=true', () => {
  const src = [
    'mykey = os.environ.get("REQUIRED_VIA_GUARD")',
    'if not mykey:',
    '    raise RuntimeError("REQUIRED_VIA_GUARD missing")',
  ].join('\n');
  const refs = scanPythonContent(src, 'cfg.py');
  assert.equal(findRef(refs, 'REQUIRED_VIA_GUARD')?.required, true);
});

test('os.environ.get with `is None` raise guard → required=true', () => {
  const src = [
    'val = os.environ.get("STRICT_KEY")',
    'if val is None:',
    '    raise ValueError("nope")',
  ].join('\n');
  const refs = scanPythonContent(src, 'cfg.py');
  assert.equal(findRef(refs, 'STRICT_KEY')?.required, true);
});

test('os.environ.get with no guard → stays required=false', () => {
  const src = [
    'val = os.environ.get("MAYBE_KEY")',
    'print("no guard here")',
  ].join('\n');
  const refs = scanPythonContent(src, 'cfg.py');
  assert.equal(findRef(refs, 'MAYBE_KEY')?.required, false);
});

// ─── scanPythonContent: Pydantic BaseSettings ─────────────────

test('Pydantic BaseSettings: typed field, no default → required=true', () => {
  const src = [
    'from pydantic_settings import BaseSettings',
    '',
    'class Settings(BaseSettings):',
    '    erp_jwt_secret: str',
    '    debug: bool = False',
  ].join('\n');
  const refs = scanPythonContent(src, 'config.py');
  // Field name uppercased → ERP_JWT_SECRET
  assert.equal(findRef(refs, 'ERP_JWT_SECRET')?.required, true);
  assert.equal(findRef(refs, 'ERP_JWT_SECRET')?.source, 'pydantic-settings');
  // Field with default → optional
  assert.equal(findRef(refs, 'DEBUG')?.required, false);
});

test('Pydantic with model_config doesn\'t crash + ignores model_config field', () => {
  const src = [
    'class Settings(BaseSettings):',
    '    model_config = SettingsConfigDict(env_prefix="APP_")',
    '    api_key: str',
  ].join('\n');
  const refs = scanPythonContent(src, 'config.py');
  assert.equal(findRef(refs, 'API_KEY')?.required, true);
  assert.ok(!findRef(refs, 'MODEL_CONFIG'), 'model_config should not be a ref');
});

test('Pydantic Field(...) → required=true', () => {
  const src = [
    'class Settings(BaseSettings):',
    '    secret: str = Field(...)',
  ].join('\n');
  const refs = scanPythonContent(src, 'config.py');
  assert.equal(findRef(refs, 'SECRET')?.required, true);
});

test('Pydantic Field(default=None) → required=false', () => {
  const src = [
    'class Settings(BaseSettings):',
    '    optional_key: Optional[str] = Field(default=None)',
  ].join('\n');
  const refs = scanPythonContent(src, 'config.py');
  assert.equal(findRef(refs, 'OPTIONAL_KEY')?.required, false);
});

test('Pydantic Optional[X] without default → required=true (Pydantic v2 semantic)', () => {
  const src = [
    'class Settings(BaseSettings):',
    '    maybe: Optional[str]',
  ].join('\n');
  const refs = scanPythonContent(src, 'config.py');
  assert.equal(findRef(refs, 'MAYBE')?.required, true);
});

test('Pydantic class NOT extending BaseSettings is ignored', () => {
  const src = [
    'class RegularClass:',
    '    api_key: str',
  ].join('\n');
  const refs = scanPythonContent(src, 'config.py');
  assert.ok(!findRef(refs, 'API_KEY'), 'non-BaseSettings class should not yield refs');
});

// ─── scanPythonContent: Google Secret Manager ─────────────────

test('Secret Manager: name=f"projects/X/secrets/JWT_SECRET/versions/latest" → required=true', () => {
  const src = 'resp = client.access_secret_version(name=f"projects/my-proj/secrets/JWT_SECRET/versions/latest")';
  const refs = scanPythonContent(src, 'secrets.py');
  const r = findRef(refs, 'JWT_SECRET');
  assert.ok(r);
  assert.equal(r!.required, true);
  assert.equal(r!.source, 'secret-manager');
});

test('Secret Manager: name in dict request format → required=true', () => {
  const src = 'resp = client.access_secret_version(request={"name": "projects/p/secrets/MY_SECRET/versions/1"})';
  const refs = scanPythonContent(src, 'secrets.py');
  assert.equal(findRef(refs, 'MY_SECRET')?.required, true);
});

// ─── False-positive guards ────────────────────────────────────

test('Commented-out code is NOT extracted', () => {
  const src = '# foo = os.environ["COMMENTED_OUT"]';
  const refs = scanPythonContent(src, 'a.py');
  assert.equal(refs.length, 0);
});

test('String literal containing os.environ text is NOT extracted', () => {
  // Triple-quoted docstring describing the behavior, not actually calling it.
  const src = 'doc = "use os.environ[\\"FAKE_NEVER_READ\\"] to read the var"';
  const refs = scanPythonContent(src, 'a.py');
  // The literal "FAKE_NEVER_READ" is INSIDE a string — should be stripped.
  assert.ok(!findRef(refs, 'FAKE_NEVER_READ'),
    `expected FAKE_NEVER_READ to be stripped; got ${JSON.stringify(refs)}`);
});

test('os.getenv with code on same line that contains comment AFTER → still extracted', () => {
  const refs = scanPythonContent('x = os.getenv("REAL_VAR")  # not a fake', 'a.py');
  assert.equal(findRef(refs, 'REAL_VAR')?.required, false);
});

// ─── Dedup / merge across patterns ────────────────────────────

test('Same name via multiple patterns: required=true wins', () => {
  const src = [
    'a = os.environ.get("DUAL_KEY")',  // optional
    'b = os.environ["DUAL_KEY"]',      // required
  ].join('\n');
  const refs = scanPythonContent(src, 'a.py');
  const r = findRef(refs, 'DUAL_KEY');
  assert.equal(r?.required, true, 'required=true should win over required=false');
});

// ─── extractPythonEnvVars (end-to-end with filesystem) ────────

test('extractPythonEnvVars: walks subdirs, finds refs', () => {
  const dir = makeTempProject();
  try {
    writeFile(dir, 'app/main.py', 'JWT = os.environ["JWT_SECRET"]');
    writeFile(dir, 'app/db.py', 'pwd = os.environ.get("DB_PASSWORD")');
    const refs = extractPythonEnvVars(dir);
    assert.equal(findRef(refs, 'JWT_SECRET')?.required, true);
    assert.equal(findRef(refs, 'DB_PASSWORD')?.required, false);
  } finally { rm(dir); }
});

test('extractPythonEnvVars: skips venv/.venv/__pycache__/node_modules', () => {
  const dir = makeTempProject();
  try {
    writeFile(dir, 'app/main.py', 'JWT = os.environ["REAL_VAR"]');
    writeFile(dir, 'venv/lib/foo.py', 'X = os.environ["VENV_VAR"]');
    writeFile(dir, '.venv/bin/bar.py', 'X = os.environ["DOTVENV_VAR"]');
    writeFile(dir, '__pycache__/baz.py', 'X = os.environ["PYC_VAR"]');
    writeFile(dir, 'node_modules/qux.py', 'X = os.environ["NM_VAR"]');
    const refs = extractPythonEnvVars(dir);
    assert.ok(findRef(refs, 'REAL_VAR'), 'expected REAL_VAR');
    assert.ok(!findRef(refs, 'VENV_VAR'), 'venv should be skipped');
    assert.ok(!findRef(refs, 'DOTVENV_VAR'), '.venv should be skipped');
    assert.ok(!findRef(refs, 'PYC_VAR'), '__pycache__ should be skipped');
    assert.ok(!findRef(refs, 'NM_VAR'), 'node_modules should be skipped');
  } finally { rm(dir); }
});

test('extractPythonEnvVars: skips files > 50KB', () => {
  const dir = makeTempProject();
  try {
    const big = '# pad\n'.repeat(15_000) + 'x = os.environ["BIG_FILE_VAR"]\n';
    assert.ok(big.length > 50 * 1024, 'precondition: file > 50KB');
    writeFile(dir, 'app/big.py', big);
    writeFile(dir, 'app/small.py', 'x = os.environ["SMALL_FILE_VAR"]');
    const refs = extractPythonEnvVars(dir);
    assert.ok(findRef(refs, 'SMALL_FILE_VAR'), 'small file processed');
    assert.ok(!findRef(refs, 'BIG_FILE_VAR'), 'big file (>50KB) should be skipped');
  } finally { rm(dir); }
});

test('extractPythonEnvVars: empty dir → empty array', () => {
  const dir = makeTempProject();
  try {
    const refs = extractPythonEnvVars(dir);
    assert.deepEqual(refs, []);
  } finally { rm(dir); }
});

test('extractPythonEnvVars: ignores non-.py files', () => {
  const dir = makeTempProject();
  try {
    writeFile(dir, 'app.py', 'x = os.environ["PY_VAR"]');
    writeFile(dir, 'app.txt', 'x = os.environ["TXT_VAR"]');
    writeFile(dir, 'app.js', 'process.env.JS_VAR');
    const refs = extractPythonEnvVars(dir);
    assert.ok(findRef(refs, 'PY_VAR'));
    assert.ok(!findRef(refs, 'TXT_VAR'));
    assert.ok(!findRef(refs, 'JS_VAR'));
  } finally { rm(dir); }
});

test('extractPythonEnvVars: invalid projectDir → empty array (no throw)', () => {
  const refs = extractPythonEnvVars('/path/that/does/not/exist/r49');
  assert.deepEqual(refs, []);
  // Defensive: typeof guard for non-string
  // @ts-expect-error testing runtime guard
  assert.deepEqual(extractPythonEnvVars(null), []);
  // @ts-expect-error testing runtime guard
  assert.deepEqual(extractPythonEnvVars(undefined), []);
});

test('extractPythonEnvVars: real-world luca-optimizer-kb shape', () => {
  const dir = makeTempProject();
  try {
    writeFile(dir, 'app/auth.py', [
      'import os',
      '',
      'JWT_SECRET = os.environ["LUCA_JWT_SECRET"]',
      'DB_PWD = os.environ["POSTGRES_PASSWORD"]',
    ].join('\n'));
    writeFile(dir, 'app/main.py', [
      'from fastapi import FastAPI',
      'from .auth import JWT_SECRET',
      'app = FastAPI()',
    ].join('\n'));
    const refs = extractPythonEnvVars(dir);
    const luca = findRef(refs, 'LUCA_JWT_SECRET');
    const pg = findRef(refs, 'POSTGRES_PASSWORD');
    assert.ok(luca, 'expected LUCA_JWT_SECRET');
    assert.equal(luca!.required, true);
    assert.equal(luca!.location, 'app/auth.py:3');
    assert.ok(pg, 'expected POSTGRES_PASSWORD');
    assert.equal(pg!.required, true);
  } finally { rm(dir); }
});

test('extractPythonEnvVars: real-world wavenet-ai-gateway shape', () => {
  const dir = makeTempProject();
  try {
    writeFile(dir, 'app/config.py', [
      'from pydantic_settings import BaseSettings',
      '',
      'class Settings(BaseSettings):',
      '    erp_jwt_secret: str  # no default — required',
      '    debug: bool = False',
      '    database_url: str',
    ].join('\n'));
    const refs = extractPythonEnvVars(dir);
    assert.equal(findRef(refs, 'ERP_JWT_SECRET')?.required, true);
    assert.equal(findRef(refs, 'DATABASE_URL')?.required, true);
    assert.equal(findRef(refs, 'DEBUG')?.required, false);
  } finally { rm(dir); }
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
