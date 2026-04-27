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
| 2026-04-27 | [permission-check-shared](./2026-04-27-permission-check-shared.md) | Active | Round 38 RBAC predicate 移到 `@deploy-agent/shared`：`hasPermission` / `effectivePermissions` / `checkUserPermission` 三個純函式 + 38 zero-dep 測試（含 7 條 server/client parity contract + 3 條 escalation regression）；sweep 腳本擴充覆蓋 `packages/*/src/` |
| 2026-04-27 | [upload-error-mapper-test-lock](./2026-04-27-upload-error-mapper-test-lock.md) | Active | Round 39 web 上傳錯誤翻譯層 wire-contract lock：`upload-error-mapper.ts`（242 LOC，4 個 exported pure helpers）+ 172 zero-dep 測試（鎖每個 `UploadFailureCode` 對 i18n key、`mapClientError` 啟發式順序、`fetchDiagnostic` 永不 throw 契約、`buildErrorReport` 條件區塊、426 MB 檔案的 "426.5 MB" 顯示字串）；sweep 腳本擴充覆蓋 `apps/web/lib/`，順帶把 R27/R30 孤兒 `test-resumable-upload.ts` (91) 拉進 gate |
| 2026-04-27 | [upload-draft-storage-test-lock](./2026-04-27-upload-draft-storage-test-lock.md) | Active | Round 40 web localStorage 草稿層 wire-contract lock：`upload-draft-storage.ts`（127 LOC，5 個 exported helpers）+ 55 zero-dep 測試（in-memory localStorage shim；鎖 7-day expiry 數字 `604800000ms`、schema v:1 migration 安全網、50 KB cap 降級保留 formData 丟 fileMeta、`gcExpiredDrafts` 不碰 non-prefix key、debounce「last value wins + 只 fire 一次」契約、SSR isBrowser no-op 護欄）|
| 2026-04-27 | [cost-estimator-test-lock](./2026-04-27-cost-estimator-test-lock.md) | Active | Round 41 GCP cost estimator wire-contract lock：`cost-estimator.ts`（108 LOC，2 個 exported pure helpers）+ 60 zero-dep 測試（pricing 常數釘死在測試與 source 兩處強制 review；free-tier `Math.max(0,...)` clamps 每個獨立驗證；2-decimal rounding；`currency: 'USD' as const` literal contract；minInstances always-on math（30×24×3600 sec/month）；formatCostEstimate 8-line 輸出格式 + integer 不出 `.00`）|
| 2026-04-27 | [state-machine-test-lock](./2026-04-27-state-machine-test-lock.md) | Active | Round 42 shared state-machine 規則 + 4 個 state-classification predicates wire-contract lock：`state-machine.ts`（129 LOC，6 個 exported helpers + 2 個 error class）+ 100 zero-dep 測試（PINNED_TRANSITIONS 15×15 = 225-cell adjacency matrix 釘死在測試與 source 兩處；`getValidTransitions` 每個 state 顯式 + reference identity；`isTerminalState`/`isActionableState`/`requiresHumanAction` 每個 state 顯式 + 集合 cardinality + `requiresHumanAction ⊆ isActionableState` / `terminal ∩ actionable = ∅` invariants；R12 `Invalid state transition:` string-match 契約；R12 `ConcurrentTransitionError` field 保留；planner 全 sweep 不能 diverge from rules）|
