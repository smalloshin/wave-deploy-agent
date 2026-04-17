# SESSION HANDOFF — wave-deploy-agent

> 每次新對話開始時讀這份檔案，結束前更新它。

## 上次進度（Last Progress）

**2026-04-18（晚上）—— 修 pipeline → deploy 的 fix 遺失 bug**

Phase 1 上線後同一天把 flag 的 latent bug 修掉了。原問題：pipeline-worker 修的
`projectDir`（AI 修補 + 生成的 Dockerfile）根本沒上傳回 GCS，deploy-engine
用的還是原始 `gcsSourceUri`，所以修補從來沒進 Docker image。

實作（commit `3c9d91b`）：

- ✅ **pipeline-worker Step 6a**：Auto-Fix 完後 tar `projectDir` →
  `gs://{bucket}/sources-fixed/{slug}-{ts}.tgz` → URI 寫到
  `project.config.gcsFixedSourceUri`（jsonb merge）。非 fatal，上傳失敗 warn 不中斷
- ✅ **deploy-worker**：`buildAndPushImage` 的 gcsSourceUri 變成
  `gcsFixedSourceUri ?? gcsOriginalSourceUri`；port-detection fallback 同樣
- ✅ **versioning new-version**：升版時 `gcsFixedSourceUri = undefined`
  （JSON.stringify 會 drop 這個 key）避免用到舊的 fixed source
- ✅ **ProjectConfig.gcsFixedSourceUri** 加到 shared types
- ✅ 原始 `gcsSourceUri` 保留做 audit trail
- ✅ Cloud Build 手動提交中
- ✅ 決策檔補 Addendum 章節

**2026-04-18 —— Deployed Source Capture（吐回部署版 Phase 1）**

核心動機：使用者修完安全漏洞 + AI 幫他產 Dockerfile 後，這些成果只活在我們
deploy-worker 的 `/tmp` 裡，deploy 完就被清掉。使用者本機還是原始有漏洞的版本，
導致下次升版重走一樣的修補流程、看不到 AI 改了什麼、也拿不到自動生成的 Dockerfile。

實作（端到端，typecheck 全過）：

- ✅ **GCS bucket 建立**：`gs://wave-deploy-agent-deployed`（365 天 lifecycle），
  `deploy-agent@` SA 有 `storage.objectAdmin`
- ✅ **DB schema**：`deployments.deployed_source_gcs_uri TEXT`（`ADD COLUMN IF NOT EXISTS`
  idempotent migration）
- ✅ **shared types**：`Deployment.deployedSourceGcsUri: string | null`
- ✅ **新 service `deployed-source-capture.ts`**：
  - `captureDeployedSource(metadata, projectDir, gcsSourceUri)` — 優先 tar `projectDir`
    （post-fix 版），fallback 抓 `gcsSourceUri`（原始上傳版）
  - 自動注入 `DEPLOYMENT.md`：部署時間、Cloud Run URL、image、revision、修補數、
    本地跑法、重新部署指令
  - `generateDownloadSignedUrl()` — 先試 `gcloud storage sign-url`，失敗走 V4 signing
    via IAM Credentials `signBlob`（Cloud Run 容器沒有 gcloud CLI 的 fallback）
- ✅ **deploy-worker Step 4b**：deploy 成功 + DB 更新後呼叫 capture，**non-fatal**
  包在 try/catch 裡，capture 失敗不影響 deploy
- ✅ **新 endpoint**：`GET /api/projects/:id/versions/:deployId/download`
  → 回傳 15 分鐘 signed URL + 檔名 + 過期時間
- ✅ **權限**：`versions:read`（和 list versions 一致）
- ✅ **Dashboard UI**：project detail 版本列表多「下載部署版」outline 按鈕，
  只有 `deployedSourceGcsUri` 存在時才顯示；用 anchor `<a download>` 觸發瀏覽器下載
- ✅ **i18n**：`downloadSource` + `downloadSourceHint` 加到 zh-TW 和 en
- ✅ **commit 1681c7c**，Cloud Build 手動提交中（SHORT_SHA=$(date +%s) 繞過 Git trigger 缺失）
- ✅ **決策檔**：`decisions/2026-04-18-deployed-source-capture.md`

⚠️ **Latent bug 發現（未修，flag 到後續）**：
pipeline-worker 套用 AI 修補到本機 `/tmp/projectDir`，但 **deploy-engine 拿的是
原始 `gcsSourceUri`（Cloud Build 用它做 build context）**。意味著 AI 修補其實**沒有**
進入 Docker image。目前 capture 優先用 `projectDir`（有修補），所以「使用者下載的」
和「Cloud Build 實際建構的」不完全一致。Phase 2 要讓 pipeline-worker 修完後
re-upload 覆蓋 gcsSourceUri，或直接改成 build 拿 projectDir。

**2026-04-14（下午）—— 全部 TODO 完成 + QA**

- ✅ **Cloud Build 0742969e 部署成功**（API + Web + Bot 全部更新）
  - MCP 12 工具全部上線（新增 get_versions, publish_version, rollback_version, toggle_deploy_lock）
  - GitHub Webhook endpoint 上線（POST /api/webhooks/github）
  - Webhook 設定 CRUD 上線（POST/GET/PATCH/DELETE /api/projects/:id/github-webhook）
  - /api/infra/overview 恢復正常（之前 404）
- ✅ **Dashboard i18n 實作完成**（commit a906e09）
  - next-intl 整合 App Router（i18n/request.ts + NextIntlClientProvider）
  - 248 個翻譯 key，9 個 namespace，zh-TW + en 完全對齊
  - 全部 8 個頁面改用 useTranslations() hook
  - TypeScript 0 errors，build 成功
- ✅ **cold-outreach-2 清理完成**（Cloud Run + image + DB 全刪）
- ✅ **QA 全部新功能通過**

**2026-04-14 —— Versioning Phase 3: GitHub Webhook 自動部署**

- ✅ **GitHub Webhook 自動部署功能完整實作**
  - **DB Schema**：projects 表新增 `github_repo_url`、`github_webhook_secret`、`github_branch`、`auto_deploy` 四個欄位（ALTER TABLE IF NOT EXISTS）
  - **Webhook Route**（`routes/webhooks.ts` 新檔）：
    - `POST /api/webhooks/github` — 接收 GitHub push event
    - HMAC-SHA256 簽名驗證（`X-Hub-Signature-256`，使用 `crypto.timingSafeEqual` 防 timing attack）
    - 支援 push / ping / delete 三種 event type
    - push 時：下載 GitHub tarball → 上傳 GCS → 解壓 → 觸發 pipeline（與 new-version 同流程）
    - 支援 monorepo（`serviceDirName` 偵測）
    - 目前僅支援公開 repo（TODO: 私有 repo 需 GitHub token）
  - **專案設定 API**（加到 `routes/projects.ts`）：
    - `POST /api/projects/:id/github-webhook` — 設定 webhook（生成隨機 secret）
    - `GET /api/projects/:id/github-webhook` — 取得設定（secret 遮罩）
    - `PATCH /api/projects/:id/github-webhook` — 切換 auto_deploy / 改 branch
    - `DELETE /api/projects/:id/github-webhook` — 移除設定
  - **Web UI**（`projects/[id]/page.tsx`）：
    - 未設定時：顯示 Repo URL + Branch 表單 + 「啟用自動部署」按鈕
    - 已設定時：顯示 Webhook URL（可複製）、遮罩 Secret、Branch、自動部署開關
    - 首次設定後顯示完整 Secret（僅一次，提示使用者複製）
    - 「移除 Webhook 設定」按鈕
  - **index.ts**：已註冊 webhookRoutes（有 try/catch 保護）

**2026-04-14 —— Discord Bot NL 部署完成 + QA**

- ✅ **Discord Bot 部署到 Cloud Run**（revision `deploy-agent-bot-00008-k9b`）
  - Image: `bot:bot1776093436`，512Mi / 1 CPU，min-instances=1，no-cpu-throttling
  - Secrets: DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID, ANTHROPIC_API_KEY, OPENAI_API_KEY
  - Health server on :8080, Bot Ready as wave deploy agent#9971, Guilds: 2
  - `[Bot] NL: enabled` — 自然語言功能已啟用
- ✅ **OpenAI GPT-4o-mini fallback** 已實作（`nl-handler.ts`）
  - `callLLM()` 統一介面：先嘗試 Claude Haiku，billing/credit 錯誤時自動 fallback GPT
  - GPT 回覆會附 ` (GPT)` 標籤，使用者可辨識
- ✅ **QA 通過**（Health Score: 86/100，0 console errors）
  - Web UI 7 個頁面全部正常載入
  - API endpoints: project-groups ✅, projects/:id ✅, versions ✅
  - Bot status: Running, NL enabled, 2 guilds connected
- 🐛 **發現 4 個 issues**（全部 deferred — 需重新部署 API 或使用者手動操作）：
  - ISSUE-001 (High): `/api/infra` route 404（API image 未含新 route）
  - ISSUE-002 (Medium): `/api/projects/:id` 缺少 latestDeployment 欄位（API 未部署）
  - ISSUE-003 (Medium): Discord Message Content Intent 未開啟
  - ISSUE-004 (Low): cold-outreach-2 顯示 Not Found

**2026-04-13（晚上）—— Versioning Phase 2 完成 + Discord Bot TODO**

- ✅ **Tagged Preview URL per revision**
  - 每次 deploy 後用 `tagRevision()` 為 revision 打 tag（`ver-N` 格式，Cloud Run 要求 3-47 字元）
  - 產生獨立 preview URL：`https://ver-6---service.a.run.app`，每個版本可以獨立預覽
  - UI 顯示 "Preview: v6 ↗" 可點擊連結（tagged），舊版顯示 "Preview URL ↗"
- ✅ **版本保留策略（Version Retention）**
  - deploy-worker 完成部署後自動檢查：超過 5 個版本時清理舊 revision（published 版本永不刪除）
  - 新增 `POST /api/projects/:id/versions/cleanup` 手動清理端點
  - `deleteRevision()` 新增到 deploy-engine.ts
- ✅ **Canary 失敗自動 Rollback**
  - deploy-worker 的 canary 從 advisory 改成 blocking + auto-rollback
  - canary 失敗時：自動找到上一個 published version，用 `publishRevision()` 切回流量
  - 首次部署（無 rollback 目標）：仍然 go live with warnings
- ✅ **Bug fixes**：
  - `tagRevision` 400（tag 長度 < 3）→ `v5` 改 `ver-5` 格式
  - `tagRevision` 400（`latestRevision: true` 格式不相容）→ 轉成 `TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST`
  - `rollbackService` 400（缺少 traffic `type` 欄位）→ 同步修復
  - versioning routes 404（deploy 後偶爾新 revision 還在切）→ 加 explicit error handling 到 index.ts
- 📝 **新增 Discord Bot TODO**（使用者要求）

**2026-04-13（下午）—— Versioning 完整 QA + Bug Fix**

- ✅ **修復 versioning routes 404 bug（CRITICAL）**
  - 根因：`projectRoutes` plugin 超過 1600 行，尾端的 versioning routes 在某些 Cloud Run revision 上不會註冊
  - 修法：拆分成獨立 `routes/versioning.ts` plugin，在 `index.ts` 單獨註冊
  - 結果：連續 3 次部署都穩定註冊，不再 intermittent 404
- ✅ **修復 `publishRevision` 400 bug**
  - 根因：Cloud Run v2 API 的 traffic target 需要 `type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'`
  - 修法：在 `deploy-engine.ts` 的 traffic 物件加上 `type` 欄位
- ✅ **修復 `isRollback` 永遠 false bug**
  - 根因：`publishDeployment()` 更新 DB 後再查 `getPublishedDeployment()` 回傳的已是新版
  - 修法：先查 `previousPublished`，再呼叫 `publishDeployment()`
- ✅ **完整 E2E QA 通過**（Publish v3 → Rollback v2 → isRollback=true → UI 驗證）
  - GET /versions: 200, 3 個版本正確
  - POST /deploy-lock: 200, toggle 雙向正確
  - POST /new-version: 201, pipeline 完整跑完 → v3 live
  - POST /publish (forward): 200, isRollback=false
  - POST /publish (rollback): 200, isRollback=true
  - POST /publish (no revision): 400, 正確拒絕
  - UI: version history 綠色高亮 LIVE 版本, deploy lock 紅色按鈕, 部署資訊只顯示最新 1 筆

**2026-04-13 —— Netlify-like 版本管理 Phase 1 完成**

- ✅ **完整實作 Netlify-like 版本管理系統**（決策：`decisions/2026-04-13-netlify-like-versioning.md`）
  - 利用 Cloud Run Revision 機制：每次部署 = immutable snapshot，一鍵 publish/rollback
  - DB schema：deployments 表新增 version / image_uri / revision_name / preview_url / is_published / published_at；projects 表新增 published_deployment_id / deploy_locked
  - **deploy-engine.ts**：`deployToCloudRun()` 捕捉 `latestReadyRevision`；新增 `publishRevision()`（traffic 100% routing）和 `listCloudRunRevisions()`
  - **deploy-worker.ts**：自動遞增版本號、記錄 imageUri/revisionName/previewUrl、Go Live 時自動 publish（除非 deployLocked）
  - **orchestrator.ts**：新增 `getNextDeploymentVersion()`、`unpublishAllDeployments()`、`publishDeployment()`、`getPublishedDeployment()`、`setDeployLock()`
  - **routes/projects.ts**：4 個新端點
    - `GET /api/projects/:id/versions` — 版本歷史
    - `POST /api/projects/:id/versions/:deployId/publish` — 發佈指定版本
    - `POST /api/projects/:id/new-version` — 升版部署（接受 gcsUri，觸發新 pipeline）
    - `POST /api/projects/:id/deploy-lock` — 切換部署鎖定
  - **Web UI**（`projects/[id]/page.tsx`）：版本歷史面板、發佈按鈕、Deploy Lock toggle、升版部署 modal（drag-and-drop 上傳）
- ✅ **Cloud Build 部署成功**（build c2adf382）
- ✅ **API 驗證**：`/versions` 端點正確回傳資料，舊部署向後相容（version=1, imageUri=null）
- ✅ **QA 驗證通過**（6 項）：
  - DB migration 自動化（API 啟動時跑 `runMigrations()`，Cloud Run log 確認）
  - Deploy Lock API（POST toggle 正確）
  - Deploy Lock UI（按鈕狀態 + 顏色切換）
  - Versions API（版本列表 + 新 columns）
  - 版本歷史面板（v1 + healthy badge）
  - 升版部署 Modal（拖曳上傳區 + 按鈕）
- ⏭️ **未測項目**（需真實操作）：升版 E2E（上傳→pipeline→v2）、Publish 版本切換（需 ≥2 版本）
- 🐛 **修復 3 個 bug**：
  1. DB migration 沒跑（production DB 缺新 columns）→ API startup 自動 `runMigrations()`
  2. `deploy-lock` 端點 body undefined 防禦不足 → `(request.body ?? {})`
  3. Cloud Build 手動提交缺 `SHORT_SHA` substitution → 加 `--substitutions=SHORT_SHA=$(date +%s)`

**2026-04-10（下午）—— Pipeline Reconciler 系統性修復**

- ✅ **系統性修復 pipeline 卡住 → `health_status=unknown` 問題**
  - 根因：deploy pipeline 是 in-process async 跑的，API container 在 SSL monitoring（10 分鐘等待）或 canary 階段重啟 → in-flight pipeline 消失 → project 永遠卡在 `deploying`/`ssl_provisioning`/`canary_check`，`health_status` 停在預設值 `'unknown'`
  - 解法：新增 **Pipeline Reconciler**（`apps/api/src/services/reconciler.ts`）
    - **啟動時**掃一次卡住的 project（`deploying`/`deployed`/`ssl_provisioning`/`canary_check` 且 `updated_at > 5 分鐘`）
    - **每 2 分鐘**週期性掃一次
    - 每個卡住的 project：驗證 Cloud Run service 真的 ready → 走狀態機 fast-forward → 跑真正的 canary check → 轉 `live` 並更新 `health_status`
    - Cloud Run service 不存在 → 轉 `failed`
  - 新增 `POST /api/infra/reconcile` 手動觸發端點
  - `apps/api/src/index.ts` 啟動時 `startReconciler()`
  - `project-groups` API 的 `latestDeployment` 加上 `healthStatus`、`sslStatus` 欄位（之前沒傳給 UI）
- ✅ **端到端驗證**
  - 刪掉之前卡住的 bid-ops-ai（backend + frontend）與所有 GCP 資源
  - 透過 Web UI 重新上傳（用 GCS 中轉 + synthetic DragEvent 注入 React state）
  - Reconciler 初次啟動時自動把前一版卡住的 bid-ops-ai 推到 `live`（證明機制有效）
  - 新版 pipeline：scanning → review_pending → approved → deploying → ssl_provisioning → **live**
  - `/api/deploys` 回傳：frontend `health_status=healthy`（canary 全過）、backend `health_status=unhealthy`（canary probe `/` 被 FastAPI 回 404 — 非系統 bug）
  - 重點：**`health_status` 不再卡在 `unknown`** — 問題徹底解決
- 📝 後續改進（非阻塞）：canary 目前固定 probe `/`，對 API-only 服務（FastAPI 沒有 root route）會回 404 → 建議改成 probe `/health` 或 `/docs`，或從 project 設定讀自訂 health path

**2026-04-10**

- ✅ 修復 `submit-gcs` 路由缺少 monorepo 偵測的 bug
  - 問題：透過 GCS 上傳路徑提交的 monorepo（如 bid-ops-ai）被當成 single project 處理，Cloud Build 在 root 找不到 Dockerfile 而失敗
  - 修復：在 `apps/api/src/routes/projects.ts` 的 `/api/projects/submit-gcs` 路由加入完整 monorepo 偵測邏輯（與 upload 路由一致）
  - 包含：service role 分類（backend/frontend）、siblings 設定、每個 service 獨立 GCS 上傳 + pipeline
- ✅ bid-ops-ai 成功部署（monorepo: backend + frontend）
  - Backend: `da-bid-ops-ai-backend` → `api.bid-ops-ai.punwave.com`（SSL provisioning）
  - Frontend: `da-bid-ops-ai-frontend` → `bid-ops-ai.punwave.com`（SSL provisioning）
  - Cloud Run URLs:
    - `https://da-bid-ops-ai-backend-zdjl362voq-de.a.run.app`
    - `https://da-bid-ops-ai-frontend-zdjl362voq-de.a.run.app`
- ✅ Deploy Agent API + Web 重新部署（Cloud Build 6b8ce3a9, SUCCESS）
- ✅ GCS direct upload 流程驗證成功（34.8MB zip 繞過 Cloud Run 32MB 限制）

**2026-04-06**

- ✅ DB Dump 上傳 + 自動匯入功能（整套 7 個檔案一次到位）
  - **Dockerfile** (`apps/api/Dockerfile`)：加 `postgresql16-client`（提供 `psql`、`pg_restore`）
  - **db-restore.ts** (`apps/api/src/services/db-restore.ts`)：新檔案，支援 `.sql`（psql）、`.dump`（pg_restore）、`.sql.gz`（gunzip|psql）三種格式
  - **projects.ts** (`apps/api/src/routes/projects.ts`)：multipart 新增 `dbDump` field，上傳到 GCS，三條路徑（git / monorepo / single）都接上
  - **deploy-worker.ts** (`apps/api/src/services/deploy-worker.ts`)：Step 2c-2 新增 DB restore step，在 DB provisioning 後、Cloud Build 前執行
  - **page.tsx** (`apps/web/app/page.tsx`)：SubmitModal 新增「資料庫 Dump」檔案上傳欄位
  - **mcp.ts** (`apps/api/src/routes/mcp.ts`)：`submit_project` tool 新增 `db_dump_path` 參數
  - **SKILL.md** (`skills/deploy-agent/SKILL.md`)：文件更新，新增 DB dump 使用說明
  - **types.ts** (`packages/shared/src/types.ts`)：ProjectConfig 加 `gcsDbDumpUri`、`dbDumpFileName`、`dbRestoreResult`、`forceDomain`、`resolvedBackendUrl`、`envAnalysis`

**2026-04-05（凌晨後續）**

- ✅ 遷移 prod Cloud Run 到 `deploy-agent@` SA（api + web 兩個 service 都切了）
  - 補了 3 個 role：`logging.logWriter`、`monitoring.metricWriter`、`storage.admin`（取代 objectAdmin，因為 objectAdmin 沒有 buckets.get）
  - SA 從 `roles/editor`（萬能）→ 12 個具名 role（最小權限）
- ✅ `cloudbuild.yaml` 明確綁定 `--service-account=deploy-agent@...`，防止被意外改掉
- ✅ Terraform README 改寫成中文，同步現況
- ✅ 修 luca-app 403 bug
  - 現象：`Error: Forbidden. Your client does not have permission to get URL / from this server.`
  - 急救：手動 `gcloud run services add-iam-policy-binding` 補 allUsers invoker
  - 根源：`deploy-worker.ts` 的 `allowUnauthenticated` default 是 `false`（其他檔案都是 `true`），導致部署時跳過 setIamPolicy → IAM 空白 → 403
  - 已修：default 改成 `true`，與其他檔案一致

**2026-04-05（凌晨，一步一步做完為止）**

- ✅ 明文 secrets migrate 完成：prod Cloud Run 已用 `--update-secrets` 切到 Secret Manager，新 revision 服務正常
- ✅ Terraform import 完成：30+ 現有 prod 資源全部納入 TF state（12 APIs、GCS bucket、AR repo、SQL instance+db+user、Redis firewall+VM、6 secrets × 3）
- ✅ Terraform apply 完成：19 added / 11 changed / **0 destroyed**
  - 建立 `deploy-agent@` service account + 10 個 IAM roles
  - Cloud SQL 啟用 backup + PITR（原 prod backups 是關的 ⚠）+ maintenance_window + query insights
  - 6 個 secrets 加上 agent SA accessor binding + default compute SA 過渡期 binding
  - Cloud Build SA 加上 run.admin + iam.serviceAccountUser
- ✅ `terraform plan` 現在 **No changes** — prod infra 與 TF config 完全對齊
- ✅ Agent API 驗證通過：`/api/projects` 200、`/api/infra/overview` 200
- ⏸️ services.tf + domains.tf 暫放 `.deferred`（等 prod Cloud Run 遷到 deploy-agent@ SA 後再接管）

**2026-04-05（深夜）**

- ✅ Terraform DR 系統：9 個 .tf 檔 + `bootstrap.sh` + `README.md` + `terraform.tfvars.example`
- ✅ 第 3 份 decision 檔：`2026-04-05-terraform-disaster-recovery.md`

**2026-04-05（晚上）**

- ✅ Dashboard 新增「基礎設施」頁（`/infra`）
  - Artifact Registry（repo 大小、cleanup policy 狀態、每 package 版本數）
  - Cloud Storage（sources/ bucket 統計、lifecycle rule 狀態）
  - Cloud Run（agent 自身 services 狀態 + Ready 燈號）
- ✅ 孤兒資源清理：橫幅顯示 orphan count + 一鍵清理（POST /api/infra/cleanup-orphans）
- ✅ 3 個新 API endpoints：`/api/infra/overview`, `/api/infra/orphans`, `/api/infra/cleanup-orphans`
- ✅ 修 bug：Cloud Run v2 API ready 狀態要讀 `terminalCondition` 不是 `conditions[]`
- ✅ 驗證 on https://wave-deploy-agent.punwave.com/infra：39 個 orphan tarball (9.9 MB) + 1 orphan AR package (`deploy-agent-api` 舊命名) 已偵測到

**2026-04-05（下午）**

- ✅ 建立 brain 會話管理系統（CLAUDE.md + SESSION_HANDOFF.md + decisions/index.md）
- ✅ GCS sources lifecycle：30 天自動刪除已套用（bucket: `wave-deploy-agent_cloudbuild`, prefix: `sources/`）
- ✅ Artifact Registry cleanup policy：keep 5 tagged + 清 7d untagged / 30d tagged
- ✅ 2 份 decision 檔：`2026-04-05-gcs-sources-lifecycle-30d.md`, `2026-04-05-artifact-registry-cleanup.md`

**2026-04-05（上午）**

- ✅ Dashboard 重構：從平面表格改為「專案 → 資源」的可展開 accordion
  - 新 API：`GET /api/project-groups`、`POST /api/project-groups/:groupId/actions`
  - 每個專案卡片顯示所有 allocated resources（Cloud Run、Redis、Postgres、Source archive）
  - 支援 bulk stop/start/delete（monorepo 可整組操作或選子集）
- ✅ 新增 `stop/start` 生命週期（GCP convention：stop = deleteService，start = 從 Artifact Registry 快取 image 重部署）
  - 停止前 snapshot image URI + envVars 到 `project.config`，確保 start 可還原
  - 有 REDIS_URL 時自動啟用 Direct VPC egress
- ✅ Source tarball 保留 + 下載：service account proxy 從 GCS 下載原始碼
- ✅ 修掉三個 bug：
  1. `--no-allow-unauthenticated` 把 IAM 炸掉 → 改成 `--allow-unauthenticated`
  2. `NEXT_PUBLIC_API_URL` 沒 bake 進 build → cloudbuild.yaml 加 build-arg
  3. 舊專案沒有 `lastDeployedImage` → stop 時從 live service 讀取並快取
- ✅ 端到端測試通過：luca-backend 停止→重啟，36 個 envVars 全部還原

## 待辦事項（TODO）

### 高優先
- [x] ~~**GCS lifecycle rule**：為 `gs://wave-deploy-agent_cloudbuild/sources/` 設 30 天自動刪除~~（2026-04-05 完成，見 `decisions/2026-04-05-gcs-sources-lifecycle-30d.md`）
- [x] ~~**Artifact Registry cleanup**~~（2026-04-05 完成：keep 5 tagged + 清 7d untagged / 30d tagged，見 `decisions/2026-04-05-artifact-registry-cleanup.md`）
- [x] ~~**Dashboard GCP 資源管理頁**~~（2026-04-05 完成：`/infra` 頁 + orphan cleanup 一鍵清理）
- [x] ~~**執行 orphan cleanup**~~（2026-04-13 完成：21 AR packages 刪除，0 orphans。SA 權限從 `artifactregistry.writer` 升到 `artifactregistry.admin`）
- [ ] **驗證 bootstrap.sh**：在 throwaway GCP project 跑一次完整 `./terraform/bootstrap.sh`（需要使用者手動操作）
- [x] ~~**migrate prod secrets 到 Secret Manager**~~（2026-04-05 完成）
- [x] ~~**Terraform import 現有 prod 資源**~~（2026-04-05 完成：30+ resources, 0 drift）
- [x] ~~**遷移 prod Cloud Run 到 deploy-agent@ SA**~~（已完成，API + Web 都用 `deploy-agent@` SA）

### 中優先
- [x] ~~**Deployed Source Capture（吐回部署版）Phase 1**~~（2026-04-18 完成：GCS bucket 365d lifecycle + DEPLOYMENT.md + dashboard 下載按鈕 + signed URL endpoint）
- [x] ~~**修 pipeline-worker → deploy-engine 的 fix 遺失 bug**~~（2026-04-18 同日修完：pipeline Step 6a re-upload 到 `sources-fixed/` + deploy-worker 優先用 `gcsFixedSourceUri`）
- [ ] **Deployed Source Capture Phase 2**：GitHub org 整合（per-project repo push + diff view）
- [x] ~~**Versioning Phase 2**：Preview URL per revision、版本保留策略（keep last N）、canary 失敗自動 rollback~~（2026-04-13 完成）
- [x] ~~**Versioning Phase 3**：Git push auto-deploy（webhook）~~（2026-04-14 完成：GitHub webhook + 自動部署。Branch Deploy 待後續）
- [ ] Terraform for agent 自身 infra（目前是手動 gcloud deploy）
- [x] ~~Dashboard i18n（next-intl 中英雙語）~~（2026-04-14 完成：248 keys, 9 namespaces, 8 pages）
- [x] ~~**Discord Bot**~~（2026-04-14 完成：已部署到 Cloud Run，NL enabled）
  - `apps/bot/` codebase 完成：7 個 slash commands + NL handler + OpenAI fallback
  - `discord-notifier.ts` 已部署：webhook 通知（deploy 完成/失敗/canary/review）
  - `cloudbuild.yaml` 已包含 build + push + deploy
  - **待辦**：使用者需到 Discord Developer Portal 開啟 Message Content Intent
  - **待辦**：加 DISCORD_CHANNEL_ID env var 啟用 morning digest
  - ~~**待辦**：重新部署 API 以修復 /api/infra 404~~（2026-04-14 完成）
- [ ] MCP server 實作（`@modelcontextprotocol/sdk`）
- [ ] OpenClaw skill（`skills/deploy-agent/SKILL.md`）

### 低優先 / Phase 3+
- [ ] IaC auto-generation（為使用者的專案產 Terraform）
- [ ] Cost estimation（GCP pricing API）
- [ ] Git PR 自動化（security fix diffs）

## 重要資訊 / 重要關注（Important Notes）

### 架構
- **部署位置**：asia-east1，GCP project = `wave-deploy-agent`
- **Agent 網址**：
  - API: `https://wave-deploy-agent-api.punwave.com` → `deploy-agent-api` Cloud Run
  - Web: `https://deploy-agent-web-zdjl362voq-de.a.run.app`（尚未綁 custom domain）
- **Artifact Registry**：`asia-east1-docker.pkg.dev/wave-deploy-agent/deploy-agent/{api,web,<user-slug>}`
- **DB**：Cloud SQL（PostgreSQL）shared instance
- **CI/CD**：`cloudbuild.yaml`，push 到 main 觸發

### 坑點（踩過的雷）
1. **Cloud Run deploy 務必加 `--allow-unauthenticated`**，否則 IAM binding 會被清掉，API 變成 503
2. **Next.js `NEXT_PUBLIC_*` 環境變數必須 build 時 bake**，runtime 設沒用 → cloudbuild.yaml 要用 `--build-arg`
3. **GCP 沒有 Cloud Run pause**，唯一真正釋放資源的方式是 delete service；start 靠快取 image 重 deploy
4. **有 REDIS_URL 的專案必須啟 Direct VPC egress**，否則連不到 internal Redis
5. **Cloud Run HTTP/1.1 request body 上限 32MiB**（hardcoded by Google ingress proxy），超過的檔案必須走 GCS direct upload
6. **`submit-gcs` 路由之前漏了 monorepo 偵測**，已修復（2026-04-10）
7. **gcloud 路徑可能在 `~/Downloads/google-cloud-sdk/bin/gcloud`**（非標準安裝位置）
8. **Pipeline 是 in-process async，沒有 durable queue**。API container 重啟會讓 in-flight pipeline 消失。已靠 **Reconciler**（啟動 + 每 2 分鐘週期掃描）補救（2026-04-10）。真正的架構正解還是應該搬到 Cloud Run Jobs。
9. **DB migration 必須自動化**。手動 `gcloud sql connect` 跑 migration 不可行（Cloud SQL 只接受 socket 連線，本地沒有 cloud-sql-proxy）。已改成 API 啟動時自動 `runMigrations()`（idempotent），並加 `/api/infra/migrate` 端點備用。
10. **手動 `gcloud builds submit` 必須帶 `--substitutions=SHORT_SHA=xxx`**，否則 Docker tag 為空（`api:` → invalid reference format）。Git trigger 模式下 `SHORT_SHA` 是內建的。
11. **Fastify plugin 超過 ~1500 行時，尾端 routes 可能不被註冊**（`tsx` 運行時 transpile 的特性）。解法：拆分大型 plugin 成多個檔案。（2026-04-13 踩坑：`projects.ts` 1615 行 → 拆出 `versioning.ts`）
12. **Cloud Run v2 API traffic target 必須帶 `type`**：`type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'`。不帶會 400 INVALID_ARGUMENT。
13. **GitHub Webhook 需要 raw body 做 HMAC 驗證**。webhookRoutes 用 `addContentTypeParser('application/json', { parseAs: 'buffer' })` 覆蓋 JSON parser，Fastify plugin encapsulation 確保只影響 webhook 路由。
14. **Cloud Run 容器沒有 gcloud CLI**。要做 GCS signed URL 的話，不能直接 `gcloud storage sign-url`（exec 會找不到）。正解：V4 signing 靠 IAM Credentials API 的 `signBlob`，SA 需要有 `iam.serviceAccountTokenCreator` on itself。`deployed-source-capture.ts` 的 `signUrlWithIamCredentials()` 是參考實作。
15. ~~**pipeline-worker 的 AI 修補沒有回流到 GCS**~~（2026-04-18 同日修完）：**分兩個 GCS URI**：`gcsSourceUri` 永遠存原始上傳做 audit；`gcsFixedSourceUri` 是 pipeline-worker Step 6a 上傳的 post-fix 版本，deploy-worker 優先使用。使用者走 `new-version` 升版時要記得清 `gcsFixedSourceUri`（已處理）。

### 使用者偏好（Boss 習慣）
- 直接給結論、不要囉嗦
- 跟 GCP convention 一致就好，不用自己發明
- 遇到 gcloud 找不到：路徑在 `/usr/local/share/google-cloud-sdk/bin/gcloud`
- 驗證 UI 時用 Chrome MCP 截圖

### 資源盤點（2026-04-05）
- Cloud Run services：只剩 `deploy-agent-api` + `deploy-agent-web`（使用者自己的專案都已清掉）
- GCS sources：61 個 tarball / 12.91 MiB（含歷史：bid-ops, kol-studio, luca-*, wave-test 等）
- Artifact Registry：api image 37+ 版本未清
