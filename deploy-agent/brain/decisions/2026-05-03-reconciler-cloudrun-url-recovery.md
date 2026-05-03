# 2026-05-03 — Reconciler Cloud Run URL recovery（R47）

## Status

Active

## Context

R46 上線那天 sweep 失敗專案，發現 `wavenet-ai-gateway-frontend` 被 reconciler 標 `failed`，metadata 寫 `"reconciler: deployment record exists but no cloudRunUrl"`。但去查 Cloud Run，revision `da-wavenet-ai-gateway-frontend-00001-2x7` 狀態是 `True`（健康），nginx logs 也正常。

**這是 reconciler false positive**：deploy 真的成功了，但我們 DB 沒寫進 `cloudRunUrl`，reconciler 看到 `cloudRunUrl` 空就以為部署卡住，標 failed。

挖根因：`apps/api/src/services/deploy-worker.ts:893` 那行 `updateDeployment(..., { cloudRunUrl: deployResult.serviceUrl ?? undefined, ... })` 是**單次 DB write，沒有 retry**。網路抖一下 / pg connection drop / pgbouncer 切換，這次寫就掉了。Cloud Run 那邊沒事繼續活，但我們 DB 永遠不知道。Reconciler 後續看到 `cloudRunUrl` 空 → mark failed。

## Decision

### Part 1：Defensive write retry（防止 root cause 再發生）

`deploy-worker.ts:893` 的單次寫包進 3-attempt retry，exponential backoff `100ms / 300ms / 900ms`。3 次都失敗只 log `[CRITICAL errorCode=cloudrun_url_persist_failed]`，**不 throw** —— Cloud Run 已經活了，硬擋下去只會把成功的 deploy 變失敗。Recovery path（Part 2）會接住。

### Part 2：Reconciler recovery path（兜底現有的失敗）

新檔 `services/reconciler-recovery.ts`：純函式 `decideReconcilerAction(deployment, cloudRunTruth, nowMs)`，回傳 4 種 verdict：

```typescript
type ReconcilerVerdict =
  | { kind: 'mark-failed'; reason: string }
  | { kind: 'recover-cloudrun-url'; uri: string }
  | { kind: 'fast-forward' }
  | { kind: 'skip'; reason: string };
```

**8 條分支**（順序就是 invariant，調換會改變語意）：

| # | 條件 | Verdict |
|---|------|---------|
| 1 | `deployment.createdAt < 6 min ago` | `skip`（race window 保護，避免跟 deploy-worker 搶寫） |
| 2 | `cloudRunUrl` 已有值 | `fast-forward`（reconciler 後續流程接手）|
| 3 | `cloudRunUrl` 空 + `cloudRunService` 空 | `mark-failed`（無從 recover）|
| 4 | `cloudRunUrl` 空 + service 不存在於 Cloud Run | `mark-failed` |
| 5 | `cloudRunUrl` 空 + 服務存在但 `conditionState=FAILED` | `mark-failed` |
| 6 | `cloudRunUrl` 空 + 服務 ready + `liveRevision !== deployment.revisionName` | `mark-failed`（zombie / publish split）|
| 7 | `cloudRunUrl` 空 + 服務 ready + revision 一致 + condition succeeded + uri 有 | `recover-cloudrun-url` ← **唯一新路徑** |
| 8 | 其他模糊（reconciling / 缺 uri / liveRevision null）| `skip`（下輪再試）|

**Race window = 6 分鐘**：deploy-worker retry 最多 1.3s，加 captureDeployedSource 等後續步驟 ~1-2 分鐘，6 分鐘給足 buffer。比 reconciler 自己的 `STALE_THRESHOLD_MS = 5 min` 略大，多一層保險。

### Part 3：Cloud Run truth helper

新增 `deploy-engine.ts:688` `getCloudRunServiceTruth(gcpProject, gcpRegion, serviceName)`：一次 GET 拿回 `{ exists, ready, uri, liveRevision, conditionState }`。沒動既有的 `isCloudRunServiceReady`（避免 caller churn）。

### Part 4：reconciler.ts 整合

把舊的 `if (!latestDeploy.cloudRunUrl) { mark failed }` 換成：

```typescript
const truth = await getCloudRunServiceTruth(...);
const verdict = decideReconcilerAction(latestDeploy, truth, Date.now());
switch (verdict.kind) {
  case 'recover-cloudrun-url':
    await updateDeployment(latestDeploy.id, { cloudRunUrl: verdict.uri });
    latestDeploy.cloudRunUrl = verdict.uri;  // sync local ref so下游 SSL/canary 可繼續
    console.log(`[Reconciler] [RECOVERED] cloudRunUrl backfilled ...`);
    break;
  case 'mark-failed': /* 既有路徑 */ break;
  case 'fast-forward':
  case 'skip': /* continue */ break;
}
```

## Consequences

**好處：**
- `wavenet-ai-gateway-frontend` 那類「Cloud Run 活著但 DB 漏寫」的專案會在下一輪 reconciler tick（每 2 分鐘）自動 recover，**不需要重新 deploy**
- Defensive retry 把 root cause 縮到極小（3 次 retry 涵蓋幾乎所有 transient pg drop）
- Recovery 邏輯純函式 + 22 個 zero-dep 測試把 8 條分支全鎖死
- Zombie 防護（branch 6）：DB 記的 revision 跟 Cloud Run 跑的對不上 → 不 recover，讓 publish-split handler 接手

**代價：**
- 每次 reconciler tick 多一次 Cloud Run REST 呼叫（per project with empty cloudRunUrl）。但這條只在「DB 寫掉了」這個小機率 case 才會 fire，整體影響可忽略
- 6 分鐘 race window 代表「deploy 後前 6 分鐘的真 failure」會看起來像 skip 而不是 fail（但 reconciler 後續 tick 會接住）

**未來可能需要做：**
- `deploy-worker.ts` 還有 4 處 `cloudRunUrl` 寫入（lines ~1354/1449/1460/1487），都在 error/rollback 路徑。同款 retry hardening 可以一起做。先標記跟進
- `reconciler.ts:188` 的「no deployment record」分支也沒做 race window 檢查，同類別問題
- recover 後 `isCloudRunServiceReady` 又被叫一次（reconciler.ts:267），是 redundant 但不錯誤。下次 simplify pass 拿掉

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **2787 passed / 0 failed across 47 files**（從 R46 的 2765/46 加 22 個 reconciler-recovery 測試剛好對上）
- Test coverage：8 條分支每條至少 1 個 test，加 race window edge cases、empty-string uri、zombie revision mismatch、ambiguous reconciling state、createdAt 用 ISO string 跟 Date 物件兩種 input
- Real-world 驗收：等 R47 上線後 2 分鐘內 reconciler tick 應該自動把 `wavenet-ai-gateway-frontend` 從 `failed` 拉回 `live`（不需要 resubmit）
