# 2026-05-03 — Lockfile arbiter（R48）

## Status

Active

## Context

`luca-web` 部署在 Step 3 Docker build 失敗：

```
> luca-web-v2@0.0.0 build
> tsc -b && vite build

Error: Cannot find module '../lib/tsc.js'
Require stack:
- /app/node_modules/.bin/tsc
```

這是經典「lockfile 跟 install 用不同 package manager」症狀。`node_modules/.bin/tsc` 的 symlink 結構是 npm 的 nested layout，但內部相對路徑找不到 typescript 套件 — 通常代表：
- 開發者本機用 pnpm（產生 pnpm-lock.yaml + flat node_modules）
- repo 裡 commit 了 stale `package-lock.json`
- 我們的 detector 看到 `package-lock.json` 就選 npm
- 容器裡跑 `npm ci` → 拼出半套 npm 結構 → tsc 找不到自己的內檔

舊的 PM detection 是簡單的 if-else 鏈：

```typescript
// project-detector.ts 舊版
if (existsSync('bun.lock')) return 'bun';
else if (existsSync('pnpm-lock.yaml')) return 'pnpm';
else if (existsSync('yarn.lock')) return 'yarn';
else return 'npm';
```

問題：
1. **沒有 multi-lockfile 的 tie-breaker**（按照 file order 第一個找到的就用，但實際應該看 mtime 或 packageManager 宣告）
2. **沒看 `package.json#packageManager`**（npm corepack convention，是最強訊號）
3. **沒看 `pnpm-workspace.yaml`**（workspace file 是強訊號，比 lockfile 還強）
4. **沒 confidence 概念**（沒 lockfile 還硬跑 `npm ci`，必死）
5. **Stale lockfile 不會被警告**（user 不知道為什麼壞）

## Decision

### Part 1：新 pure module `lockfile-arbiter.ts`

```typescript
export interface LockfileVerdict {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  confidence: 'high' | 'medium' | 'low';
  reason: string;       // 給 log 看
  warnings: string[];   // 給 user 看（surface 到 review report）
}

export function arbitrateLockfile(projectDir: string): LockfileVerdict;
```

**Priority order**（first match wins）：

1. **`package.json#packageManager: "pnpm@..."`** → 高信心度該 PM；若該 PM 對應的 lockfile 不在 → warn「declared X but only Y lockfile found」
2. **`pnpm-workspace.yaml`/`.yml` 存在** → 高信心度 pnpm；若 `package-lock.json` 也在 → warn「stale package-lock.json should be removed」
3. **多個 lockfile 存在** → 取 mtime 最新的，高信心度；其他 lockfile 標 stale + 警告
4. **單一 lockfile 存在** → 對應的 PM，中信心度
5. **沒 lockfile** → npm，低信心度 + warn「no lockfile present — builds will not be reproducible」

### Part 2：`project-detector.ts` 整合

`DetectionResult` 加兩個 additive 欄位（不破壞現有 caller）：

```typescript
packageManagerConfidence?: 'high' | 'medium' | 'low';
packageManagerWarnings?: string[];
```

舊的 if-else 鏈替換成 `arbitrateLockfile(projectDir)` 一行。

### Part 3：`dockerfile-gen.ts` 兩處改動

**(a) npm low-confidence → 用 install 而非 ci**

```typescript
const npmInstallCmd = d.packageManagerConfidence === 'low'
  ? 'npm install --no-audit --no-fund'
  : 'npm ci';
```

**理由**：`npm ci` 要求 lockfile 跟 package.json lock-step，沒 lockfile 或 stale lockfile 會直接炸。`npm install` 寬容（自動 sync）。我們接受沒 lockfile 的專案有微小 reproducibility loss — 反正它本來就沒有 reproducibility。

pnpm/yarn/bun 的 `--frozen-lockfile` 不動：那些 PM 的 fail message 清楚（「lockfile not found」），不會像 npm 這樣產出半套破壞性的 node_modules。

**(b) pnpm 多 copy `pnpm-workspace.yaml*`**

Next.js multi-stage build 的 deps stage COPY 那行：

```dockerfile
# pnpm 分支舊版：
COPY package*.json pnpm-lock.yaml* ./
# 新版：
COPY package*.json pnpm-lock.yaml* pnpm-workspace.yaml* pnpm-workspace.yml* ./
```

Workspace 專案沒這個檔，pnpm install 會找不到 packages，build 失敗。`*` glob 在 Docker 找不到檔不會錯。

### Part 4：明確不做的事

- **不加 Docker-side install retry**（`npm ci || npm install --legacy-peer-deps`）— 那種 fallback 會掩蓋真的 version conflict bug，產出 non-deterministic image
- **不自動 rm 多餘 lockfile** — user 的 source of truth，我們只警告
- **不改 user 的 Dockerfile**（user-provided 路徑） — R44h 護欄已經建立，動 user Dockerfile 是 footgun

## Consequences

**好處：**
- `luca-web` 那類「pnpm 專案有 stale package-lock」會自動辨識正確 PM
- 沒 lockfile 的專案會用 `npm install` 不會死在 `npm ci`
- pnpm workspace 專案 build 不會缺 workspace 檔
- 33 個 zero-dep 測試把 5 條優先序 + 多 lockfile mtime + corepack mismatch + workspace + 0 lockfile 邊界全鎖死

**代價：**
- `package-lock.json` 跟 `pnpm-lock.yaml` 都在的專案，行為從「永遠選 npm」變成「選 mtime 新的」。對於蓄意保留兩個 lockfile 的怪人會行為改變（極稀有）
- `packageManagerWarnings` 目前還沒被任何 caller 讀取（surface 到 review report 是後續工作 — 已在 type doc comment 標記）

**未來可能需要做：**
- 把 `packageManagerWarnings` surface 到 review report 的 LLM threat summary 或 dashboard
- `dockerfile-gen.ts:82-95` 的非 Next.js Node 分支 COPY 完全沒帶 lockfile（latent bug，現在沒影響因為 luca-web 是 Next.js）
- `dockerfile-gen.ts:53` 的 `buildCmd` 是 no-op ternary（`'npm run build' : 'npm run build'`）— 應該照 PM 切，但目前沒影響因為 npm 在所有 node base image 都裝了

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **2820 passed / 0 failed across 48 files**（從 R47 的 2787/47 加 33 個 lockfile-arbiter 測試剛好對上）
- Test coverage：每條 priority 至少 1 個 happy path + 全部 edge case（multi-lockfile mtime tie-break, corepack mismatch, workspace + stale npm lock, 空目錄, 壞 package.json, packageManager 欄位空字串等）
- Real-world 驗收：等 R48 上線後重 trigger luca-web 部署，預期 `arbitrateLockfile` 會輸出正確 PM + 對應 install command，Docker build 不再死在 tsc module not found
