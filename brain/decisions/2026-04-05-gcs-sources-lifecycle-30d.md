# GCS Sources Tarball — 30 天自動刪除 Lifecycle Rule

**Date**: 2026-04-05
**Status**: Active

## Context

每次使用者 submit/resubmit 專案，`apps/api` 會把原始碼打包成 tarball 上傳到：

```
gs://wave-deploy-agent_cloudbuild/sources/<slug>-<timestamp>.tgz
```

這些 tarball 用途：
1. Cloud Build 抓取並 build image
2. Dashboard「下載原始碼」功能（service account proxy）
3. 萬一需要 rollback 可以重 submit

**問題**：DELETE /api/projects/:id 的 teardown 不會清 GCS tarball（當初刻意保留給 rollback），累積下來會無限成長。

**現況（2026-04-05）**：61 個物件 / 12.91 MiB，其中包含已刪除專案（bid-ops, kol-studio, test-deploy, wave-test 等）的歷史 tarball。

## Decision

在 `gs://wave-deploy-agent_cloudbuild` bucket 套 lifecycle rule：

```json
{
  "lifecycle": {
    "rule": [{
      "action": {"type": "Delete"},
      "condition": {
        "age": 30,
        "matchesPrefix": ["sources/"]
      }
    }]
  }
}
```

**規則**：`sources/` 前綴下的物件超過 30 天自動刪除。

## Consequences

### 好處
- **無限成長問題解決**：穩態容量 = 30 天內的 submit 量，不再累積
- **零維護**：GCP 自動執行，不用寫 code
- **只影響 tarball**：不碰 Cloud Build 的其他產物（`artifacts/`、`logs/` 等）

### 代價
- **30 天前的專案無法下載原始碼 / 重 build**：如果使用者要 rollback 超過 30 天的版本，原始碼已消失
  - Mitigation: Artifact Registry 的 image 還在，可以用舊 image 重 deploy（start 功能已支援）
- **Cloud Build 重跑會失敗**：如果某個 build 因為 infra 問題延後重跑，30 天後 tarball 不見了
  - 極罕見，可接受

### 為何不選其他方案
- **Teardown 時同步刪**：無法處理「resubmit 產生新 tarball 但舊的沒清」的情況；也無法追朔清理歷史殘留
- **手動定期清**：一人創業，要自動化
- **更短 age（如 7 天）**：Boss 可能會想 review 最近兩週的部署，30 天較保守

## Implementation

```bash
gsutil lifecycle set /tmp/gcs-sources-lifecycle.json gs://wave-deploy-agent_cloudbuild
gsutil lifecycle get gs://wave-deploy-agent_cloudbuild  # verify
```

Config 檔內容見上方 Decision 區塊。

## Follow-up

- [ ] 下一個決策：Artifact Registry image cleanup（keep last N tags）— 同樣是無限累積問題
- [ ] 觀察 lifecycle 生效後的儲存量曲線（一週後回頭看）
