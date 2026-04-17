# Terraform Cloud Run Import Runbook

## 問題

2026-04-17 發現：`terraform/services.tf` 內容完整（api/web/bot 都有），但 state 中沒有對應 resources。`terraform plan` 顯示：

- **22 to add**：包含已存在 prod 的 Cloud Run services（`api`, `web`, `bot`）、IAM binding、4 個 Discord secrets
- **2 to update**：
  - 🔴 `google_storage_bucket.cloudbuild` — **會移除手動加的 CORS 設定（dashboard upload 用的，砍了 upload 會壞）**
  - `google_sql_database_instance.deploy_agent` — 只是 authorized_networks 的 name field 小差異（OK）

**直接 apply 會破壞 prod。** 必須先 import 現有資源，並把 CORS 加進 storage.tf。

## 修復順序

### Step 1: 把 storage bucket CORS 寫進 storage.tf

```bash
# 先看現有 CORS 設定
gcloud storage buckets describe gs://wave-deploy-agent_cloudbuild \
  --format="value(cors_config)"
```

編輯 `terraform/storage.tf`，加到 `google_storage_bucket.cloudbuild` 裡：

```hcl
resource "google_storage_bucket" "cloudbuild" {
  name     = "${var.gcp_project}_cloudbuild"
  location = var.gcp_region
  # ... 既有 lifecycle rule ...

  cors {
    origin          = [
      "https://wave-deploy-agent.punwave.com",
      "https://deploy-agent-web-zdjl362voq-de.a.run.app",
      "http://localhost:3000",
    ]
    method          = ["GET", "POST", "PUT", "OPTIONS"]
    response_header = ["Content-Type", "x-goog-resumable", "Content-Length", "Content-Range", "Range"]
    max_age_seconds = 3600
  }
}
```

重 plan 確認 storage bucket 不再出現在 changes。

### Step 2: Import Cloud Run services

```bash
cd deploy-agent/terraform

# Projects + region
export P=wave-deploy-agent
export R=asia-east1

terraform import google_cloud_run_v2_service.api \
  "projects/$P/locations/$R/services/deploy-agent-api"

terraform import google_cloud_run_v2_service.web \
  "projects/$P/locations/$R/services/deploy-agent-web"

terraform import google_cloud_run_v2_service.bot \
  "projects/$P/locations/$R/services/deploy-agent-bot"
```

### Step 3: Import public-invoker IAM

```bash
terraform import 'google_cloud_run_v2_service_iam_member.api_public' \
  "$P asia-east1 deploy-agent-api roles/run.invoker allUsers"

terraform import 'google_cloud_run_v2_service_iam_member.web_public' \
  "$P asia-east1 deploy-agent-web roles/run.invoker allUsers"
```

### Step 4: Import Discord secrets（若已存在）

```bash
# Check existing
gcloud secrets list --project=$P --filter="name~DISCORD"

# 若存在，import
for SECRET in DISCORD_TOKEN DISCORD_APP_ID DISCORD_GUILD_ID DISCORD_CHANNEL_ID; do
  terraform import "google_secret_manager_secret.secrets[\"$SECRET\"]" \
    "projects/$P/secrets/$SECRET"
  terraform import "google_secret_manager_secret_version.versions[\"$SECRET\"]" \
    "projects/$P/secrets/$SECRET/versions/1"
done
```

若 Discord secrets 還沒建，這些 4 個新增就是正常的（Bot 目前用 env var，還沒搬到 Secret Manager）。先評估要不要搬。

### Step 5: Import artifactregistry.admin（若沒有）

```bash
gcloud projects get-iam-policy $P \
  --filter="bindings.role=roles/artifactregistry.admin AND bindings.members:serviceAccount:deploy-agent@" \
  --flatten="bindings[].members"

# 若已綁定：
terraform import 'google_project_iam_member.agent["roles/artifactregistry.admin"]' \
  "$P roles/artifactregistry.admin serviceAccount:deploy-agent@$P.iam.gserviceaccount.com"
```

### Step 6: 重新 plan，確認 drift

```bash
terraform plan -out=plan.tfplan 2>&1 | tee plan.out
# 應該：
# - 0 to add（或只剩真的要加的 Discord secrets）
# - 少數 in-place update（Cloud Run spec 可能跟實際有細節差，例如 annotations）
# - 0 to destroy
```

**🔴 Red flag：如果 plan 要 destroy 任何 Cloud Run service → 停下來，手動修 services.tf 對齊實際 prod spec**

### Step 7: Apply

```bash
terraform apply plan.tfplan
```

### Step 8: 收尾 — 接管 domains.tf

```bash
mv domains.tf.deferred domains.tf

terraform import google_cloud_run_domain_mapping.api \
  "locations/$R/namespaces/$P/domainmappings/wave-deploy-agent-api.punwave.com"

terraform import google_cloud_run_domain_mapping.web \
  "locations/$R/namespaces/$P/domainmappings/wave-deploy-agent.punwave.com"

terraform plan
# 應該 No changes
```

## Rollback

任何 apply 出錯（Cloud Run drift 太大）：

```bash
# 把 services.tf 改回 .deferred 暫停 TF 管理
mv services.tf services.tf.deferred

# State 裡把 cloud run 移出（不影響 prod 資源本身）
terraform state rm google_cloud_run_v2_service.api
terraform state rm google_cloud_run_v2_service.web
terraform state rm google_cloud_run_v2_service.bot
```

prod Cloud Run 本身不會被 `state rm` 動到。

## 為什麼不能 headless 做

- Cloud Run import 後若 spec drift 太大，可能會觸發 revision 重建 → 短暫流量中斷
- Storage bucket CORS 差一個字就壞 dashboard upload
- Discord secrets 目前是 env var 還是 secret 需要實機確認

必須 user 在 terraform 熟的環境下做，agent 不該 apply。
