# 2026-05-07 — Dockerfile COPY vs .dockerignore 衝突 detector（R61）

## Status

Active

## Context

`legal-flow-20260505` 部署失敗 canonical：

`.dockerignore`：
```
node_modules
.next
.git
*.zip
*.md
.env*.local         ← 排除 .env.local
dev.db
```

User Dockerfile 第 31-32 行：
```dockerfile
COPY .env .env       ✅ 過（.env 沒被排除）
COPY .env.local .env.local   ❌ 死（.env.local 被排除）
```

Cloud Build 跑 4 分鐘到 Step 22/27 才發現 `COPY failed: file not found in build context or excluded by .dockerignore`。

LLM diagnosis 抓得到（gpt provider 寫得很清楚），但**事前警告比事後 cheaper 5 分鐘 Cloud Build time + 操作成本**。

## Decision

加 R61 pre-build detector：parse Dockerfile 的 `COPY <src>` lines + parse `.dockerignore` patterns，cross-reference 找衝突。**不 block deploy**（user 的選擇），但 emit warning 進 `scan_report` + dashboard，pipeline 繼續走。

### Pure decider（`services/dockerignore-conflict-detector.ts`）

```typescript
export interface DockerignoreConflict {
  copyLine: string;        // 完整 Dockerfile line
  lineNumber: number;       // 1-based
  copySource: string;       // COPY src（如 ".env.local"）
  excludingPattern: string; // 排除的 pattern（如 ".env*.local"）
}

export function detectDockerignoreConflicts(input: {
  dockerfile: string;
  dockerignore: string;
}): DockerignoreConflict[];
```

**純函式** — 不 touch fs / DB / time。Caller 讀兩個 file 餵字串。

### Glob 處理

Subset of dockerignore syntax：

| Symbol | 行為 |
|--------|------|
| `*` | 不跨 `/` 任意字元 |
| `**` | 跨 `/` 任意字元（含 `**/` prefix 表 zero-or-more dir）|
| `?` | 不跨 `/` 單字元 |
| `.`, `+`, `(` 等 | escape |
| `!pattern` | 反向 re-include（last matching rule wins）|
| trailing `/` | dir + descendants |
| Pattern 不帶 trailing `/` | 也接受 descendants（gitignore semantics — `.next` 排除 `.next/standalone`）|

### Dockerfile parsing

| 案例 | 處理 |
|------|------|
| `COPY src dst` | parse src args，最後一個是 dst |
| `COPY --chown=user:group src dst` | 剝 `--chown=`、剝 `--from=` 之外的 flags |
| `COPY --from=builder src dst` | **跳過**（multi-stage artifact，不過 dockerignore）|
| `ADD https://...` | **跳過**（URL fetch 不過 context）|
| `ADD secret.tar /` | 跟 COPY 同樣處理 |
| `COPY "quoted" .` | 剝引號 |
| `COPY . .` | **跳過**（dot src 太粗，不評估） |
| 多 src（`COPY a b c /dst`）| 每個 src 各自檢查 |

### 兩個 enforcement 點

**1. `pipeline-worker.ts` Step 2 後**（在 R44h next-config-fixer 之後、Step 3 Cloud Build 之前）：
- 讀 `<projectDir>/.dockerignore` 跟 `dockerfileAbsPath`
- 跑 detector
- 寫進 `project.config.dockerignoreConflicts` JSONB
- 不 block，console.warn + DB persist

**2. Dashboard scan_report 顯示**（後續 follow-up，先 persist 資料即可）

### 為什麼不 block

R44h 精神：不動 user 的判斷。User 可能故意在 `.dockerignore` 排除某檔但 Dockerfile copy 它（雖然會 fail，但那是 user 的選擇）。我們的角色是**警告**，不是 enforce。

## Consequences

**好處**：
- Pre-build catch 比 4 分鐘 Cloud Build timeout cheaper 90 倍 time + cost
- LLM diagnosis 自動有更精確 context（warning 已寫進 scan_report，下游 LLM 也能引用）
- 21 zero-dep tests 鎖死 glob behavior（`**` prefix、`*` 不跨 `/`、negation order、`COPY --from`、quoted、多 src、case-sensitive、空檔、trailing-slash dir）

**代價**：
- 新檔 200 LOC + 21 tests
- Glob matcher 是 subset（不支援 char class `[a-z]`、不支援 path-rooted distinction）
- Dashboard UI 還沒接（v1 先存進 config，v2 再做 UI 顯示）

**已知限制**：
- `COPY . .` / `COPY ./* .` 等粗粒度 src 跳過不評估（避免大量 false positive）
- Negation `!` 只支援 last-matching-wins，不支援複雜 nested rules
- 不 cross-check dockerignore 跟 source filesystem（只 check Dockerfile 跟 dockerignore 兩個檔）

## 驗證

- `tsc --noEmit` 兩 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **3046 passed / 0 failed across 56 files**（3025 → +21 R61 tests）
- 21 個新測試：
  - canonical legal-flow case（`.env*.local` excludes `.env.local`，`.env` 不受影響）
  - `*` 不跨 `/` vs `**` 跨 `/`
  - `**/secrets.json` 三個 path 全 match（含 root）
  - comments + blank lines
  - `!` re-include + order
  - `COPY --from=`、`--chown=`、ADD URL、quoted、多 src
  - Edge cases：empty dockerignore、no COPY lines、`COPY . .` skip、trailing slash dir、case-sensitive

## 後續

- TODOS.md R61 entry 標 done
- R61.1 future: dashboard UI 接 `dockerignoreConflicts` field 顯示 warning（含 quick-fix 提示「刪掉 COPY 該行 / 從 dockerignore 拿掉 pattern」）
- R61.2 future: extend detector 也 cross-check `.gcloudignore` (Cloud Build 偶用)
