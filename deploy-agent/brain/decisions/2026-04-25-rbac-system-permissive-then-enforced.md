# 2026-04-25 — RBAC（角色／權限／API key 系統）

## Context

wave-deploy-agent 過去**所有 API 端點都裸露**——47 個 route 加上 MCP 入口，零身份驗證。任何打中 service URL 的人都可以 approve/reject 部署、刪專案、觸發 infra cleanup、讀寫 settings。唯一有保護的是 GitHub webhook（HMAC-SHA256）。

一人創業階段這個風險原本是「能跑就好」的取捨。但一旦 dashboard 公開上線、Discord bot 進 guild、MCP server 對外暴露，攻擊面就是整個部署管線。`POST /api/projects/:id/deploy-lock` 被惡意打就能鎖死部署、`POST /api/infra/cleanup-orphans` 被觸發就會掃 GCP 資源。必須把門關上。

設計時 office-hours 給的指令是「全部都要」（CEO review mode: scope expansion）——多使用者、多角色、API key、稽核日誌一次到位。同時要求**零停機 migration**：不能因為加 auth 就把現有 Discord bot / MCP / dashboard 全打掛。

## Decision

### 角色 / 權限模型

3 個系統角色：

| 角色 | 權限 | 用途 |
|------|------|------|
| `admin` | `*`（萬用字元） | 老闆，管一切 |
| `reviewer` | `projects:read, reviews:*, deploys:read, versions:read, mcp:access` | 資安審查員 |
| `viewer` | `*:read` 只讀 | 監控用 |

權限字串 `resource:action` 格式（`projects:read`、`reviews:decide`、`infra:admin` 等共 16 個 + 1 個 `*`）。沒有層級結構、沒有繼承——一個 user 一個 role 一組 permissions。簡單到不會在生產出意外。

### Auth 三條 path

```
Request 進來
  │
  ├─ Authorization: Bearer <token>
  │   ├─ 先嘗試 API key（da_k_ 前綴 → SHA-256 查 api_keys）
  │   └─ 失敗則嘗試 session token（SHA-256 查 sessions）
  │
  ├─ Cookie: deploy_agent_session=<token>
  │   └─ SHA-256 → 查 sessions
  │
  └─ 無 credentials
      ├─ AUTH_MODE=permissive：放行 + 寫 audit log（migration 用）
      └─ AUTH_MODE=enforced：401
```

**4 個消費者各自的策略**：

| 消費者 | Auth 方式 | 備註 |
|--------|----------|------|
| Web Dashboard | httpOnly cookie | 登入頁 → POST /api/auth/login → set-cookie + token |
| Discord Bot | API Key（Bearer） | `DEPLOY_AGENT_API_KEY` env，permissions = reviewer 等級 |
| MCP Server | API Key（Bearer） | 獨立一把 key，permissions = admin 等級 |
| GitHub Webhook | HMAC-SHA256（不變） | 完全不走 RBAC，獨立驗證 |

### 5 張 DB Table

`roles` + `users` + `sessions` + `api_keys` + `auth_audit_log`，全部 `CREATE TABLE IF NOT EXISTS` + `ON CONFLICT DO UPDATE` seed，部署一萬次 schema 都同樣。

關鍵設計：

- **password_hash** 存 bcrypt cost=12，永遠不可逆
- **session token** 只存 SHA-256 hash，raw token 只在 login response 出現一次
- **api_key** 同上，prefix（`da_k_xxxx` 前 12 字元）存明文方便辨識，`raw_key` 只在 create 那一次回傳
- `last_used_at` 是 best-effort async update，不會 block request
- `auth_audit_log` 用 `BIGSERIAL`，conditional FK（user_id 可為 null，給 anonymous request 也能寫）

### Auth Middleware：宣告式 route → permission map

```typescript
const ROUTE_PERMISSIONS: Array<[string, Permission]> = [
  ['GET:/api/projects', 'projects:read'],
  ['POST:/api/reviews/:id/decide', 'reviews:decide'],
  ['POST:/api/infra/cleanup-orphans', 'infra:admin'],
  // ... 共 36 個 route
];
```

放成 array of tuples（不是 dict）因為 method+path 當 key 會跟 path 中的 `:` 衝突。Lookup 時用 `indexOf(':')` 切第一個冒號（**critical bug fix**：原本用 `key.split(':')[1]` 會在 `:param` 出現時把 path 截斷，所以 `/api/projects/:id` 會永遠 lookup 失敗、回傳 null），確保 method 跟 path 分得乾淨。

`patternToRegex()` 把 `:param` 轉成 `[^/]+`，並把 `.` 等 regex meta-char escape 掉。3 類路徑：

- **PUBLIC_ROUTES**：`/health`、`/api/webhooks/github`、`/api/auth/login`——完全不檢查
- **AUTHENTICATED_ROUTES**：`/api/auth/me`、`/api/auth/api-keys/*`——任何登入用戶都可以
- **ROUTE_PERMISSIONS**：其餘需要對應 permission

#### 2026-04-26 audit fix：17 個漏掉的 route + fail-closed 預設

第一刀 ship 後實際盤點發現 ROUTE_PERMISSIONS 漏了 17 個 route——包括破壞性的 `POST /api/projects/:id/start|stop|scan|skip-scan|force-fail|resubmit|retry-domain`、機密的 `GET|PUT /api/projects/:id/env-vars` / `github-webhook`、唯讀的 `GET /api/projects/:id/detail|source-download|scan/report`、以及觀測性新 ship 的 `GET /api/deploys/:id/timeline|stream|build-log` + `POST /api/upload/diagnose`。原本 enforced mode 對 unmapped route 的處理是「authenticated user 一律放行」——viewer 也能 stop project、改 env-vars。已加全部 mapping，**並改 enforced mode 預設為 fail-closed**：

```
unmapped route in enforced mode → 403 { reason: 'route_not_mapped' } + audit log
unmapped route in permissive mode → log warn + 放行（migration 階段保持寬鬆）
```

關鍵 separation-of-duties 決策：

- `skip-scan` / `force-fail` → **`reviews:decide`** 而非 `projects:deploy`——deployer 不能繞過 reviewer 的安全把關
- `env-vars` / `github-webhook` → **`projects:write`** 而非 `projects:read`——含密碼/secrets 不能 viewer 級可讀
- `start` / `stop` / `scan` / `resubmit` / `retry-domain` → **`projects:deploy`**——destructive but reversible，跟其他 deploy-grade action 對齊

新增 8 個 RBAC audit unit test 把上面這些都驗起來，包括「viewer 對 8 個危險 route 都拿不到 permission」+「reviewer 不能 deploy / 不能讀 env-vars」的 separation-of-duties test。

### AUTH_MODE：permissive → enforced 兩段切換

| 模式 | 無 credentials request | 有但權限不足 |
|------|----------------------|------------|
| `permissive`（**預設**） | 放行 + 寫 anonymous_request audit log | 403 |
| `enforced` | 401 | 403 |

permissive 是 zero-downtime migration 的關鍵——deploy 上去之後現有所有不帶 token 的 request 還是會通，但 audit log 開始記錄是誰沒帶。這時候去設定 Bot/MCP 的 API key、讓 Web 走 cookie。等 audit log 沒看到 anonymous 後，切 `AUTH_MODE=enforced` 一聲令下全部封死。

### Web Dashboard：AuthProvider + sidebar + admin page

`apps/web/lib/auth.tsx` 提供 `<AuthProvider>` + `useAuth()` hook：

- 進站第一動作 GET `/api/auth/me`，401 就導去 `/login`
- `login(email, password)` → POST + set-cookie（自動 by browser）
- `hasPermission(p)` 從 `user.permissions` 比對

`apps/web/app/admin/page.tsx`（795 行）有 3 個 tab：

- **Users**：列表 + create + update role + activate/deactivate + delete
- **API Keys**：自己建自己的 key（admin 可建任何 permission；非 admin 只能建自己有的 permission），revoke
- **Audit Log**：依 created_at desc 列最新 100 筆，看誰登入失敗、誰被拒、誰建了什麼 key

### Bot：API key 設定走 env

`apps/bot/src/config.ts` 加 `apiKey: process.env.DEPLOY_AGENT_API_KEY ?? ''`，沒設就 warning（permissive mode OK，enforced mode 會 401）。`api-client.ts` 在每個 fetch 加 `Authorization: Bearer ${apiKey}` header。

## Consequences

### Pros

- **安全姿態從零分變 90 分**：47 個 route 全有 permission gate；admin/reviewer/viewer 三段權限對應實際使用情境
- **零停機 migration**：permissive 模式讓現有消費者繼續跑，audit log 提供 visibility 知道誰沒帶 token，準備好再切 enforced
- **API key 可細到單一 permission**：admin 可以發一把只能 `reviews:decide` 的 key 給 bot，bot 被偷了爆炸面積也只有那一塊
- **API key 跟 user 系統共用 user_id**：不需要兩套 user model，bot 也是個 user，只是登入方式不同
- **稽核日誌齊全**：login / login_failed / logout / permission_denied / anonymous_request / user_created / user_updated / user_deleted / api_key_created / api_key_revoked 全寫入 `auth_audit_log`
- **Cookie security 標準**：httpOnly + Secure（prod）+ SameSite=Lax + 7 天 expiry
- **Rate limit 防暴力**：login `5/min`，全域 `600/min`，`/health` 例外避免 Cloud Run probe 把預算燒光
- **bcrypt cost=12**：未來幾年都安全，慢到 GPU 暴力破解不划算
- **Tests 33/33 unit pass**：permissions logic、route → permission map、pattern → regex、password hashing 全有 coverage；integration tests（10 個）跟 DB 整合，沒 DB 也乾淨 skip

### Cons / 已知妥協

- **沒有 SSO/OAuth/Passkey**：一人創業階段過度。未來真的多人協作再加，cookie + role 系統留 hook
- **Permissions 是 flat array，沒有層級**：未來想要 `projects:*` 之類的萬用字元要再加 logic（目前只有 `*` total wildcard）
- **No password reset email flow**：admin 改密碼是 `PATCH /api/auth/users/:id { password }`。沒 SMTP 也做不了 forgot-password。Acceptable for now，使用者就那幾個
- **API key 撤銷不會立刻同步**：`is_active=false` UPDATE 之後，已經在 flight 的 request 還是用舊權限跑完。session 同理。Acceptable
- **沒做 CSRF token**：靠 SameSite=Lax + 不接受 GET 改狀態（POST/PUT/DELETE 才會修改）。標準 OWASP 建議夠用
- **Cookie SESSION_SECRET 預設 dev-secret-change-me**：production 必須設，否則 cookie signing 是一致的但 secret 已知 = 沒 signing。已加 warning
- **Permissive mode 不是永遠**：使用者必須記得切 enforced。SESSION_HANDOFF 有 checklist

### 實作 Commits

- `34a8671`（4/17）— RBAC Phase 1: 5 tables, auth-service, middleware, routes, web login + admin
- 後續累積修補（`pr/sync-all` HEAD）—— pattern matching bug fix（`indexOf(':')` 取代 `split(':')`）+ test-auth.ts 33 unit tests + 9 integration tests skip cleanly without DB

### Migration Checklist（要切 enforced 之前）

1. Cloud Run 設好 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `SESSION_SECRET`（從 Secret Manager 讀）
2. 第一次起 API 會 bootstrap admin user
3. 進 `/admin` 建一把 API key 給 Bot（permissions = `reviews:read,reviews:decide,projects:read,deploys:read`）
4. Cloud Run 設定 Bot 的 `DEPLOY_AGENT_API_KEY` env
5. 同樣建一把給 MCP（permissions = `*`）
6. **觀察 audit log 一週**——`SELECT * FROM auth_audit_log WHERE action = 'anonymous_request'` 回 0 筆才能切
7. Cloud Run 設 `AUTH_MODE=enforced`，redeploy

## Status

Active

## Files

### 新增
- `apps/api/src/middleware/auth.ts` — onRequest hook + ROUTE_PERMISSIONS map + AUTH_MODE check
- `apps/api/src/routes/auth.ts` — login/logout/me + users CRUD + api-keys CRUD + audit log endpoints
- `apps/api/src/services/auth-service.ts` — bcrypt hash + session/api-key generation + permission predicates
- `apps/api/src/test-auth.ts` — 33 unit tests + 9 integration tests (DB-gated, skip cleanly)
- `apps/web/lib/auth.tsx` — `<AuthProvider>` + `useAuth()` hook
- `apps/web/app/login/page.tsx` — login form + error display
- `apps/web/app/admin/page.tsx` — Users / API Keys / Audit Log tabs (795 lines)
- `packages/shared/src/auth-types.ts` — `Permission`, `Role`, `AuthUser`, `ApiKey`, `AuthAuditEntry`, `AuthMode`

### 修改
- `apps/api/src/db/schema.sql` — 5 RBAC tables + indexes + role seeds
- `apps/api/src/index.ts` — register cookie + rate-limit + auth hook + auth routes; bootstrap admin
- `apps/bot/src/config.ts` + `apps/bot/src/api-client.ts` — DEPLOY_AGENT_API_KEY env + Bearer header
- `apps/web/app/layout.tsx` — wrap `<AuthProvider>`
- `apps/web/app/sidebar.tsx` — render user info + logout button + permission-gated nav links

### Env vars
- `AUTH_MODE` = `permissive` | `enforced`（預設 `permissive`）
- `SESSION_SECRET` = cookie signing key（**production 必設**）
- `SESSION_TTL_DAYS` = 7（預設）
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_DISPLAY_NAME` = bootstrap admin
- `RATE_LIMIT_MAX` = 600（global per-IP per-min）
- `DEPLOY_AGENT_API_KEY`（在 bot env 裡，由 admin 從 dashboard 建出）
