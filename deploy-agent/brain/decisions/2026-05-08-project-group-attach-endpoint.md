# 2026-05-08 — Project group attach endpoint（R63）

## Status

Active

## Context

Project groups 在 wave-deploy-agent 是 dashboard-level metadata，把 sibling services 顯示在同個 group 卡片內方便 bulk 操作（stop-all / delete-all / view-all-deployments）。

兩個 path 會建 group：
1. **submit-gcs monorepo split**（`routes/projects.ts:669`）：偵測到 ≥2 subdirs 都有 Dockerfile → 拆成 N projects 共用 `groupId`
2. **single-service submit**：每個 project 自己的 ID 當 `projectGroup`（singleton group）

但**沒有 endpoint** 可以把 single-service projects 後來連到同一個 group。`wavenetdeveloper-rfp-agent` 用例：
- `rfp-agent` (FastAPI API) 跟 `rfp-agent-frontend` (UI) 是分兩次 submit-gcs（不同時間、不同 zip）→ 各自獨立 group
- User 想把它們連在一起方便管理

之前選項：
- **A**) 接受 — 兩個 group 分開（dashboard 上散）
- **B**) 直接 SQL UPDATE config jsonb（sandbox 擋了，prod DB write）
- **C**) 加 endpoint — 永久解 + 未來其他 attach 都能用

選 **C**。

## Decision

加 `PATCH /api/projects/:id/group` endpoint：

```typescript
// Body
{
  projectGroup: string;   // required, ≤100 chars
  groupName?: string;     // optional, ≤200 chars
}
// Response
{
  success: true,
  projectId: string,
  projectGroup: string,
  groupName: string | null,
}
```

### 實作

純 config merge — 把 `projectGroup` 跟（optional）`groupName` 寫進 `project.config` JSONB。**不動**：
- Cloud Run service / revision
- DB schema
- Deploy state（pipeline 不重跑）
- Other config fields（spread merge）

### Auth

`requireOwnerOrAdmin` —— 跟 `PATCH /api/projects/:id/env-vars` 一樣 pattern。Group 變動會影響 `POST /api/project-groups/:gid/actions` 的 bulk stop/delete scope，所以 ownership gate 是必要的。

### Validation

- `projectGroup` 必填 + ≤100 chars（既有 group ID 是 UUID 36 chars 或 `group-<timestamp>` ≤24 chars，100 給足 margin）
- `groupName` optional + ≤200 chars
- 都是 string typecheck

不檢查 target group 存在 — 因為 group ID 沒 standalone 的 row（隱含於 projects 表 config field）。User 可以 attach 到任何 string（含不存在的）；dashboard 會自然反映。

## Consequences

**好處**：
- rfp-agent + rfp-agent-frontend 立刻能連到同 group（一個 PATCH call）
- 未來 fork API（R58）、auto-detect missing siblings 等都能用這個 endpoint
- Pure config 操作，rollback safe（再 PATCH 回舊值即可）
- Auth 一致（owner/admin）

**代價**：
- 沒寫 zero-dep test（route handler validation 很薄，本 codebase 慣例 routes 不單獨單測 — pure helpers 才測）
- API surface +1 endpoint

**已知未解**：
- 沒 list/dashboard endpoint to "list available groups" — user 需要自己知道 target group ID
- 沒 atomic move（一次只 patch 一個 project）— 大 group 重組要 N 次 PATCH

## 驗證

- `tsc --noEmit` 兩 workspace 全綠
- 不加 tests（route validation 薄 + 本 repo 慣例）
- E2E 驗：`PATCH /api/projects/11754286-.../group { projectGroup: '7e32ad3c-...', groupName: 'rfp-agent' }` 後 `/api/project-groups/7e32ad3c-...` 應該包含兩個 service

## 後續

- TODOS.md 不開 entry（這是 rfp-agent attach 的 enabler，本身就是 done）
- R63.x future：list groups endpoint / atomic multi-attach
