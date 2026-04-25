# 2026-04-26 — Live Build-Log Streaming via onBuildStarted Hook

**Status**: Active

**Supersedes part of**: [2026-04-25-deployment-observability.md](./2026-04-25-deployment-observability.md)
（原本 Commit 2 故意砍 live tail 留作 follow-up，這份 ADR 把它做完）

---

## Context

部署觀測性 Tier 2（SSE log stream）shipped 之後，build log 是 **post-mortem only**：
要等 `buildAndPushImage()` 整個 return 後才能拿到 `buildLog`，再透過 GET `/api/deploys/:id/build-log`
一次性下載。使用者在 build 進行的 5-10 分鐘期間 UI 是黑盒——這正是當初要解決的 wedge，
卻在第一刀 ship 時被遺留。

技術阻擋是「buildId 太晚 expose」：

- Cloud Build POST `/v1/projects/{p}/builds` 回傳的 operation metadata **第一秒**就有 `metadata.build.id`
- 但既有的 `buildAndPushImage` 把 buildId 藏在 polling loop 裡，只在最終 return 物件露出來
- `pollBuildLog()`（async generator，2s GCS poll）已經寫好且測過，是 idle waiting 的
- 所以唯一缺的是「buildId 早點 leak 出來」這條訊號

---

## Decision

加一個 **`BuildHooks.onBuildStarted` callback**，在 `buildAndPushImage` 拿到 buildId 的當下就 fire。
deploy-worker 收到 callback 後 **立刻** spawn 一個背景 `streamBuildLogToDeployment()`
任務，把 `pollBuildLog` 的 chunks 透過 `deployment-event-stream.publish('log', ...)` 廣播
出去，跟既有的 stage events 共用同一條 SSE stream。

### 介面設計

```typescript
// deploy-engine.ts
export interface BuildHooks {
  onBuildStarted?: (info: { buildId: string; bucket: string }) => void;
}

export async function buildAndPushImage(
  projectDir: string,
  config: DeployConfig,
  gcsSourceUri?: string,
  hooks?: BuildHooks,
): Promise<{
  success: boolean;
  imageUri: string;
  error: string | null;
  buildLog?: string;
  buildId?: string;     // ← 成功失敗都帶回，方便 caller 收尾
}>
```

callback 在「拿到 buildId、開始 polling 之前」就觸發，throw 不會炸 deploy（catch + warn）。

### Worker 端 wiring

```typescript
// deploy-worker.ts（buildAndPushImage 呼叫處）
const buildLogAbort = new AbortController();
let buildLogPromise: Promise<void> | null = null;

const buildResult = await buildAndPushImage(projectDir, config, gcsSourceUri, {
  onBuildStarted: ({ buildId, bucket }) => {
    void recordStageEvent(deploymentId, 'build', 'started', { build_id: buildId, bucket, live_log: true });
    buildLogPromise = streamBuildLogToDeployment({
      deploymentId, buildId, bucket, abortSignal: buildLogAbort.signal,
    });
  },
});

// build 結束（不管成功失敗），cancel poller，等它收尾
buildLogAbort.abort();
if (buildLogPromise) { try { await buildLogPromise; } catch {} }
```

關鍵：

1. **背景 task，不 await**——streaming 跟 polling 並行，不擋 build
2. **AbortController 主導生命週期**——build 一結束就 abort，poller 看到 signal aborted return 出 generator
3. **Promise 回收**——abort 後 await 一次 silent，避免 unhandled rejection
4. **best-effort**——publish/poller throw 都不能炸 deploy

### Stream 事件協議（新增 3 種 meta 訊號）

跟既有的 stage events 共享 SSE stream，用 `kind` 區分：

| Type | kind | 時機 |
|------|------|------|
| `meta` | `build_log_stream_started` | hook 觸發，poller 起跑 |
| `log`  | （無 kind，payload 含 chunk）| 每個 chunk yield |
| `meta` | `build_log_stream_error`   | poller throw（GCS 物件遲到、權限錯）|
| `meta` | `build_log_stream_ended`   | finally guard，**aborted 不 emit**（避免 UI 看到誤導訊息）|

`log` payload shape：

```ts
{
  build_id: string,
  bytes_offset: number,    // 0-based, append-only invariant
  text: string,
  lag_ms: number,           // observed_lag_ms from poller
  gcs_updated: string,      // ISO timestamp
}
```

### Test 策略

加 `__pollerForTest?: (...) => AsyncGenerator<BuildLogChunk>` 注入點到
`streamBuildLogToDeployment`。production code 走真 `pollBuildLog`，test 餵 fake
generator。**5 個 unit test**：

1. ✅ chunks → log events + bookend metas（順序、payload 形狀、seq monotonic）
2. ✅ aborted signal → 沒有 end-meta、沒 error-meta、清乾淨
3. ✅ poller throw → synthetic `build_log_stream_error` meta，process 不 crash
4. ✅ zero-chunk run → 還是有 start + end bookends
5. ✅ 10 chunks 大量 publish → 不爆

---

## Consequences

**好處**：

- ✅ Build 期間 UI **真的看得到字**，不是傻等 5-10 分鐘看 spinner
- ✅ 跟既有 stage events 走同一條 SSE，前端不用第二個 connection
- ✅ Reconnect 走 ring buffer + Last-Event-ID 那套，免費繼承
- ✅ Hook 是 opt-in（`hooks?` optional）——既有 caller 不用動，台機 / CLI 路徑不影響
- ✅ Test 有 `__pollerForTest` 注入點，**不需要 mocking framework**，符合既有風格

**代價**：

- 多一條背景 task = 多一條 abort/await 路徑要維護（但已 bounded：build 結束就收）
- `BuildHooks` interface 需要長期維護（之後若加 `onPushStarted` 之類的會擴）
- `buildId` 變成 return type 的一部分，所有 caller 都看得到（其實是好事）

**沒做的**：

- 沒 e2e test（依賴真 Cloud Build），unit + 手動驗證 + spike 結果為證
- 沒重新跑「使用者介面看到 live tail」的螢幕截圖驗證——等使用者起床 review

---

## Files Touched

| 檔案 | 改動 |
|------|------|
| `apps/api/src/services/deploy-engine.ts` | 加 `BuildHooks` interface + `onBuildStarted` 觸發點 + `buildId` 進 return type（成功 / timeout / failure 三條路徑） |
| `apps/api/src/services/deploy-worker.ts` | 加 `streamBuildLogToDeployment` exported helper + 在 `buildAndPushImage` 呼叫處 wire callback / abort / await 收尾 |
| `apps/api/src/test-build-log-live.ts` | NEW — 5 unit tests，跟既有 `test-*.ts` 一致風格 |

`buildId` cast 雙處（success + failure path）由 `(buildResult as unknown as { buildId?: string }).buildId` 改為直接 `buildResult.buildId`，多餘 cast 清掉。

---

## Verification

- ✅ `npx tsx src/test-build-log-live.ts`：**5/5 PASS**
- ✅ 全套 unit test：**77/77 PASS**（10 + 7 + 15 + 7 + 33 + 5）
- ✅ `apps/api npm run build`：clean
- ✅ `apps/web npm run build`：clean

