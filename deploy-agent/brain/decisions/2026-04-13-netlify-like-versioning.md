# 2026-04-13 Netlify-like 版本管理

## Status: Active

## Context

老闆問：「我有改版也可以部署上去嗎？」

需求是像 Netlify 一樣的版本管理體驗：
- 每次部署是一個不可變快照（immutable deploy）
- 可以看到所有歷史版本
- 每個版本有 Preview URL
- 一鍵發佈（publish）任何版本到正式域名
- 一鍵回滾（rollback = 發佈舊版本）
- Deploy Lock 防止自動發佈

## Decision

利用 Cloud Run 原生的 **Revision 機制** 實作 Netlify 模型：

| Netlify 概念 | Cloud Run 對應 | 我們的實作 |
|-------------|---------------|-----------|
| Site | Service (`da-{slug}`) | Project |
| Deploy | Revision | Deployment record（含 version 編號）|
| Preview URL | Revision URL | `previewUrl` 欄位 |
| Publish | `updateTraffic(revision, 100%)` | `publishRevision()` |
| Rollback | 發佈舊 revision | 同 publish，選舊版本 |

**不建新的 Cloud Run service**。同一個 service 的不同 revision = 不同版本。

### Schema 變更

```sql
-- deployments 表新增
ALTER TABLE deployments ADD COLUMN version INT DEFAULT 1;
ALTER TABLE deployments ADD COLUMN image_uri TEXT;
ALTER TABLE deployments ADD COLUMN revision_name VARCHAR(255);
ALTER TABLE deployments ADD COLUMN preview_url TEXT;
ALTER TABLE deployments ADD COLUMN is_published BOOLEAN DEFAULT false;
ALTER TABLE deployments ADD COLUMN published_at TIMESTAMPTZ;

-- projects 表新增
ALTER TABLE projects ADD COLUMN published_deployment_id UUID REFERENCES deployments(id);
ALTER TABLE projects ADD COLUMN deploy_locked BOOLEAN DEFAULT false;
```

### API 端點

| 端點 | 用途 |
|------|------|
| `GET /api/projects/:id/versions` | 版本歷史列表 |
| `POST /api/projects/:id/versions/:deployId/publish` | 發佈指定版本 |
| `POST /api/projects/:id/new-version` | 上傳新原始碼觸發新版本 |
| `POST /api/projects/:id/deploy-lock` | 切換部署鎖定 |

### Deploy Worker 變更

- `createDeployment()` 自動遞增版本號
- 每次部署記錄 `imageUri`、`revisionName`
- Go Live 時自動 `publishDeployment()`（除非 `deployLocked`）

### Web UI

- Project detail page：版本歷史面板（所有版本 + 狀態 + 發佈按鈕）
- 「升版部署」按鈕 + 上傳 modal
- Deploy Lock toggle

## Consequences

### 好處
- 一鍵回滾（秒級，不需重新 build）
- 版本歷史可追蹤
- Deploy Lock 防止意外發佈
- 完全向後相容（舊 deployment 記錄 version=1）

### 代價
- 每個版本佔一個 Cloud Run revision（免費額度 1000 個 revision）
- Schema migration 需要跑（用 `ADD COLUMN IF NOT EXISTS`，安全）
- Preview URL 目前用 Cloud Run service URL 而非 revision-specific URL（需 Cloud Run v2 完整 traffic splitting 才能做到）

### 後續規劃
- Phase 2: Preview URL 改用 Cloud Run revision-specific URL
- Phase 2: 版本保留策略（保留最近 N 個，自動 archive 舊版）
- Phase 2: Auto Rollback（canary 失敗自動回滾到上一個 healthy 版本）
- Phase 3: Git Push 自動部署（webhook）
- Phase 3: Branch Deploy
