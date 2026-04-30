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
| 2026-04-17 | [rbac-auth-system](./2026-04-17-rbac-auth-system.md) | Active | RBAC 權限系統 Phase 1 permissive：5 張 DB 表、bcrypt + session cookie、3 角色 |
| 2026-04-28 | [archive-normalizer](./2026-04-28-archive-normalizer.md) | Active | R44d：unzip 後修 Windows zip 反斜線路徑（`legal_flow\package.json` → 正常 subdir），50 個 zero-dep 測試 |
| 2026-04-28 | [pipeline-worker-tar-timeout](./2026-04-28-pipeline-worker-tar-timeout.md) | Active | R44e：pipeline-worker.ts 兩個 sync `execFileSync` tar timeout 30s/60s → 600s + maxBuffer 100MB（R44b 漏掉的 sync sites）|
| 2026-04-30 | [r44f-pipeline-worker-normalize](./2026-04-30-r44f-pipeline-worker-normalize.md) | Active | R44f：pipeline-worker GCS 重抓路徑加 `normalizeExtractedPaths` + `descendIntoWrapperDir`；AI fix step `fix.filePath` 用新 `sanitizeRelativePath`（反斜線→正斜線 / 剝 drive letter / 剝 wrapper prefix / 拒 `..`）；archive-normalizer 從 1 export 擴成 3 export；測試 50 → 96 zero-dep 全綠 |
| 2026-04-30 | [r44g-prisma-auto-fix](./2026-04-30-r44g-prisma-auto-fix.md) | Active | R44g：偵測 Prisma 專案 → pipeline-worker Step 2 注入 `RUN DATABASE_URL="..." npx prisma generate` 到使用者 Dockerfile（builder stage 在 build 前），auto-gen Dockerfile 也加；純函式 + idempotent + 注入防護；56 + 6 個 zero-dep 測試 |
