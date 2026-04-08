# Artifact Registry Cleanup Policy — deploy-agent repo

**Date**: 2026-04-05
**Status**: Active

## Context

Artifact Registry repo `asia-east1-docker.pkg.dev/wave-deploy-agent/deploy-agent` 儲存：
- `api` — deploy-agent 本身的 API image（每次 CI push 都產一個）
- `web` — deploy-agent 本身的 Web image
- `<user-slug>` — 每個使用者 submit 的專案 image

**問題**：沒有 cleanup policy，無限累積。

**現況（2026-04-05）**：
- repo 總大小：**7.4 GB**（GCS sources 才 12.91 MiB，這裡才是大頭）
- 光 `api` package 就 37+ 版本沒清
- 即使使用者刪掉專案，DELETE teardown 會清掉對應的 image，但 deploy-agent 自己的 CI image 永遠不會被刪

**費用**：Artifact Registry Standard $0.10/GB/month。7.4 GB ≈ $0.74/month，不多但會持續成長。

## Decision

套 3 條 cleanup policies（Keep 優先）：

```json
[
  { "name": "keep-recent-tagged", "action": "Keep",
    "mostRecentVersions": {"keepCount": 5} },

  { "name": "delete-old-untagged", "action": "Delete",
    "condition": {"tagState": "UNTAGGED", "olderThan": "7d"} },

  { "name": "delete-old-tagged", "action": "Delete",
    "condition": {"tagState": "TAGGED", "olderThan": "30d"} }
]
```

**效果**：
- 每個 package（`api`, `web`, 各 user slug）至少留最新 5 個 tagged 版本
- Untagged（build 失敗或被覆蓋的 layer）7 天後刪
- Tagged 但超過 30 天的也刪（但 keep 規則會保底最新 5 個）

## Consequences

### 好處
- **穩態容量可預測**：每 package 最多 5 個版本，不會無限成長
- **rollback 還有空間**：5 個最近版本夠做近期 rollback
- **Keep 優先**：即使一個月沒部署也不會把所有版本清光

### 代價
- **超過 30 天的歷史版本無法 rollback**：與 GCS lifecycle 30 天一致，所以原始碼+image 都是 30 天視窗
- **首次執行會大量刪除**：從 7.4 GB 降到大約 <1 GB，下次觀察

### 為何這組數字
- **keepCount=5**：一週 5 次部署算激進，足夠覆蓋「上次穩定版 + 近期嘗試」
- **untagged 7d**：dangling layer 保留一週夠 debug 用
- **tagged 30d**：跟 GCS lifecycle 對齊，方便心智模型

## Implementation

```bash
gcloud artifacts repositories set-cleanup-policies deploy-agent \
  --location=asia-east1 \
  --policy=/tmp/ar-cleanup-policy.json \
  --no-dry-run
```

Cleanup policy 由 GCP 背景執行（通常每天一次）。

## Follow-up

- [ ] 一週後檢查 repo 大小是否降下來
- [ ] 考慮 dashboard 加「GCP 資源管理」頁面，直接在 UI 看 repo 大小 / storage usage / lifecycle 狀態
