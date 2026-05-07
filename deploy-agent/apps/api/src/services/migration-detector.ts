/**
 * Migration tool detector (R57)
 *
 * 為什麼存在：vibe-coded 專案 deploy v2 時，新 schema 的 column 沒人跑 migration
 * → container 起來查不到 column → crash。R57 在 deploy-worker Step 3.5 跑
 * migration job，但要先知道用哪個工具。這個 detector 是純函式，給 projectDir
 * 回傳該用什麼 migration 命令（或不該跑）。
 *
 * v1 scope（CEO + eng review 已縮編）：
 *   - Prisma (with migrations/) → `npx prisma migrate deploy`
 *   - Prisma (db push only, no migrations/) → warn, skip（destructive in prod）
 *   - Alembic (FastAPI/SQLAlchemy) → `alembic upgrade head`
 *   - 其他都歸 'none'，跳過 migration step
 *
 * v2/v3 follow-up（見 TODOS.md R57.3）：Django, Drizzle, TypeORM, Knex,
 * Flask-Migrate, Rails。
 *
 * 為什麼是純函式：3 種 detection branches + 4 個 edge cases（壞 schema /
 * alembic.ini 沒對應 alembic/ / 多個 markers / monorepo 子目錄）→ 用 zero-dep
 * 測試把每個 branch 鎖死，無 fs mock 需要。
 */

import fs from 'node:fs';
import path from 'node:path';

/** Discriminated verdict — engineer 直接 switch 來決定行為。 */
export type MigrationDetectionResult =
  | { tool: 'prisma'; command: string; warnings: string[] }
  | { tool: 'prisma_db_push_only'; command: null; warnings: string[] } // 偵測到但拒絕跑（destructive in prod）
  | { tool: 'alembic'; command: string; warnings: string[] }
  | { tool: 'django'; command: string; warnings: string[] }            // R57.3
  | { tool: 'flask_migrate'; command: string; warnings: string[] }     // R57.3
  | { tool: 'drizzle'; command: string; warnings: string[] }           // R57.3
  | { tool: 'knex'; command: string; warnings: string[] }              // R57.3
  | { tool: 'typeorm_manual'; command: null; warnings: string[] }      // R57.3 — detected but command varies, ask user
  | { tool: 'none'; command: null; warnings: string[] };

/**
 * Detect what migration tool the project uses.
 *
 * Pure on filesystem: only reads, never writes. Best-effort — silently
 * skips files it can't read (permissions / not a git repo / etc).
 *
 * @param projectDir absolute path to the unpacked project source
 * @returns discriminated verdict + warnings for log
 */
export function detectMigrationTool(projectDir: string): MigrationDetectionResult {
  if (typeof projectDir !== 'string' || !projectDir) {
    return { tool: 'none', command: null, warnings: ['projectDir not provided'] };
  }
  if (!safeIsDir(projectDir)) {
    return { tool: 'none', command: null, warnings: [] };
  }

  // ─── Prisma detection ───
  const prismaSchema = findFirstExisting(projectDir, [
    'prisma/schema.prisma',
    'schema.prisma',
  ]);
  if (prismaSchema !== null) {
    const migrationsDir = path.join(path.dirname(prismaSchema), 'migrations');
    if (safeIsDir(migrationsDir) && hasAnyMigrationFile(migrationsDir)) {
      return {
        tool: 'prisma',
        command: 'npx prisma migrate deploy',
        warnings: [],
      };
    }
    // Has schema.prisma but no migrations/ folder.
    // Common case: user used `prisma db push` for local dev. Running
    // `db push` in prod would alter schema directly without history,
    // and could lose data. Refuse to run.
    return {
      tool: 'prisma_db_push_only',
      command: null,
      warnings: [
        `偵測到 Prisma schema 但沒有 migrations/ 資料夾。建議改用 prisma migrate dev 產生 migration files 後再部署，避免 prod schema 直接被 db push 改動。`,
      ],
    };
  }

  // ─── Alembic detection ───
  const alembicIni = path.join(projectDir, 'alembic.ini');
  if (safeIsFile(alembicIni)) {
    // alembic.ini exists. Look for alembic/ versions dir.
    // Default name is `alembic/` but user can configure script_location.
    // Try common cases:
    const alembicDirs = [
      path.join(projectDir, 'alembic'),
      path.join(projectDir, 'migrations'),
      path.join(projectDir, 'db', 'alembic'),
    ];
    const versionsDir = alembicDirs
      .map((d) => path.join(d, 'versions'))
      .find((p) => safeIsDir(p));

    if (versionsDir && hasAnyAlembicVersion(versionsDir)) {
      return {
        tool: 'alembic',
        command: 'alembic upgrade head',
        warnings: [],
      };
    }
    // alembic.ini exists but no versions/ dir → ambiguous, warn but skip
    return {
      tool: 'none',
      command: null,
      warnings: [
        `偵測到 alembic.ini 但找不到 versions/ 資料夾。請確認 alembic 設定 script_location 指向 alembic/、migrations/ 或 db/alembic/。略過 migration step。`,
      ],
    };
  }

  // ─── R57.3 Django (Python) ───
  // manage.py + Django imported anywhere → use Django's built-in migrate.
  // We check requirements.txt + pyproject.toml because Django is usually in
  // one of those. If user has manage.py but no Django dep, it's probably a
  // template/skeleton — skip.
  // Negative-lookahead `(?![A-Za-z0-9_-])` so the pattern matches `django`,
  // `Django==4.2`, `django>=3` etc. but NOT `django-rest-framework` (the
  // hyphen continues the package name).
  if (safeIsFile(path.join(projectDir, 'manage.py')) && hasPythonDep(projectDir, /^django(?![A-Za-z0-9_-])/i)) {
    return {
      tool: 'django',
      command: 'python manage.py migrate --noinput',
      warnings: [],
    };
  }

  // ─── R57.3 Flask-Migrate (Python) ───
  // Uses Alembic underneath but exposed through `flask db` CLI.
  // Detect Flask-Migrate dep specifically — alembic alone is handled above.
  if (
    hasPythonDep(projectDir, /^flask[-_]migrate(?![A-Za-z0-9_-])/i) ||
    (hasPythonDep(projectDir, /^flask(?![A-Za-z0-9_-])/i) &&
      safeIsFile(path.join(projectDir, 'migrations', 'env.py')))
  ) {
    return {
      tool: 'flask_migrate',
      command: 'flask db upgrade',
      warnings: [],
    };
  }

  // ─── R57.3 Drizzle (TypeScript / Node) ───
  // drizzle.config.{ts,js,mjs} present + drizzle-kit in deps → drizzle-kit migrate.
  // We check the config file because some projects pull drizzle as a transitive dep.
  const drizzleConfig = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.json']
    .map((n) => path.join(projectDir, n))
    .find(safeIsFile);
  if (drizzleConfig && hasNodeDep(projectDir, 'drizzle-kit')) {
    return {
      tool: 'drizzle',
      command: 'npx drizzle-kit migrate',
      warnings: [],
    };
  }

  // ─── R57.3 Knex (TypeScript / Node) ───
  // knexfile.{js,ts,cjs,mjs} + knex in deps → knex migrate:latest.
  const knexfile = ['knexfile.js', 'knexfile.ts', 'knexfile.cjs', 'knexfile.mjs']
    .map((n) => path.join(projectDir, n))
    .find(safeIsFile);
  if (knexfile && hasNodeDep(projectDir, 'knex')) {
    return {
      tool: 'knex',
      command: 'npx knex migrate:latest',
      warnings: [],
    };
  }

  // ─── R57.3 TypeORM (TypeScript / Node) ───
  // TypeORM migrations require knowing the data-source path which varies per
  // project. We detect but emit a warning + skip — user can run manually or
  // override via project.config.migrationCommand (future work).
  // Detection: typeorm in deps + data-source file present.
  if (hasNodeDep(projectDir, 'typeorm')) {
    const hasDataSource = ['data-source.ts', 'data-source.js', 'src/data-source.ts', 'src/db/data-source.ts']
      .some((rel) => safeIsFile(path.join(projectDir, rel)));
    if (hasDataSource) {
      return {
        tool: 'typeorm_manual',
        command: null,
        warnings: [
          `偵測到 TypeORM 但 data-source 路徑因專案而異 — 自動 migration 暫不支援。請在 Dockerfile build stage 跑一次 \`typeorm migration:run -d <your-data-source>\` 並 commit migrations，或等 R57.3.x 加 project-config 覆寫支援。略過 migration step。`,
        ],
      };
    }
  }

  // ─── No DB markers found ───
  return { tool: 'none', command: null, warnings: [] };
}

/**
 * Get a concise human-readable label for log/UI.
 * Pure helper.
 */
export function describeMigrationTool(verdict: MigrationDetectionResult): string {
  switch (verdict.tool) {
    case 'prisma': return 'Prisma migrate deploy';
    case 'prisma_db_push_only': return 'Prisma (db push only, skipped)';
    case 'alembic': return 'Alembic upgrade head';
    case 'django': return 'Django manage.py migrate';
    case 'flask_migrate': return 'Flask-Migrate db upgrade';
    case 'drizzle': return 'Drizzle Kit migrate';
    case 'knex': return 'Knex migrate:latest';
    case 'typeorm_manual': return 'TypeORM (detected, manual command required)';
    case 'none': return 'no migration tool detected';
  }
}

// ───────────────── internal helpers ─────────────────

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function safeIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Return the first existing path from candidates (joined to base), or null. */
function findFirstExisting(base: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const full = path.join(base, c);
    if (safeIsFile(full)) return full;
  }
  return null;
}

/** Returns true if migrations/ has at least one .sql file or sub-dir containing migration.sql. */
function hasAnyMigrationFile(migrationsDir: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(migrationsDir); } catch { return false; }
  for (const entry of entries) {
    const full = path.join(migrationsDir, entry);
    // Prisma layout: migrations/20240101_init/migration.sql
    // OR plain SQL files (rare but we accept)
    if (safeIsFile(full) && entry.endsWith('.sql')) return true;
    if (safeIsDir(full) && safeIsFile(path.join(full, 'migration.sql'))) return true;
  }
  return false;
}

/** Returns true if alembic versions/ dir contains at least one .py revision file. */
function hasAnyAlembicVersion(versionsDir: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(versionsDir); } catch { return false; }
  return entries.some((e) => e.endsWith('.py') && e !== '__init__.py' && !e.startsWith('.'));
}

/**
 * R57.3: check if a Python project has a given dep declared.
 *
 * Reads `requirements.txt` (line-by-line) and `pyproject.toml` (loose grep
 * for `name = "<dep>"`). The pattern is matched against each requirement
 * line — pass `/^django\b/i` to match `django`, `Django==4.2`, `django>=3`,
 * etc. while NOT matching `django-rest-framework`.
 */
function hasPythonDep(projectDir: string, namePattern: RegExp): boolean {
  // requirements.txt
  const reqPath = path.join(projectDir, 'requirements.txt');
  try {
    const text = fs.readFileSync(reqPath, 'utf-8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      // Strip inline comments + extras spec.
      const head = line.split(/[#;]/)[0]?.trim() ?? '';
      if (namePattern.test(head)) return true;
    }
  } catch {
    /* file missing or unreadable */
  }

  // pyproject.toml — loose grep, no real TOML parser. Catches both
  // [tool.poetry.dependencies] django = "^4" and [project.dependencies]
  // entries.
  const pyproject = path.join(projectDir, 'pyproject.toml');
  try {
    const text = fs.readFileSync(pyproject, 'utf-8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      // poetry style: `django = "^4.2"` — extract bare name.
      const poetryMatch = /^([A-Za-z0-9._-]+)\s*=/.exec(line);
      if (poetryMatch && namePattern.test(poetryMatch[1] ?? '')) return true;
      // PEP 621 style: `"django>=4.2"`,
      const pep621Match = /"([A-Za-z0-9._-]+)/.exec(line);
      if (pep621Match && namePattern.test(pep621Match[1] ?? '')) return true;
    }
  } catch {
    /* file missing or unreadable */
  }

  return false;
}

/**
 * R57.3: check if a Node project has a given dep declared in package.json.
 * Looks at both `dependencies` and `devDependencies`. Match is exact-name.
 */
function hasNodeDep(projectDir: string, depName: string): boolean {
  const pkgPath = path.join(projectDir, 'package.json');
  try {
    const text = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.[depName] !== undefined) return true;
    if (pkg.devDependencies?.[depName] !== undefined) return true;
  } catch {
    /* file missing, unreadable, or invalid JSON */
  }
  return false;
}
