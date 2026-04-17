# SESSION HANDOFF — wave-deploy-agent

> 每次新對話開始時讀這份檔案，結束前更新它。

## 上次進度（Last Progress）

**2026-04-17（晚上）**

- ✅ **RBAC 權限系統 Phase 1 上線**（permissive mode，見 `decisions/2026-04-17-rbac-auth-system.md`）
  - 5 張新表：`roles`, `users`, `sessions`, `api_keys`, `auth_audit_log`
  - 3 角色 seeded：admin（`*`）、reviewer（reviews:decide + 讀取）、viewer（全部唯讀）
  - `auth-service.ts`：bcrypt (cost 12) + SHA-256 token hash + audit log
  - `middleware/auth.ts`：onRequest hook + route→permission map，涵蓋 47 個端點
  - `routes/auth.ts`：login/logout/me/users CRUD/api-keys CRUD/audit-log，login 5/min rate limit
  - Web：`/login` 頁 + `AuthProvider` + Sidebar 顯示使用者 + 登出鈕
  - AUTH_MODE=permissive（預設）：anonymous 被 log 但放行，零停機
  - commit `34a8671`，已部署
- ✅ Orphan cleanup：清掉 9 個 tarball + 1 AR package（107 MB）
- ✅ Dashboard Design Review：15 項設計問題，完成 11 項修復
  - Sidebar active state 高亮（藍色左邊框 + 背景 + 粗體白字）— 抽出 `sidebar.tsx` client component
  - Deploys 頁加分頁（PAGE_SIZE=20）+ 專案名稱連結到 project detail
  - Project detail 頁：語言/框架偵測用「—」取代 "Detecting..."、sourceType 顯示 "upload/git" 而非 server path、新增升版按鈕
  - Review detail 頁：threat summary 從 raw text 改為 ReactMarkdown 渲染 + `.markdown-body` 樣式
  - Settings 頁寬度限制 720px、input 欄位加寬到 560px
  - Homepage：單服務群組名稱可直接點擊進 project detail、batch 操作加 window.confirm 確認、刪除按鈕 hover 紅色
  - 新增 `.markdown-body` 完整 CSS（h1-h3, p, ul/ol, code, pre, hr）
- ✅ 已部署上線（commit `bb9919c`，Cloud Build → prod 驗證 HTTP 200）
- ⏭️ 跳過 4 項（#3 save 按鈕已存在、#4 infra 空白是 API 資料問題、#7/#10 需 API 端改動）
- ⏸️ RBAC 權限系統計劃已批准（見 plan file），但使用者要求先處理 design review，尚未開始實作

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
- [ ] **執行 orphan cleanup**：首次清理 39 個 tarball + 1 AR package（用 dashboard 按鈕即可）
- [ ] **驗證 bootstrap.sh**：在 throwaway GCP project 跑一次完整 `./terraform/bootstrap.sh`
- [x] ~~**migrate prod secrets 到 Secret Manager**~~（2026-04-05 完成）
- [x] ~~**Terraform import 現有 prod 資源**~~（2026-04-05 完成：30+ resources, 0 drift）
- [ ] **遷移 prod Cloud Run 到 deploy-agent@ SA**：目前還用 default compute SA，遷完後把 services.tf.deferred + domains.tf.deferred 接管起來

### 中優先
- [ ] **RBAC Phase 2/3**（Phase 1 已完成）：
  - [ ] Cloud Run 加 env：`ADMIN_EMAIL`, `ADMIN_PASSWORD`（secret）, `SESSION_SECRET`（secret）→ bootstrap admin
  - [ ] Login 進 dashboard → 建 Bot API key → Bot `api-client.ts` 加 `Authorization: Bearer`
  - [ ] MCP 同樣建 API key 並更新
  - [ ] 觀察 `auth_audit_log` 中 `action='anonymous_request'` 幾天
  - [ ] 切 `AUTH_MODE=enforced`
- [ ] Terraform for agent 自身 infra（目前是手動 gcloud deploy）
- [ ] Dashboard i18n（next-intl 中英雙語）— design spec 已訂
- [ ] MCP server 實作（`@modelcontextprotocol/sdk`）
- [ ] OpenClaw skill（`skills/deploy-agent/SKILL.md`）

### 低優先 / Phase 3+
- [ ] Canary monitor + auto-rollback
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

### 使用者偏好（Boss 習慣）
- 直接給結論、不要囉嗦
- 跟 GCP convention 一致就好，不用自己發明
- 遇到 gcloud 找不到：路徑在 `/usr/local/share/google-cloud-sdk/bin/gcloud`
- 驗證 UI 時用 Chrome MCP 截圖

### 資源盤點（2026-04-05）
- Cloud Run services：只剩 `deploy-agent-api` + `deploy-agent-web`（使用者自己的專案都已清掉）
- GCS sources：61 個 tarball / 12.91 MiB（含歷史：bid-ops, kol-studio, luca-*, wave-test 等）
- Artifact Registry：api image 37+ 版本未清
