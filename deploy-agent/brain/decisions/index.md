# Decisions Index — wave-deploy-agent

> 所有架構／產品決策的目錄。每個決策獨立一個檔案，放在本目錄。

## 使用規則

1. **每次做出架構或產品決策時**，建立新檔 `YYYY-MM-DD-<slug>.md`
2. **檔名 slug 用 kebab-case**，簡短描述（例：`2026-04-05-stop-via-delete-service.md`）
3. **決策檔內容結構**（參考 ADR 格式）：
   - **Context**：為什麼需要做這個決定
   - **Decision**：決定是什麼
   - **Consequences**：帶來的好處與代價
   - **Status**：Active / Superseded by `<新決策檔>`
4. **被取代的決策不要刪**，把 Status 改成 Superseded 並連到新決策
5. **在本 index.md 登記**：新增一列到下方表格

## 決策狀態說明

| 狀態 | 意義 |
|------|------|
| **Active** | 目前生效中 |
| **Superseded** | 已被其他決策取代，保留作歷史紀錄 |
| **Deprecated** | 已棄用但尚未有取代方案 |
| **Proposed** | 提案中，尚未實作 |

## 決策清單

| 日期 | 決策 | 狀態 | 說明 |
|------|------|------|------|
| 2026-04-05 | [gcs-sources-lifecycle-30d](./2026-04-05-gcs-sources-lifecycle-30d.md) | Active | GCS source tarball 30 天自動刪除，防止無限成長 |
| 2026-04-05 | [artifact-registry-cleanup](./2026-04-05-artifact-registry-cleanup.md) | Active | AR repo keep last 5 tagged + 清 7d untagged / 30d tagged |
| 2026-04-05 | [terraform-disaster-recovery](./2026-04-05-terraform-disaster-recovery.md) | Active | 用 Terraform + bootstrap.sh 實現 agent 一指令重建；secrets 搬到 Secret Manager |
| 2026-04-13 | [netlify-like-versioning](./2026-04-13-netlify-like-versioning.md) | Active | Netlify-like 版本管理：immutable deploy、版本歷史、一鍵 publish/rollback、deploy lock |
| 2026-04-18 | [deployed-source-capture](./2026-04-18-deployed-source-capture.md) | Active | 每次 deploy 成功後把 post-fix code + 自動生成 Dockerfile 存到 GCS (365d lifecycle)，dashboard 一鍵下載，讓使用者從安全基準繼續開發 |
