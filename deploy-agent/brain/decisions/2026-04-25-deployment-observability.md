# 2026-04-25 — Deployment Observability（3 層架構）

## Context

過去使用者只看得到 `deployments.health_status` 的單一狀態（unknown / healthy / failed），看不到 deploy 走到哪一階段、為什麼失敗。Bot/MCP 通知只有「成功」或「失敗」兩種結果，使用者要去翻 Cloud Build console / Cloud Run console 才能 debug。office-hours 對話中決定加上完整的部署觀測 stack。

最早 scope 包含 4 層（Tier 4 = 「即時 cost / latency 指標」），但被 kill 掉，理由：一人創業階段成本沒到關鍵路徑、會引入 Cloud Monitoring API 維護成本、跟 deploy 失敗 debug 沒直接相關。最終 scope 收斂為 3 層。

## Decision

### Tier 1 — Timeline（每次 deploy 的 7 階段時間軸）

7 個 stage 是固定 state machine：`upload → extract → build → push → deploy → health_check → ssl`。

新增 `deployment_stage_events` table（不是改現有的 `state_transitions`，因為兩者抽象層不同）：

```sql
CREATE TABLE deployment_stage_events (
  id BIGSERIAL PRIMARY KEY,
  deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE,
  stage VARCHAR(32),     -- upload | extract | build | push | deploy | health_check | ssl
  status VARCHAR(16),    -- started | succeeded | failed | skipped
  metadata JSONB,
  created_at TIMESTAMPTZ
);
```

- `state_transitions` 是 orchestrator-level 的 project state（submitted/scanning/approved/...）
- `deployment_stage_events` 是 single-deployment 的 sub-stage transitions

`recordStageEvent()` 是 best-effort：DB 寫入失敗 **不能** 讓部署 crash。觀測性不能影響業務本身。

API：`GET /api/deploys/:id/timeline` 回傳 `{ deployment, overall, stages, events }`；overall 是 `failed > running > succeeded > pending` 的 priority resolver。

UI：`DeploymentTimeline.tsx` 是橫向 stepper，pulsing dot 動畫表示 in-flight stage。Detail page 自動 5s 輪詢直到 terminal。

### Tier 2 — LogStream（SSE 即時事件 + 事後 build log）

**為什麼 SSE 不是 WebSocket**：deploy events 是單向（server → client），SSE 走 HTTP 不需要額外協議升級，自帶 reconnect + Last-Event-ID resume，適合 Cloud Run（沒有 sticky session）。

**Per-deployment in-memory ring buffer（N=2000）**：每個 deployment 有 monotonic seq + EventEmitter + ring buffer。Client 用 `Last-Event-ID` header reconnect，server replay 從那 seq 之後的事件。如果 client 落後超過 ring window，server 送 synthetic `gap` event，client refetch `/timeline` 拿 fresh state。

**Memory lifecycle**：terminal 後 10 min 自動 purge（schedulePurge）。避免長期累積 buffer。

**Build log 是 post-mortem，不是 live**：deploy-engine 目前在 build 結束才會 expose `buildId`，要做 live tail 需要 refactor。Commit 2 範圍只做 stage events live + build log 點擊載入。Live build log 留作 follow-up commit。

### Tier 3 — Diagnostic（LLM 解釋失敗原因，server-side cache）

按 build_id（build 失敗時）或 deployment_id（其他失敗）建 cache key，UNIQUE (cache_key, kind) 強制單一 LLM 呼叫。

**為什麼 GET 跟 POST 分開**：
- `GET /diagnose` → read-only，cache 沒命中就 404，**永遠不會** 觸發 LLM
- `POST /diagnose` → 顯式付錢按鈕觸發；race condition 用 `ON CONFLICT DO NOTHING + 重讀 winner` 收斂

**LLM provider**：reuse `callLLM()`（Claude → GPT fallback），不另外做。輸出強制 bilingual zh-TW / en（prompt 指定）。

UI：`DiagnosticBlock.tsx` 只在 `overall === 'failed'` 時 render；mount 時先 GET（拿過去的快取），用戶按「Explain why」才 POST。

### Tier 4 — Killed（為什麼）

「即時成本／延遲圖表」對一人創業階段沒進入 critical path：
- 成本資訊已經有現成 GCP billing dashboard
- Latency p95 對單純的部署觀測沒幫助（要的是 deploy 卡哪、為什麼）
- 引入 Cloud Monitoring metrics API → 多一個 IAM scope + 多一個失效點

Tier 1+2+3 已經涵蓋「我這次 deploy 到底發生什麼事」全部問題。

## Consequences

### Pros
- **使用者三層 mental model 一致**：timeline 看「走到哪」，logstream 看「正在發生什麼」，diagnostic 看「為什麼失敗」
- **成本可預測**：LLM 只在使用者顯式按鈕時花錢，且 cache by immutable key（同一個 build_id 不會花兩次）
- **觀測性永不影響業務**：所有 stage event 寫入是 best-effort，DB 失敗只 console.warn
- **Reconnection 友善**：SSE Last-Event-ID + ring buffer + gap event，client 斷線不會丟資料
- **零新依賴**：sse 用 fastify reply.hijack + native EventSource；no socket.io、no Pusher
- **Tests 39/39 pass**：stage-events 10 + timeline-route 7 + event-stream 15 + diagnostics 7

### Cons / 已知妥協
- **Build log 不是 live**：要看 build 過程必須等 build 結束（post-mortem fetch）。Live tail 需要 deploy-engine refactor 把 buildId 提早 expose。
- **Ring buffer in-memory**：API 重啟時所有 in-flight deploy 的 SSE buffer 會掉，client 會看到斷線（但 DB 還有 event，重連後 timeline 是對的）
- **Tier 4 缺**：使用者要查歷史成本／延遲趨勢得另外去 GCP billing dashboard

### 實作順序（4 個 commits）
- `5130777` Phase 1: spike scaffolding
- `12c1ed1` Commit 0: stage events table + worker hooks + service
- `e1c6363` Commit 1: timeline endpoint + DeploymentTimeline UI
- `3ccec46` Commit 2: SSE stream + LogStream + post-mortem build log
- `c01655d` Commit 3: LLM diagnostics

## Status

Active

## Files

- `apps/api/src/services/stage-events.ts` — recordStageEvent + summarizeStages
- `apps/api/src/services/deployment-event-stream.ts` — SSE pub/sub + ring buffer
- `apps/api/src/services/build-log-poller.ts` — async-gen poller + fetchBuildLogOnce
- `apps/api/src/services/deployment-diagnostics.ts` — LLM cache + diagnose
- `apps/api/src/routes/deploys.ts` — /timeline /stream /build-log /diagnose
- `apps/web/app/components/DeploymentTimeline.tsx` — 7-stage stepper
- `apps/web/app/components/LogStream.tsx` — SSE consumer
- `apps/web/app/components/DiagnosticBlock.tsx` — LLM analysis UI
- `apps/web/app/deploys/[id]/page.tsx` — 整合三層的 detail page
