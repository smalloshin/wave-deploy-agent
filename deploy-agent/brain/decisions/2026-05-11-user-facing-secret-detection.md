# 2026-05-11 — User-facing secret detection + reveal endpoint（R64）

## Status

Active

## Context

`legal-flow-20260505` canonical：user 把 `SYSTEM_PASSWORD="admin123"` 寫在 `.env`，期待 deploy 完 user 打 admin123 能登入。實際發生：

1. Pipeline `services/env-detector.ts:classifyEnvValue` 偵測 `admin123` 為 weak secret（短、common placeholder）
2. Auto-gen 強隨機字串覆寫，注入 Cloud Run `--set-env-vars`
3. Cloud Run env 啟動就在 process.env，Next.js standalone 不會 override → user 打 admin123 → 401
4. User 不知道發生什麼，找 deployer 才查到 root cause

**這個是 R49 + env-detector 的 silent failure**。Pipeline 做對的事（不把 admin123 暴露在 production），但 deployer 跟 user 完全沒被告知。

既有 `isUserCredentialVar` 只 match strict pattern `AUTH_PASSWORD` / `ADMIN_PASSWORD` / bare `PASSWORD`，這些走 keep-verbatim path（甚至比新行為更危險 — 沒驗 weak 就 deploy）。`SYSTEM_PASSWORD` 不在 strict pattern → 走 weak → silent auto-gen。

兩個 path 對 user-facing 都不夠好：
- Strict: keep verbatim → admin123 deploy 到 prod（安全漏洞）
- Broad: auto-gen silent → user 不能登（UX 災難）

R64 拆第三條 path。

## Decision

新增 **`user_facing_weak_replaced`** 警告類別 + **`isUserFacingCredential`** broader pattern + **`GET /api/projects/:id/env-vars/reveal`** endpoint。

### 三層 classification

| Pattern | 範例 | 行為 |
|---------|------|------|
| **`isUserCredentialVar`** (既有 strict)：`^AUTH_PASSWORD$` / `^ADMIN_PASSWORD$` / bare `PASSWORD` | `AUTH_PASSWORD` | Keep verbatim（不驗 weak，user 顯式 opt-in） |
| **`isUserFacingCredential`** (R64 broader)：含 strict + `(SYSTEM\|LOGIN\|APP\|MASTER\|ROOT\|SHARED\|GUEST\|DEMO\|TEST\|USER\|SUPER\|ACCOUNT)_PASSWORD` + `_PIN` / `_PASSPHRASE` suffix | `SYSTEM_PASSWORD` | Weak → **auto-gen + P0 warning + reveal endpoint** |
| **Machine secret**：剩下的 `*SECRET*` / `*KEY*` / `*TOKEN*` 等 | `JWT_SECRET`、`GEMINI_API_KEY` | Weak → auto-gen silent（machine never types） |

### `isUserFacingCredential` 是 exported pure function

獨立可測。`env-detector.ts` 加 entry：

```typescript
export function isUserFacingCredential(name: string): boolean {
  const upper = name.toUpperCase();
  if (/^(AUTH|ADMIN)_(USERNAME|PASSWORD|USER|EMAIL)$/.test(upper)) return true;
  if (upper === 'USERNAME' || upper === 'PASSWORD') return true;
  const userFacingPrefixes = ['SYSTEM','LOGIN','APP','MASTER','ROOT',
    'SHARED','GUEST','DEMO','TEST','USER','SUPER','ACCOUNT'];
  for (const p of userFacingPrefixes) {
    if (upper === `${p}_PASSWORD`) return true;
    if (upper === `${p}_USERNAME`) return true;
    if (upper === `${p}_USER`) return true;
    if (upper === `${p}_EMAIL`) return true;
    if (upper === `${p}_PIN`) return true;
    if (upper === `${p}_PASSPHRASE`) return true;
  }
  if (/_PIN$/.test(upper) || /_PASSPHRASE$/.test(upper)) return true;
  return false;
}
```

### 新 warning shape

`EnvWarning.type` union 加 `'user_facing_weak_replaced'`，加 optional `severity?: 'info' | 'p1' | 'p0_user_action_needed'`：

```typescript
warnings.push({
  type: 'user_facing_weak_replaced',
  severity: 'p0_user_action_needed',
  variable: 'SYSTEM_PASSWORD',
  fallbackValue: 'admin123',
  recommendation: `User-facing password "SYSTEM_PASSWORD" was set to weak value "admin123"... ` +
                   `Users CANNOT type "admin123" to login. Choose one: ` +
                   `(1) GET /api/projects/:id/env-vars/reveal to see the auto-gen value, share securely; ` +
                   `(2) PATCH /api/projects/:id/env-vars to set a deployer-chosen strong password users can remember.`,
});
```

Existing warning types 不變（backward compat — `severity` 是 optional）。

### `GET /api/projects/:id/env-vars/reveal` endpoint

- **Auth**: `requireOwnerOrAdmin`（跟 PATCH env-vars 一樣 — if you can write, you can read）
- **Source**: Cloud Run 服務 live env 優先，DB fallback；response 帶 `source: 'cloud_run' | 'db'`
- **Optional `?keys=A,B,C`**: 窄化 reveal scope（UI 「show me just SYSTEM_PASSWORD」）
- **Audit log**: 每次 reveal 寫進既有 `auth_audit_log` table，`action='env_vars_reveal'`，metadata 含 keys_requested / keys_revealed / source / ip
- **Response shape**:
  ```json
  {
    "projectId": "...",
    "source": "cloud_run",
    "envVars": { "SYSTEM_PASSWORD": "x3K9..." },
    "warning": "These are raw secret values. Do not paste into chat..."
  }
  ```

## Consequences

**好處**：
- legal-flow-20260505 那類 case 不再 silent 死：scan_report 馬上 P0 warning，deployer 部署當下看到 → 主動 reveal 或 override
- Dashboard 未來可以加「user-facing password requires action」red badge（warning severity=p0_user_action_needed 拉出來）
- 既有 `isUserCredentialVar` strict path 不動（backward compat）
- Auto-gen 跟 reveal 兩條 path 兼具：securityvibe-coder 默認 + deployer 仍有 escape hatch
- 39 個 zero-dep tests 把 pattern 鎖死（含正則 word-boundary 避免 `PASSWORDLESS_TOKEN` 誤命中）

**代價**：
- 新 endpoint 多一個 audit log row 每次 reveal（接受）
- Pattern 列表是人為決定 — 未來 user 用其他命名（e.g. `WORKSPACE_PIN`）會走 generic suffix；但完全沒命中的 user-facing var 還是會 silent auto-gen（false negative 接受）
- 沒做 UI 變化（dashboard 還沒加 red badge / reveal 按鈕）— API ready，UI 留 R64.1

**已知未解**：
- 既有 `isUserCredentialVar` 對 weak AUTH_PASSWORD 直接 keep verbatim 是另一個漏洞，但是 user 顯式 opt-in 的「我就要 admin123」case。R64 不動。
- Reveal endpoint 不 mask，全值 plaintext 回 caller。Audit log 不夠，依賴 caller 不漏（UI 別 paste 到不該的地方）。

## 驗證

- `tsc --noEmit` 兩 workspace 全綠
- `bash scripts/sweep-zero-dep-tests.sh` → **3129 passed / 0 failed across 59 files**（3090 → +39 R64 tests）
- 39 tests：
  - 既有 strict pattern 5 case（backwards compat）
  - R64 expanded prefix patterns 12 case（SYSTEM/LOGIN/APP/MASTER/ROOT/SHARED/GUEST/DEMO/TEST/USER/SUPER/ACCOUNT）
  - PIN/PASSPHRASE suffix 5 case
  - Case-insensitive 2 case
  - Machine-secret negative 12 case（JWT_SECRET, NEXTAUTH_SECRET, GEMINI_API_KEY, STRIPE_SECRET_KEY, GOOGLE_PRIVATE_KEY, CSRF_SECRET, CLIENT_SECRET, REFRESH_TOKEN, DATABASE_URL, API_KEY, ENCRYPTION_KEY, SESSION_SECRET）
  - Defensive 3 case（empty, generic vars, `PASSWORDLESS_TOKEN` word-boundary）

## 後續

- R64.1 dashboard UI：scan_report `warnings[].severity === 'p0_user_action_needed'` 紅色 badge + 「Reveal value」按鈕 + 「Override」modal
- R64.2 既有 `isUserCredentialVar` keep-verbatim weak path 評估是否也要 P0 warning（影響 deploy 過的 AUTH_PASSWORD=admin123 user）
- R64.3 reveal endpoint 加 mask mode（default mask，需要 `?reveal=true` 明確展示，UI 更安全）
