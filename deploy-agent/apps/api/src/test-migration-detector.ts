/**
 * Tests: migration-detector (R57)
 *
 * 為什麼這個邏輯需要被鎖死：deploy-worker Step 3.5 完全依賴這個函式判斷該不該
 * 跑 migration。誤判：
 *   - 該跑卻沒跑 → user code 部署 v2 但 schema 還在 v1，crash
 *   - 不該跑卻跑 → Prisma db_push 在 prod 改 schema 可能掉資料
 *   - tool=prisma 但 command 寫錯 → CI 跑爛 migration
 *
 * Lake-the-boil：每個 detection branch + 每個 ambiguous edge case 都鎖一條測試。
 *
 * Run: bun run src/test-migration-detector.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectMigrationTool,
  describeMigrationTool,
} from './services/migration-detector';

let passed = 0;
let failed = 0;
const tempDirs: string[] = [];

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
  const dir = mkdtempSync(join(tmpdir(), 'migration-detector-test-'));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('\n=== migration-detector unit tests ===\n');

// ─── Prisma detection ───

test('Prisma: schema.prisma + prisma/migrations/ with .sql → tool=prisma', () => {
  const dir = makeTempProject();
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  mkdirSync(join(dir, 'prisma/migrations'));
  mkdirSync(join(dir, 'prisma/migrations/20240101_init'));
  writeFileSync(join(dir, 'prisma/migrations/20240101_init/migration.sql'), 'CREATE TABLE foo();');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'prisma');
  if (r.tool === 'prisma') assert.equal(r.command, 'npx prisma migrate deploy');
  assert.equal(r.warnings.length, 0);
});

test('Prisma: schema.prisma at root (not in prisma/) + migrations/ → tool=prisma', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'schema.prisma'), 'datasource db {}');
  mkdirSync(join(dir, 'migrations'));
  mkdirSync(join(dir, 'migrations/20240101_init'));
  writeFileSync(join(dir, 'migrations/20240101_init/migration.sql'), '');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'prisma');
});

test('Prisma: schema.prisma but NO migrations/ folder → tool=prisma_db_push_only with warning', () => {
  const dir = makeTempProject();
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), 'datasource db {}');
  // No migrations/ dir
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'prisma_db_push_only');
  assert.equal(r.command, null);
  assert.ok(r.warnings.length > 0);
  assert.match(r.warnings[0], /db push|migration files/i);
});

test('Prisma: schema.prisma + empty migrations/ folder → tool=prisma_db_push_only', () => {
  const dir = makeTempProject();
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), '');
  mkdirSync(join(dir, 'prisma/migrations')); // exists but empty
  const r = detectMigrationTool(dir);
  // Empty migrations dir is treated as "no migration files" → db_push_only
  assert.equal(r.tool, 'prisma_db_push_only');
});

test('Prisma: migrations folder has plain .sql files (no sub-dirs) → still tool=prisma', () => {
  const dir = makeTempProject();
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), '');
  mkdirSync(join(dir, 'prisma/migrations'));
  writeFileSync(join(dir, 'prisma/migrations/001_init.sql'), 'CREATE TABLE foo();');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'prisma');
});

// ─── Alembic detection ───

test('Alembic: alembic.ini + alembic/versions/ with .py revision → tool=alembic', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'alembic.ini'), '[alembic]\nscript_location = alembic');
  mkdirSync(join(dir, 'alembic'));
  mkdirSync(join(dir, 'alembic/versions'));
  writeFileSync(join(dir, 'alembic/versions/20240101_init.py'), '"""init"""\nrevision = "abc123"');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'alembic');
  if (r.tool === 'alembic') assert.equal(r.command, 'alembic upgrade head');
});

test('Alembic: alembic.ini + migrations/versions/ → tool=alembic (custom script_location)', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'alembic.ini'), '');
  mkdirSync(join(dir, 'migrations'));
  mkdirSync(join(dir, 'migrations/versions'));
  writeFileSync(join(dir, 'migrations/versions/20240101_init.py'), '');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'alembic');
});

test('Alembic: alembic.ini + db/alembic/versions/ → tool=alembic', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'alembic.ini'), '');
  mkdirSync(join(dir, 'db'));
  mkdirSync(join(dir, 'db/alembic'));
  mkdirSync(join(dir, 'db/alembic/versions'));
  writeFileSync(join(dir, 'db/alembic/versions/abc.py'), '');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'alembic');
});

test('Alembic: alembic.ini exists but versions/ has only __init__.py → tool=none with warning', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'alembic.ini'), '');
  mkdirSync(join(dir, 'alembic'));
  mkdirSync(join(dir, 'alembic/versions'));
  writeFileSync(join(dir, 'alembic/versions/__init__.py'), '');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'none');
  assert.ok(r.warnings.length > 0);
});

test('Alembic: alembic.ini exists but NO versions/ dir anywhere → tool=none with warning', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'alembic.ini'), '');
  // No alembic/ dir at all
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'none');
  assert.ok(r.warnings.length > 0);
  assert.match(r.warnings[0], /versions|script_location/i);
});

// ─── No DB / negative cases ───

test('No DB markers → tool=none, no warnings', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'package.json'), '{"name":"test"}');
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'none');
  assert.equal(r.warnings.length, 0);
});

test('Empty project dir → tool=none', () => {
  const dir = makeTempProject();
  const r = detectMigrationTool(dir);
  assert.equal(r.tool, 'none');
});

// ─── Defensive cases ───

test('Non-existent projectDir → tool=none, no throw', () => {
  const r = detectMigrationTool('/nonexistent/path/abc123');
  assert.equal(r.tool, 'none');
});

test('Empty string projectDir → tool=none with warning, no throw', () => {
  const r = detectMigrationTool('');
  assert.equal(r.tool, 'none');
  assert.ok(r.warnings.length > 0);
});

test('Non-string projectDir → tool=none, no throw', () => {
  // @ts-expect-error testing defensive guard
  const r = detectMigrationTool(null);
  assert.equal(r.tool, 'none');
});

test('Both Prisma AND Alembic markers → Prisma wins (Node ecosystem dominant)', () => {
  // Pathological case — most projects shouldn't have both. We pick deterministic
  // winner so behavior is reproducible.
  const dir = makeTempProject();
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), '');
  mkdirSync(join(dir, 'prisma/migrations'));
  mkdirSync(join(dir, 'prisma/migrations/init'));
  writeFileSync(join(dir, 'prisma/migrations/init/migration.sql'), '');
  writeFileSync(join(dir, 'alembic.ini'), '');
  mkdirSync(join(dir, 'alembic'));
  mkdirSync(join(dir, 'alembic/versions'));
  writeFileSync(join(dir, 'alembic/versions/x.py'), '');
  const r = detectMigrationTool(dir);
  // Prisma checked first in detector — wins
  assert.equal(r.tool, 'prisma');
});

// ─── R57.3 Django ───

test('R57.3 Django: manage.py + django in requirements.txt → tool=django', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'manage.py'), '#!/usr/bin/env python\nimport django');
  writeFileSync(join(dir, 'requirements.txt'), 'Django==4.2\nrequests==2.31');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'django');
  assert.equal(v.command, 'python manage.py migrate --noinput');
});

test('R57.3 Django: manage.py without django dep → falls through (probably template)', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'manage.py'), '');
  writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31\n');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'none');
});

test('R57.3 Django: django dep in pyproject.toml [tool.poetry.dependencies] → tool=django', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'manage.py'), '');
  writeFileSync(
    join(dir, 'pyproject.toml'),
    '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^4.2"\n',
  );
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'django');
});

test('R57.3 Django regression: django-rest-framework alone (no django) → no false positive', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'manage.py'), '');
  writeFileSync(join(dir, 'requirements.txt'), 'django-rest-framework==3.14\n');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'none', 'name pattern must not match django-rest-framework as django');
});

// ─── R57.3 Flask-Migrate ───

test('R57.3 Flask-Migrate: explicit Flask-Migrate dep → tool=flask_migrate', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'requirements.txt'), 'Flask==3.0\nFlask-Migrate==4.0\n');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'flask_migrate');
  assert.equal(v.command, 'flask db upgrade');
});

test('R57.3 Flask-Migrate: alembic.ini outside migrations/ + Flask only → no flask-migrate verdict', () => {
  // Plain Alembic detection wins because alembic.ini at root resolves first.
  const dir = makeTempProject();
  writeFileSync(join(dir, 'alembic.ini'), '[alembic]');
  mkdirSync(join(dir, 'alembic'));
  mkdirSync(join(dir, 'alembic/versions'));
  writeFileSync(join(dir, 'alembic/versions/abc123_init.py'), '# revision');
  writeFileSync(join(dir, 'requirements.txt'), 'Flask==3.0\n');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'alembic', 'alembic at root takes precedence over flask_migrate fallback');
});

// ─── R57.3 Drizzle ───

test('R57.3 Drizzle: drizzle.config.ts + drizzle-kit dep → tool=drizzle', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'drizzle.config.ts'), 'export default {}');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { 'drizzle-kit': '^0.20', 'drizzle-orm': '^0.30' } }),
  );
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'drizzle');
  assert.equal(v.command, 'npx drizzle-kit migrate');
});

test('R57.3 Drizzle: drizzle config without drizzle-kit dep → no false positive', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'drizzle.config.js'), '');
  writeFileSync(join(dir, 'package.json'), '{}');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'none');
});

// ─── R57.3 Knex ───

test('R57.3 Knex: knexfile.ts + knex dep → tool=knex', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'knexfile.ts'), 'export default {}');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { knex: '^3.0' } }),
  );
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'knex');
  assert.equal(v.command, 'npx knex migrate:latest');
});

test('R57.3 Knex: knexfile.js + knex in devDependencies → tool=knex', () => {
  const dir = makeTempProject();
  writeFileSync(join(dir, 'knexfile.js'), '');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { knex: '^3.0' } }),
  );
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'knex');
});

// ─── R57.3 TypeORM ───

test('R57.3 TypeORM: typeorm dep + data-source.ts → typeorm_manual with warning', () => {
  const dir = makeTempProject();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { typeorm: '^0.3', 'pg': '^8' } }),
  );
  writeFileSync(join(dir, 'data-source.ts'), 'export const AppDataSource = ...');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'typeorm_manual');
  assert.equal(v.command, null);
  assert.ok(v.warnings.length >= 1, 'must include warning about manual command');
  assert.match(v.warnings[0] ?? '', /TypeORM/);
});

test('R57.3 TypeORM: typeorm dep WITHOUT data-source file → tool=none', () => {
  const dir = makeTempProject();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { typeorm: '^0.3' } }),
  );
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'none');
});

// ─── Priority: Prisma > Alembic > Django > Flask-Migrate > Drizzle > Knex > TypeORM ───

test('R57.3 priority: Prisma + Django markers → Prisma wins', () => {
  // A monorepo or hybrid project might have both. Prisma should win because
  // it's the more common Node-side workflow + appears first in detector.
  const dir = makeTempProject();
  mkdirSync(join(dir, 'prisma'));
  writeFileSync(join(dir, 'prisma/schema.prisma'), '');
  mkdirSync(join(dir, 'prisma/migrations'));
  mkdirSync(join(dir, 'prisma/migrations/20260101_init'));
  writeFileSync(join(dir, 'prisma/migrations/20260101_init/migration.sql'), '');
  writeFileSync(join(dir, 'manage.py'), '');
  writeFileSync(join(dir, 'requirements.txt'), 'Django==4.2\n');
  const v = detectMigrationTool(dir);
  assert.equal(v.tool, 'prisma');
});

// ─── describeMigrationTool ───

test('describeMigrationTool: covers all 9 tool variants (R57 + R57.3)', () => {
  assert.match(
    describeMigrationTool({ tool: 'prisma', command: 'npx prisma migrate deploy', warnings: [] }),
    /Prisma migrate deploy/,
  );
  assert.match(
    describeMigrationTool({ tool: 'prisma_db_push_only', command: null, warnings: [] }),
    /db push only/i,
  );
  assert.match(
    describeMigrationTool({ tool: 'alembic', command: 'alembic upgrade head', warnings: [] }),
    /Alembic/,
  );
  assert.match(
    describeMigrationTool({ tool: 'django', command: 'python manage.py migrate --noinput', warnings: [] }),
    /Django/,
  );
  assert.match(
    describeMigrationTool({ tool: 'flask_migrate', command: 'flask db upgrade', warnings: [] }),
    /Flask-Migrate/,
  );
  assert.match(
    describeMigrationTool({ tool: 'drizzle', command: 'npx drizzle-kit migrate', warnings: [] }),
    /Drizzle/,
  );
  assert.match(
    describeMigrationTool({ tool: 'knex', command: 'npx knex migrate:latest', warnings: [] }),
    /Knex/,
  );
  assert.match(
    describeMigrationTool({ tool: 'typeorm_manual', command: null, warnings: [] }),
    /TypeORM/,
  );
  assert.match(
    describeMigrationTool({ tool: 'none', command: null, warnings: [] }),
    /no migration tool/i,
  );
});

cleanup();
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
