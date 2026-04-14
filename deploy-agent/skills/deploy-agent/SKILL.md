---
name: deploy
description: 潮部署！上傳專案到 Wave Deploy Agent 進行安全掃描、自動修復、審查並部署到 GCP Cloud Run。觸發詞：「我要潮部署」
---

# /deploy — Wave Deploy Agent 潮部署

🚀 **我要潮部署某個專案！**

將專案提交到 Wave Deploy Agent，經過安全掃描、AI 自動修復、人工審查，最終部署到 GCP Cloud Run。

## API Base URL

```
https://wave-deploy-agent-api.punwave.com
```

Dashboard：https://wave-deploy-agent.punwave.com

## 完整部署流程

當使用者說「我要潮部署」時，按照以下步驟執行：

### Step 1: 確認專案資訊

向使用者確認以下資訊（如果尚未提供）：
- **專案名稱**（必填）— 例如 `my-awesome-app`
- **來源方式**（必填）— `upload`（上傳壓縮檔）或 `git`（Git 倉庫 URL）
- **自訂網域**（必填）— 例如 `my-app`（會變成 `my-app.punwave.com`）
- **是否公開**（選填）— 預設 `true`，允許未驗證存取
- **資料庫 Dump**（選填）— `.sql`、`.dump` 或 `.sql.gz` 檔案路徑，部署時自動匯入

### Step 2: 提交專案

**方式 A — 上傳壓縮檔：**

如果使用者提供了本地路徑或檔案：
```bash
# 打包專案
tar -czf /tmp/PROJECT_NAME.tgz -C /path/to/project .

# 上傳
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "sourceType=upload" \
  -F "customDomain=SUBDOMAIN" \
  -F "allowUnauthenticated=true" \
  -F "file=@/tmp/PROJECT_NAME.tgz" \
  -F "dbDump=@/path/to/dump.sql"  # 選填：資料庫 dump 檔
```

**方式 B — Git 倉庫：**
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "sourceType=git" \
  -F "gitUrl=https://github.com/owner/repo" \
  -F "dbDump=@/path/to/dump.sql"  # 選填：資料庫 dump 檔
```

記下回傳的 `project.id`。

**⚠ Domain 衝突處理：**

如果 API 回傳 HTTP 409 且 `error: "domain_conflict"`，表示該 domain 已被其他服務使用。
向使用者顯示衝突資訊，並詢問：
- 「這個 domain 已經被 `{existingRoute}` 使用中。要覆蓋嗎？」
- 如果使用者同意覆蓋，重新提交時加上 `-F "forceDomain=true"`
- 如果使用者不同意，請使用者提供其他 domain

### Step 3: 等待掃描完成

每 10 秒輪詢一次，直到狀態變為 `review_pending`：
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['project']['status'])"
```

過程中向使用者即時回報進度：
- `scanning` → 「🔍 掃描中...正在分析程式碼安全性」
- `review_pending` → 「✅ 掃描完成！等待審查」

### Step 4: 查看掃描報告

```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail"
```

向使用者摘要報告內容：
- 發現了幾個安全問題
- 自動修復了幾個
- 預估月費是多少

### Step 5: 查找待審查項目

```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/reviews?status=pending" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(r['id']) for r in d['reviews'] if r.get('project_name')=='PROJECT_NAME']"
```

### Step 6: 通過審查（觸發部署）

詢問使用者是否通過審查。如果通過：
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/reviews/REVIEW_ID/decide" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","reviewerEmail":"USER_EMAIL","comments":"潮部署通過！"}'
```

如果駁回：
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/reviews/REVIEW_ID/decide" \
  -H "Content-Type: application/json" \
  -d '{"decision":"rejected","reviewerEmail":"USER_EMAIL","comments":"REASON"}'
```

### Step 7: 等待部署完成

通過審查後，自動觸發部署 pipeline。每 15 秒輪詢：
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['project']['status'])"
```

向使用者即時回報：
- `deploying` → 「🏗️ 部署中...Cloud Build 正在建構映像」
- `deployed` → 「📦 映像已部署到 Cloud Run」
- `ssl_provisioning` → 「🔒 SSL 憑證申請中...」
- `canary_check` → 「🐦 Canary 健康檢查中...」
- `live` → 「🎉 潮部署完成！專案已上線！」
- `failed` → 「❌ 部署失敗，查看詳情...」

### Step 8: 回報最終結果

部署成功後，顯示：
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail"
```

向使用者展示：
- Cloud Run URL
- 自訂網域 URL（如有）
- 健康狀態
- 部署時間

---

## 其他操作

### 查看所有專案
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects"
```

### 查看專案詳情
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail"
```

### 重試失敗的專案
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/resubmit"
```

### 刪除專案（含 GCP 資源清除）
```bash
curl -s -X DELETE "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID"
```

### 查看部署紀錄
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/deploys"
```

---

### 帶資料庫 Dump 部署

如果使用者提供了資料庫 dump 檔（`.sql`、`.dump`、`.pgdump`、`.sql.gz`），部署時會：
1. 自動建立專案專屬的 PostgreSQL 資料庫（Cloud SQL）
2. 用 `psql` 或 `pg_restore` 匯入 dump 檔
3. 把 `DATABASE_URL` 指向新建的資料庫

```bash
# 範例：帶 SQL dump 部署
tar -czf /tmp/my-app.tgz -C /path/to/project .
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=my-app" \
  -F "sourceType=upload" \
  -F "file=@/tmp/my-app.tgz" \
  -F "dbDump=@/path/to/production.sql"
```

支援的格式：
- `.sql` — 純 SQL（`pg_dump --format=plain`）
- `.dump` / `.pgdump` — 自訂格式（`pg_dump --format=custom`）
- `.sql.gz` — 壓縮的純 SQL

---

## Pipeline 流程

```
提交 → 語言偵測 → Dockerfile 生成 → SAST 掃描 → SCA 掃描
  → AI 威脅分析 → 自動修復 → 驗證掃描 → 審查報告
  → 成本估算 → 【人工審查】→ DB 建立 → DB Dump 匯入（如有）
  → Cloud Build → Cloud Run → 網域設定 → SSL 憑證
  → Canary 檢查 → 🎉 上線！
```

## MCP 工具

API 提供 MCP 端點 `/mcp/tools/list` 和 `/mcp/tools/call`：

| 工具 | 說明 |
|------|------|
| `submit_project` | 提交專案進行掃描 |
| `get_project_status` | 查看專案狀態 |
| `list_projects` | 列出所有專案 |
| `get_scan_report` | 取得安全掃描報告 |
| `approve_deploy` | 通過審查，觸發部署 |
| `reject_deploy` | 駁回審查 |
| `get_deploy_status` | 查看部署健康狀態 |
| `rollback_deploy` | 回滾到上一版本 |
| `get_versions` | 取得專案版本歷史 |
| `publish_version` | 發佈指定版本（切流量） |
| `rollback_version` | 回滾到上一個已發佈版本 |
| `toggle_deploy_lock` | 鎖定/解鎖部署 |

---

## 版本管理操作

### 查看版本歷史
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/versions" | python3 -m json.tool
```

### 發佈指定版本
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/versions/DEPLOY_ID/publish" \
  -H "Content-Type: application/json"
```

### 回滾到上一版本
找到上一個版本的 deployment ID，然後用上面的 publish 端點發佈它。

### 鎖定/解鎖部署
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/deploy-lock" \
  -H "Content-Type: application/json"
```

### 升版部署（新版本）
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/new-version" \
  -H "Content-Type: application/json" \
  -d '{"gcsUri": "gs://bucket/path/to/source.tgz"}'
```

---

## GitHub Webhook 自動部署

### 設定 GitHub Webhook
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/github-webhook" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/owner/repo", "branch": "main"}'
```

回傳 webhook URL 和 secret。到 GitHub repo Settings → Webhooks 新增：
- **Payload URL**: 回傳的 `webhookUrl`
- **Content type**: `application/json`
- **Secret**: 回傳的 `secret`
- **Events**: Just the push event

### 查看 Webhook 設定
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/github-webhook"
```

### 移除 Webhook 設定
```bash
curl -s -X DELETE "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/github-webhook"
```

---

## Discord Bot 自然語言操作

Bot 支援 @mention 或 DM 方式輸入自然語言指令：

| 指令範例 | 對應操作 |
|----------|----------|
| 列出所有專案 | list_projects |
| bid-ops 的狀態 | get_project_status |
| 通過 cold-outreach 的審查 | approve_deploy |
| 駁回 cold-outreach | reject_deploy |
| 發佈 bid-ops v3 | publish_version |
| 回滾 bid-ops | rollback_version |
| 鎖定 bid-ops 的部署 | toggle_deploy_lock |

危險操作（發佈、回滾、鎖定）需要確認按鈕。
