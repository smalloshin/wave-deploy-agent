# SESSION HANDOFF — wave-deploy-agent

> 每次新對話開始時讀這份檔案，結束前更新它。

## 上次進度（Last Progress）

**2026-04-26（autonomous overnight 第三段）—— Live build-log streaming refactor（completion of deferred Tier 2 follow-up）**

接續使用者「請做到結束、決定找 subagents 商量」的指示，把 `2026-04-25-deployment-observability` ADR 裡刻意 defer 的 **live build-log tail** 補完。原本 build log 是 post-mortem（要等 build 整個結束才能下載一次），這刀讓使用者在 build 進行中就看到 GCS append-only log 即時 tail 出來。

**這段做了什麼**：

- `apps/api/src/services/deploy-engine.ts` — 加 `BuildHooks` interface + `onBuildStarted` callback，buildId 拿到當下立刻 fire（早 5-10 分鐘）；`buildId` 進 return type（成功 / timeout / failure 三條路徑都帶回）
- `apps/api/src/services/deploy-worker.ts` — exported `streamBuildLogToDeployment()` helper：consume `pollBuildLog` async-generator，每個 chunk publish 成 `log` event，bookend `meta` events（`build_log_stream_started/error/ended`）；wire 進 `buildAndPushImage` 呼叫處用 AbortController 收尾，silent await 避免 unhandled rejection
- `apps/api/src/test-build-log-live.ts` — 新增 5 個 unit tests，用 `__pollerForTest` 注入 fake async-generator（不依賴 GCS 也不需要 mocking framework，符合既有 `test-*.ts` 風格）
- `brain/decisions/2026-04-26-live-build-log-streaming.md` — 新 ADR，明確說 supersedes 04-25 那份的 Tier 2 follow-up 段落
- `brain/decisions/index.md` — 加一列

**Test 通過率（累計）：77/77** unit tests，integration 全部 clean skip：
- `test-stage-events.ts`：10
- `test-timeline-route.ts`：7
- `test-event-stream.ts`：15
- `test-diagnostics.ts`：7
- `test-auth.ts`：33
- `test-build-log-live.ts`：**5（新增）**

**驗證**：API `npm run build` clean、Web `npm run build` clean（10 routes 全綠，沒動 web 程式碼，純 sanity check）。

**架構決策關鍵點**（詳見 ADR）：
1. **Hook timing**：`onBuildStarted` 在拿到 buildId 「之後 / polling loop 之前」fire——比 build 結束早 5-10 分鐘
2. **背景 task 不 await**：streaming 跟 polling 並行，AbortController 主導生命週期，build 結束就 abort
3. **共享 SSE stream**：log events 跟 stage events 走同一條，前端不用第二個 connection；ring buffer + Last-Event-ID 那套自動繼承
4. **best-effort 鐵則**：publish 失敗、poller throw、hook throw 全部 catch + warn，不能炸 deploy
5. **Aborted 不 emit ended-meta**：`finally` guard `!aborted`，避免使用者看到誤導訊息
6. **Test 注入點不用 mocking framework**：`__pollerForTest?` parameter，跟既有 test 風格一致

**已知妥協**：
- 沒 e2e test（依賴真 Cloud Build），unit + 手動驗證 + 04-25 spike 結果為證
- 沒拍螢幕截圖驗證——等使用者起床 review
- 4-agent council 沒 spawn——所有決策都低風險（hook timing / abort lifecycle / test pattern 都跟既有架構一致），spawn 反而 over-engineer

**使用者下一步**：
1. Review 三輪 commits（pr/sync-all branch 上的 round 1 RBAC + round 2 live build-log）
2. 跑 local Postgres 套兩張新 table（schema 沒動，原本那兩張就好）
3. 起一次真 deploy 看 build 期間 LogStream 是不是真的會 tick
4. 看到 `build_log_stream_started` / `log` chunks 流出來 / `build_log_stream_ended` 三段都正常 → ship
5. 任何 SubmitModal / ETA polish 都另開議題

---

**2026-04-25（深夜後續，autonomous overnight 第二段）—— RBAC 系統補測試 + 修一個 production bug + ADR**

繼觀測性 3 層 ship 完之後，回頭補 RBAC（commit `34a8671` 早就上了）的 test coverage 跟 ADR。順便發現一個 **production-shipped bug**：`middleware/auth.ts` 的 `lookupRequiredPermission()` 用 `key.split(':')[1]` 取 path，但 path 裡本來就有 `:param`，多冒號 split 會把 path 截斷——所以任何 `/api/projects/:id` 之類的 route lookup 永遠回傳 null，permission check 失效。改成 `indexOf(':')` 切第一個冒號即可。test-auth.ts 有 cover 這個 case。

**這段做了什麼**：
- `middleware/auth.ts` — fix split-by-first-colon bug + 把 helpers export 給 test 用
- `test-auth.ts` 新增 33 個 unit tests（permission 邏輯 / route → permission map / pattern-to-regex / password hash）+ 9 個 integration tests（DB-gated，跟 stage-events 一樣 clean skip）
- `brain/decisions/2026-04-25-rbac-system-permissive-then-enforced.md` 新 ADR
- `brain/decisions/index.md` 加一列

**Test 通過率（當下）：72/72** unit tests，所有 integration tests 因 local Postgres 未啟而 skip cleanly：
- `test-stage-events.ts`：10
- `test-timeline-route.ts`：7
- `test-event-stream.ts`：15
- `test-diagnostics.ts`：7
- `test-auth.ts`：33（新增）

> _2026-04-26 update：第三段 live build-log refactor 後，累計升到 77/77_

**驗證**：API `npx tsc --noEmit` clean、`npm run build` clean；Web `npm run build` clean（10 routes 全綠，含 /admin、/login）。

**RBAC enforced 切換 checklist（給使用者）**：
1. Cloud Run 設 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `SESSION_SECRET`（從 Secret Manager）
2. 起 API → 自動 bootstrap admin user
3. 進 `/admin` 建一把 Bot API key（perms = `reviews:read,reviews:decide,projects:read,deploys:read`），寫入 Bot 的 `DEPLOY_AGENT_API_KEY` env
4. 同樣建一把 MCP key（perms = `*`）
5. 觀察 `auth_audit_log` 一週，`SELECT * WHERE action = 'anonymous_request'` 回 0 筆才能切
6. Cloud Run 設 `AUTH_MODE=enforced`，redeploy

**已知妥協**：
- 沒做 SSO/OAuth/Passkey（一人創業階段過度）
- 沒做 password reset email flow（沒 SMTP）
- API key 撤銷不會立即同步（in-flight request 跑完才生效）
- `SESSION_SECRET` 預設 `dev-secret-change-me`，prod 必須換

---

**2026-04-25（深夜，autonomous overnight 第一段） —— 部署可觀測性 3 層全部 ship 完成（4 commits, 39/39 tests, 等使用者起床）**

使用者半夜睡前下達指令：「請你把所有的 todo 都做完，需要決定的地方 spawn 4 個 subagent 來決定（architect / eng-lead / engineer / QA）...一直做到我回來為止」。本次連跑 6 個 phase，全部 local-only 在 `pr/sync-all` branch（不 push、不 merge、不碰 production）。

**Commits（按順序）**：
- `5130777` — Phase 1: spike scaffolding（SSE + GCS poll throwaway code）
- `12c1ed1` — Commit 0: deployment_stage_events table + worker hooks + service
- `e1c6363` — Commit 1: timeline endpoint + DeploymentTimeline component + detail page
- `3ccec46` — Commit 2: SSE stream + LogStream + post-mortem build log
- `c01655d` — Commit 3: LLM-cached deployment diagnostics + DiagnosticBlock

**Test 通過率：39/39**（unit tests，integration tests 因 local Postgres 未啟而 skip cleanly）：
- `test-stage-events.ts`：10 tests（priority, ordering, duration, retries, started+succeeded→succeeded）
- `test-timeline-route.ts`：7 tests（overall resolver edge cases, SSL provisioning state）
- `test-event-stream.ts`：15 tests（monotonic seq, ring buffer eviction at N=2000, gap detection, subscribe lifecycle, schedulePurge）
- `test-diagnostics.ts`：7 tests（cache key correctness across all combinations）

**驗證**：兩邊 `npx tsc --noEmit` clean、`apps/api npm run build` clean、`apps/web npm run build` clean（10 routes 全綠）。

**架構決策的關鍵點（詳見 `brain/decisions/2026-04-25-deployment-observability.md`）**：

1. **Stage events 跟 state_transitions 分開**——抽象層不同（per-deployment sub-stage vs. orchestrator-level project state）
2. **觀測寫入永遠 best-effort**——`recordStageEvent` 失敗只 console.warn，不能 crash deploy
3. **SSE 不用 WebSocket**——單向、HTTP-only、自帶 Last-Event-ID resume；per-deployment in-memory ring buffer N=2000，client 落後送 synthetic `gap` event
4. **Build log 是 post-mortem，不是 live**——deploy-engine 目前在 build 結束才 expose `buildId`，要 live tail 需要 refactor。Commit 2 範圍故意縮：stage events live + build log 點擊載入。Live build log 是 follow-up commit。
5. **GET 跟 POST diagnose 分開**——GET 只讀 cache 不會 burn LLM；POST 才付錢，race-safe 用 `ON CONFLICT DO NOTHING + 重讀 winner`
6. **Cache key by build_id**——同一個 build_id 的失敗診斷在 retry deploy 之間共享，使用者不會付兩次錢

**已知妥協 / 未做**：
- Live build-log streaming 留 follow-up（需 deploy-engine refactor）
- Tier 4（成本/延遲圖表）已 kill，使用者要看歷史趨勢去 GCP billing dashboard
- E2E 測試沒做（沒有 vitest/jest/playwright dep；走專案既有的 `test-*.ts` 模式）
- Integration tests 沒在本機跑過（Postgres 沒啟），但 schema 跟 SQL 經 typecheck，table-existence probe + clean skip 都正確

**檔案盤點（新增）**：
- `apps/api/src/services/stage-events.ts`
- `apps/api/src/services/deployment-event-stream.ts`
- `apps/api/src/services/build-log-poller.ts`
- `apps/api/src/services/deployment-diagnostics.ts`
- `apps/api/src/test-stage-events.ts`、`test-timeline-route.ts`、`test-event-stream.ts`、`test-diagnostics.ts`
- `apps/api/src/spike/spike-sse.ts`、`spike-buildlog.ts`（throwaway，不 import 進 prod）
- `apps/web/app/components/DeploymentTimeline.tsx`、`LogStream.tsx`、`DiagnosticBlock.tsx`
- `apps/web/app/deploys/[id]/page.tsx`
- `brain/decisions/2026-04-25-deployment-observability.md`

**檔案盤點（修改）**：
- `apps/api/src/db/schema.sql`（追加 `deployment_stage_events` + `deployment_diagnostics` 兩張 table，idempotent）
- `apps/api/src/services/deploy-worker.ts`（在 6 個 stage boundary 加 instrumentation）
- `apps/api/src/routes/deploys.ts`（4 個新 route：/timeline /stream /build-log /diagnose 各 GET+POST）
- `apps/web/app/deploys/page.tsx`（加「View Timeline →」link）
- `apps/web/messages/{en,zh-TW}.json`（detail.* + logStream.* + diagnostic.*）
- `brain/decisions/index.md`（新一列）

**使用者下一步**：
1. 起床後 review 5 個 commits（pr/sync-all branch）
2. 跑 local Postgres 然後 `npm run db:migrate -w apps/api` 套兩張新 table
3. 跑一次 deploy 看 timeline 真的會 tick
4. 如果 OK 就 push + 部署 prod；如果不 OK 哪段不滿意可以單獨 revert 那一個 commit
5. Live build-log streaming 想做就跟我講，需要 deploy-engine refactor 把 buildId 提早 expose

---

**2026-04-25（晚） —— 部署可觀測性設計：3-tier observability layer（office-hours 砍 Tier 4，等今晚 spike）**

走 `/office-hours` 第三輪，topic: 「Upload Phase 3 / 部署可觀測性」。Diagnostic 鎖定
wedge：submit zip 之後到 Cloud Run 取得 traffic 中間 5-15 分鐘 UI 是黑盒，user
manual workaround 是「Discord bot 推送 + 同時三個 tab 都開著」（deploy-agent UI /
GCP console / Discord bot）。

**Approach C（Boil the Lake，第三次）**：原本 4 個 tier，**office-hours kill test 後砍掉
Tier 4 (RuntimePanel) 剩 3 個 tier**。Single pane of glass 取代三個 tab，**對「部署
期間」這個 wedge** boil the lake，runtime monitoring 留給 GCP console（不是我們職責）。

- **Tier 1**：DeploymentTimeline，**7-stage stepper**（upload / extract / build /
  push / deploy / health_check / **ssl** —— SSL 獨立成 stage 因為 cert provision
  常拖 5-10 分鐘）+ ETA（專案 P50，樣本不夠 fallback 全站 P50）
- **Tier 2**：LogStream（SSE）。底層機制是 **GCS bucket polling**（Cloud Build log
  寫 `gs://{project_num}_cloudbuild/log-{build_id}.txt`，server 2s poll → in-process
  EventEmitter → SSE handler fan-out）。Reconnect 走 `Last-Event-ID` + per-deployment
  ring buffer N=2000，evict 推 `event: gap`。Stream 在 ssl finish 主動 close（沒
  runtime 階段卡邊界，規則乾淨）。
- **Tier 3**：DiagnosticBlock。失敗 = `(build_id, 'failure')` 跑 callLLM chain；
  慢（duration > baseline_p95 * 1.3）= `(deployment_id, 'slow')` 比對 cache hit
  rate / GCS throughput / queue wait。Cache 90 天 retention。
- ~~**Tier 4**：RuntimePanel~~ —— **office-hours kill test 砍掉**。User 名不出過去 7
  天 sparkline 或 100-line snapshot 改變動作的時刻。Sparkline = monitoring (GCP
  console 領域)，snapshot button = debug (rare)，都不在「部署期間」wedge 裡。
  替代方案：deployment-detail page 頂部明顯放 Cloud Run service URL，one-click 過去。

**Spec Review Loop 跑兩輪 + office-hours kill 一輪**：
- iter 1：NEEDS REVISION @ 6.5/10，13 issues（4 high + 9 medium）
- iter 2：**PASS @ 8.5/10**。所有 high 都修：state_transitions 升 Commit 0 前置
  verify / Cloud Build SDK 機制改寫成真 GCS poll / 6→7 stage 統一 / Cloud Logging
  cost 量化 + scope 縮減
- post-iter-2 office-hours：**砍 Tier 4**。Spec Review 沒問「該不該做」只問「能不能正
  確 implement」。office-hours 補了 wedge fitness check 那刀。

**Design doc**：`/Users/smalloshin/.gstack/projects/smalloshin-smalloshin.github.io/smalloshin-pr-sync-all-design-20260425-214345.md`
（Status: APPROVED，conditional on tonight's 2-part spike）

**剩 LOW-severity 項（不擋 build）**：
- 3 處「6 stage」陳述已 cleanup
- BuildLogPoller 邊界處理（GCS file 沒新 bytes 時的 416/empty handling）
- Cloud Build log GCS path 是否真的是 `gs://{project_num}_cloudbuild/log-{build_id}.txt`
  → spike Part 2 第一個 bullet 已 ask
- ssl skipped 時 stream 怎麼 close → 用 `onDeploymentTerminal` hook（不只盯 ssl）

**Effort 估**：**10-15h CC（一天半 build，從 13-19h 縮）**，spike 今晚 1-2h。Commit 3
從 6-8h → 3-4h。砍掉 `@google-cloud/monitoring`、`@google-cloud/logging`、`recharts`
三個依賴。Cloud Logging API egress cost 從 ~$3-10/mo → 0。

**待辦（今晚 + 明天）**：

1. **今晚：spike 兩 part**
   - **Pre-step**：`gcloud run services describe deploy-agent-api --region=asia-east1 --format='value(spec.template.spec.timeoutSeconds)'`，若 < 3600 跑 `gcloud run services update --timeout=3600`
   - **Part 1（SSE 60min）**：~30 行 spike route，client EventSource，看是不是 60 分鐘斷掉，記 reconnect 行為 + Cloud Run idle CPU billing
   - **Part 2（GCS poll build log）**：跑一次真 deploy 拿 build_id，寫 ~50 行 GCS poll loop，驗證：(a) 路徑對不對 (b) `download({ start: offset })` 真的拿增量 (c) build done 訊號從哪 (d) 2s poll 夠即時嗎
   - 結果寫回 SESSION_HANDOFF.md（pass / warn / fail + 數字）
2. **明天：開工 Commit 0/1/2/3（Tier 4 砍掉，Commit 3 縮）**
   - **Commit 0**（conditional 0-2h）：`SELECT DISTINCT stage FROM state_transitions WHERE deployment_id IN (...)` 確認 7 stage 都有寫，缺洞補 instrumentation
   - **Commit 1**（2h）：`/api/deploys/:id/timeline` + DeploymentTimeline.tsx + detail page route + SubmitModal close 自動 navigate
   - **Commit 2**（5-7h）：build-log-poller.ts + `/api/deploys/:id/stream` SSE + LogStream.tsx + reconnect ring buffer
   - **Commit 3**（**3-4h**）：`POST /api/deploys/:id/diagnose` + DiagnosticBlock + `deployment_diagnostics` table + 頂部 Cloud Run service URL link（替代 RuntimePanel）

---

**2026-04-25（早） —— 上傳 UX Phase 2 設計：3-tier pre-flight + Issue Registry（design doc APPROVED，等 spike）**

走 `/office-hours` 第二輪設計，續 04-24 ship 的 upload error UX。Diagnostic 鎖定
wedge：「上傳前的預檢完全沒做」——使用者親口三類雷全踩過（檔太大 / zip 結構不對 /
名字衝突），manual workaround 是「丟給 Claude Code 看」。

**Approach C（Boil the Lake）**：rename `UploadFailureCode → UploadIssueCode`、加
`severity: 'error' | 'warning' | 'info'`，pre-flight 跟 post-failure 共用同一個
mental model + 元件 + i18n + LLM。三層：

- **Tier 1（client）**：zip.js 讀 EOCD + central directory，掃 node_modules /
  build artifacts / package.json / Dockerfile（< 3s budget）
- **Tier 2（server）**：`POST /api/upload/precheck`，查 name / domain / quota，
  + GCS signed-URL probe（真 PUT 0-byte，不是 getMetadata theater）（< 1.5s budget）
- **Tier 3（LLM advisory）**：reuse `callLLM` chain，severity=info，settings 可關
  （< 3s budget，timeout silent skip）

**Spec Review Loop 跑兩輪**：
- Iteration 1：6/10，13 issues
- Iteration 2：**8/10 PASS**（top 3 fatal 都修：ZIP64 spike 變 gate / GCS probe
  變真 PUT / rename + feature 切 2 commits）
- Reviewer 結論：「ship the spike first, then build」

**Design doc**：`/Users/smalloshin/.gstack/projects/smalloshin-smalloshin.github.io/smalloshin-pr-sync-all-design-20260425-200517.md`
（Status: APPROVED，conditional on spike）

**剩 7 個 execution-detail（build 時邊處理）**：
- N1 ⚠️ `precheck_tokens` TTL 30s 太短 → 改 5min 或 refresh-on-use
- N2 ⚠️ Tier 2 < 1.5s 裝不下 GCS probe + 3 DB queries → spike 量真實 latency
- N3 ⚠️ Commit 2 還是大 → 切 2a（server only）/ 2b（UI wiring）
- N4 precheck_tokens 沒 migration plan
- N5 GCS probe 留 orphaned `__precheck/*.probe` → bucket lifecycle rule
- N6 Commit 1 「zero behavior change」字面不對 → 改「type-compatible, additive only」
- N7 Test plan 漏：token expiry 中途、N concurrent probe、Tier 1 過 / Tier 2 中途 cancel、Tier 3 LLM 3s timeout

**待辦（明天開工順序）**：

1. **Spike P2（zip.js + ZIP64 1.5GB browser）**——這是 gate，不過直接重議 Approach B：
   ```bash
   cd deploy-agent/apps/web && bun add @zip.js/zip.js
   # 寫 ~80 行 spike 收 3 種 zip：50MB / 1GB+ / ZIP64
   # 量 CD size、entry count、heap delta（DevTools Memory tab）
   # 判準：
   #   ✅ < 2s + heap < 100MB → Approach C 直接幹
   #   ⚠️ < 5s + heap < 300MB → 加 progress 拆兩階段繼續
   #   ❌ > 5s OR heap > 300MB OR OOM → 回 office-hours 重議 Approach B
   ```
2. Spike 結果寫回 SESSION_HANDOFF.md（pass / warn / fail + 數字）
3. 過 spike 才開工 Commit 1（rename + severity field，~30 min CC）

---

**2026-04-24 —— 上傳錯誤 UX 升級：typed registry + LLM fallback + draft 保留（commit `02bf5aa`）**

走 `/office-hours 幫我設計一下上傳檔案的功能` 從診斷到全量實作。使用者一句話定調：
**「立刻做到好！不要下個月再說」**——直接走 Approach C 完整版。

**Wedge 確認**：問題不是「進度條/上傳速度」，而是「失敗時你不知道怎麼辦」——
之前所有上傳 catch 都是 `setError((err as Error).message)` + 一坨字串，自己用都會踩雷。

**設計核心：Failure Mode Registry**

每個錯誤都有 `code: UploadFailureCode`（discriminated union），對應一個 i18n key + 可恢復動作。
Server 出 envelope，client 用 `mapEnvelope()` 轉 `UploadFailure` 渲染。沒命中的（`code === 'unknown'`）
client 主動 POST `/api/upload/diagnose`，server 用 LLM (Claude → GPT-5.4 → rule-based) 給用戶看的繁中分析。

**14 個錯誤碼涵蓋全 7 個 stage**（validate/init/upload/submit/extract/analyze/deploy）：
file_too_large_for_direct, file_extension_invalid, init_session_failed, gcs_auth_failed, gcs_timeout,
network_error, submit_failed, extract_failed, extract_buffer_overflow, analyze_failed, domain_conflict,
project_quota_exceeded, unknown — 每個都帶 retryable flag + recoveryHint i18n key。

**新檔**：
- `packages/shared/src/upload-types.ts`（typed registry + envelope schema + draft schema）
- `apps/web/lib/upload-error-mapper.ts`（mapEnvelope/mapClientError/fetchDiagnostic/buildErrorReport）
- `apps/web/lib/upload-draft-storage.ts`（localStorage 草稿 7 天 TTL，debounced save 500ms）
- `apps/web/app/components/UploadErrorBlock.tsx`（DS 4.0 token UI，重試/取消/複製錯誤報告）
- `apps/api/src/services/upload-diagnostic.ts`（reuse `callLLM` from llm-analyzer.ts，12s timeout，rule-based fallback）

**改動**：
- `apps/api/src/routes/projects.ts`：所有上傳 catch 改用 `uploadError(stage, code, message, opts)` helper 統一出 envelope。
  新增 `POST /api/upload/diagnose` 端點。**向後相容**：envelope 同時帶 legacy `error` 欄位。
- `apps/api/src/services/llm-analyzer.ts`：把 `callLLM` 從 internal 改 export（一行）給 upload-diagnostic 重用。
- `apps/web/app/page.tsx` (SubmitModal) + `apps/web/app/projects/[id]/page.tsx`（升版 modal）：
  refactor 三段式 try/catch（init / upload / submit），每段都吐 envelope 走 mapper，
  Cancel 用 xhrRef.abort()，Retry 不丟表單。homepage 加 draft restored banner。
- `apps/web/package.json` + `next.config.ts`：補 `@deploy-agent/shared` workspace dep + `transpilePackages`。
- `apps/web/messages/{zh-TW,en}.json`：新增 `projectDetail.uploadErrors` 區塊（14 個訊息 + recovery hints + LLM category labels）。

**驗證**：`npx tsc --noEmit` 全部 clean（api / web / shared）。Bot 有 pre-existing TS error
（sendTyping on PartialGroupDMChannel）跟此次無關。

**狀態**：✅ 已 push + prod deploy（使用者授權「都做」）。
- Push：`pr/sync-all` → `wave-deploy-agent/main` (`0e2fd85..cd03341`，2 commits)
- Build：`3ec0da84-7b11-4fa4-b606-452a3f264c1b` SUCCESS（9 分 6 秒，SHORT_SHA=`cd03341`）
- Cloud Run revisions：api `00130-kw4` / web `00093-kpb` / bot `00041-28d`（traffic 100% 新 rev）
- Smoke：`/health` 200 / `/api/projects` 200 / web home 200
- Envelope live：`POST /api/upload/init` 空 body 回 `{ok:false, stage:"init", code:"init_session_failed", retryable:false, error:"fileName is required"}`（新 schema + legacy 欄位都在）

接續前一天 polish batch 2 後使用者回 `推 prod 推 prod`，先推 batch 2（build `9870625d` SUCCESS，
revision 00088-76x → 00089-cvc，CSS hash 維持 `e925b539b76f20bc.css`），然後走 backlog：

1. **Worktree 根 stale workspace 清理（commit `7b51c9d`）** —— Pitfall #24 的根源修法：
   - `git rm -r apps packages cloudbuild.yaml docker-compose.yml package.json package-lock.json turbo.json tsconfig.base.json`
   - `rm -rf node_modules`
   - 66 files deletion，只留 `.claude/ .gstack/ brain/ deploy-agent/ skills/ terraform/` 與 `CLAUDE.md`
   - `brain/` 有分歧（root 有 unique `runbooks/` + RBAC plan），保留
   - 之後 `gcloud builds submit` 誤從根跑的風險歸零

2. **projects/[id]/page.tsx fontSize + borderRadius 全數 token 化（commit `974024f`，125 處）**：
   - fontSize 12/13/14 → `var(--fs-xs)`（87 處）
   - fontSize 16 → `var(--fs-sm)`、18 → `var(--fs-md)`（2 處）
   - fontSize 10/11 保留 literal（micro meta，低於 DS scale）
   - borderRadius 4/6/8 → `var(--r-sm)`（54 處）
   - borderRadius 12 → `var(--r-md)`（2 處）
   - `npx tsc --noEmit` clean

3. **Prod deploy（build `a1d7e5c8` SUCCESS, 7m52s）**：
   - 第一次 submit 忘了帶 `--substitutions=SHORT_SHA=` → 踩到 **Pitfall #21**（已記錄）→
     build step 0 `invalid reference format`（tag 結尾 `:`），FAIL
   - 補 `--substitutions=SHORT_SHA=$(git rev-parse --short HEAD)` → SUCCESS
   - Web revision 00089-cvc → 00090-r8n
   - CSS 無變動（純 inline style token 替換）

**2026-04-21 —— Design System 4.0 落地（anchor `projects/[id]` redesign + DESIGN.md + tokens）**

接續前一天 UI / 部署坑之後，走 `/design-html` 全站 redesign。使用者明確要求：「全部重新設計，不用
拘泥於現有格式。字可以放大一點，目前的太小比較看不清楚」。

**產出：**

1. **Anchor HTML**：`~/.gstack/projects/smalloshin-smalloshin.github.io/designs/deploy-agent-redesign-20260420/finalized.html`
   - 以 `projects/[id]` 為錨，完整 app shell：240px sidebar + main 內容（max 1400）+ 2fr/1fr grid
   - Hero：專案名 36px bold + 綠色 pill「已上線」
   - 區塊：版本卡（v1 sea-50 highlight）、安全報告卡、部署時間軸（彩色圓點）、右欄快速動作／詳細資料／環境變數
   - Pretext 已 wire：`await document.fonts.ready` + `prepare()` + ResizeObserver
   - 響應式：960px sidebar 轉到上方、640px version/env row 堆疊

2. **DESIGN.md** （`deploy-agent/DESIGN.md`）：完整 4.0 token 文件
   - Typography：base 18px，scale 14/16/18/22/28/36/48，Inter + JetBrains Mono
   - Color：保留 sea brand，新增 ink scale（比舊 gray 高對比）、status 正名為 `--ok/--warn/--danger/--info`
   - Space 8px base（4/8/12/16/24/32/48/64）、Radius `--r-sm/md/lg/pill`
   - Components：pill（帶 8px dot）、button（primary/secondary/sm）、card、timeline
   - AI-slop 黑名單：紫藍漸層、三欄 feature grid、浮雕 blob 等
   - 驗證清單：字級、token 使用、3 viewport、狀態色、reduced-motion

3. **Tokens 落地** （`apps/web/app/globals.css`）：
   - sea 10 階 + ink 8 階 + 舊 gray 全部 alias 過去（零破壞）
   - status 正名（ok/warn/danger/info）+ legacy `--status-live/success/critical/warning/low/high/medium/info` 全保留
   - 所有 --fs-*、--sp-*、--r-* token 上
   - body 換 Inter + 18px；mono 換 JetBrains
   - `.pill` 重做成新 4.0 style（帶 leading dot）；`.pill-compact` 保留舊小圓章給 legacy
   - `.card` / `.btn-sm` / `.markdown-body h1-h3` 都用 token

4. **Font loading** （`apps/web/app/layout.tsx`）：
   - 用 `next/font/google` 掛 Inter（400/500/600/700）+ JetBrains Mono（400/500）
   - CSS 變數 `--font-inter` / `--font-mono` 注入 html element
   - `<main>` padding 32 48 64 + max 1400，對齊 app shell 規格

5. **`projects/[id]` 部分 port**：
   - Hero 改用 `--fs-2xl` 36px 700 + `-0.02em` letter-spacing
   - `Card` sub-component 重做（header 22px 600 + 可帶 subtle meta）
   - `InfoRow` 改 24px padding + top border 做 list 分隔、`overflow-wrap: anywhere`（避免 URL 斷在中間字元）
   - `BackLink` 用 `--ink-500` + `--fs-sm`
   - 其他 1900+ lines 的 inline style 先不動（透過 token alias 自動繼承新色階；body 18px 直接生效）

**驗證（localhost dev）**：
- body Inter / 18px / `#0b0e14` ✓
- bg `#f6f7f9`（--ink-50）✓
- `.btn-primary` sea-500 ✓
- TypeScript clean（`npx tsc --noEmit` exit 0）

**Prod deploy（build `ebca8c9b`）**：
- 第一次 `gcloud builds submit` 從 worktree 根跑，掃到**舊版 root `/apps/web`**（不是 `deploy-agent/apps/web`），結果 prod CSS `c04af6d58f5c4b53.css` 還是 Geist dark theme
- 第二次從 `deploy-agent/` CWD 重跑，tarball 從 2.1MB/220 files 縮到 1.3MB/129 files
- 新 CSS hash `e925b539b76f20bc.css` 開頭 `:root{--sea-50:#eff3fb;...}` ✓
- 新 revision `deploy-agent-web-00088-76x` ✓
- HTML 注入 next/font class `__variable_8b3a0b __variable_6d24ac` ✓
- 詳見 Pitfall #24（雙 apps/web 目錄陷阱）

**Sidebar DS 4.0 port**：
- width 220 → 240
- 取消 `--accent-blue` + `rgba(88,166,255,*)` 舊風格
- active：`--sea-50` 底 + `--sea-600` 文字 + `--r-md` 圓角
- item padding `--sp-3 --sp-4`、字 `--fs-md`、weight 500/600
- login link / logout button 全換 token

**DS 4.0 polish batch（commit `0ad8939` 後 + 本批）**：
- 8 頁完整 port：/, /login, /reviews, /deploys, /infra, /settings, /admin, /reviews/[id]
- 全換 heroStyle（`--fs-2xl` 36 + weight 700 + -0.02em letter-spacing）
- Table-in-card pattern：外包 `--r-lg` card，thead `--ink-50` + weight 600
- 所有 messages/banners 改 canonical `--ok-bg/--warn-bg/--danger-bg/--info-bg`

**DS 4.0 polish batch 2（本次）**：
- `projects/[id]/page.tsx` 清掉所有 hardcoded 色：
  - `#58a6ff` / `rgba(88,166,255,*)` → `--sea-500` / `--sea-50` / `--info`
  - `rgba(248,81,73,*)` (5 variants) → `--danger` / `--danger-bg`
  - `rgba(63,185,80,*)` (6 variants) → `--ok` / `--ok-bg`
  - `rgba(210,153,34,*)` / `rgba(255,200,87,*)` → `--warn` / `--warn-bg`
  - `rgba(139,148,158,*)` → `--ink-*` scale
  - `#f85149` / `#3fb950` / `#d29922` / `#8b949e` / `#db6d28` → tokens
  - `codeBlockStyle`：dark-mode 殘留的 `rgba(0,0,0,0.28)` + white border → `--ink-50` + `--ink-100` border
  - `SEVERITY_COLORS` + `strategyLabel` map → 全換 tokens
  - Modal 背景 `rgba(0,0,0,0.6)` → `rgba(11,14,20,0.5)`（DS 4.0 標準）
  - 唯一保留：`#8957e5` 紫色（environment/external，DS 沒紫色 token）
- `page.tsx` 三個 modal 全部 port：
  - `SubmitModal`：body `--surface-1` + `--r-lg` + `--sp-6` + `--shadow-md`，所有 `fontSize: 13/14` → tokens，drag zone `--ok`/`--sea-500` 邊框
  - `DomainConflictModal`：`--warn` 邊框 + `.btn-danger` confirm
  - `DeleteModal`：body + log area 全 token，confirm 換 `.btn-danger`
  - `ModalField`：label 500 + 6px margin + `--r-md` input + `--fs-md`
- `reviews/[id]/page.tsx` 補兩處：auto-fix badge `rgba(63,185,80,0.15)` → `--ok-bg`，diff pre `rgba(0,0,0,0.15)` → `--ink-50` + `--ink-100` border
- `admin/page.tsx`：modal backdrop `rgba(0,0,0,0.4)` → `rgba(11,14,20,0.5)`
- `lib/locale-switcher.tsx`：active 背景 `var(--accent-blue, #58a6ff)` → `--sea-500`，fontSize 11/12 → `--fs-xs`，borderRadius 4 → `--r-sm`
- TypeScript `npx tsc --noEmit` exit 0
- 尚未 push，等使用者確認再一次推 prod

**2026-04-20（下半場）—— UI `--status-live` 通過按鈕消失 + Cloud Build logsBucket 400（commits `56dbf46`, `54794e4`）**

連發兩個坑，都從一張 screenshot 抓到：

**Bug #1：通過按鈕按下去整個不見（`56dbf46`）**

reviews/[id]/page.tsx 的 approve/reject 按鈕用 `var(--status-live)` / `var(--status-live-bg)`
做底色，但 `globals.css` 的 brand palette refactor（`b0bef0d`）把 token 改成
`--status-success` / `--status-success-bg`，沒留 alias —— 結果 `var(--status-live)`
undefined，CSS fallback 成 initial（transparent），按鈕底色消失、白字在白底 → 看不見。
全站 20+ 處 JSX 都還在用 `--status-live`。

修法兩層：
1. `globals.css` 加 legacy alias `--status-live: var(--status-success)` —— 所有 20+
   處 JSX 一次救活，不用逐一改。
2. approve/reject 兩顆按鈕用 inline style 明確指定 `background: var(--status-success)` /
   `var(--status-critical)` + `color: var(--text-inverse)`，保證白字 + 綠/紅底，不再
   靠 CSS token 間接跳轉。

**Bug #2：新專案部署全部 400（`54794e4`）**

上一個 commit（`b5e9916`）把 `logsBucket` 放進 Cloud Build request 的 `options` 物件裡，
Google REST API 回 `INVALID_ARGUMENT: Unknown name "logsBucket" at "build.options"`。
效果：deploy-worker 呼叫 Cloud Build submit 直接 400 → 沒 build ID → 沒 log →
走「no log」fallback → dashboard 秀「平台問題」。

修法：`deploy-engine.ts` 把 `logsBucket` 移到 Build top-level：

```ts
// 錯：
options: { logging: 'GCS_ONLY', logsBucket: `gs://${gcsBucket}` }
// 對：
logsBucket: `gs://${gcsBucket}`,
options: { logging: 'GCS_ONLY' }
```

**Pitfall 記（#20）**：Cloud Build REST API `logsBucket` 是 Build 物件的**頂層**欄位，
不是 `options` 內層。文件和 `gcloud builds submit --gcs-log-dir` flag 都很容易讓人
以為是 options 的 sub-field。submit-time 直接 400，但如果沒盯 dashboard 的「新建專案
全部走 no-log fallback」現象，會以為是別的問題。

**Pitfall 記（#21）**：`gcloud builds submit --config cloudbuild.yaml .`（不經 trigger）
`$SHORT_SHA` 是空字串，會炸 `invalid reference format: docker tag ends with ':'`。
手動 submit 必須帶 `--substitutions=SHORT_SHA=<sha>`，或改 yaml 加 default value。
trigger 驅動的 build 才會自動塞真 commit sha。

**部署狀態**：
- `da0cce7a` SUCCESS（`56dbf46` —— UI 綠色按鈕 + `--status-live` alias + Layer 1 source
  context + Layer 2 pre-flight 全部到 prod）
- `cc5ac9de` SUCCESS（`54794e4` —— logsBucket top-level 修）
- `e9ec21aa` SUCCESS（`425b978` —— HTTP 429 分頁停久就跳的修法）
- API + Web health 200 ✓

---

**2026-04-20（延伸）—— HTTP 429「Failed to load project」停久就跳（commit `425b978`）**

使用者回報「三不五時會出現這個錯誤？特別是在一個網頁停得夠久的時候」—— screenshot
秀 429。根因兩層疊：

1. **API rate limit 太緊**：`apps/api/src/index.ts:51` 預設 `RATE_LIMIT_MAX=100` req/min
   per IP。公司/家裡 NAT 把所有同事的 request 當同一個 IP 算，多人共用很快爆。
2. **Web 每頁 polling 不管前景背景**：
   - `projects/[id]/page.tsx` 每 5s 打 **2 個** endpoint（`loadDetail` + `loadVersions`）= 24 req/min
   - `page.tsx` (project list) + `reviews/page.tsx` + `deploys/page.tsx` 各 12 req/min
   - 分頁丟在背景，setInterval 還在偷打 API
   - 疊 2-3 個 idle 分頁 2 分鐘 → 100 滿 → 切回來或導航時 429

修法兩邊一起：
- **API**：預設 `RATE_LIMIT_MAX=600` req/min（10/sec，有足夠餘裕）；`/health` 進 `allowList`
  不吃額度（Cloud Run probe 不該跟 user 爭 quota）；env 可壓可放。
- **Web**：4 個 setInterval 每輪先 `if (document.hidden) return;` 跳過。背景分頁零成本。

**Pitfall 記（#22）**：`@fastify/rate-limit` v10 的 `allowList` 是 **IP/key 清單**，
字串元素會跟 request key 比對，**不是**路徑清單。要 skip 路徑必須傳 function
`(req) => req.url === '/health'`。一開始以為可以直接 `allowList: ['/health']` 是錯的。

**Pitfall 記（#23）**：SPA polling 預設 5s + 不管 document.hidden 非常燒額度。在背景
分頁累積一下午可以打爆 rate limit。長久一點的設計：visibility API + exponential backoff，
或乾脆換 WebSocket / SSE 才是對的。

**Pitfall 記（#24）**：worktree 根有**舊版 `/apps/`、`/packages/`、`/cloudbuild.yaml`**
殘留（monorepo 初期遺物），跟 `deploy-agent/apps/*` 兩份**長得一模一樣、各有不同內容**。
`gcloud builds submit --config cloudbuild.yaml .` 會把**當下 CWD** 整包上傳成 tarball，
從**根目錄**跑 → 打包根目錄的舊程式碼 + 根目錄的舊 cloudbuild.yaml（6 steps、沒有 bot）。

症狀是 Cloud Build 顯示 SUCCESS，prod CSS/HTML 卻是舊版。tarball size 是關鍵訊號：
從根目錄跑 **2.1MB / 220 files**（雙份），從 `deploy-agent/` 跑 **1.3MB / 129 files**（對的）。

**解法**：永遠 `cd deploy-agent && gcloud builds submit ...`。長遠解法：刪掉根目錄殘留
（`/apps/`、`/packages/`、`/cloudbuild.yaml`、`/package.json` 等 monorepo root 檔案），
要動到「實際部署產物」所以需要 Boss 授權再做。

---

**2026-04-20 —— LLM 診斷升級：餵 source code + Cloud Build pre-flight（commits `677162b`, `1dd6a3b`）**

使用者觀察到：Claude 在對話時能指出「好像有個 ts 檔出錯」，但 UI 的 LLM 診斷只會說
「判斷不出來 / 未知」。差距的根因：**UI LLM 完全沒看到 user source code**，只吃
Cloud Build 的高階錯誤文字（而且舊 log bucket 讀不到 → 空 log fallback）。

使用者明確要求「讓 UI 做到跟你一樣的事情」。方案兩層：

**Layer 1 — 餵 source code 給 LLM（commit `677162b`）**

新檔 `apps/api/src/services/source-reader.ts`：
- `extractErrorLocations(buildLog)` — 從 log 尾端 regex 出 `file.ts:47:5` 這種
  「檔名:行號」，自動過濾 node_modules/.next/dist
- `readSourceContextFromDir(projectDir, buildLog)` — 本機 fs 讀
  （deploy-worker hot path 最快）
- `readSourceContextFromGcs(gcsUri, buildLog)` — 事後 reanalyze 從 GCS tarball
  拉到 /tmp 解壓（gcpFetch + shell tar，codebase 風格一致，零 npm lib）
- 每個 fingerprint 檔 cap 4KB、每個 snippet cap 3KB、最多 5 個 error-adjacent 檔

三條路徑都接上：
- deploy-worker Step 3 build 失敗 → projectDir 讀
- deploy-worker 其他 step 失敗 → projectDir 優先，不在就 GCS tarball
- reanalyze-failure endpoint → GCS tarball（pipeline 早結束）

`llm-analyzer.analyzeDeployFailure` 新增 optional `sourceContext?: SourceContext | null`
參數，format 成純文字區塊注入 user prompt：「【專案設定檔】package.json / tsconfig /
next.config ... 【錯誤位置附近的程式碼】src/app/foo.ts:47 …」。
「沒 log」fallback 也考慮 hasSource，只要有 source 就給 LLM 試一次。

**Layer 2 — Cloud Build pre-flight（commit `1dd6a3b`）**

TS 專案在 docker build 前先跑 `tsc --noEmit`，錯誤以乾淨 stderr fail fast，
不用等 `next build` 在 docker 裡跑 5 分鐘才發現：

```
steps:
  - name: node:22-alpine  (或 oven/bun:1 / corepack pnpm|yarn)
    entrypoint: sh
    args: -c 'install + npx --no-install tsc --noEmit'
    id: preflight-tsc
  - name: gcr.io/cloud-builders/docker
    args: build ...
```

啟用條件：
- `detectedLanguage === 'typescript'` + projectDir 有 tsconfig.json + 偵測到 pkgMgr
- env `DEPLOY_PREFLIGHT` 不等於 '0'（預設開）

Trade-off：happy path 多 60-90s install（跑兩次），fail 時省 3-5min docker build +
拿到最乾淨的「檔名:行號: TSxxxx: ...」stderr → 直接餵 Layer 1 的 source-reader +
LLM → 預期從「判斷不出來」升級到「`src/app/foo.ts` 第 47 行的 `foo.qux()` 少
import，改成 `import foo from 'bar'`」這種精確修法。

**驗證計劃**：
1. push + 重新部署 API（deploy-agent Cloud Run）
2. 找一個會 TS 錯誤的測試專案部署，確認 pre-flight 在 docker 前就 fail
3. 檢查 build log bucket 拿到 tsc 乾淨輸出
4. 確認 dashboard 失敗面板秀出具體檔名:行號 + 修法

**Pitfall 記（#19）**：LLM 診斷品質 = context 品質。給它 log 尾端 8KB 不夠，
package.json + tsconfig + 錯誤行 ±50 行程式碼才是關鍵。這跟「人類開發者」排
錯流程一樣 —— 看報錯訊息先定位檔案，再打開看程式碼判斷怎麼改。

---

**2026-04-19（深夜 QA）—— 雙面向診斷 UI 的舊資料坑（commit `8310032`）**

跑 `/qa` 對 prod dashboard 做 diff-aware 測試，發現**雙面向診斷 UI 對舊資料完全失效**：

- gam-publisher 的 `buildDiagnosis` 是 04-18 產的舊格式（只有 category / summary / rootCause / extraObservations...）
- 新欄位 `ownership` / `userFacingMessage` / `adminFacingMessage` **都是 undefined**
- UI 邏輯是 `{diag ? <rich> : <fallback-with-reanalyze-btn>}` —— 舊 diag 走 rich 分支但渲染不出任何使用者面向內容
- **最慘：reanalyze 按鈕藏在 else 分支，admin 也點不到**

修法（`deploy-agent/apps/web/app/projects/[id]/page.tsx`）：
1. `diag` 存在但缺 `userFacingMessage` → 秀灰色虛線框提示「這是舊版診斷格式…管理員可重新分析」
2. Reanalyze 按鈕搬出三元式，改 `isAdmin && (...)` 永遠秀，文字動態：
   - 有 diag：「🤖 重新分析（刷新診斷）」
   - 沒 diag：「🤖 用 AI 重新分析失敗原因」
3. 順手 `e73be6e` 加 `*.tsbuildinfo` 到 gitignore（每次 build 都 dirty）

**QA report**：`.gstack/qa-reports/qa-report-deploy-agent-web-2026-04-19.md`
**待 push + Cloud Build 重新部署 web app 才能在 prod 驗證**

Pitfall 學到（#18）：**diag schema 加欄位要想好 migration**。老資料不會自動補欄位，
UI 渲染邏輯必須同時處理「新格式」和「缺欄位的舊格式」兩種狀態，不能只靠
`{diag ? ... : ...}` 就以為搞定。未來 schema 升級直接寫一次 batch reanalyze 回填。

---

**2026-04-19（晚上）—— 部署失敗分析加「使用者面向／管理員面向」雙面向（commit `27ba13b`）**

使用者明確指出目前的錯誤訊息是管理員面向的（IAM、bucket、SA 等術語），
但使用者面向的訊息才應該是主要顯示內容。需求：
> 「可能是 code 錯，或是我們的 code 錯。我必須要能夠讓使用者與管理員看到
> 到底是誰的錯，誰需要修正，修正哪裡」

**`BuildFailureAnalysis` 型別擴充**：
- `ownership: 'user' | 'platform' | 'environment' | 'unknown'` — **最重要的新欄位**
- `userFacingMessage` — 使用者面向，禁用 infra 術語
- `adminFacingMessage` — 管理員面向，技術細節
- `userActionable` / `platformActionable` — 誰要行動

**LLM prompt 明確要求拆兩面向**：
- User 語氣像朋友說話，告訴他「你的 X 第 Y 行改成 Z」
- Platform 問題明確告訴使用者「這不是你的錯」
- 沒給 ownership 時靠 category auto-infer
  （user_code/dep/config/runtime→user / infra→platform / network→environment）

**Dashboard UI 重寫**：
- Ownership pill 最醒目（👤 你的程式碼需要修正 / 🔧 平台問題，管理員處理中 /
  🌐 環境問題 / ❓ 判斷不出來）用不同色調
- 使用者面向訊息放最上、用 ownership 色調 highlight
- **管理員技術細節**折疊在 `isAdmin && showAdminDetail` 區塊，非 admin 完全看不到
- admin 區內含 adminFacingMessage / rootCause / actionable 狀態 / raw error / stack
- `useAuth()` → `role_name === 'admin' || permissions.includes('*')` 判斷

**寫入點都更新**：deploy-worker（第一次失敗）+ reanalyze-failure endpoint（回填舊失敗）

---

**2026-04-19（傍晚）—— Reanalyze 拿不到 log 的踩雷 + 自有 bucket 修法**

使用者測試第一版 reanalyze 對 gam-publisher 沒效，LLM 產出「未知 / 一堆通用排查清單」。
追查發現 `[Reanalyze] Build log fetch returned HTTP 403`。

**根因（重要踩雷）**：
Cloud Build legacy logging 模式把 log 寫到
`gs://{PROJECT_NUMBER}.cloudbuild-logs.googleusercontent.com`
這 bucket 是 **Google 內部管理**的，**連 project owner 都看不到 IAM policy**，
deploy-agent SA 無法被授權讀取 → HTTP 403 → buildLog = '' → LLM 在「僅根據錯誤
訊息推理」模式下幻覺產通用建議。

**commit `b5e9916` 三層修法**：

1. **`deploy-engine.ts`** — 新 build 加 `options.logsBucket: gs://{ourBucket}` +
   `logging: 'GCS_ONLY'`，未來所有 build log 寫進我們自有的
   `wave-deploy-agent_cloudbuild`（已有完整 admin）
2. **`llm-analyzer.ts analyzeDeployFailure`** — log 為空時**直接不叫 LLM**，
   回結構化 fallback（說明拿不到 log 的真正原因 + Cloud Build console 連結 +
   建議重試）。避免幻覺
3. **`routes/projects.ts reanalyze-failure`** — 嘗試兩種 log 路徑
   （`log-{id}.txt` / `{id}.log`）；把 log fetch 失敗原因（HTTP 403 / 沒 logsBucket
   / regex miss）放進 response body（`logFetched`, `logBytes`, `logFetchNote`）
   方便 debug

**部署**：Cloud Build `4662cdf4` SUCCESS，Cloud Run `deploy-agent-api-00119-g64` 上線

**對 gam-publisher 的結論**：舊 build log 永遠拿不到。使用者需要「升版部署 / 重試流程」
跑一次新 build（會用新 bucket），**新失敗之後**再點 reanalyze 才會出正常診斷
（預期指向 `src/app/api/cron/sync/route.ts:47` `processAndStore` 多傳一個參數）。

---

**2026-04-19（下午）—— 部署失敗 LLM 診斷 + 舊失敗 reanalyze 回填**

重大修繕（2 commit 連續上線，解決「部署失敗根本沒跑 LLM」的陳年 bug）：

1. **`b98bac2` — 部署失敗時自動跑 LLM 診斷 + dashboard 完整顯示**
   - 根因：之前 `deploy-engine.ts` 有 silent catch（`catch { /* ignore */ }`），
     讓 `buildLog` 永遠是空字串；`deploy-worker.ts` Step 3 裡 `if (buildResult.buildLog)`
     guard 直接 skip LLM call → 所以 LLM 根本沒跑過
   - 修法：
     - `deploy-engine.ts` silent catch 改成 `console.warn` 吐原因
     - `deploy-worker.ts` 拔掉 `if (buildLog)` guard，build failure 一定跑 LLM
     - main catch 擴充：其他 step（deploy/domain/ssl）失敗也跑
       `analyzeDeployFailure`（llm-analyzer 新的一般化 API）
     - `llm-analyzer.ts` 擴欄位：`errorSnippet` / `extraObservations` / `step`，
       category 加 `runtime` / `network`
     - `discord-notifier.ts` 對齊新欄位
     - `apps/web/app/projects/[id]/page.tsx` 失敗 banner 完整 render：
       `summary` → `errorLocation`（code tag）→ `errorSnippet`（pre block）
       → `rootCause` → 💡 修復建議（藍色 accent box）→ 附加觀察（黃色 warning）
       → 原始錯誤訊息（collapsed details）
   - 部署：Cloud Run `deploy-agent-api-00117-b4h` ✅

2. **`7058175` — POST /api/projects/:id/reanalyze-failure（舊失敗回填）**
   - 背景：現存 `failed` transition 的 metadata 不會自動回填，
     像 gam-publisher 這種在 LLM 上線前就失敗的專案需要手動觸發
   - 端點行為：
     - 讀取最新 `to_state='failed'` transition metadata
     - Regex `/builds\/([a-f0-9-]{36})/i` 從 error 字串抽 Cloud Build ID
     - 重抓 Cloud Build metadata → GCS `log-{buildId}.txt`
     - 呼叫 `analyzeDeployFailure`
     - `UPDATE state_transitions SET metadata = metadata || $1::jsonb`（jsonb merge）
   - Dashboard UI：失敗 banner 在 `!diag` 分支多一顆
     「🤖 用 AI 重新分析失敗原因」按鈕 → 點一下打 API → 成功後 `loadDetail()`
     頁面自動刷新出完整診斷
   - 權限：`projects:deploy`
   - 部署：Cloud Build 手動提交中（bfr1u4lzj）

**驗證路徑**（部署完後對 gam-publisher 跑）：
`curl -X POST -b cookies 'https://.../api/projects/{gam-publisher-id}/reanalyze-failure'`
預期應該回 `{ diagnosis: { category: 'user_code', errorLocation: 'src/app/api/cron/sync/route.ts:47',
errorSnippet: 'await ReportProcessorService.processAndStore(dateStr, rawCSV);',
rootCause: 'processAndStore 只接受 1 個參數，但程式碼傳了 2 個', ... } }`
（來源：f53e4bf6 build log 顯示的 TS error）

---

**2026-04-19 —— Review decide 500 修正 + GPT fallback 統一 + admin 改密碼 UI**

三件小修繕（commit `a6dd8aa`，Cloud Build `e664734d` 8M27S SUCCESS，
API 切到 `deploy-agent-api-00116-4hp`）：

1. **`/api/reviews/:id/decide` 500 Internal Server Error**
   - 根因：`reviewSchema.parse()` 在 email 不合法時拋 `ZodError`，Fastify 沒 catch → 500
   - 修法：改用 `safeParse`，失敗回 400 + flatten details。
   - 同時 `reviewerEmail` 變 optional，**優先用 `request.auth.user.email`**（登入後自動帶）
   - 前端 `apps/web/app/reviews/[id]/page.tsx` 用 `useAuth()` 預填 email 欄位
   - 驗證：curl 帶壞 email → 400（修前是 500）✅

2. **OpenAI fallback model 統一 gpt-5.4**
   - `apps/bot/src/nl-handler.ts:208` 從硬寫 `'gpt-4o-mini'` 改為
     `process.env.OPENAI_MODEL ?? 'gpt-5.4'`
   - API（`llm-analyzer.ts` / `resource-analyzer.ts`）本來就是 gpt-5.4，現在 Bot 也對齊

3. **Admin 改密碼 UI**
   - `apps/web/app/admin/page.tsx` user 列表 actions 欄多一顆「改密碼」按鈕
   - 點擊彈出 modal（新密碼 + 確認），打既有的 `PATCH /api/auth/users/:id`
   - 補 7 個 i18n key：`changePassword`, `changePasswordTitle`, `newPassword`,
     `confirmPassword`, `passwordMismatch`, `passwordTooShort`, `saving`, `save`

---

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
- [ ] **Design System 4.0 推其他頁**：anchor + tokens 已落地。還要 port 的頁：
      `/` (project list)、`/reviews`、`/reviews/[id]`、`/deploys`、`/infra`、`/settings`、`/admin`、`/login`。
      anchor HTML 在 `~/.gstack/projects/smalloshin-smalloshin.github.io/designs/deploy-agent-redesign-20260420/finalized.html`；
      DESIGN.md 在 `deploy-agent/DESIGN.md`；globals.css 已含 alias 不會打壞舊頁
- [ ] **RBAC 系統實作（plan 已定）**：見 `~/.claude/plans/lively-petting-sifakis.md`。
      47 個 API 端點目前裸露，規劃加入 users/roles/sessions/api_keys/auth_audit_log 5 張表 +
      Fastify onRequest hook + 3-phase migration（PERMISSIVE → 更新消費者 → ENFORCED）。
      目前已有基礎（`/api/auth/*` routes + `middleware/auth.ts` + `auth-service.ts`），
      需全面串 route → permission map + 消費者（Bot / MCP / Web）都吃 credentials
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
16. **Cloud Build 預設 legacy logs bucket 讀不到**（2026-04-19 踩雷）：未指定 `options.logsBucket` 時，log 寫到 `gs://{PROJECT_NUMBER}.cloudbuild-logs.googleusercontent.com`，這是 Google 內部管理的 bucket，**連 project owner 都看不到 IAM policy**，不能被授權。解法：建 build 時永遠指定 `options: { logging: 'GCS_ONLY', logsBucket: 'gs://{自有bucket}' }`，日後 deploy-agent 才讀得到。參考 `deploy-engine.ts buildRequest.options`。
17. **LLM 沒 log 就別亂叫**（2026-04-19）：`analyzeDeployFailure` log 為空時不要呼叫 LLM，會產「推理式」幻覺給使用者一堆無用通用建議。直接回 structured fallback（`provider: 'fallback'`）說明實情並附 Cloud Build console 連結比較誠實。

### 使用者偏好（Boss 習慣）
- 直接給結論、不要囉嗦
- 跟 GCP convention 一致就好，不用自己發明
- 遇到 gcloud 找不到：路徑在 `/usr/local/share/google-cloud-sdk/bin/gcloud`
- 驗證 UI 時用 Chrome MCP 截圖

### 資源盤點（2026-04-05）
- Cloud Run services：只剩 `deploy-agent-api` + `deploy-agent-web`（使用者自己的專案都已清掉）
- GCS sources：61 個 tarball / 12.91 MiB（含歷史：bid-ops, kol-studio, luca-*, wave-test 等）
- Artifact Registry：api image 37+ 版本未清
