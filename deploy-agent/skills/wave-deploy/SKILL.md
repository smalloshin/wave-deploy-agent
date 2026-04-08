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

---

## ⛔ 必讀規則：不要猜、不要跳過、必須問使用者

> **鐵律：如果以下任何必填欄位使用者沒有明確提供，你必須停下來詢問使用者，絕對不要自己猜測或填入預設值。**
>
> 違反這個規則 = 部署失敗 + 浪費 GCP 資源 + 使用者會生氣。

---

## 完整流程

### Step 0: 收集必填資訊（🚫 不可跳過）

在執行任何 API 呼叫之前，你**必須**確認以下所有必填欄位都已由使用者明確提供。

| 欄位 | 必填 | 說明 | 範例 | 缺少時的行為 |
|------|------|------|------|------------|
| 專案來源 | ✅ 必填 | 本地目錄路徑、壓縮檔路徑(.tar.gz/.tgz/.zip)、或 Git URL | `/path/to/project` | ❌ 必須問使用者 |
| 專案名稱 | ✅ 必填 | 英文、小寫、可含連字號 | `my-app` | ❌ 必須問使用者（不要從路徑猜） |
| 自訂網域 | ✅ 必填 | 會變成 `{subdomain}.punwave.com` | `my-app` | ❌ 必須問使用者 |
| 環境變數 | ⚠️ 必問 | key=value 格式，可多筆。使用者可以說「沒有」 | `DATABASE_URL=postgres://...` | ❌ 必須問使用者（使用者回答「沒有」才可跳過） |
| DB Dump | ⚠️ 必問 | 資料庫備份檔 (.sql/.dump/.sql.gz)，部署時自動還原 | `/path/to/dump.sql` | ❌ 必須問使用者（使用者回答「沒有」才可跳過） |

> **⚠️ 必問** = 這些欄位雖然可以不填，但你**必須主動詢問**使用者是否需要。
> 只有使用者明確回答「不需要」「沒有」「跳過」時，才能跳過。
> **絕對不要**因為使用者沒主動提起就自己決定跳過。

**執行步驟：**

1. 檢查使用者的訊息，列出已提供和尚未提供的欄位
2. **立刻停下來**，用以下格式詢問所有尚未確認的欄位：

```
要幫你潮部署，我需要確認幾個資訊：

1. 📁 專案來源：[已提供 ✅ / ❓ 請提供本地路徑、壓縮檔路徑、或 Git URL]
2. 📛 專案名稱：[已提供 ✅ / ❓ 你想叫什麼名字？(英文小寫，例如 my-app)]
3. 🌐 自訂網域：[已提供 ✅ / ❓ 你想用什麼子網域？(例如 my-app → my-app.punwave.com)]
4. 🔐 環境變數：[已提供 ✅ / ❓ 有需要注入的環境變數嗎？(例如 DATABASE_URL、API_KEY 等，沒有請說「沒有」)]
5. 🗄️ DB Dump：[已提供 ✅ / ❓ 有需要在部署時還原的資料庫備份嗎？(.sql/.dump 檔，沒有請說「沒有」)]

請確認以上資訊，我就開始部署！
```

3. 等使用者全部回覆後，才能進入 Step 1
4. 如果使用者只回答了部分，**再次追問**剩下的欄位，不要自己跳過

> ⚠️ 再次強調：**絕對不要**在缺少必填欄位的情況下呼叫 submit_project 或 upload API。
> 如果你在 Step 0 發現缺少欄位卻直接跳到 Step 1，你就搞砸了。

---

### Step 1: 打包並上傳

**前置確認**（心理 checklist，不需顯示給使用者）：
- [ ] 專案來源 ✅ 已確認
- [ ] 專案名稱 ✅ 已確認
- [ ] 自訂網域 ✅ 已確認
- [ ] 環境變數 ✅ 已確認（使用者提供了 or 明確說不需要）
- [ ] DB Dump ✅ 已確認（使用者提供了 or 明確說不需要）

如果上面任何一項打不了勾，**回到 Step 0**。

根據來源類型選擇對應方式：

**來源是目錄：**
```bash
# 打包
tar -czf /tmp/PROJECT_NAME.tgz -C /path/to/project .

# 上傳
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "customDomain=SUBDOMAIN" \
  -F "envVars[KEY1]=VALUE1" \
  -F "envVars[KEY2]=VALUE2" \
  -F "file=@/tmp/PROJECT_NAME.tgz"
```

**來源是壓縮檔 (.tar.gz / .tgz / .zip)：**
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "customDomain=SUBDOMAIN" \
  -F "file=@/path/to/archive.tar.gz"
```

**來源是 Git URL：**
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/upload" \
  -F "name=PROJECT_NAME" \
  -F "sourceType=git" \
  -F "gitUrl=https://github.com/owner/repo" \
  -F "customDomain=SUBDOMAIN"
```

**重要：** 上傳回應會告訴你是否為 monorepo。如果是 monorepo，回應中的 `services` 陣列會有多個 project，每個都有自己的 `project.id`。後續步驟需要對每個 service 都操作。

記下所有回傳的 `project.id`。

### Step 2: 等待掃描完成

每 15 秒輪詢狀態，直到所有 project 都變成 `review_pending`（或 `failed`）：

```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=d['project']; print(f'{p[\"name\"]}: {p[\"status\"]}')"
```

向使用者即時回報：
- `scanning` → 「掃描中...正在分析程式碼安全性」
- `review_pending` → 「掃描完成！」
- `failed` → 「掃描失敗」— 可用 skip-scan 跳過

**如果掃描卡住超過 3 分鐘，使用 skip-scan：**
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/skip-scan"
```

### Step 3: 查看掃描報告

```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail" | python3 -m json.tool
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

### Step 4: 通過審查（觸發部署）

先查找待審查的 review ID：
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/reviews?status=pending" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for r in d.get('reviews', []):
    print(f'{r[\"id\"]} — {r.get(\"project_name\", \"?\")}')"
```

詢問使用者是否通過。通過後：
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/reviews/REVIEW_ID/decide" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","reviewerEmail":"deploy@punwave.com","comments":"潮部署通過"}'
```

**Monorepo 部署順序很重要：** 先 approve backend，等它部署完成後再 approve frontend（這樣 frontend build 時才能注入正確的 backend URL）。

### Step 5: 等待部署完成

每 15 秒輪詢，直到狀態變為 `live`、`ssl_provisioning`、或 `failed`：
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); p=d['project']; print(f'{p[\"name\"]}: {p[\"status\"]}')"
```

狀態說明：
- `deploying` → 「Cloud Build 正在建構映像」
- `deployed` → 「映像已部署到 Cloud Run」
- `ssl_provisioning` → 「SSL 憑證申請中（可能需要數分鐘）」
- `canary_check` → 「Canary 健康檢查中」
- `live` → 「潮部署完成！專案已上線！」
- `failed` → 「部署失敗」

### Step 6: 回報最終結果

```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/detail" | python3 -c "
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
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('projects', []):
    print(f'{p[\"name\"]:30s} {p[\"status\"]:20s} {p.get(\"config\",{}).get(\"customDomain\",\"\")}')"
```

### 重新部署（已上線的專案）
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/resubmit"
```
然後回到 Step 2 繼續流程。

### 重試網域對應（domain mapping 失敗時）
```bash
curl -s -X POST "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/retry-domain"
```

### 下載安全掃描報告
```bash
curl -s "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID/scan/report" -o scan-report.md
```

### 刪除專案（含 GCP 資源）
```bash
curl -s -X DELETE "https://wave-deploy-agent-api.punwave.com/api/projects/PROJECT_ID"
```

---

## 網域衝突處理

上傳時如果收到 HTTP 409 回應，表示自訂網域已被其他服務佔用：

```json
{"error": "domain_conflict", "message": "Domain \"xxx.punwave.com\" is already mapped to service \"da-xxx\". Set forceDomain=true to override."}
```

此時應告知使用者，並詢問是否要：
1. 換一個不同的子網域
2. 強制覆蓋（加上 `-F "forceDomain=true"`）

---

## 注意事項

1. **Monorepo 偵測**：如果專案根目錄包含 `frontend/` + `backend/`（或 `client/` + `server/`），會自動拆成兩個 Cloud Run service
2. **環境變數**：Frontend 的 `VITE_API_URL`/`NEXT_PUBLIC_API_URL` 等會自動注入 backend sibling 的 URL
3. **Port 偵測**：自動從 Dockerfile EXPOSE、框架預設（FastAPI→8000, Next.js→3000, nginx→80）偵測
4. **Custom Domain**：SSL 憑證通常需要 5-15 分鐘。在等待期間，Cloud Run URL 已可存取
5. **公開存取**：部署後需確認 Cloud Run service 允許未驗證存取（`allUsers` → `roles/run.invoker`）
