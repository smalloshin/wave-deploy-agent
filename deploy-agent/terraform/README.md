# wave-deploy-agent — Terraform 基礎設施

Agent 自身所有 GCP 資源，全部由 Terraform 管理。

## 檔案說明

| 檔案 | 用途 |
|------|------|
| `versions.tf` | Terraform + provider 版本鎖定 |
| `variables.tf` | 所有輸入變數 |
| `backend.tf` | Remote state（GCS bucket） |
| `bootstrap.tf` | GCP APIs、專屬 service account、IAM bindings |
| `secrets.tf` | Secret Manager 6 個 secrets + IAM |
| `storage.tf` | GCS Cloud Build bucket + Artifact Registry |
| `database.tf` | Cloud SQL（Postgres 16）+ backup + PITR |
| `redis.tf` | 共用 Redis VM + firewall |
| `outputs.tf` | URLs、要加到 Cloudflare 的 DNS records |
| `bootstrap.sh` | 從零重建的一鍵 script |
| `import.sh` | 把現有 prod 資源 import 進 state（已跑過）|
| `services.tf.deferred` | Cloud Run api + web（暫時不接管，見下方）|
| `domains.tf.deferred` | Cloud Run domain mappings（暫時不接管）|

## 情境 A：災難復原（整個 project 爆了，從零重建）

```bash
cd deploy-agent/terraform

# 1. 填入真實值（secrets 從密碼管理器拿）
cp terraform.tfvars.example terraform.tfvars
# 編輯 terraform.tfvars

# 2. 一鍵重建
./bootstrap.sh
```

Script 會自動做：
1. `gcloud config set project` 切到目標 project
2. 開必要的 GCP APIs（storage、iam、cloudresourcemanager）
3. 建 `${project}-tfstate` GCS bucket（含 versioning）
4. `terraform init` → `plan` → `apply`（有確認提示）
5. 觸發第一次 Cloud Build，build + push api / web images
6. 呼叫 `/api/internal/migrate` 跑 DB schema migration
7. 印出要加到 Cloudflare 的 DNS CNAME records

**時間**：約 20–30 分（Cloud SQL 建立最慢，15–20 分）

**⚠️ 限制**：
- **DB 資料不會自動回來**，要另外從 backup 恢復
- `services.tf` + `domains.tf` 目前是 `.deferred`，bootstrap 不會建 Cloud Run service 和 domain mapping（要手動補或把 `.deferred` 拿掉後重跑）

## 情境 B：日常維護（prod 還活著，要改 infra）

```bash
cd deploy-agent/terraform

# 看 diff
terraform plan

# 套用
terraform apply
```

Terraform state 在 `gs://wave-deploy-agent-tfstate/deploy-agent/`（versioned）。改完記得 commit `.tf` 檔到 git（`terraform.tfvars` 不要 commit，已 gitignored）。

## 目前納管的資源（31 個）

- ✅ 12 個 GCP APIs（run、sql、secretmanager 等）
- ✅ `deploy-agent@` service account + 12 個 IAM roles（最小權限，取代原本的 default compute SA）
- ✅ GCS Cloud Build bucket（含 30 天 sources/ lifecycle rule）
- ✅ Artifact Registry repo（含 cleanup policy）
- ✅ Cloud SQL instance + database + user（**backup + PITR 已啟用**，刪除保護開）
- ✅ Redis 共用 VM + firewall rule
- ✅ 6 個 secrets × (secret + version + IAM binding) = 18 個資源

## 目前還沒納管

- ⏸️ **Cloud Run services**（`deploy-agent-api` + `deploy-agent-web`）— 還是靠 `cloudbuild.yaml` 手動部署；code 在 `services.tf.deferred`
- ⏸️ **Domain mappings**（`wave-deploy-agent-api.punwave.com` 等）— code 在 `domains.tf.deferred`
- ❌ **Cloudflare DNS records** — 手動在 Cloudflare 建，指向 `ghs.googlehosted.com`
- ❌ **Cloud Build triggers** — 目前只有手動 `gcloud builds submit` 或 dashboard 觸發
- ❌ **使用者專案的資源**（使用者部署的 Cloud Run、Redis DB、Postgres DB）— 由 agent 自己在 runtime 管，不在 TF 裡

## 安全規範

- `terraform.tfvars` **嚴禁 commit**（已 gitignored）
- Secrets 只有 `deploy-agent@` SA 能讀
- Cloud SQL `deletion_protection = true`，防手滑刪 DB
- State bucket 開了 versioning，state 壞掉可以 rollback
- 服務跑在 `deploy-agent@` SA（最小權限），不是 default compute SA

## 要切 prod Cloud Run 到 `.deferred` 管制的步驟

當未來要讓 Terraform 接管 Cloud Run 時：

```bash
mv services.tf.deferred services.tf
mv domains.tf.deferred domains.tf

# Import 現有的 Cloud Run services
terraform import google_cloud_run_v2_service.api \
  projects/wave-deploy-agent/locations/asia-east1/services/deploy-agent-api
terraform import google_cloud_run_v2_service.web \
  projects/wave-deploy-agent/locations/asia-east1/services/deploy-agent-web

# Import domain mappings
terraform import google_cloud_run_domain_mapping.api_custom \
  locations/asia-east1/namespaces/wave-deploy-agent/domainmappings/wave-deploy-agent-api.punwave.com
# （其他 domain mappings 類推）

# 驗證無 drift
terraform plan
```
