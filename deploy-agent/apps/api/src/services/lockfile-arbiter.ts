/**
 * Lockfile arbiter (R48)
 *
 * Vibe-coded Node 專案常常 lockfile 與 package manager 不對齊：
 *   - 開發者用 pnpm，CI 卻看到 stale `package-lock.json` 沒清掉
 *   - `package.json#packageManager` 宣告 pnpm，但只 commit 了 npm lockfile
 *   - 多種 lockfile 同時存在（merge conflict 殘渣）
 *
 * 過去 `project-detector.ts` 用單純的 if/else 鏈：bun → pnpm → yarn → npm。
 * 這套順序對「stale package-lock.json + 真實 pnpm 專案」會誤判成 npm，導致
 * Dockerfile 跑 `npm ci` → tsc/vite 二進位連結錯誤（典型的 luca-web 失敗）。
 *
 * 本模組是純 decider：讀專案目錄，回傳最佳猜測 + confidence + warnings。
 * 沒有 DB、沒有 network。所有 I/O 都在這裡，呼叫者 (project-detector) 只
 * 負責把 verdict 拼回 DetectionResult。
 */

import fs from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface LockfileVerdict {
  packageManager: PackageManager;
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable explanation for the log. */
  reason: string;
  /** Things to surface to the user (lockfile mismatch warnings, etc.) */
  warnings: string[];
}

interface LockfileEntry {
  /** Filename relative to projectDir */
  file: string;
  /** Package manager this lockfile belongs to */
  pm: PackageManager;
  /** mtime in ms since epoch */
  mtimeMs: number;
}

const LOCKFILE_TO_PM: Record<string, PackageManager> = {
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
};

/**
 * Decide which package manager to use for a project. Reads the project
 * directory only — no DB, no network. Returns the best guess plus
 * confidence + warnings.
 */
export function arbitrateLockfile(projectDir: string): LockfileVerdict {
  // 防禦：目錄不存在或讀不到 → 回 npm/low/沒 warnings
  if (!safeIsDir(projectDir)) {
    return {
      packageManager: 'npm',
      confidence: 'low',
      reason: 'project directory does not exist, defaulting to npm',
      warnings: [],
    };
  }

  // 收集存在的 lockfiles + mtime
  const lockfiles = collectLockfiles(projectDir);

  // 1. 檢查 package.json#packageManager（corepack 慣例）
  const declaredPm = readDeclaredPackageManager(projectDir);
  if (declaredPm.malformed) {
    // package.json 壞了 → 不阻斷，繼續走 lockfile 檢測，但 warn
    const verdict = decideByLockfilesOrDefault(lockfiles, projectDir);
    verdict.warnings.unshift('package.json is not valid JSON');
    return verdict;
  }
  if (declaredPm.pm) {
    const warnings: string[] = [];
    // 如果有 lockfile 但 PM 不一致 → warn
    const presentPms = new Set(lockfiles.map((l) => l.pm));
    if (presentPms.size > 0 && !presentPms.has(declaredPm.pm)) {
      const lockfileNames = lockfiles.map((l) => l.file).join(', ');
      if (declaredPm.pm === 'pnpm' && presentPms.has('npm')) {
        warnings.push(
          `package.json declares pnpm but only ${lockfileNames} found — install will likely fail; commit pnpm-lock.yaml`,
        );
      } else {
        warnings.push(
          `package.json declares ${declaredPm.pm} but lockfile(s) ${lockfileNames} are for a different package manager`,
        );
      }
    }
    return {
      packageManager: declaredPm.pm,
      confidence: 'high',
      reason: `package.json#packageManager declares ${declaredPm.pm}`,
      warnings,
    };
  }

  // 2. 檢查 pnpm-workspace.yaml / pnpm-workspace.yml
  const hasPnpmWorkspace =
    safeIsFile(path.join(projectDir, 'pnpm-workspace.yaml')) ||
    safeIsFile(path.join(projectDir, 'pnpm-workspace.yml'));
  if (hasPnpmWorkspace) {
    const warnings: string[] = [];
    const stalePackageLock = lockfiles.find((l) => l.pm === 'npm');
    if (stalePackageLock) {
      warnings.push(
        'stale package-lock.json should be removed (this is a pnpm workspace)',
      );
    }
    return {
      packageManager: 'pnpm',
      confidence: 'high',
      reason: 'pnpm-workspace.yaml present',
      warnings,
    };
  }

  // 3 & 4. 走 lockfile-based decision
  return decideByLockfilesOrDefault(lockfiles, projectDir);
}

// ───────────────────── internal logic ─────────────────────

function decideByLockfilesOrDefault(
  lockfiles: LockfileEntry[],
  _projectDir: string,
): LockfileVerdict {
  if (lockfiles.length === 0) {
    return {
      packageManager: 'npm',
      confidence: 'low',
      reason: 'no lockfile found, defaulting to npm',
      warnings: ['no lockfile present — builds will not be reproducible'],
    };
  }

  // 把 bun.lock + bun.lockb 視為「同一個 PM 的不同版本」，不算 conflict
  const distinctPms = new Set(lockfiles.map((l) => l.pm));

  if (distinctPms.size === 1) {
    // 單一 PM（即使有兩個 bun lockfile 也算）
    const pm = lockfiles[0].pm;
    if (lockfiles.length === 1) {
      return {
        packageManager: pm,
        confidence: 'medium',
        reason: `only ${lockfiles[0].file} lockfile present`,
        warnings: [],
      };
    }
    // 多個 lockfile 但同一個 PM（例如 bun.lock + bun.lockb）→ 用 newest
    const newest = lockfiles.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b));
    return {
      packageManager: pm,
      confidence: 'medium',
      reason: `multiple ${pm} lockfiles present, newest is ${newest.file}`,
      warnings: [],
    };
  }

  // 多種 PM lockfile → newest mtime 勝
  const sorted = [...lockfiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const winner = sorted[0];
  const losers = sorted.slice(1).filter((l) => l.pm !== winner.pm);

  const warnings = losers.map((loser) => {
    const dateStr = new Date(loser.mtimeMs).toISOString().slice(0, 10);
    return `stale ${loser.file} (last modified ${dateStr}), recommend removing`;
  });

  return {
    packageManager: winner.pm,
    confidence: 'high',
    reason: `${winner.file} lockfile is newest among ${lockfiles.length} candidates`,
    warnings,
  };
}

// ───────────────────── filesystem helpers ─────────────────────

function collectLockfiles(projectDir: string): LockfileEntry[] {
  const entries: LockfileEntry[] = [];
  for (const [filename, pm] of Object.entries(LOCKFILE_TO_PM)) {
    const full = path.join(projectDir, filename);
    const mtime = safeMtimeMs(full);
    if (mtime !== null) {
      entries.push({ file: filename, pm, mtimeMs: mtime });
    }
  }
  return entries;
}

interface DeclaredPmResult {
  pm: PackageManager | null;
  malformed: boolean;
}

function readDeclaredPackageManager(projectDir: string): DeclaredPmResult {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!safeIsFile(pkgPath)) return { pm: null, malformed: false };
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    return { pm: null, malformed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { pm: null, malformed: true };
  }
  if (!parsed || typeof parsed !== 'object') return { pm: null, malformed: false };
  const declared = (parsed as Record<string, unknown>).packageManager;
  if (typeof declared !== 'string' || declared.trim() === '') {
    return { pm: null, malformed: false };
  }
  // Format: "pnpm@8.15.0", "yarn@4.0.0", "npm@10.0.0", "bun@1.1.0"
  // 也接受沒帶 @version 的（例如 "pnpm"）
  const match = declared.match(/^(npm|pnpm|yarn|bun)(?:@.*)?$/);
  if (!match) return { pm: null, malformed: false };
  return { pm: match[1] as PackageManager, malformed: false };
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeMtimeMs(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}
