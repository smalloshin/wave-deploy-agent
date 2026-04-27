# Decisions Index — wave-deploy-agent

> 所有架構／產品決策的目錄。每個決策獨立一個檔案，放在本目錄。

## 使用規則

1. **每次做出架構或產品決策時**，建立新檔 `YYYY-MM-DD-<slug>.md`
2. **檔名 slug 用 kebab-case**，簡短描述（例：`2026-04-05-stop-via-delete-service.md`）
3. **決策檔內容結構**（參考 ADR 格式）：
   - **Context**：為什麼需要做這個決定
   - **Decision**：決定是什麼
   - **Consequences**：帶來的好處與代價
   - **Status**：Active / Superseded by `<新決策檔>`
4. **被取代的決策不要刪**，把 Status 改成 Superseded 並連到新決策
5. **在本 index.md 登記**：新增一列到下方表格

## 決策狀態說明

| 狀態 | 意義 |
|------|------|
| **Active** | 目前生效中 |
| **Superseded** | 已被其他決策取代，保留作歷史紀錄 |
| **Deprecated** | 已棄用但尚未有取代方案 |
| **Proposed** | 提案中，尚未實作 |

## 決策清單

| 日期 | 決策 | 狀態 | 說明 |
|------|------|------|------|
| 2026-04-05 | [gcs-sources-lifecycle-30d](./2026-04-05-gcs-sources-lifecycle-30d.md) | Active | GCS source tarball 30 天自動刪除，防止無限成長 |
| 2026-04-05 | [artifact-registry-cleanup](./2026-04-05-artifact-registry-cleanup.md) | Active | AR repo keep last 5 tagged + 清 7d untagged / 30d tagged |
| 2026-04-05 | [terraform-disaster-recovery](./2026-04-05-terraform-disaster-recovery.md) | Active | 用 Terraform + bootstrap.sh 實現 agent 一指令重建；secrets 搬到 Secret Manager |
| 2026-04-13 | [netlify-like-versioning](./2026-04-13-netlify-like-versioning.md) | Active | Netlify-like 版本管理：immutable deploy、版本歷史、一鍵 publish/rollback、deploy lock |
| 2026-04-18 | [deployed-source-capture](./2026-04-18-deployed-source-capture.md) | Active | 每次 deploy 成功後把 post-fix code + 自動生成 Dockerfile 存到 GCS (365d lifecycle)，dashboard 一鍵下載，讓使用者從安全基準繼續開發 |
| 2026-04-25 | [deployment-observability](./2026-04-25-deployment-observability.md) | Active | 部署觀測 3 層架構：Tier 1 timeline（7-stage stepper）+ Tier 2 SSE log stream + Tier 3 LLM 診斷（cached by build_id），Tier 4 cost/latency 圖表已 kill |
| 2026-04-25 | [rbac-system-permissive-then-enforced](./2026-04-25-rbac-system-permissive-then-enforced.md) | Active | 全站 RBAC：3 角色（admin/reviewer/viewer）+ 16 權限 + bcrypt password + SHA-256 session + API key + audit log；零停機 permissive→enforced 兩段切換 |
| 2026-04-26 | [live-build-log-streaming](./2026-04-26-live-build-log-streaming.md) | Active | Build log 從 post-mortem 升級成 live tail：`onBuildStarted` callback 早 leak buildId，背景 task 把 `pollBuildLog` chunks 透過 SSE 廣播到既有 deployment-event-stream |
| 2026-04-27 | [chunked-upload-defaults](./2026-04-27-chunked-upload-defaults.md) | Active | Round 30 緊急 fix：chunked GCS resumable upload 預設值收緊（1 MiB chunks / 15 retries / 60s backoff cap / 120s XHR timeout）解 vibe-coded user 慢連線 426 MB 檔案上傳卡 33% 問題 |
| 2026-04-27 | [rbac-scope-list-pattern](./2026-04-27-rbac-scope-list-pattern.md) | Active | Round 31 RBAC LIST IDOR 修法 pattern：`scopeForRequest(auth,mode) → ListXxxScope` + `buildListXxxSql(scope)` 三態 pure helpers，filter 在 SQL 不在 app code，避免 timing channel；R32–R36 follow-through 收完所有 IDOR（4 P0 list + 6 P1 single + 1 bulk mutating） |
| 2026-04-27 | [bot-api-key-bootstrap](./2026-04-27-bot-api-key-bootstrap.md) | Active | Round 37 Bot RBAC consumer wiring：抽 `auth-headers.ts` 純 helper（22 LOC）+ 18 個 zero-dep 測試鎖 `Bearer <key>` wire shape；boss-gated 下一步是決定 bot user identity（reviewer SA / 共用 admin）+ 發 api_keys row |
