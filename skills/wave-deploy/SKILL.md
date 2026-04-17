---
name: wave-deploy
description: |
  潮部署！透過 Wave Deploy Agent 將專案部署到 GCP Cloud Run。
  觸發條件：使用者說「潮部署」、「請幫我潮部署」、「wave deploy」、或使用 /wave-deploy。
  支援上傳壓縮檔、本地目錄、Git 倉庫。自動偵測 monorepo 前後端、安全掃描、AI 修復。
---

# /wave-deploy — 潮部署 Wave Deploy Agent

將任何專案提交到 Wave Deploy Agent，經過安全掃描、AI 自動修復、人工審查，最終部署到 GCP Cloud Run。

## API 資訊

- **API Base**: `https://wave-deploy-agent-api.punwave.com`
- **Dashboard**: `https://wave-deploy-agent.punwave.com`
- **Custom Domain 格式**: `{subdomain}.punwave.com`
- **Monorepo**: 自動偵測，frontend → `{domain}.punwave.com`，backend → `api.{domain}.punwave.com`

## 🔑 認證（必讀）

所有 API 呼叫都需要 Bearer token。使用者本機需設 env var：

```bash
export DEPLOY_AGENT_API_KEY="da_k_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

下方所有 curl 範例都預設會從 shell 讀 `$DEPLOY_AGENT_API_KEY`。如果呼叫回 `HTTP 401`，檢查 env var 是否有設且 export 到 subshell。

在 `AUTH_MODE=permissive` 時漏掉 header 仍會通（但會被 audit log 當 anonymous）；切到 `enforced` 之後漏掉就 401。

---

## 完整流程

### Step 1: 確認專案資訊

向使用者確認以下資訊（如果尚未提供）：

| 欄位 | 必填 | 說明 | 範例 |
|------|------|------|------|
| 專案來源 | 是 | 本地目錄路徑、壓縮檔路徑(.tar.gz/.tgz/.zip)、或 Git URL | `/path/to/project` |
| 專案名稱 | 否 | 不填則從目錄名或檔名推斷 | `my-app` |
| 自訂網域 | 否 | 不填則只用 Cloud Run URL | `my-app` |
| 環境變數 | 否 | key=value 格式，可多筆 | `DATABASE_URL=postgres://...` |

### Step 2: 打包並上傳

根據來源類型選擇對應方式：

**來源是目錄：**
```bash
# 打包
tar -czf /tmp/PROJECT_NAME.tgz -C /path/to/project .

# 上傳
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "customDomain=SUBDOMAIN" \
  -F "envVars[KEY1]=VALUE1" \
  -F "envVars[KEY2]=VALUE2" \
  -F "file=@/tmp/PROJECT_NAME.tgz"
```

**來源是壓縮檔 (.tar.gz / .tgz / .zip)：**
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "customDomain=SUBDOMAIN" \
  -F "file=@/path/to/archive.tar.gz"
```

**來源是 Git URL：**
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "sourceType=git" \
  -F "gitUrl=https://github.com/owner/repo" \
  -F "customDomain=SUBDOMAIN"
```

**重要：** 上傳回應會告訴你是否為 monorepo。如果是 monorepo，回應中的 `services` 陣列會有多個 project，每個都有自己的 `project.id`。後續步驟需要對每個 service 都操作。

記下所有回傳的 `project.id`。

### Step 3: 等待掃描完成

每 15 秒輪詢狀態，直到所有 project 都變成 `review_pending`（或 `failed`）：

```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=d['project']; print(f'{p[\"name\"]}: {p[\"status\"]}')"
```

向使用者即時回報：
- `scanning` → 「掃描中...正在分析程式碼安全性」
- `review_pending` → 「掃描完成！」
- `failed` → 「掃描失敗」— 可用 skip-scan 跳過

**如果掃描卡住超過 3 分鐘，使用 skip-scan：**
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/skip-scan"
```

### Step 4: 查看掃描報告

```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail" | python3 -m json.tool
```

向使用者摘要：
- 發現幾個安全問題（按嚴重程度分類：critical / high / medium / low）
- 自動修復了幾個
- LLM 威脅分析摘要
- 預估月費

**如果有未能自動修復的 findings，告知使用者可以下載詳細報告：**
```
報告下載：https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/scan/report
```

### Step 5: 通過審查（觸發部署）

先查找待審查的 review ID：
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/reviews?status=pending" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for r in d.get('reviews', []):
    print(f'{r[\"id\"]} — {r.get(\"project_name\", \"?\")}')"
```

詢問使用者是否通過。通過後：
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X POST "https://wave-deploy-agent-api.punwave.com/api/reviews/REVIEW_ID/decide" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","reviewerEmail":"deploy@punwave.com","comments":"潮部署通過"}'
```

**Monorepo 部署順序很重要：** 先 approve backend，等它部署完成後再 approve frontend（這樣 frontend build 時才能注入正確的 backend URL）。

### Step 6: 等待部署完成

每 15 秒輪詢，直到狀態變為 `live`、`ssl_provisioning`、或 `failed`：
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=d['project']; print(f'{p[\"name\"]}: {p[\"status\"]}')"
```

狀態說明：
- `deploying` → 「Cloud Build 正在建構映像」
- `deployed` → 「映像已部署到 Cloud Run」
- `ssl_provisioning` → 「SSL 憑證申請中（可能需要數分鐘）」
- `canary_check` → 「Canary 健康檢查中」
- `live` → 「潮部署完成！專案已上線！」
- `failed` → 「部署失敗」

### Step 7: 回報最終結果

```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail" | python3 -c "
import json,sys
d = json.load(sys.stdin)
p = d['project']
print(f'Project: {p[\"name\"]}')
print(f'Status: {p[\"status\"]}')
for dep in d.get('deployments', []):
    print(f'Cloud Run: {dep.get(\"cloudRunUrl\", \"N/A\")}')
    print(f'Domain: {dep.get(\"customDomain\", \"N/A\")}')
    print(f'SSL: {dep.get(\"sslStatus\", \"N/A\")}')
"
```

顯示完整結果給使用者：
- Cloud Run URL（可直接存取）
- 自訂網域 URL（如有，可能 SSL 仍在 provisioning）
- 部署時間

如果是 monorepo，列出所有 service 的 URL。

---

## 常用操作

### 查看所有專案
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/projects" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('projects', []):
    print(f'{p[\"name\"]:30s} {p[\"status\"]:20s} {p.get(\"config\",{}).get(\"customDomain\",\"\")}')"
```

### 重新部署（已上線的專案）
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/resubmit"
```
然後回到 Step 3 繼續流程。

### 下載安全掃描報告
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/scan/report" -o scan-report.md
```

### 刪除專案（含 GCP 資源）
```bash
curl -s -H "Authorization: Bearer $DEPLOY_AGENT_API_KEY" -X DELETE "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID"
```

---

## 注意事項

1. **Monorepo 偵測**：如果專案根目錄包含 `frontend/` + `backend/`（或 `client/` + `server/`），會自動拆成兩個 Cloud Run service
2. **環境變數**：Frontend 的 `VITE_API_URL`/`NEXT_PUBLIC_API_URL` 等會自動注入 backend sibling 的 URL
3. **Port 偵測**：自動從 Dockerfile EXPOSE、框架預設（FastAPI→8000, Next.js→3000, nginx→80）偵測
4. **Custom Domain**：SSL 憑證通常需要 5-15 分鐘。在等待期間，Cloud Run URL 已可存取
5. **公開存取**：部署後需確認 Cloud Run service 允許未驗證存取（`allUsers` → `roles/run.invoker`）
