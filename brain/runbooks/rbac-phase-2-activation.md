# RBAC Phase 2 啟用 Runbook

> Phase 1（permissive mode）已上線於 2026-04-17。
> 這份 runbook 走完 Phase 2 → Phase 3（enforced mode）的完整步驟。

## 前置檢查

```bash
# 確認 Phase 1 已部署且 auth_mode = permissive
curl -s https://wave-deploy-agent-api.punwave.com/health
# 預期：{"status":"ok", ... "auth_mode":"permissive"}
```

---

## Step 1: 在 Secret Manager 建立 ADMIN_PASSWORD + SESSION_SECRET

```bash
# 產生 session secret（32 bytes random hex）
SESSION_SECRET=$(openssl rand -hex 32)
printf '%s' "$SESSION_SECRET" | gcloud secrets create deploy-agent-session-secret \
  --project=wave-deploy-agent \
  --data-file=- \
  --replication-policy=automatic
# ⚠️ 用 printf 不是 echo — echo 會加 \n，password hash 會把 \n 算進去，
# 之後登入時很容易弄錯

# 產生 admin 初始密碼（請事後立刻改掉）
ADMIN_PASSWORD=$(openssl rand -base64 24)
echo "初始 admin 密碼（請記錄）：$ADMIN_PASSWORD"
printf '%s' "$ADMIN_PASSWORD" | gcloud secrets create deploy-agent-admin-password \
  --project=wave-deploy-agent \
  --data-file=- \
  --replication-policy=automatic

# 授權 deploy-agent@ SA 存取
for SECRET in deploy-agent-session-secret deploy-agent-admin-password; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --project=wave-deploy-agent \
    --member="serviceAccount:deploy-agent@wave-deploy-agent.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## Step 2: 更新 API Cloud Run，掛上 secrets + ADMIN_EMAIL

```bash
gcloud run services update deploy-agent-api \
  --project=wave-deploy-agent \
  --region=asia-east1 \
  --update-env-vars=ADMIN_EMAIL=YOUR_EMAIL@example.com \
  --update-secrets=SESSION_SECRET=deploy-agent-session-secret:latest,ADMIN_PASSWORD=deploy-agent-admin-password:latest
```

**重啟後** API 會 bootstrap admin user（log 出現 `[auth] Bootstrapped admin user: ...`）。

---

## Step 3: 驗證登入

```bash
# 用你設定的 ADMIN_EMAIL + ADMIN_PASSWORD 登入
curl -s -X POST https://wave-deploy-agent-api.punwave.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"YOUR_EMAIL@example.com","password":"YOUR_ADMIN_PASSWORD"}' \
  -c /tmp/cookies.txt

# 預期：回傳 user 物件 + token + set-cookie
# GET /api/auth/me 應回 200
curl -s https://wave-deploy-agent-api.punwave.com/api/auth/me -b /tmp/cookies.txt
```

或用 web dashboard：https://wave-deploy-agent.punwave.com/login

---

## Step 4: 建立 Bot API key

登入 dashboard 後（或用 curl），建立 API key：

```bash
# 登入後用 cookie
curl -s -X POST https://wave-deploy-agent-api.punwave.com/api/auth/api-keys \
  -H "Content-Type: application/json" \
  -b /tmp/cookies.txt \
  -d '{
    "name": "Discord Bot",
    "permissions": [
      "projects:read","reviews:read","reviews:decide",
      "deploys:read","versions:read","projects:deploy","versions:publish"
    ]
  }'
# 回傳會包含 raw_key（例：da_k_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx）
# ⚠️ 只顯示一次，立刻複製
```

把 raw_key 存到 Secret Manager 並掛到 Bot Cloud Run：

```bash
echo "da_k_xxxxxxxxxxxxxx" | gcloud secrets create deploy-agent-bot-api-key \
  --project=wave-deploy-agent \
  --data-file=- \
  --replication-policy=automatic

gcloud secrets add-iam-policy-binding deploy-agent-bot-api-key \
  --project=wave-deploy-agent \
  --member="serviceAccount:deploy-agent@wave-deploy-agent.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud run services update deploy-agent-bot \
  --project=wave-deploy-agent \
  --region=asia-east1 \
  --update-secrets=DEPLOY_AGENT_API_KEY=deploy-agent-bot-api-key:latest
```

Bot 重啟後，`api-client.ts` 會自動帶 `Authorization: Bearer`（已在 config.ts 讀 `DEPLOY_AGENT_API_KEY`）。

驗證：從 Discord 執行任何 bot 命令，確認 `auth_audit_log` 中出現對應 user_id 的成功 request（不是 anonymous）。

---

## Step 5: 建立 MCP API key（admin 級別）

```bash
curl -s -X POST https://wave-deploy-agent-api.punwave.com/api/auth/api-keys \
  -H "Content-Type: application/json" \
  -b /tmp/cookies.txt \
  -d '{"name":"MCP Server","permissions":["*"]}'
```

儲存 raw_key 到環境變數 `DEPLOY_AGENT_API_KEY` 給 MCP 使用。所有 `curl /mcp/tools/call` 範例已更新（見 `skills/wave-deploy/SKILL.md`）加上 `-H "Authorization: Bearer $DEPLOY_AGENT_API_KEY"`。

---

## Step 6: 觀察 anonymous requests

跑幾天 permissive mode，查 audit log：

```bash
curl -s https://wave-deploy-agent-api.punwave.com/api/auth/audit-log?limit=500 \
  -b /tmp/cookies.txt | jq '.entries[] | select(.action=="anonymous_request")'
```

**目標：連續 48 小時沒有任何 anonymous request**（除了 webhook 和 health）。

如果還有 anonymous，找出來源並補上認證（通常是：漏掉的消費者、舊 cache 的 bot、舊 script）。

---

## Step 7: 切到 enforced mode

```bash
gcloud run services update deploy-agent-api \
  --project=wave-deploy-agent \
  --region=asia-east1 \
  --update-env-vars=AUTH_MODE=enforced
```

**立刻驗證**：
```bash
# 無認證 → 401
curl -sI https://wave-deploy-agent-api.punwave.com/api/projects
# 預期：HTTP/2 401

# Bot 仍正常（從 Discord 下指令測）
# Web dashboard 仍正常（/login 仍可用）
```

如果出問題 → **立刻回滾**：
```bash
gcloud run services update deploy-agent-api \
  --project=wave-deploy-agent \
  --region=asia-east1 \
  --update-env-vars=AUTH_MODE=permissive
```

---

## Step 8: 改預設 admin 密碼

登入 dashboard 後（或直接用 API），呼叫 PATCH 改自己的密碼：

```bash
# 先拿自己的 user id
MY_ID=$(curl -s https://wave-deploy-agent-api.punwave.com/api/auth/me -b /tmp/cookies.txt | jq -r .id)

curl -s -X PATCH "https://wave-deploy-agent-api.punwave.com/api/auth/users/$MY_ID" \
  -H "Content-Type: application/json" \
  -b /tmp/cookies.txt \
  -d '{"password":"NEW_STRONG_PASSWORD_16_CHARS_MIN"}'
```

完成後，Secret Manager 裡的 `deploy-agent-admin-password` 就只是 bootstrap fallback，可留可刪。

---

## Rollback 計劃

任何步驟出錯：

- **Step 2 後，admin 沒 bootstrap 出來** → 查 Cloud Run logs 看 `[auth] Admin bootstrap failed` 原因
- **Bot/MCP 401** → 確認 secret 是否帶完整 key（含 `da_k_` 前綴）
- **切 enforced 後 web 401** → 回滾 AUTH_MODE=permissive，確認 cookie domain / CORS credentials 設定

最終核彈回滾（admin user 爛掉、無法登入）：
```sql
-- 直接進 Cloud SQL 手動插一筆 admin
-- password_hash 用 bcrypt CLI 產生（cost 12）
INSERT INTO users (email, password_hash, role_id, display_name)
SELECT 'recovery@example.com', '$2b$12$...', id, 'Recovery'
  FROM roles WHERE name = 'admin';
```
