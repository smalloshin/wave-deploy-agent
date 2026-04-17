# Cloud Build Trigger 還原 Runbook

## 問題

2026-04-17 發現 `gcloud beta builds triggers list --project=wave-deploy-agent` 回傳 0 項。
代表 push 到 GitHub main 不會自動觸發 Cloud Build。

歷史部署記錄顯示 2026-04-16 以前有自動部署（commit → build），但之後 trigger 不見。

目前 workaround：手動 `gcloud builds submit`（SESSION_HANDOFF 有紀錄）。

## 修復方式（需要 console OAuth，不能 CLI headless）

### Option A: Cloud Build GitHub App（推薦）

1. 進入 https://console.cloud.google.com/cloud-build/triggers?project=wave-deploy-agent
2. 點「Create Trigger」
3. 填：
   - **Name**: `main-branch-deploy`
   - **Region**: `global`（或 `asia-east1`，二擇一即可）
   - **Event**: Push to a branch
   - **Source**:
     - 1st gen: Connect new repo → GitHub → 授權 → 選 `smalloshin/wave-deploy-agent`
     - 2nd gen: Link host connection 先做 GitHub app OAuth
   - **Branch regex**: `^main$`
   - **Configuration**: Cloud Build config file
   - **Location**: Repository
   - **Cloud Build configuration file location**: `cloudbuild.yaml`
   - **Service account**: `deploy-agent@wave-deploy-agent.iam.gserviceaccount.com`
4. 儲存後，推一個小 commit 驗證自動 build 起來

### Option B: 直接用 webhook trigger（不用 GitHub app）

```bash
# 產生 webhook secret
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "$WEBHOOK_SECRET" | gcloud secrets create cloudbuild-webhook-secret \
  --project=wave-deploy-agent \
  --data-file=- \
  --replication-policy=automatic

# TODO: 建立 webhook trigger
# 詳見 https://cloud.google.com/build/docs/automate-builds-webhook-events
```

Option A 比較簡單，Option B 要自己在 GitHub 設 webhook。

## 驗證

完成後：
```bash
gcloud beta builds triggers list --project=wave-deploy-agent
# 應該列出一筆

# 測試：推空 commit
git commit --allow-empty -m "test: verify Cloud Build trigger"
git push wave-deploy-agent HEAD:main
gcloud builds list --limit=1 --project=wave-deploy-agent
# 應該看到新 build 正在 RUNNING
```

## 為什麼會消失？

推測：
1. 之前手動從 console 刪掉
2. 某次 Terraform apply 把它移除（但目前 terraform 沒管 trigger）
3. GitHub app 授權過期 → trigger 被 GCP 清掉

下次可以把 trigger 寫進 Terraform（`google_cloudbuild_trigger` resource）避免再次遺失。
