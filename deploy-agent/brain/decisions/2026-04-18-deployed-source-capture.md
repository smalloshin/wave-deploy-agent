# 2026-04-18 — Deployed Source Capture（吐回部署版）

## Context

wave-deploy-agent 的核心價值是 **vibe-coded 專案的安全閘門**：掃描 + AI 自動修補 + 部署。
但修補過的 code 只活在 deploy-worker 的 `/tmp/projectDir`，deploy 成功後整棵 dir 被 cleanup 掉。

使用者本機的原始碼依然含漏洞，下次升版會：

1. 上傳一樣有漏洞的 code
2. 再次被掃到、再次被修
3. 永遠不知道「修過」長什麼樣子

更糟的是，我們自動產生的 Dockerfile（對 vibe-coded 專案來說這通常是整個容器化的關鍵）
也沒回流給使用者。沒有這份 Dockerfile，使用者無法在本地測試、無法 reproduce CI。

**目標**：每次成功部署後，把「實際部署的 code snapshot（含 AI 修補 + 生成的 Dockerfile）」
存起來，讓使用者一鍵下載，從安全基準繼續開發。

## Decision

實作 Phase 1 「GCS-backed snapshot + dashboard download」：

- **Bucket**：`gs://wave-deploy-agent-deployed`
  - Lifecycle rule：365 天自動刪除
  - 路徑：`{slug}/v{version}.tgz`
  - 服務帳號 `deploy-agent@` 有 `roles/storage.objectAdmin`
- **Capture 時機**：deploy-worker Step 4b，在 Cloud Run deploy 成功、DB 更新後
  - 資料來源優先 `projectDir`（含 post-fix 內容）
  - Fallback 抓 `gcsSourceUri`（原始上傳，無修補，但至少有東西）
  - 失敗是 non-fatal — capture 出錯不會破壞 deploy
- **Manifest**：tarball 內自動注入 `DEPLOYMENT.md`，內容包含
  - 部署時間、Cloud Run URL、Docker image、revision、AI 修補數
  - 本地執行指令（`docker build && docker run`）
  - 重新部署指令
  - 「如果是 fallback 到 gcsSourceUri，會顯示不同訊息提醒使用者」
- **DB**：`deployments.deployed_source_gcs_uri TEXT`（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）
- **下載 API**：`GET /api/projects/:id/versions/:deployId/download`
  - 產生 15 分鐘 V4 signed URL（IAM Credentials `signBlob` API — Cloud Run 沒有 gcloud CLI）
  - 權限：`versions:read`
- **Dashboard**：project detail 頁版本列表多一顆「下載部署版」按鈕，只有當 `deployedSourceGcsUri` 存在時才顯示
- **i18n**：zh-TW + en 翻譯同步加入

## Consequences

### 好處

1. **安全迴圈閉合**：使用者可以從 wave-deploy-agent 修過的版本繼續開發，不會一直重新引入一樣的漏洞
2. **Dockerfile 回流**：使用者第一次看到自動生成的 Dockerfile，可以納入自己 repo
3. **審計軌跡**：每個部署版本有完整 snapshot，事後可以 diff 哪行被 AI 改掉
4. **Rollback 不只是 traffic switch**：除了切 Cloud Run revision，還能「把當時的 code 下回本機」

### 代價

1. **GCS 儲存成本**：每個部署多一份 tarball。單 tarball 預估 1–50 MB，365 天 retention，
   合理專案（每專案累計 ~50 個部署）約 500 MB–2.5 GB — 成本可忽略
2. **Pipeline 多一步**：deploy-worker 增加 capture 步驟，但只在 deploy 成功後跑 + non-fatal
3. **Latent bug（尚未修）**：pipeline-worker 套 AI 修補到本機 `projectDir`，但 **deploy-engine
   用的是 `gcsSourceUri`（原始上傳版）**。build 時 Cloud Build 拿到的其實是未修補的 code。
   目前我們的 capture 用 `projectDir`（有修補），所以**使用者下載的和 Cloud Build 實際建構的
   不完全一致** — 這是 capture 階段發現的舊 bug，已 flag 為獨立待辦修正。

### Phase 2（暫緩）

- 同步把 snapshot push 到 GitHub（per-project repo）做正式版控
- Diff view：在 dashboard 顯示 v1 vs v2 哪些檔案被 AI 改了

## Addendum — 2026-04-18（同日）latent bug 修復

原本 Phase 1 上線時留了一個 flag：pipeline-worker 把 AI 修補 + 生成的
Dockerfile 寫進本機 `projectDir`，但 `deploy-engine.buildAndPushImage()`
用的是 `project.config.gcsSourceUri`（原始上傳版）當 Cloud Build source，
所以修補從來沒進 Docker image。

修法（commit `3c9d91b`）：

1. **pipeline-worker Step 6a**：在 Auto-Fix + Verification Scan 之後，
   重新 tar `projectDir` 上傳到 `gs://{bucket}/sources-fixed/{slug}-{ts}.tgz`，
   把 URI 寫到 `project.config.gcsFixedSourceUri`（jsonb merge，
   保留其他欄位）。非 fatal — 上傳失敗時 warn 但不中斷 pipeline。
2. **deploy-worker**：`buildAndPushImage` 拿的 URI 現在是
   `gcsFixedSourceUri ?? gcsSourceUri`。Dockerfile port-detection fallback 也一樣。
3. **versioning new-version endpoint**：使用者升版時清掉
   `gcsFixedSourceUri`（設為 `undefined`，JSON.stringify 會 drop），
   避免新一版走到舊的 fixed source。
4. **原始 `gcsSourceUri` 保留不動** — 做為 audit trail。
5. **Deployed Source Capture（Phase 1）** 本來就優先用 `projectDir`，
   所以三者現在完全一致：
   - Cloud Run 實際跑的 code ← `gcsFixedSourceUri`（有修補）
   - dashboard 下載的 tarball ← `projectDir`（有修補，和 fixed URI 內容相同）
   - `gcsSourceUri` ← 原始上傳，純 audit

### 驗證（等新 revision 上線後）

1. 上傳一個有 `password = 'hardcoded-secret'` 的專案，走 pipeline
2. 確認 `scan_report.auto_fixes` 有東西
3. 確認 `project.config.gcsFixedSourceUri` 有值
4. Deploy 後下載 snapshot，確認 `password = ...` 是修過的版本
5. `gcloud run services describe` 檢查 Cloud Run 實際 image 的 code 一致

## Status

Active
