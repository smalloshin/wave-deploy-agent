# 2026-05-07 — Honest-Monorepo Descent（R60）

## Status

Active

## Context

`wavenetdeveloper-rfp-agent` 部署：user 上傳的 zip 結構：
```
./
├── frontend/index.html      ← 53 KB 單檔（FastAPI StaticFiles 要 mount 的前端）
└── backend/
    ├── Dockerfile
    ├── main.py               ← `app.mount("/", StaticFiles(directory="../frontend"))`
    ├── requirements.txt
    └── knowledge/
```

`routes/projects.ts:786` 看到 root 沒 Dockerfile + 一個 subdir (`backend/`) 有 Dockerfile，就 descend 進 `backend/`。Container 裡只剩 backend 內容，`os.path.join(BASE_DIR, "..", "frontend")` 解到 root 沒這個 dir，static mount 默默 fail，前端 UI 全沒。

User code 用 sibling reference 這事 pipeline 沒辦法知道，但是 **build context = root 的話 sibling 永遠在**，純粹是 pipeline 太 eager。

## Decision

引入 R60 honest-monorepo strategy：root 有 multiple subdirs + 只有一個 subdir 有 Dockerfile 時，**不 descend**，build context = root，記下 `dockerfilePath = <subdir>/Dockerfile` 給 Cloud Build `-f` flag 用。Sibling dirs 全部跟著進 image。

### 5-branch pure decider（`services/monorepo-strategy.ts`）

```typescript
export type MonorepoStrategy =
  | { kind: 'flat'; dockerfilePath: 'Dockerfile' }            // root 有 Dockerfile
  | { kind: 'honest-monorepo'; dockerfilePath: string;        // R60 新增
      subdirName: string }
  | { kind: 'multi-service';                                   // ≥2 subdirs 有 Dockerfile
      servicesWithDockerfile: string[] }
  | { kind: 'auto-gen-flat'; dockerfilePath: 'Dockerfile' };  // 沒 Dockerfile，root 自動生
```

| # | 條件 | Strategy |
|---|------|----------|
| R1 | root 有 Dockerfile | `flat` |
| R2 | ≥2 subdirs 各有 Dockerfile | `multi-service`（split 為 N projects，既有行為）|
| R3 | root 有 package.json 但沒 Dockerfile | `auto-gen-flat`（auto-gen 寫到 root）|
| R4 | ≥2 subdirs，**只 1 個** 有 Dockerfile | **`honest-monorepo`** ← R60 新增 |
| R5 | 其他 | `auto-gen-flat`（fallback）|

### 為什麼這樣設計

| 選項 | 為什麼不選 |
|------|-----------|
| 改用 LLM 判斷 user 結構 | 5-10s call、不確定性、user code 100 個案沒一個一致 |
| 把 frontend/ 跟 backend/ 都 deploy（auto multi-service）| user 只有一個 Dockerfile，沒打算 deploy frontend 當獨立 service。FastAPI 是 hybrid pattern（API + 靜態檔由同一個 container 提供） |
| 把 frontend/ 內容 copy 進 backend/ | 改 user source 結構，違反 R44h 精神 |
| **Build context = root + `-f <sub>/Dockerfile`（選用）** | Docker 標準作法、user Dockerfile 不變、sibling 自然在、Cloud Build 一個 flag 解決 |

### 7 個檔案改動

| File | 改動 |
|------|------|
| `services/monorepo-strategy.ts`（新）| 95 LOC pure decider |
| `test-monorepo-strategy.ts`（新）| 17 zero-dep 測試（5 branches + edge cases + 反向 wire-contract）|
| `routes/projects.ts:658-810` | 改用 decider、honest-monorepo 設 `config.dockerfilePath` 不 descend |
| `routes/versioning.ts:213-260` | 同樣 — new-version 路徑也 re-evaluate strategy（user re-zip 後可能改 layout） |
| `services/deploy-engine.ts` | `DeployConfig.dockerfilePath?` + Cloud Build args 加 `-f` flag（只在非 'Dockerfile' 時 emit）|
| `services/deploy-worker.ts:783` | `buildAndPushImage` call 帶 `dockerfilePath: project.config?.dockerfilePath` |
| `services/pipeline-worker.ts:183` | Step 2 fixers (R44g/R46) 用 `dockerfileAbsPath = join(projectDir, dockerfileRelPath)` |
| `packages/shared/src/types.ts:124` | `ProjectConfig.dockerfilePath?: string` 新欄位 |

### Backward compat

- `dockerfilePath` 預設 undefined / `'Dockerfile'`，所有現有 project 行為 0 變化
- multi-service split path 完全保留（`servicesWithDockerfile.length >= 2` 走原路）
- single-wrapper-dir descent (R44f `descendIntoWrapperDir`) 在 decider 之前跑，behavior 不變

## Consequences

**好處**：
- rfp-agent canonical case 修了 — `frontend/index.html` 不再被砍掉
- FastAPI + 靜態前端 hybrid pattern 變支援的 first-class case
- Pure decider 可獨立測（17 tests），未來加 strategy 不影響 routes
- Decider transparency log（`[GCS Submit] strategy: honest-monorepo, dockerfilePath: backend/Dockerfile`）容易 audit

**代價**：
- Build context 變大（rfp-agent 從 6.4 MB → 6.4 MB + 53 KB frontend，影響忽略）
- `dockerfilePath` field 是新 schema field — 在 ProjectConfig type 加好，DB 用 JSONB 儲存無 migration
- 對於只有 backend 想 deploy 不要 frontend 的 user，要自己加 `.dockerignore` 把 frontend 排除（不阻塞，warning 級）

**已知未解 risk**：
- User Dockerfile 寫死 `WORKDIR /app` + `COPY . .` 的話，整個 root（含 sibling）都 copy 進 image。對 user 來說 sibling 出現在 `/app/frontend/` 是預期的（`os.path.join(BASE_DIR, "..", "frontend")` 解到 `/app/frontend`，因為 `BASE_DIR` 是 `/app/backend`）。**前提**: user backend `WORKDIR /app/backend`，但實際 user Dockerfile 是 `WORKDIR /app` + `COPY backend/* ./`，這時 sibling 不在預期位置。**Mitigation**: 我們不修 user Dockerfile，遇到這個 case 仍會 fail，但 LLM diagnosis 會抓得到（root cause: `BASE_DIR/../frontend` 不存在）。

## 驗證

- `tsc --noEmit` 兩 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **3018 passed / 0 failed across 55 files**（3001 → +17 R60 tests）
- 17 tests:
  - R1 flat：root has Dockerfile（3 cases，含 hasPackageJson 衝突）
  - R2 multi-service：2/3 subdirs（含 order preservation）
  - R3 auto-gen-flat with package.json
  - R4 honest-monorepo canonical（rfp-agent shape，3 subdirs only-1，含 root files）
  - R5 fallback：empty / files only / 0-with-Dockerfile / 1-subdir-with-Dockerfile
  - Defensive：reference-identity（fresh object 每次）、forward-slash 路徑

- E2E（未做）：等平台 deploy + resubmit `wavenetdeveloper-rfp-agent` zip 驗 frontend/index.html 確實 serve 到

## 後續

- TODOS.md R60 entry 標 done
- TODOS.md 留 R61 (.dockerignore vs Dockerfile COPY 衝突 detector)
- openspec spec update：`project-detection/spec.md` 加 `honest-monorepo` case，`deployment-pipeline/spec.md` 加 `dockerfilePath` config field
