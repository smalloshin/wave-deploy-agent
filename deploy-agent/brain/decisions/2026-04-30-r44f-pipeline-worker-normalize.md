# R44f — pipeline-worker 在 GCS 重抓路徑也要做 normalize + wrapper-dir descent + AI fix path 淨化

**日期**：2026-04-30
**狀態**：Active
**Round**：44f（接續 R44b/c/d/e）

## Context

R44 saga 為了把 legal-flow（一個 426 MB Windows-zipped Next.js + Prisma + SQLite vibe-coded 專案）跑完整條 pipeline，從 R44a 一路打補丁。前面 R44b/c/d/e 都收得差不多了，但 legal-flow 跑到第 4 步 LLM Threat Analysis 之後，下一輪自動 build 還是會炸，原因是 pipeline-worker 自己有兩個漏洞，前面 round 沒掃到。

**漏洞 1：GCS 重抓 source 的路徑沒 normalize、也沒 descend wrapper-dir。**

`pipeline-worker.ts` 的 Step 0（行 73–118）會在 `projectDir` 不存在時從 GCS 拉 tarball 重抓——這條路徑只在 Cloud Run 換 revision 後才會跑（因為 `/tmp` 是 ephemeral，舊 source 隨 revision 一起蒸發）。問題是：

- `submit-gcs`（`routes/projects.ts:647-654`）和 `new-version`（`routes/versioning.ts:213`）都會在 unzip 之後 inline 做 `normalizeExtractedPaths` + 「單一 wrapper-dir 就 descend」這兩件事。
- 但 pipeline-worker 的重抓路徑是直接 `tar xzf` 完就算了，**沒 normalize 也沒 descend**。
- 結果：`fixed.tgz` 被打包時連 `legal_flow/` 包裹層一起進去，Linux Alpine BusyBox 解壓後又留下一堆 `legal_flow\xxx` 反斜線檔名混在 root。下游 `project-detector` 看不到 `package.json`，回 `language: 'unknown'`，整條 pipeline 就在 Step 1 死掉。

**漏洞 2：AI fix step 拿 LLM 吐回來的 `fix.filePath` 直接 `path.join(projectDir, fix.filePath)`，沒淨化。**

`pipeline-worker.ts:207`：

```ts
const filePath = join(projectDir, fix.filePath);
```

LLM（無論是 GPT-5.5 還是 Claude）有時候會吐回來：

- `legal_flow\src\auth.ts`（Windows 反斜線）→ POSIX `path.join` 不認 `\` 是分隔符，會在 `projectDir` root 建一個叫 `legal_flow\src\auth.ts` 的字面檔名
- `legal_flow/src/auth.ts`（已經 descend 進 `legal_flow/` 之後 LLM 又把 wrapper 名字回吐）→ 找不到檔，fix 失敗
- `../etc/passwd`（極端情況）→ path traversal 風險

現有 code 沒任何防線。R44d 的 `archive-normalizer` 只處理 extractDir top level 的反斜線檔名，不管 LLM 自己吐什麼。

## Decision

把 R44d 的 `archive-normalizer.ts` 擴成包含三個 helper：原本的 `normalizeExtractedPaths` 留著不動，再加：

### 1. `descendIntoWrapperDir(extractDir: string): string`

純路徑 resolver，不動檔案：

- 讀 `extractDir` 直接 children
- 過濾掉 dotfile（`.git`、`.DS_Store`）和 `__MACOSX`（macOS zip 噪音）
- 如果剩下**剛好 1 個** entry 而且是 directory
- 而且該 dir 含 PROJECT_MARKERS 任一個（`package.json` / `Dockerfile` / `requirements.txt` / `go.mod` / `pom.xml` / `Cargo.toml` / `build.gradle` / `Gemfile` / `composer.json`）
- 則回傳該子目錄路徑；否則回傳 `extractDir` 不變

語意上等同 `routes/projects.ts:647-654` 和 `routes/versioning.ts:213` 既有的 inline logic，純化成可重用 helper。

### 2. `sanitizeRelativePath(input, options?: { wrapperDirName?: string }): string | null`

純字串 helper（不碰 fs），給 LLM-emitted `fix.filePath` 用：

依序：

1. 反斜線 → 正斜線（`legal_flow\src\app.ts` → `legal_flow/src/app.ts`）
2. 剝 Windows drive letter prefix（`C:/...` 或 `D:/...`）
3. 剝 leading `/`
4. 剝 leading `./`（重複多次）
5. 如果 caller 給了 `wrapperDirName` 且字串以 `<name>/` 開頭，剝掉

**拒絕條件**（回傳 `null`）：

- 空字串、`null`、`undefined`、純空白
- 任一 segment 為 `..` 或 `.`（path traversal 守衛）
- 任一 empty segment（`a//b`）
- 字串等於 wrapperDirName 本身（光禿禿的 wrapper 名字、沒有後續路徑可指）

### 3. pipeline-worker.ts 兩處接線

**Step 0（GCS 重抓路徑，行 116 之後）**：

```ts
execFileSync('tar', ['xzf', tgzPath, '-C', projectDir], { ... });
const normResult = await normalizeExtractedPaths(projectDir);
const descended = descendIntoWrapperDir(projectDir);
if (descended !== projectDir) {
  wrapperDirName = basename(descended);
  projectDir = descended;
}
```

`wrapperDirName` 是新加的 local `let`，給後面 AI fix step 用。warm path（projectDir 已存在、是 submit-gcs 早就 descend 過）不會跑這段，wrapperDirName 維持 `undefined`，sanitize 時不會誤剝。

**Step 5（AI fix loop，行 207）**：

```ts
const sanitized = sanitizeRelativePath(fix.filePath, { wrapperDirName });
if (!sanitized) {
  autoFixResults.push({ applied: false, diff: '', explanation: `Rejected unsafe filePath: ${fix.filePath}`, ... });
  continue;
}
const filePath = join(projectDir, sanitized);
```

不再無條件 `join(projectDir, raw)`。被拒絕的 fix 進 `autoFixResults` 標 `applied: false`，跟「找不到 originalCode」走同一條鏈，不影響其他 fix。

## Verification

`apps/api/src/test-archive-normalizer.ts` 從 50 個測試擴到 **96 個 zero-dep 測試**：

- 原 50 個 `normalizeExtractedPaths` 測試不動
- 新增 `descendIntoWrapperDir` 測試：marker / no-marker / multi-children / file-only / hidden-ignored / empty / nonexistent / 9 種 marker 各測一次
- 新增 `sanitizeRelativePath` 測試：反斜線、leading `/`、drive letter、`./`、wrapper prefix、path traversal（5 變體）、empty/null/undefined、happy path、combined transformations

所有測試以 `os.tmpdir()` 真檔案系統跑，`=== 96 passed, 0 failed ===`。`tsc --noEmit` 無錯誤。

## Consequences

**好處**：
- legal-flow 下一次自動 deploy 不會在 Step 1 因 `language: 'unknown'` 而死
- LLM 吐回 `legal_flow\xxx` 不會再在 projectDir root 留一堆字面反斜線檔名
- Path traversal 從一個原本沒護欄的 callsite 補上守衛
- `archive-normalizer.ts` 成為「extract 後處理」的單一可信來源；以後任何新增 unzip path 都應該照同樣 normalize+descend 模式

**代價**：
- pipeline-worker 多兩個 import + 一個 local `let wrapperDirName`
- AI fix loop 多一個 sanitize 失敗分支（被拒絕的 fix 不會試）
- 既有 routes（projects.ts / versioning.ts）的 inline descend logic **沒** 重構成呼叫 `descendIntoWrapperDir`——這是刻意保守，避免 R44 saga 還在打補丁時順手改更多東西。下次 round 可以收斂，但不在這 round。

**風險**：
- 如果 `wrapperDirName` 被誤判（例如使用者真的把專案叫做 `legal_flow` 並把所有檔放在 `legal_flow/legal_flow/...` 下），sanitize 會剝錯一層。實務上機率近零，且失敗模式是「找不到檔」而非「寫到危險路徑」，安全可接受。
