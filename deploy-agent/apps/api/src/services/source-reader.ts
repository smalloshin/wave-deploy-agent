// Source Reader
// ─────────────
// 把使用者程式碼的 context 餵給 LLM，讓診斷從「我猜不出來」升級到
// 「tsconfig 第 17 行寫 `moduleResolution: nodenext` 但 package.json 沒有 `"type": "module"`，
//  所以 TypeScript 認不得 `.js` extension import」這種精確的回答。
//
// 兩個進入點：
// 1. readSourceContextFromDir(projectDir, buildLog)  —— 本機有 projectDir 時（deploy-worker hot path）
// 2. readSourceContextFromGcs(gcsUri, buildLog)      —— 事後 reanalyze，從長期 bucket / 原始上傳 bucket 拉
//
// 兩條路徑最後都回傳同一個 SourceContext 物件，給 llm-analyzer 注入到 prompt。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gcpFetch } from './gcp-auth';

const execFileAsync = promisify(execFile);

// ─── Types ───

export interface SourceContext {
  /** 錯誤 log 裡提到的檔案 → 擷取錯誤行 ±50 行的程式碼片段 */
  filesNearError: Record<string, string>;
  /** 專案「指紋」檔案（package.json / tsconfig / Dockerfile / next.config 等），幫 LLM 判斷專案長相 */
  projectFingerprint: Record<string, string>;
  /** 讀了幾個檔、總 bytes，便於 log 觀察 */
  stats: { filesReadNearError: number; fingerprintFiles: number; totalBytes: number };
}

// 檔案大小上限（避免爆 token）
const MAX_SNIPPET_LINES_AROUND_ERROR = 50;        // 錯誤行前後各 50 行
const MAX_FINGERPRINT_BYTES = 4000;               // 每個 fingerprint 檔最多 4 KB
const MAX_FILES_NEAR_ERROR = 5;                   // 最多讀 5 個 error-adjacent 檔（避免 prompt 失控）
const MAX_SNIPPET_BYTES_PER_FILE = 3000;          // 每個 snippet 最多 3 KB

// 要當 fingerprint 的檔名清單（存在就讀）
const FINGERPRINT_CANDIDATES = [
  'package.json',
  'tsconfig.json',
  'Dockerfile',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.js',
  'nuxt.config.ts',
  'vite.config.js',
  'vite.config.ts',
  'svelte.config.js',
  'astro.config.mjs',
  'remix.config.js',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'composer.json',
];

// ─── Error-location extraction ───

/**
 * 從 build log 解析「檔案:行號」的 pattern。
 * 能匹配：
 *   - src/app/foo.ts:47:5
 *   - ./src/app/foo.ts(47,5)
 *   - /workspace/src/app/foo.ts:47
 *   - error TS2345: Argument of type ... at src/foo.ts:10
 *
 * 回傳 unique 的 { file, line } 清單，照在 log 中出現順序（錯誤通常在尾端 → reverse）
 */
export function extractErrorLocations(buildLog: string): Array<{ file: string; line: number }> {
  if (!buildLog || buildLog.trim().length === 0) return [];

  // 只看 log 尾端（錯誤通常在尾端 8 KB 內）
  const tail = buildLog.length > 8000 ? buildLog.slice(-8000) : buildLog;

  // 支援多種格式：
  //   path/to/file.ext:line[:col]
  //   path/to/file.ext(line,col)
  //   path/to/file.ext:line
  // 允許 ./ 前綴、/workspace/ 前綴、windows 風格就算了（Cloud Build 是 linux）
  const patterns = [
    // file.ts:47:5 or file.ts:47
    /([\w./\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|swift|vue|svelte|html|css|scss)):(\d+)(?::\d+)?/g,
    // file.ts(47,5)
    /([\w./\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|swift|vue|svelte|html|css|scss))\((\d+),\d+\)/g,
  ];

  const locations: Array<{ file: string; line: number }> = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(tail)) !== null) {
      const rawFile = match[1];
      const line = parseInt(match[2], 10);
      if (!rawFile || !Number.isFinite(line) || line <= 0) continue;

      // 濾掉 node_modules、.next、dist 這些 build artefact 裡的路徑
      if (/\/node_modules\//.test(rawFile)) continue;
      if (/\/\.next\//.test(rawFile)) continue;
      if (/\/dist\//.test(rawFile)) continue;
      if (/\/build\//.test(rawFile)) continue;

      // 濾掉系統路徑
      if (rawFile.startsWith('/usr/') || rawFile.startsWith('/opt/')) continue;

      // Normalize：去掉 /workspace/ 或 ./ 前綴
      let file = rawFile;
      if (file.startsWith('/workspace/')) file = file.slice('/workspace/'.length);
      if (file.startsWith('./')) file = file.slice(2);

      const key = `${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ file, line });

      if (locations.length >= MAX_FILES_NEAR_ERROR * 3) break; // 蒐集超收，後面 dedupe + 取前 N
    }
  }

  // 反轉：錯誤通常出現在尾端，更尾端的通常是根本原因
  return locations.reverse().slice(0, MAX_FILES_NEAR_ERROR);
}

// ─── Local filesystem reader ───

/**
 * 從本機 projectDir 讀 fingerprint + error-adjacent snippets。
 * projectDir 不存在就回 empty context。
 */
export async function readSourceContextFromDir(
  projectDir: string,
  buildLog: string,
): Promise<SourceContext> {
  const empty: SourceContext = {
    filesNearError: {},
    projectFingerprint: {},
    stats: { filesReadNearError: 0, fingerprintFiles: 0, totalBytes: 0 },
  };

  if (!projectDir || !existsSync(projectDir)) return empty;

  const filesNearError: Record<string, string> = {};
  const projectFingerprint: Record<string, string> = {};
  let totalBytes = 0;

  // 1. Fingerprint 檔（淺層掃 —— 只看 root）
  for (const name of FINGERPRINT_CANDIDATES) {
    const fullPath = join(projectDir, name);
    if (!existsSync(fullPath)) continue;
    try {
      const content = await readFile(fullPath, 'utf8');
      const truncated = content.length > MAX_FINGERPRINT_BYTES
        ? content.slice(0, MAX_FINGERPRINT_BYTES) + `\n... (truncated, total ${content.length} bytes)`
        : content;
      projectFingerprint[name] = truncated;
      totalBytes += truncated.length;
    } catch (err) {
      console.warn(`[SourceReader] Failed to read ${fullPath}: ${(err as Error).message}`);
    }
  }

  // 2. Error-adjacent snippets
  const locations = extractErrorLocations(buildLog);
  for (const { file, line } of locations) {
    // 防 path traversal：只允許相對路徑，解析後必須還在 projectDir 裡
    if (isAbsolute(file) && !file.startsWith(projectDir)) continue;
    const resolved = isAbsolute(file) ? file : resolve(projectDir, file);
    if (!resolved.startsWith(resolve(projectDir))) continue;
    if (!existsSync(resolved)) continue;

    try {
      const stat = statSync(resolved);
      if (stat.size > 200_000) continue; // 太大不讀，避免暴走
      const content = await readFile(resolved, 'utf8');
      const snippet = extractSnippetAroundLine(content, line, MAX_SNIPPET_LINES_AROUND_ERROR);
      const truncated = snippet.length > MAX_SNIPPET_BYTES_PER_FILE
        ? snippet.slice(0, MAX_SNIPPET_BYTES_PER_FILE) + '\n... (snippet truncated)'
        : snippet;
      filesNearError[`${file}:${line}`] = truncated;
      totalBytes += truncated.length;
    } catch (err) {
      console.warn(`[SourceReader] Failed to read snippet from ${resolved}:${line}: ${(err as Error).message}`);
    }
  }

  return {
    filesNearError,
    projectFingerprint,
    stats: {
      filesReadNearError: Object.keys(filesNearError).length,
      fingerprintFiles: Object.keys(projectFingerprint).length,
      totalBytes,
    },
  };
}

// ─── GCS tarball reader ───

/**
 * 從 GCS 上的 tarball 拉 source 回 /tmp，解壓後讀 fingerprint + snippets。
 * 失敗（下載 403、tarball 壞掉等）就回 null，不要讓 LLM 分析整個崩掉。
 * 會自動清理 /tmp 的暫存目錄。
 */
export async function readSourceContextFromGcs(
  gcsUri: string | null | undefined,
  buildLog: string,
): Promise<SourceContext | null> {
  if (!gcsUri || !gcsUri.startsWith('gs://')) return null;

  const tmpDir = join(tmpdir(), `src-reader-${randomBytes(6).toString('hex')}`);
  const tarballPath = `${tmpDir}.tgz`;

  try {
    await execFileAsync('mkdir', ['-p', tmpDir], { timeout: 5_000 });

    // Download
    const withoutPrefix = gcsUri.slice(5);
    const slashIdx = withoutPrefix.indexOf('/');
    const bucket = withoutPrefix.slice(0, slashIdx);
    const object = withoutPrefix.slice(slashIdx + 1);
    const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;

    const resp = await gcpFetch(downloadUrl);
    if (!resp.ok) {
      console.warn(`[SourceReader] GCS download failed (${resp.status}): ${gcsUri}`);
      return null;
    }
    const tgz = Buffer.from(await resp.arrayBuffer());

    const { writeFileSync } = await import('node:fs');
    writeFileSync(tarballPath, tgz);
    await execFileAsync('tar', ['xzf', tarballPath, '-C', tmpDir], { timeout: 60_000 });

    // Read from the extracted dir (re-use the local path reader)
    const ctx = await readSourceContextFromDir(tmpDir, buildLog);
    console.log(`[SourceReader] GCS tarball read: ${ctx.stats.filesReadNearError} snippets + ${ctx.stats.fingerprintFiles} fingerprint files (${ctx.stats.totalBytes} bytes)`);
    return ctx;
  } catch (err) {
    console.warn(`[SourceReader] Failed reading ${gcsUri}: ${(err as Error).message}`);
    return null;
  } finally {
    // 清理
    try { await execFileAsync('rm', ['-rf', tmpDir, tarballPath], { timeout: 10_000 }); } catch { /* ignore */ }
  }
}

// ─── Helpers ───

/**
 * 擷取某行前後 N 行的程式碼片段，行號從 1 開始。
 * 回傳格式：
 *   42 |   import foo from 'bar';
 *   43 |   function baz() {
 *   44 > |     return foo.qux();  ← 錯誤這行（用 > 標示）
 *   45 |   }
 */
function extractSnippetAroundLine(content: string, errorLine: number, contextLines: number): string {
  const lines = content.split('\n');
  const start = Math.max(0, errorLine - 1 - contextLines);
  const end = Math.min(lines.length, errorLine - 1 + contextLines + 1);
  const width = String(end).length;

  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const ln = i + 1;
    const marker = ln === errorLine ? '>' : ' ';
    out.push(`${String(ln).padStart(width, ' ')} ${marker}| ${lines[i] ?? ''}`);
  }
  return out.join('\n');
}

// ─── Format for LLM prompt ───

/**
 * 把 SourceContext 序列化成給 LLM prompt 用的純文字區塊。
 * 完全空（沒讀到任何東西）回空字串，caller 應該自己判斷要不要串進 prompt。
 */
export function formatSourceContextForPrompt(ctx: SourceContext | null): string {
  if (!ctx) return '';

  const parts: string[] = [];

  if (Object.keys(ctx.projectFingerprint).length > 0) {
    parts.push('【專案設定檔】');
    for (const [name, content] of Object.entries(ctx.projectFingerprint)) {
      parts.push(`--- ${name} ---\n${content}`);
    }
  }

  if (Object.keys(ctx.filesNearError).length > 0) {
    parts.push('\n【錯誤位置附近的程式碼】');
    for (const [location, snippet] of Object.entries(ctx.filesNearError)) {
      parts.push(`--- ${location} ---\n${snippet}`);
    }
  }

  return parts.join('\n\n');
}
