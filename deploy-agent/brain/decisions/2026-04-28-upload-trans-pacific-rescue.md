# 2026-04-28 — Round 44: Upload Trans-Pacific Rescue (enriched onerror + verifyComplete)

## Status

**Active**

## Context

Round 30（2026-04-27 commit `7741a35`）把 chunked GCS resumable upload 預設值收緊（`MAX_RETRIES=15`、`CHUNK_SIZE=1 MiB`、`MAX_BACKOFF_MS=60_000`、`CHUNK_TIMEOUT_MS=120_000`），但 R30 直到 2026-04-28 02:09 UTC 才實際部署到 production（緊急 build `6a658e37` SHORT_SHA `5b84460`，跳過了 14 commits）。

R30 部署後使用者立刻重試 426.5 MB `legal_flow_build.zip` 上傳。錯誤回報：

```
attempts: 16
chunkStart: 446693376
chunkEnd: 447194584
lastError: "network"
```

`attempts: 16` = `MAX_RETRIES (15) + 1` 完全吻合 R30 bail-out 邏輯，**證明 R30 確實在 prod**。但檔案還是上不去。

Server-side 診斷揭露事實：
- `gsutil ls gs://wave-deploy-agent_cloudbuild/uploads/` 看到 8 份完整的 `legal_flow_build.zip`，全部 `447,194,585 bytes`
- 最近一份 `gs://wave-deploy-agent_cloudbuild/uploads/1777344905678-legal_flow_build.zip` 在 2026-04-28T03:03:22Z finalized，**比使用者錯誤回報時間 03:18:34Z 早 15 分鐘**
- `gsutil stat` MD5 base64 `AO1nweEUgJRT/TuqaEBfJQ==` → hex `00ed67c1e114809453fd3baa68405f25`
- 本機檔案 `md5 /Users/smalloshin/Downloads/legal_flow_build.zip` → `00ed67c1e114809453fd3baa68405f25`
- **完全一致** → 檔案完整、bytes 沒掉、hash 沒錯

`gsutil ls -L -b gs://wave-deploy-agent_cloudbuild` 揭露根因：

```
Location type:        multi-region
Location constraint:  US
```

bucket 在美國 multi-region，使用者在台灣。CORS 已驗證沒問題（origin/method/responseHeader 都允許）。

**根因鏈**：
1. 最後一個 chunk（489 KiB partial，`Content-Range: bytes 446693376-447194584/447194585`）的 PUT bytes 抵達 GCS、GCS finalize 完成
2. GCS 回傳的 200/201 response 在跨太平洋回程（GCS US ↔ Taiwan ISP）被 middlebox / TCP idle timeout 切斷
3. 瀏覽器收到 `xhr.onerror`，R30 retry 啟動，**對已 finalize 的 session URI 再 PUT** — GCS 對 closed session 的回應行為 + 同樣 TCP 路徑 + 同樣 middlebox 行為 → 16 次全 onerror
4. R30 雖然 retry 多了 3 倍，但根本不知道 bytes 早就到了、根本不知道 session 已經 closed — 它只看得到 `xhr.onerror`

**診斷洞**：`xhr.onerror = () => reject(new Error('network'))` 這行（`apps/web/lib/resumable-upload.ts:204`）把 `xhr.status` / `xhr.statusText` / `xhr.responseURL` / `xhr.responseText` 全部丟掉。看不到 GCS 是「TCP 切斷（status=0）」、「CORS preflight 失敗」、還是「504 Gateway Timeout」— 全部 collapse 成同一個 `lastError: "network"` 字串。

R30 是用對的方向（retry 多一點），但解錯了問題（檔案到不到 GCS）。R44 補上：**(1) 看到 GCS 真的回了什麼，(2) 直接問 GCS 物件存不存在，省去 retry 跟 bail-out**。

## Decision

R44 推 3 件套（架構 + 程式碼）：

### #1 — Enriched `xhr.onerror`（`apps/web/lib/resumable-upload.ts`）

把原本的單字串 `'network'` 升級成攜帶診斷欄位的 `Error & XhrErrorDiagnostic`：

```typescript
xhr.onerror = () => {
  const err = new Error('network') as Error & XhrErrorDiagnostic;
  err.xhrStatus = xhr.status;
  err.xhrStatusText = typeof xhr.statusText === 'string' ? xhr.statusText : '';
  err.xhrResponseURL = typeof xhr.responseURL === 'string' ? xhr.responseURL : '';
  err.xhrResponseText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
  reject(err);
};
```

bail-out path 在組裝 `lastError` 時，看到診斷欄位就用 `formatXhrDiagnostic(err)` 序列化；沒看到就保留舊行為（`'network'` 文字 — 這條 fallback 路徑只在非生產 caller / 老 mock 才會走）。輸出格式：

```
network status=0 statusText="" url= body=""
network status=503 statusText="Service Unavailable" url=https://storage.googleapis.com/upload/x body="<error>nope</error>"
```

`network ` literal 前綴保留，不破壞既有 log grep。

`isXhrErrorDiagnostic(err)` 是純 type-guard，純 `'xhrStatus' in err && typeof === 'number'`。

### #2 — `POST /api/upload/verify`（`apps/api/src/routes/projects.ts`）

新 server-side endpoint 直接查 GCS metadata：

```
POST /api/upload/verify
Body: { gcsUri: string, expectedSize?: number, expectedMd5?: string }

→ 200 { exists: true, complete: bool, size, md5, contentType, timeCreated, generation, sizeMatch, md5Match }
→ 200 { exists: false, complete: false }      // GCS 404 — object 不存在
→ 4xx 400 { error: 'gcsUri is required' | 'gcsUri must reference the agent bucket' }
→ 5xx 500 { error: 'gcs_auth_failed' | 'gcs_metadata_failed' }
```

權限：`projects:write`（與 `/api/upload/init` 同），在 `apps/api/src/middleware/auth.ts` ROUTE_PERMISSIONS map 登記。bucket prefix guard 防止任意 gcsUri 注入查別 bucket。read-only metadata，無 mutation。

### #3 — `verifyComplete` callback wired in callers（`apps/web/app/page.tsx` + `apps/web/app/projects/[id]/page.tsx`）

`uploadResumable` 新增 optional `verifyComplete?: () => Promise<boolean>`。bail-out 前（`attempt > maxRetries` 時）呼叫一次：
- `verifyComplete() === true` → return `{ ok: true, bytesUploaded: total }`，連同 `onProgress(total, total)`
- `verifyComplete() === false` → 走原本 `network_error` / `gcs_timeout` failure path
- `verifyComplete()` throws → 也走 failure path（graceful degrade，不卡使用者）
- happy path / aborted path：**完全不呼叫**，不浪費請求

兩個 web caller 把它接到 `/api/upload/verify`，用 init 時拿到的 `gcsUri` + `file.size` 當 query：

```typescript
verifyComplete: async () => {
  try {
    const res = await fetch(`${API}/api/upload/verify`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gcsUri, expectedSize: file.size }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { complete?: boolean };
    return data.complete === true;
  } catch {
    return false;
  }
}
```

只用 size，不傳 expectedMd5（client 沒有 md5；要算 426 MB 的 md5 太貴）。size match 已足夠當「GCS finalize 了」的訊號 — GCS 不會把不完整的 partial upload 當完整 object 暴露 metadata。

### Tests

`apps/web/lib/test-resumable-upload.ts` 從 96 → **123 PASS**（+27 R44 cases）：

- **Pure helpers**（`formatXhrDiagnostic` / `isXhrErrorDiagnostic`）：5 個 case，含 200-char body truncation 數值釘死（JSON length 202）、bare Error rejected、wrong-type field rejected
- **Integration**（`uploadResumable` × FakeXhr）：8 cases：
  - persistent network_error 16 attempts → `lastError` 帶 enriched `network status=0 ...`、含 `responseURL`
  - persistent http-level error 503 → `lastError` 帶 `status=503` / `Service Unavailable` / responseText
  - 老 mock 的 `kind: 'network_error'` 沒帶欄位 → 維持 `network ` 前綴 back-compat
  - `verifyComplete=true` → ok + bytesUploaded=total + 呼叫一次
  - `verifyComplete=false` → failure 維持 + 呼叫一次
  - `verifyComplete throws` → failure graceful degrade
  - happy path → verifyComplete **0 calls**
  - pre-aborted signal → verifyComplete **0 calls**

`FakeXhrHarness` 升級：`status` / `statusText` / `responseURL` / `responseText` 都成 mockable 欄位，`network_error` FakeResponse 加 4 個 optional override；老 case 預設值維持原行為。

`bun apps/web/lib/test-resumable-upload.ts` → `=== 123 passed, 0 failed ===`。
`tsc --noEmit`：web + api 兩邊都 clean。

## Consequences

### 好處

1. **trans-Pacific final-chunk 救得回來**：bytes 在 GCS、回程被切的 case 不再走 retry-bail-fail；`/api/upload/verify` 直接問 GCS metadata，size match 就 return success。下次使用者上傳 426 MB 不會再「失敗」。
2. **錯誤訊息有 actionable 資訊**：下次真的失敗，`lastError` 帶 `status=0` 還是 `status=503` 還是 `status=429` 直接告訴我們 GCS 端發生什麼事 — TCP cut / quota / CORS / 5xx，不用拐彎抹角猜。
3. **不破壞既有 retry 邏輯**：R30 的 chunked + 15-retry + 60s backoff 全部保留，R44 是補在「retry 都用光之後」的安全網。
4. **無權限放寬**：verify endpoint 跟 init 同個 `projects:write`，bucket prefix guard 防 gcsUri 注入查別 bucket，read-only metadata 沒 mutation。

### 代價

1. **bail-out path 多一個 round-trip**：每次 retry exhaust 多一次 `/api/upload/verify` 呼叫。實際上只在使用者真的吃到 16 次 onerror 才會發生，發生時的 cost 也只有 metadata GET 一次（小於 1 KB），可忽略。
2. **依賴 GCS metadata API**：如果 GCS metadata API 也壞了，verify 會 false→ failure 沿用舊 path。這不是退化，只是無法救援。
3. **diagnostic field 沒進 UploadErrorEnvelope schema**：`lastError` 字串只是給 log/UI 看，沒進 `UploadFailure.network_error` 的型別欄位。短期夠用，下一輪可以擴 envelope 把 `xhrStatus` 做成 first-class field（讓 LLM diagnostic 直接 read 結構化欄位，不用 regex）。
4. **R44 不修根本問題**：bucket 還是在 US。這只是把 trans-Pacific TCP 砍 response 的 case 救回來。要根治得做 **R45 — bucket 搬到 asia-east1 / asia-southeast1**，獨立 ADR。

### 後續

- **R45（pending）**：建 `wave-deploy-agent-uploads-asia` bucket（asia-east1）、新 lifecycle、新 IAM、新 CORS、`/api/upload/init` 切過去；要 single-tenancy migration 計劃 + 歷史 sources 處理。
- **`UploadFailure.network_error.detail.xhrStatus` first-class**：把 R44 字串解析成型別欄位，讓 `apps/web/lib/upload-error-mapper.ts` 跟 `services/llm-analyzer.ts` 直接讀結構，不用 string parse。

## Files Changed

```
apps/web/lib/resumable-upload.ts          + Round 44 header + XhrErrorDiagnostic + formatXhrDiagnostic + isXhrErrorDiagnostic + verifyComplete option + enriched onerror handler + bail-out hook
apps/web/lib/test-resumable-upload.ts     + 27 R44 tests (123/0)
apps/web/app/page.tsx                     + verifyComplete wiring (uploads page)
apps/web/app/projects/[id]/page.tsx       + verifyComplete wiring (project upgrade page)
apps/api/src/routes/projects.ts           + POST /api/upload/verify endpoint
apps/api/src/middleware/auth.ts           + ['POST:/api/upload/verify', 'projects:write']
brain/decisions/2026-04-28-upload-trans-pacific-rescue.md  (this file)
brain/decisions/index.md                  + R44 row
brain/SESSION_HANDOFF.md                  + R44 entry
```

零行為改動 from R30 retry 數學；R44 完全是 additive — 沒有 verifyComplete 的 caller 行為與 R30 一字不差。
