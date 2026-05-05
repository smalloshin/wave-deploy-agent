# 2026-05-05 — Pre-deploy DB migration step（R57）

## Status

Active

## Context

`luca-v2` resubmit 部署掛了：新 schema 的 column 沒人跑 `prisma migrate deploy`，container 起來查不到 column → uvicorn / FastAPI 啟動 crash → Cloud Run health check timeout 4 分鐘 → deploy 失敗。

R44g 已經在 build time 注入 `prisma generate`（產 Prisma Client TypeScript 檔），但**那是 codegen，不是 schema migration**。Vibe-coded 專案沒人手動跑 `prisma migrate deploy` 或 `alembic upgrade head`，每次 v2 部署 schema 都會跟 code 對不上。

CEO review + plan-eng-review 結論：**Pipeline 加 Step 3.5 跑 migration job**，介於 image push 完成跟 Cloud Run revision swap 之間。失敗時 NEW revision 不切流量，舊版繼續服務 100% traffic = zero-downtime。

## Decision

### 整體架構

```
Step 3   Cloud Build (image built + pushed to AR)
   ↓
Step 3.5 ★ R57 Migration job ★
         │
         ├─ migration-detector.ts (pure)
         │    Prisma + migrations/      → npx prisma migrate deploy
         │    Prisma + 無 migrations/   → 警告 + skip (db push 不可在 prod 跑)
         │    Alembic + alembic.ini     → alembic upgrade head
         │    無 DB markers              → skip
         │
         ├─ Concurrency: claim row in wave_deploy_migrations
         │    (unique partial index ON project_id WHERE status='running')
         │    第二個並行 deploy 自動 retry-wait 10 min
         │
         ├─ Cloud Run Jobs orchestration:
         │    - 用同一個剛 build 的 image (multi-stage 用 R57 prisma CLI helper 保留)
         │    - Cloud SQL Auth Proxy sidecar via volume mount
         │    - 2 vCPU / 2 GiB / 10 min timeout
         │    - Sync poll execution status (gcp-poll.ts DRY helper, 3s/9s/27s backoff)
         │
         ├─ on success → continue Step 4
         └─ on failure → throw with errorCode → deploy-worker outer catch
                        → 舊 revision 保留 100% traffic
                        → LLM diagnosis 含 container logs (R53)
   ↓
Step 4   Cloud Run revision swap (existing — DB schema 已升級)
```

### 5 個新檔案

| File | 行數 | 用途 |
|------|------|-----|
| `services/migration-detector.ts` | 159 | 純函式偵測 tool（17 tests）|
| `services/gcp-poll.ts` | 158 | DRY polling helper，R47 reconciler-recovery 也可用（14 tests）|
| `services/cloudrun-jobs-migration-runner.ts` | 405 | Async orchestrator（concurrency control + GCP API + audit row）|
| `db/schema.sql` (append) | +50 | `wave_deploy_migrations` table + 3 indexes |
| `services/prisma-fixer.ts` (extend) | +120 | `ensurePrismaCliInProd()` 保留 prisma CLI 在 prod stage（8 R57 tests）|

### 2 個 modify

| File | 改動 |
|------|------|
| `services/settings-service.ts` | 加 `runMigrations: boolean` toggle（預設 false，opt-in）|
| `services/stage-events.ts` | `StageName` 加 `'migrate'`，STAGE_ORDER 插在 push 跟 deploy 之間 |
| `services/deploy-worker.ts` | Step 3.5 hook（30 行）|

### 為什麼 Cloud Run Jobs 而不是 Cloud Build step / init container / sidecar

| 選項 | 為什麼不選 |
|------|-----------|
| init container | Cloud Run service 不支援（GKE 才有）|
| sidecar | sidecar 是 service mesh 用，不是 one-shot job |
| Cloud Build step | Cloud Build worker 沒 VPC 連到 Cloud SQL（要架 Auth Proxy 在 build worker，超麻煩）；polluting build log；migration 跟 build 緊綁，build 失敗看不到 migration log |
| **Cloud Run Jobs（選用）** | 同一個 image / env / VPC connector / Cloud SQL Auth Proxy；獨立資源獨立 quota；image 已在 GCR cached for 後續 service 啟動 |

### 為什麼 row-based concurrency 而不是 advisory lock

CEO spec review 一輪刪改後 reviewer 5.1：advisory lock 是 connection-scoped，**沒 TTL**，network blip 連線斷就釋放，但 transaction 可能還在跑。Race window 真實。

改用 row-based primitive：
- `wave_deploy_migrations` table + unique partial index `WHERE status='running'`
- INSERT ON CONFLICT DO NOTHING — 拿不到 row 就 retry 等
- `expires_at` TTL 15 min — worker crash 時 stale row 會被掃掉（reconciler 跟 runner 自身都會 sweep）

### Toggle 設計（reviewer 2.4 簡化）

`settings.runMigrations: boolean` **預設 false**：
- reviewer 提醒：default-on 跟「v1 no rollback」不一致
- operator 在 staging 測過再 explicit `PUT /api/settings { runMigrations: true }`
- per-project override 暫不做（YAGNI）

### v1 scope（CEO + eng review 已縮編）

**支援**：
- ✅ Prisma（with migrations/）
- ✅ Prisma db_push only（偵測但不跑，警告 user 改 migrate dev）
- ✅ Alembic（FastAPI / SQLAlchemy）

**v2 add（TODOS.md R57.3）**：
- ❌ Django / Drizzle / TypeORM / Knex / Flask-Migrate

**v3+**：
- ❌ Rails / SQL files + checksums table（vibe-coders 沒這些）

### Audit log shape

每次 migration step 寫 row 到 `wave_deploy_migrations` + stage event：

```sql
SELECT tool, command, status, exit_code, duration_ms, error_message, started_at, finished_at
FROM wave_deploy_migrations
WHERE project_id = ?
ORDER BY started_at DESC;
```

stage_events 也記一筆 `'migrate'` started/succeeded/failed/skipped — 給 dashboard 7-stepper（變 8-stepper）用。

## Consequences

**好處：**
- `luca-v2` / wavenet 那類 v2 redeploy 自動跑 migration → schema 自動跟 code 對上
- Zero-downtime：失敗時舊 revision 100% traffic，user 完全不受影響
- Concurrency control 可審計（row + audit log），advisory lock 的 hidden race window 解
- `gcp-poll.ts` 是 DRY helper，未來 R47 reconciler-recovery + 其他 GCP polling 都可重用
- 44 個新 zero-dep 測試（detector 17 + gcp-poll 14 + prisma-fixer R57 8 + settings R57 5）

**代價：**
- Deploy 整體時間 +30-90s（Cloud Run Job cold start + image pull）。對小專案可忽略，對 50 deploy/day 的專案 = +5-7 min/day
- `wave_deploy_migrations` table 每次 deploy +1 row，需要 cleanup cron（TODOS.md R57.2）
- Prisma CLI in prod stage 多 ~50MB image size（接受）
- v1 不支援 down migration / rollback — forward-only。失敗時 user 改 schema 重 submit。文件提示

**已知未解 risk（不阻塞 R57 上線）：**
- multi-file Prisma migration 中間失敗 → 半成功狀態（each file atomic but inter-file not）。Audit log 記錄哪幾檔成功
- migration 成功 + Cloud Run revision swap 失敗 → DB 領先 code（v1 不修，文件提示「改 schema 重 submit」）
- R47 reconciler race window 15 min 在 R57 之後可能還是不夠（deploy 時間從 9 min → 12-15 min）。實測後可能調 25 min（TODOS.md R57.1）

**未來可能需要做（已寫進 TODOS.md）：**
- R57.1 R47 race window 從 15→25 min（看 e2e 真實 timing）
- R57.2 `cleanup_old_migrations()` cron（30 天前 row）
- R57.3 Django / Drizzle / TypeORM / Knex / Flask-Migrate detector
- R57.4 reconciler 也撈 Job logs（observ symmetry）
- R57.5 user Dockerfile 警告「missing prisma CLI in prod stage」
- R57.6 Cloud SQL pool size 文件（pool ≥20 for production）

## 驗證

- `tsc --noEmit` 兩個 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **3001 passed / 0 failed across 54 files**（從 R56 的 2957/52 加 44 R57 測試 + 2 新檔剛好對上）
- Test coverage：
  - migration-detector: 17 tests（5 detection branches + 4 edge cases + 4 defensive + 4 describe variants）
  - gcp-poll: 14 tests（schedule pure helper 5 + async poll 9 — happy / failed / timeout / fetcher_error / cancelled / transient retry）
  - prisma-fixer ensurePrismaCliInProd: 8 tests（single-stage no-op / multi-stage inject / idempotent / builder selection / fallback / ENTRYPOINT / 2 defensive）
  - settings runMigrations: 5 tests（default false / true / 非 boolean fallback / JSON string / 3 flags 共存）
- Real-world 驗收：等 R57 上線後在 staging 測試（拿 `luca-optimizer-kb` 加個 migration column 試 e2e），確認舊 revision 在 migration 失敗時保留服務
- Phased rollout：
  - Phase 1: ship 程式碼 toggle off，dogfood 自己 luca / wavenet
  - Phase 2: settings runMigrations=true，1 週監控 audit log
  - Phase 3: 對外開放
