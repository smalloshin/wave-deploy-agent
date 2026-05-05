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
