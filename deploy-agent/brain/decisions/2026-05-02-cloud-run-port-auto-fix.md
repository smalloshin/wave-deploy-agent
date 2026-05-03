# 2026-05-02 — Cloud Run PORT 自動修正（R46）

## Status

Active

## Context

R45 部署完那天，user 發現 `luca-optimizer-kb` 部署掛了。從 deploy-worker 的 LLM 診斷看：

```
Step 4: Deploy to Cloud Run failed
container failed to start and listen on the port defined provided by the
PORT environment variable within the allocated timeout.

Dockerfile 最後一行：
# Use a standard CMD for uvicorn. The PORT env var will be respected by uvicorn.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

User 的 Dockerfile 寫死 port 8080，Cloud Run revision 設 `PORT=8000`，container 起來 listen 8080，Cloud Run health check probe 8000，4 分鐘 timeout 後判定失敗。註解寫「PORT env var will be respected」純粹誤解 Docker exec form 的語意。

順手讀我們自己的 `dockerfile-gen.ts` 才發現**同一類 bug 也潛伏在 auto-gen 裡**：

```typescript
// 舊 code：
const startCmd = 'uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}';
return `... CMD ${JSON.stringify(startCmd.split(' '))}`;
// 產出：
// CMD ["uvicorn","main:app","--host","0.0.0.0","--port","${PORT:-8000}"]
```

**Docker exec form 是 JSON 陣列，不會 spawn shell。**`${PORT:-8000}` 不會展開，會被當 literal 13 字元字串傳給 uvicorn，uvicorn 解析 port 失敗炸掉。為什麼之前沒被別人撞到？因為從來沒有純 Python+FastAPI 走過 auto-gen 路徑（都是 user 帶自己的 Dockerfile）。但只要有人撞上，一定掛。

**兩種 failure mode 同一個根本原因**：exec form 不展開變數。

## Decision

### 1. 新 deterministic Step 2 fixer：`dockerfile-port-fixer.ts`

不走 LLM。理由：

- **延遲**：LLM call 5-10 秒 vs 純函式 <1ms
- **確定性**：機械 pattern 100% 重現，LLM 可能漏掉或亂改
- **R44h 才剛建護欄擋 LLM 翻 strictness flag**：再讓 LLM 改 Dockerfile 本身就增加風險面
- **可單元測試**：純函式 + 31 個 zero-dep 測試鎖每個 case

跟 R44g `prisma-fixer` / R44h `next-config-fixer` 同 architecture pattern。

**API**：

```typescript
export interface PortFixResult {
  changed: boolean;
  next: string;
  reason: string;
  replacedPorts?: number[];
}

export function fixDockerfilePorts(content: string): PortFixResult;
```

**辨識的 5 種 hardcoded port 形式**：

| Form | 範例 | Framework |
|------|------|-----------|
| `--port=N` / `-p=N` / `--listen=N` | `--port=8000` | uvicorn / flask |
| `--bind=H:N` / `-b=H:N` | `--bind=0.0.0.0:8000` | gunicorn |
| `--port N` (separate value) | `--port 8000` | uvicorn / flask |
| `--bind H:N` (separate value) | `--bind 0.0.0.0:8000` | gunicorn |
| 位置型 `H:N` after `runserver`/`server` | `runserver 0.0.0.0:8000` | django / rails |

**辨識的 1 種變數洩漏**：args 含 `$PORT` / `${PORT}` / `${PORT:-N}` 任一 → 觸發 sh -c wrap（即使沒寫死 port）。

**Idempotent**：

- `sh -c` / `bash -c` / `/bin/sh -c` / `/bin/bash -c` / `ash -c` / `/bin/ash -c` 開頭的 CMD 一律不動（user 自己包了 shell）
- `CMD ["node", "server.js"]` 不動（port 在 code 裡，沒辦法從 Dockerfile 改）
- Shell form `CMD uvicorn ...`（不是 JSON 陣列）不動
- 隨機整數不在 port-flag 旁邊 → 不動（避免改到 retry count 之類）
- 跑兩次結果一樣

**Defensive**：

- 壞 JSON、非字串元素、空陣列、null input 全部 `changed=false` 不 throw
- 保留 leading whitespace
- Single-quote 含空白的 args（POSIX 安全）
- 不動 `$` 含的字串（讓 `${PORT:-N}` 在 sh -c 裡正確展開）

**Fix 形式**：把 directive 整行改寫成：
```
CMD ["sh", "-c", "<原 args 重組，port literal 替換成 ${PORT:-原值}>"]
```

例如 `luca-optimizer-kb` 會被改成：
```
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
```

### 2. 修 `dockerfile-gen.ts` 的同款 latent bug

Python 的 startCmd 從：
```typescript
CMD ${JSON.stringify(startCmd.split(' '))}
```
改成：
```typescript
const cmdLine = startCmd === 'python main.py'
  ? 'CMD ["python", "main.py"]'  // 沒變數可展，exec form 安全
  : `CMD ["sh", "-c", ${JSON.stringify(startCmd)}]`;  // 含 ${PORT}，必須 sh -c
```

`python main.py` 走 exec form（沒 shell expansion 需要），其他 framework 走 sh -c。

### 3. 整合進 pipeline-worker Step 2

接在 Prisma fixer 後面、Next.js eslint strip 前面。對 auto-gen 跟 user Dockerfile 都跑（兩者都可能有問題）。

```typescript
try {
  const dockerfilePath = join(projectDir, 'Dockerfile');
  if (existsSync(dockerfilePath)) {
    const original = readFileSync(dockerfilePath, 'utf-8');
    const result = fixDockerfilePorts(original);
    if (result.changed) {
      writeFileSync(dockerfilePath, result.next);
      console.log(`[Pipeline]   R46: ${result.reason}`);
    }
  }
} catch (err) {
  console.warn(`[Pipeline]   R46: port fix failed (non-fatal): ${(err as Error).message}`);
}
```

順序：prisma-fixer → port-fixer → next-config eslint strip → security scan → ...

### 4. Audit trail

修過的 Dockerfile 會被 R44 deployed-source-capture 存到 GCS（user 一鍵下載），post-fix 結果使用者看得到。`reason` 字串裡有「was: 8080」之類的原始 port，方便 grep log 找出哪些專案被自動修。

## Consequences

**好處：**

- `luca-optimizer-kb` 那類 user 寫死 port 的 Dockerfile 自動修正，未來不再需要 user 手動改 → 重 deploy
- Auto-gen Python Dockerfile 的潛在 bug 一併解掉
- 跟 R44g/R44h 同 architecture pattern，team 一致性
- 31 + 5 = 36 個 zero-dep 測試鎖死，未來有人改邏輯會立刻看到測試掛
- 純函式可單元測試，不需要起 DB/Cloud Run 就能驗

**代價：**

- Pipeline Step 2 多一個 Dockerfile read+write（毫秒級，可忽略）
- User Dockerfile 被改寫，可能讓「我改了 Dockerfile 但你沒理我」這種困惑場景出現。Mitigation：log 寫得清楚、deployed-source-capture 讓 user 看到 post-fix 結果
- 只覆蓋目前最常見的 5 種 port 形式，其他怪招（例如 `--listen-port=8080`、`PORT=8080 my-cli`、自訂 wrapper script）漏掉。Mitigation：辨識規則保守，不認的就不動，不會誤改

**未來可能需要做：**

- Node.js framework 的 hardcoded port 偵測（express `.listen(8080)` 之類），但這在 JS code 裡而不在 Dockerfile，需要不同 strategy
- 自動偵測 EXPOSE / ENV PORT 不一致並修正
- 把 port-fix 的決定也寫進 `scan_reports.metadata`，未來在 dashboard 顯示「我們幫你改了什麼」

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `./scripts/sweep-zero-dep-tests.sh` → **2765 passed / 0 failed across 46 files**（從 R45 的 2729/45 + R46 新增 31 個 port-fixer 測試 + 5 個 dockerfile-gen R46 測試）
- 部署：等 commit + push + Cloud Build
- E2E 驗收計畫：R46 上線後重 trigger `luca-optimizer-kb` 部署，預期會自動修 user Dockerfile，container 正確 listen `${PORT}`，health check 過、deploy 成功
