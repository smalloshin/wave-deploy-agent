# 2026-04-17 RBAC Auth System — Phase 1 permissive

## Context

wave-deploy-agent 有 47 個 API 端點全部公開，任何人可：
- approve/reject 部署
- 刪除專案
- 觸發 infra cleanup
- 讀寫 settings

唯一有保護的是 GitHub webhook（HMAC-SHA256）。這是**一人創業 SaaS 的頭號安全漏洞**，必須優先修掉。

## Decision

採 **3-Phase 零停機遷移**，先上 Phase 1（permissive mode）：

### 架構選擇

| 選項 | 方案 | 理由 |
|------|------|------|
| 密碼 hash | bcrypt cost 12 | OWASP 推薦、Node 生態成熟 |
| Session token | SHA-256 hash 存 DB | 比 JWT 簡單、可 revoke、不需 refresh flow |
| Session 傳輸 | httpOnly cookie + Bearer 雙支援 | Web 用 cookie，Bot/MCP 用 API key |
| API key 格式 | `da_k_<48 hex>` | 易辨識、前綴可用於 list 不洩漏 raw |
| Rate limit | login 5/min、global 100/min | @fastify/rate-limit |
| 路由授權 | onRequest hook + route map | 宣告式，集中維護 |

### 角色設計

只做 3 個系統角色（admin / reviewer / viewer），不做自訂角色。理由：一人創業不需要 ACL 工廠，寫死最快。後期要擴充再加。

### 3-Phase 遷移

```
Phase 1 (這次完成):
  AUTH_MODE=permissive (預設)
  anonymous requests 被 log + 放行
  有 credentials 的正常驗證
  → 零風險部署

Phase 2 (下 session):
  建 admin user (ADMIN_EMAIL + ADMIN_PASSWORD 啟動時 bootstrap)
  建 API key for Bot + MCP
  Bot/MCP 加 Authorization: Bearer header
  監控 auth_audit_log 確認沒有 anonymous request

Phase 3:
  AUTH_MODE=enforced
  anonymous → 401
```

## Implementation

### DB（5 張新表）
- `roles`（系統 + 自訂角色）
- `users`（bcrypt password_hash, role_id）
- `sessions`（SHA-256 token_hash, expires_at）
- `api_keys`（SHA-256 key_hash, permissions 可比 role 更窄）
- `auth_audit_log`（login/logout/permission_denied/anonymous_request）

### 檔案
- `apps/api/src/services/auth-service.ts` — 所有 DB 操作
- `apps/api/src/middleware/auth.ts` — onRequest hook + route map
- `apps/api/src/routes/auth.ts` — login/logout/me/users/api-keys/audit
- `packages/shared/src/auth-types.ts` — 共用 types
- `apps/web/lib/auth.tsx` — AuthProvider + useAuth hook
- `apps/web/app/login/page.tsx` — 登入頁

### 新增 deps
- `@fastify/cookie` (httpOnly cookie)
- `@fastify/rate-limit` (防暴力破解)
- `bcrypt` (密碼 hash)

## Consequences

### 好處
- ✅ 零停機上線：permissive mode 預設，不影響現有消費者
- ✅ 47 端點集中授權，維護成本低
- ✅ API key / Session 雙軌，Web 跟 Bot/MCP 都能用
- ✅ 完整 audit log，可追蹤 anonymous 請求來源
- ✅ bcrypt + SHA-256 hash，DB 洩漏也不洩密
- ✅ 可授予比自身更窄的 API key 權限（least privilege）

### 代價
- ⚠️ 多一次 DB query per request（middleware 查 session/api_key）
  - 緩解：sessions.token_hash + api_keys.key_hash 都有 index，單次 <5ms
  - 未來：可加 in-memory LRU cache
- ⚠️ Phase 3 切換前必須確認所有消費者都帶 credentials，不然會 401
- ⚠️ ADMIN_PASSWORD 首次 bootstrap 是明文 env var（之後可用 Secret Manager）

### 開發者體驗
- 權限不足 → 403 + required_permission 告訴前端
- 未登入 → 401
- API key 只在建立時回傳一次，之後只能看 prefix

## Status

**Active** — Phase 1 已部署上線（2026-04-17, AUTH_MODE=permissive）

## Next Steps

1. [ ] Secret Manager: `ADMIN_PASSWORD`, `SESSION_SECRET`
2. [ ] Cloud Run 設 `ADMIN_EMAIL` + 掛 `ADMIN_PASSWORD` secret → bootstrap admin
3. [ ] Login 驗證 → 建立 Bot API key → Bot 更新 api-client.ts 帶 Bearer
4. [ ] MCP API key 同上
5. [ ] 監控 `auth_audit_log` 中 `action='anonymous_request'` 幾天，確認沒殘餘流量
6. [ ] 切 `AUTH_MODE=enforced`
