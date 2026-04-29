# 2026-04-28 — archive-normalizer：修 Windows zip 反斜線路徑

## Status

Active

## Context

vibe-coded 使用者用 Windows（7-Zip / WinRAR / Explorer Send to）打包 source zip，會在 zip header 寫成 `legal_flow\package.json` 這種反斜線分隔。

跨平台 unzip 處理方式不同：
- **macOS Info-ZIP**：自動把 `\` 轉成 `/` 還原成正常 subdir
- **Linux/Alpine BusyBox unzip**（我們 Cloud Run base image 用的）：保留反斜線當合法檔名字元，把整段 `legal_flow\package.json` 當成 root 下的單一檔名

接著 `apps/api/src/services/project-detector.ts` 在 detect 階段用 `path.basename(filename)` 取檔名 → POSIX `path.basename` 不認反斜線當分隔符 → `path.basename('legal_flow\\package.json')` 直接回傳整個字串 → `fileNames.has('package.json')` 永遠 false → 沒有 manifest → `language: 'unknown'`。

submit-gcs flow 看到 `unknown` 就丟 `Unsupported language: unknown`，project 直接 `failed`。

實例：legal-flow 426 MB zip 過了 R44b/R44c 的 GCS upload + tar 修復，最終卡在這條 detector 路徑（project `493dacee-103b-4893-b771-745d882369ce`）。

## Decision

新增 `apps/api/src/services/archive-normalizer.ts`，在 unzip 完成後立刻掃 extract dir，把 root 下含反斜線的檔名 rename 成正常 subdir 結構。

核心 API：

```typescript
export interface NormalizeResult {
  scanned: number;
  renamed: number;
  collisions: number;
  blocked: number;
  samples: Array<{ from: string; to: string }>;
}

export async function normalizeExtractedPaths(
  extractDir: string,
): Promise<NormalizeResult>;
```

行為與 guard：
1. 只看 root 層，遇到含 `\` 的 entry：
   - 是 dir 跳過（避免 mkdir/rename 撞到本身）
   - 是 file → `entry.replace(/\\/g, '/')` 算新路徑
2. **path traversal guard**：resolve 後如果跑出 extractDir 外（例如 `..\..\etc\passwd`）→ 計入 `blocked`，不 rename
3. **collision guard**：目標已存在 → 計入 `collisions`，不蓋
4. **idempotent**：再跑一次 scan 仍找不到帶反斜線的檔，`renamed=0`
5. 回傳 `samples` 上限 5 筆 from/to，方便 audit log

接線：`apps/api/src/routes/projects.ts` 兩個 unzip 點都 call 一次：
- submit-gcs flow（GCS source 解壓後）
- multipart upload flow（streamed zip 解壓後）

ZIP 之外（tar.gz / git clone）路徑不需要這個處理，因為 `tar` 不會生反斜線檔名。

## 測試

`apps/api/src/test-archive-normalizer.ts` 50 個 zero-dep 測試（用 `os.tmpdir()` 真 fs operations，跟 R39-R43 wire-contract lock pattern 一致）：
- backslash-basic（8）：基本 rename + 多檔
- clean-zip（6）：沒反斜線 → noop
- traversal（4）：`..\` / `..\..\` 各種 reject
- collision（4）：目標存在 / 連續重複名字
- idempotent（4）：跑兩次第二次 renamed=0
- samples（7）：上限 5、shape 對
- empty/nonexistent（4）：dir 空 / dir 不存在
- backslash-dir（2）：root dir 名字含 `\` 不動它
- mixed（5）：好 + 壞 entries 混合
- shape（6）：return type 完整

Output 格式 `=== 50 passed, 0 failed ===` 跟 `scripts/sweep-zero-dep-tests.sh` Format A 一致，自動加進 cumulative sweep。

## Consequences

### 好處

- **解掉 Windows zip 在 Linux 環境失敗的整類問題**：未來不只 detector，所有後續步驟（codescan、Dockerfile gen、build context）看到的都是正常 subdir
- **零 dep**：純 fs/promises，沒有新加 npm package
- **安全**：path traversal + collision guard 在 unit test 都覆蓋
- **可觀察**：normalize 結果寫進 request log（`renamed > 0` 時），audit 看得到

### 代價

- **多一次 root-level readdir**：對乾淨 zip 是 ~ms 級開銷，可忽略
- **沒處理 nested 反斜線**：如果 `legal_flow/sub\dir/file.js` 第二層才出現反斜線，目前不掃。實務上 7-Zip / WinRAR 不會這樣產出（要嘛全 `/` 要嘛全 `\`），但若未來踩到要再開 R44d-recursive
- **沒覆蓋 tar.gz**：tar 用 `/` 分隔不會踩這坑，但若未來支援 7z / rar 或某些奇怪打包工具，需要再延伸

## 相關決策

- 上游：R44b（execFileAsync timeout 60s → 600s，修 trans-Pacific upload）
- 下游：R44e（pipeline-worker.ts 的 execFileSync sites R44b 漏掉的，timeout 30s/60s → 600s）
- 後續可能：R44c-stream（submit-gcs streaming 改寫，避免 memory 跟檔案大小同比）

## Round saga 完整時間軸

```
R44   2026-04-27  GCS download → tar bundle → upload to Cloud Build 全鏈路出錯
R44b  2026-04-28  routes/projects.ts execFileAsync timeout 60s → 600s + maxBuffer 100MB
R44c  2026-04-28  submit-gcs validation + structured error codes
R44d  2026-04-28  archive-normalizer.ts（this ADR）
R44e  2026-04-28  pipeline-worker.ts execFileSync sites timeout 30s/60s → 600s
```
