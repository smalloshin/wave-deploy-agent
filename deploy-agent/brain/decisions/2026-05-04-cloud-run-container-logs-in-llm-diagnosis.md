# 2026-05-04 — Cloud Run container logs in LLM diagnosis（R53）

## Status

Active

## Context

Boss 在 dashboard 看到 wavenet-ai-gateway-backend 部署失敗，LLM 診斷寫的：

> 你的 Dockerfile 啟動指令看起來已經有正確監聽 8080，所以目前不像是部署平台的設定問題。比較可能是程式在啟動 FastAPI 時就失敗了，例如 `app.main:app` 匯入失敗、缺少必要環境變數，或啟動時連資料庫/外部服務卡住。請先在本機用同樣方式跑一次：`docker build -t app . && docker run -e PORT=8080 -p 8080:8080 app`，看容器啟動時印出的錯誤。

但實際上我手動 `gcloud logging read --service=da-... --revision=da-...-00003-2x7` 一撈，看到精確 root cause：

```
File "/app/app/config.py", line 67, in __init__
    raise RuntimeError("erp-jwt-secret is required but not available from Secret Manager")
RuntimeError: erp-jwt-secret is required but not available from Secret Manager
```

加上 `gcloud secrets describe erp-jwt-secret` 確認 GCP Secret Manager 那邊真的沒這個 secret。

**Boss 直接問：「你說的怎麼跟訊息上顯示的不一樣」**

兩個訊息其實**不矛盾**，是**不同詳細度**：

| Source | 看到 | 結論 |
|--------|------|------|
| Dashboard LLM | Cloud Run 給的 generic timeout 訊息 + Dockerfile 內容 | 「可能是 FastAPI 啟動失敗，建議自己 debug」（範圍對但太籠統）|
| 我（手動撈 Cloud Run logs）| Container Python traceback + GCP Secret Manager 狀態 | 「`erp-jwt-secret` 在 GCP 不存在」（精確 root cause）|

**Root cause of the gap**：deploy-worker 失敗時的 LLM diagnosis 流程：

```
Cloud Run deploy 失敗 → 抓 deploy-worker 的 error message → 餵給 LLM → 寫診斷
                                                          ↑
                                          沒撈 container 內部 stderr
```

LLM 看不到 container 的 stderr/stdout，只能根據 generic 的 "container failed to listen on port" 加 Dockerfile 內容做 educated guess。**這是 product gap**，不是 LLM 的問題。

## Decision

新增 deterministic helper `cloud-run-logs-fetcher.ts` + 在 deploy-worker.ts 的 outer catch 加 R53 區塊：當 `currentStep` 含 `Cloud Run` 字眼時，從 error 訊息提取 service+revision，撈 Cloud Run Logging API → prepend container logs 到 `attachedLog` → 一起餵 LLM。

### 三個 export

```typescript
// Pure helpers
export function extractCloudRunMetaFromError(errorMsg: string): { serviceName?, revisionName? };
export function formatLogEntries(entries: CloudLogEntry[], maxBytes?: number): string;

// Async fetcher (best-effort, never throws)
export async function fetchContainerLogs(
  serviceName: string,
  revisionName: string,
  gcpProject: string,
  lookbackMs?: number,  // default 10 min
): Promise<string | null>;
```

### Service+revision extraction

Cloud Run 的 timeout error 訊息會帶 Logs URL，URL 內 query string URL-encoded 帶 `service_name="X"` + `revision_name="Y"`：

```
Logs URL: https://console.cloud.google.com/logs/viewer?...resource.labels.service_name%3D%22da-wavenet-ai-gateway-backend%22%0Aresource.labels.revision_name%3D%22da-wavenet-ai-gateway-backend-00003-2x7%22
```

Regex 同時涵蓋 URL-encoded 跟一般 quoted form：

```typescript
const svcMatch =
  errorMsg.match(/service_name(?:=|%3D)(?:"|%22)([a-z0-9-]+)(?:"|%22)/i) ||
  errorMsg.match(/service_name[=:]?\s*["']([a-z0-9-]+)["']/i);
```

### Cloud Logging API 呼叫

```
POST https://logging.googleapis.com/v2/entries:list
Body:
  resourceNames: ["projects/PROJECT"]
  filter: |
    resource.type="cloud_run_revision"
    AND resource.labels.service_name="X"
    AND resource.labels.revision_name="Y"
    AND timestamp >= "ISO_T_MINUS_10_MIN"
    AND severity >= DEFAULT
  orderBy: "timestamp desc"
  pageSize: 100
```

`severity >= DEFAULT` 涵蓋 stdout（DEFAULT/INFO）跟 stderr（ERROR/CRITICAL）— Python traceback 通常落在 stderr 但有些 framework 用 stdout。

### Format for LLM

`formatLogEntries(entries, maxBytes=30000)`：
- 反序（Cloud Logging 回傳 newest first，反成 oldest first 讓 LLM 從上往下讀 traceback）
- `[2026-05-04T00:30:05 ERROR] textPayload` 一行一條
- 超過 30KB 從**頭**截（保留尾巴，crash signal 在 stack 底部）
- `jsonPayload.message` fallback when `textPayload` 缺

### 整合進 deploy-worker.ts outer catch

`currentStep && currentStep.includes('Cloud Run')` → 拉 logs → prepend 給 attachedLog：

```typescript
attachedLog = `=== Cloud Run container logs (REVISION) ===
<container logs>

=== Original deploy-worker error ===
<original attachedLog>`;
```

LLM prompt 不用改 — analyzeDeployFailure 既有 prompt 已經教 LLM 從 logs 中找 root cause。

### 失敗都 silent skip

- 拿不到 access token → skip + log warn
- HTTP non-200 → skip + log warn（含狀態碼）
- 沒 entries → skip
- error 訊息沒 service/revision → skip

**Best-effort：絕不 throw**，避免在 failure-handling 路徑上製造新失敗。

## Consequences

**好處：**

- Dashboard 上未來 Cloud Run deploy 失敗的 LLM 訊息會精確指出 root cause（如 `RuntimeError: erp-jwt-secret is required but not available from Secret Manager` → "您的 app 需要 GCP Secret Manager 的 erp-jwt-secret，請建立..."）
- Discord notification 也會有更好的 buildDiagnosis（discord-notifier 直接用 buildDiagnosis 結構）
- 操作者不用再手動 `gcloud logging read`

**代價：**

- 每個 Cloud Run deploy 失敗多一次 Cloud Logging API call（~500ms-2s）。但只在失敗路徑，整體影響忽略
- 需要 deploy-worker 的 SA 有 `roles/logging.viewer`（默認 Cloud Run runtime SA 通常有）— 沒有的話 silent skip 不影響原行為
- LLM prompt 多 30KB context（從 5KB 變 35KB）— 小幅增加 token cost，但對 GPT/Claude 都在 budget 內

**未來可能需要做：**

- R54 提案：對 Cloud Build 失敗也做類似——撈完整 build log（不只 stderr）+ 撈 cache miss 細節 → LLM 更精準
- R55 提案：把 build_diagnosis 結構化欄位多加一層 `containerLogsExcerpt`，讓 dashboard UI 可以用 collapsible block 顯示 container logs 給操作者
- 把 `extractCloudRunMetaFromError` 也用在 reconciler 的「stuck deployment」訊息分析上

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **2914 passed / 0 failed across 51 files**（從 R52 的 2895/50 加 19 個 R53 測試剛好對上）
- Test coverage：
  - extractCloudRunMetaFromError: 9 tests（real error format URL-encoded、quoted form、empty/null、case-insensitive、duplicate match）
  - formatLogEntries: 10 tests（empty/null、reverse chrono、format、jsonPayload fallback、skip empty、truncate from head、marker、no truncation needed、default severity）
- Real-world 驗收：等 R53 上線後 resubmit wavenet-ai-gateway-backend，預期 LLM 訊息會直接寫「erp-jwt-secret 在 Secret Manager 不存在，請執行 `gcloud secrets create erp-jwt-secret ...`」
