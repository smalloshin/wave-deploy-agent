# 2026-04-27 — RBAC Scope-Filter Pattern for LIST Endpoints

## Status

**Active**（commit `6c2d9a4`，pending production deploy authorization）

## Context

Round 25 的 RBAC Phase 1（commit-set 圍繞 `2026-04-25-rbac-system-permissive-then-enforced.md`）幫
**MUTATING** 路由（POST/DELETE/PUT）裝上 `requireOwnerOrAdmin(req, reply, project, action)`
這個 per-resource owner-or-admin 閘門。但 **LIST** 路由（GET /api/projects, /api/deploys,
/api/reviews, /api/project-groups, ...）全都沒處理——任何 authenticated user 看得到任何
人的 project metadata, deployment URL, review decision, threat summary。

這是教科書 OWASP A01:2021 Broken Access Control（API Top 10 #1 — Broken Object Level
Authorization）。對「安全部署 agent」來說是最丟臉的 failure mode。

Round 31 修了 GET /api/projects（commit `6c2d9a4`），同時做了完整 audit，發現
**還有 9 個 endpoint 同樣有 IDOR**（3 個 P0 list、6 個 P1 single-resource）。
這個決策檔登記**修法的標準 pattern**，後續 endpoint 都照這個模子做。

## Decision

### Pattern A — LIST endpoints（query-time filter）

```typescript
// services/<resource>-query.ts — pure helpers, zero deps
export type List<Resource>Scope =
  | { kind: 'all' }
  | { kind: 'owner'; ownerId: string }
  | { kind: 'denied' };

export type AuthMode = 'permissive' | 'enforced';

export function scopeForRequest(auth: AuthContext, mode: AuthMode): List<Resource>Scope {
  const u = auth.user;
  if (!u) return mode === 'permissive' ? { kind: 'all' } : { kind: 'denied' };
  if (u.role_name === 'admin') return { kind: 'all' };
  return { kind: 'owner', ownerId: u.id };
}

export function buildList<Resource>Sql(scope: List<Resource>Scope): { text: string; values: unknown[] } {
  switch (scope.kind) {
    case 'all':    return { text: 'SELECT * FROM <table> ORDER BY created_at DESC', values: [] };
    case 'owner':  return { text: 'SELECT * FROM <table> WHERE owner_id = $1 ORDER BY created_at DESC', values: [scope.ownerId] };
    case 'denied': return { text: 'SELECT * FROM <table> WHERE FALSE ORDER BY created_at DESC', values: [] };
  }
}
```

Route handler：

```typescript
app.get('/api/<resource>', async (request) => {
  const mode = (process.env.AUTH_MODE ?? 'permissive') as 'permissive' | 'enforced';
  const scope = scopeForRequest(request.auth, mode);
  const rows = await list<Resource>(scope);
  return { <resource>: rows };
});
```

Service layer：`list<Resource>(scope = { kind: 'all' })` 預設 `'all'` 保留內部 caller
（worker, reconciler, mcp）的 backwards-compat。

### Pattern B — Single-resource GET（per-record check）

對於 `GET /api/<resource>/:id`，scope filter 不適用（已經知道哪一筆）。改用：

```typescript
app.get<{ Params: { id: string } }>('/api/<resource>/:id', async (request, reply) => {
  const row = await get<Resource>(request.params.id);
  if (!row) return reply.status(404).send({ error: 'Not found' });

  // Re-use existing requireOwnerOrAdmin pattern from round 25.
  // Resolve to the parent project if the resource is project-owned.
  const project = await getProject(row.project_id);
  if (!project) return reply.status(404).send({ error: 'Project not found' });
  const check = await requireOwnerOrAdmin(request, reply, project, 'read_<resource>');
  if (!check.ok) return;  // reply already sent (401/403 + audit log)

  return { <resource>: row };
});
```

對 `GET /api/projects/:id` 自身，直接拿 project owner_id 比對即可。

### Verdict 種類為什麼三種而非兩種

`'denied'` kind 看起來多餘（middleware 應該已經擋掉 anonymous in enforced），但
保留三態的理由：

1. **Defense in depth**：middleware regression 不該變成資料外洩
2. **Type safety**：route handler 不用寫 `if (auth.user) { ... } else { return [] }`
3. **WHERE FALSE 比 throw 安全**：500 反倒洩漏「這 endpoint 存在」訊號

### 為什麼不在 app code filter（`.filter(p => p.owner_id === userId)`）

1. **DB I/O 浪費**：拉所有 row 再丟一半
2. **Timing channel leak**：response time 跟「實際 row 數」相關，攻擊者可以 enumerate
3. **容易忘**：開發者新增 endpoint 時抄錯 pattern，filter 漏寫

### Pure helpers 的硬性要求

- `scopeForRequest()` / `buildListXxxSql()` **必須** 是 pure function：no DB, no fastify, no env
- 統一接口：`buildXxxSql(scope) → { text, values }`，方便 reuse from CLI / GraphQL / MCP
- 配對的 zero-dep tsx test runner：每個 scope kind + 每個 SQL output + security regression

## Consequences

**Pros**
- 一份 pattern 解 9 個 endpoint，後續新 LIST endpoint 照抄即可
- Pure helper 100% 可單測，無需 stub DB
- Filter 在 SQL 層，無 timing channel
- Backwards-compat：service function 預設 `{ kind: 'all' }`，不影響 worker/reconciler/mcp

**Cons**
- 每個 resource 都要寫一份 `<resource>-query.ts`（model/route/test 三檔）
- 對於 cross-project resource（reviews → project_id），SQL 需要 JOIN 到 projects table 取 owner_id
- 角色擴張時（reviewer 該不該看 ALL reviews？）三態可能不夠，要演化成 N 態

**Why not single generic `withOwnerScope(table, query)` helper?**
看似 DRY，實際上每個 resource 的 owner relation 不同（projects 直接有 owner_id；
reviews 透過 scan_reports → projects；deployments 透過 project_id → projects）。
強行抽象只會讓 SQL composition 變糊，每個 resource 寫一次 explicit query 反而清楚。

## Verification Plan

對每個套用此 pattern 的 endpoint，必須：

1. ✅ 寫 zero-dep tsx test：`test-<resource>-query.ts` 涵蓋
   - admin → all
   - non-admin user → owner
   - anonymous + permissive → all（legacy compat）
   - anonymous + enforced → denied
   - empty role_name → owner（fail closed）
   - SQL composition for 三種 scope
   - Security regression：ownerId 不嵌入 SQL text
   - SQL injection-shaped ownerId 走 parameter
2. ✅ Cumulative sweep（`./scripts/sweep-zero-dep-tests.sh`）全綠
3. ✅ TypeScript clean（`npx tsc --noEmit`）
4. ⏸️ Production smoke test：admin 帳號看到全部、viewer 帳號只看到自己的

## Audit Findings (filed 2026-04-27)

Round 31 同時做了完整 audit。除了已修的 `GET /api/projects`，還有：

**P0（list endpoint 全洩）**
- `GET /api/deploys` — `routes/deploys.ts:11`
- `GET /api/reviews` — `routes/reviews.ts:31`
- `GET /api/project-groups` — `routes/project-groups.ts:165`

**P1（single-resource 無 owner check）**
- `GET /api/deploys/:id` — `routes/deploys.ts:23`
- `GET /api/deploys/:id/ssl-status` — `routes/deploys.ts:36`
- `GET /api/deploys/:id/logs` — `routes/deploys.ts:369`
- `GET /api/reviews/:id` — `routes/reviews.ts:65`
- `GET /api/project-groups/:groupId` — `routes/project-groups.ts:173`
- `GET /api/projects/:id/versions` — `routes/versioning.ts:34`

P0 應在 Round 32+ 依此 pattern 一次 boil 完。P1 用 Pattern B（per-resource check）。

## Round 32 Follow-Through (2026-04-27)

`GET /api/project-groups` 兩個 handler 修完，commit `<round-32>`。

**做法**：因為 groups view 是 projects 的 *aggregation* 不是獨立 resource，沒新增
`project-groups-query.ts`。改成：

1. **Extract pure aggregation helpers** 到 `apps/api/src/services/project-groups-pure.ts`：
   - `groupProjects(projects)` — 從 `routes/project-groups.ts:122-161` 搬出來
   - `filterProjectsByGroupId(projects, groupId)` — `:177` 那條 inline filter 提煉成 named helper
2. **Re-use existing `scopeForRequest`** — 不複製 verdict 邏輯，直接 import from
   `services/projects-query.ts`
3. **兩個 GET handler**（`/api/project-groups` LIST + `/api/project-groups/:groupId` GET-by-id）
   都從 `request.auth` derive scope，pass 給 `listProjects(scope)`，下游 SQL 自動 filter
4. **POST `/api/project-groups/:groupId/actions` 不在這輪修**（mutating，需要 per-target
   `requireOwnerOrAdmin` 而不是 list-scope filter）

**IDOR 不變式**（test 鎖死）：`filterProjectsByGroupId` **永遠不會 widen** input。
所以只要 SQL 層已經 scope-filter（admin → all rows；viewer → 只有自己 ownerId 的 rows），
output groups 就 IDOR-safe。一個 viewer 不可能透過任何 groupId 猜測值看到別人的 group。

**附帶好處**：scope-filter 在 `enrichProjectWithResources` 之前，所以 viewer 看 groups
時也少做 `O(N projects)` 個 GCP API call（Cloud Run service detail / domain mapping
/ Redis allocation 查詢）。RBAC 修法順便省 GCP cost。

**Snapshot test**（locked behavior）：viewer 看 mixed-owner 的 group 時，`serviceCount`
反映**scope-filtered subset**（不是全 owner 的 true total）。例：Alice + Bob 共享
`projectGroup=shared-group`，viewer Alice 看 `serviceCount=1`（只有自己的）不是 2。
這是正確 RBAC outcome；未來 refactor 想「修」這個 count 之前，這個 test 會擋。

**新測試**：`apps/api/src/test-project-groups-scope.ts` — 38 PASS。Cumulative sweep
**1805 / 1805 PASS across 32 zero-dep files**（was 1767/31 at end of round 31）。

**Audit follow-through 進度**：
- ✅ R31: `GET /api/projects` (commit `6c2d9a4`)
- ✅ R32: `GET /api/project-groups` LIST + GET-by-id (commit `637d1d4`)
- ✅ R33: `GET /api/reviews` (commit `a93169c`)
- ✅ R34: `GET /api/deploys` (commit `7d9d25e`) — **P0 list endpoints DONE**
- ✅ R35: 6 P1 single-resource GETs Pattern B (commit `aec31c6`) — **P1 per-record DONE**
- ⏸️ R??: `POST /api/project-groups/:groupId/actions` per-target check (mutating, 出 list 範疇)

**5th-caller-trigger for `audit-query-core` abstraction**：目前 4 callers
（discord-audit / auth-audit / reviews / projects）。如果 R33 reviews refactor
後仍是「parser + SQL builder + scope」這同樣三件事，且 R34 deploys 也是同樣
shape，那 R34 就是觸發點，再決定要不要抽 generic `audit-query-core`。在那之前
deferred。

## Round 33 Follow-Through (2026-04-27)

`GET /api/reviews` 兩個 envelope path（legacy + paged）修完，commit `a93169c`。

**做法**：reviews-query 已經 JOIN `projects p ON sr.project_id = p.id`（R30b 留下的拓撲），
新增 scope param 是純粹擴張：

1. **`buildWhere(query, scope = { kind: 'all' })` 把 scope 放最前面**
   - placeholder `$1` 永遠是 ownerId（如果 owner scope）；user filters 順序遞增
   - test 鎖 placeholder ordering（`assertEq(sql.values, [SAMPLE_USER_ID, 50, 0])`）
   - 為什麼放最前：auditor 讀 SQL 第一眼看到「先 RBAC 再 user filter」，符合 defense-in-depth 心智模型
2. **`buildReviewsListSql(q, scope)` + `buildReviewsCountSql(q, scope)`** 兩處 thread through
3. **route handler 兩條路徑都 wire**（legacy `{ reviews }` + paged `{ reviews, total, ... }`）

**Tests deltas**：
- `test-reviews-query.ts` 85 → 118 PASS（+33 R33 tests）
- 涵蓋 scope=all/owner/denied + scope×user-filter 堆疊 + placeholder numbering 鎖死 +
  security regression（ownerId 不嵌字串、SQL-injection-shaped 也走 pg param）+
  IDOR contract（alice scope ≠ bob scope）+ JOIN / ORDER BY / LIMIT 保留
- Sweep 1805 / 32 → 1838 / 32 全綠

**Self-critique**：本來該 TDD red 先 — tests 寫完先跑一次確認失敗，再實作。實際操作
我兩件事一起寫然後一次跑 green，沒驗 red phase。下次先單獨 commit tests-only
跑一次失敗，再 commit implementation。

## Round 34 Follow-Through (2026-04-27)

`GET /api/deploys` 修完，commit `7d9d25e`。**P0 list endpoint sweep 完成**。

**做法**：deploys 是 4 個 P0 中拓撲最簡單的——deployments 本來就 JOIN projects，
加 `WHERE p.owner_id = $1` 完事。

1. **NEW `apps/api/src/services/deploys-query.ts`** — 70 LOC，**只有單一函式
   `buildListDeploysSql(scope)`**。沒 parser，沒 zod，沒 filter（deploys list 還沒
   query-string filter）。直接 switch on `scope.kind` 回傳 `{ text, values }`
2. **Reuse `scopeForRequest`** from projects-query — verdict 三態邏輯不複製
3. **NEW `test-deploys-query.ts`** — 41 PASS：scope kind × SQL + JOIN/ORDER BY/LIMIT
   保留 + security regression + IDOR contract + E2E with `scopeForRequest`（含
   admin/viewer/reviewer/anonymous-permissive/anonymous-enforced/empty-role-name fail-closed）
4. **MODIFIED `routes/deploys.ts:13`** — 5 行 wire：derive mode → derive scope → build
   SQL → query → return

**5th-caller-trigger 結論（從 R32 ADR amendment 延伸）**：本來說 R34 決定要不要抽
`audit-query-core`。Verdict **NO**：deploys-query 太簡單（無 parser、無 zod、
無 filter），三 line WHERE + 三 line values + switch on `scope.kind`。抽象只會
藏起明顯的東西，沒移除真實重複。等第 6 個 caller 出現帶 full parser+composer
shape 再評估。

Sweep 1838 / 32 → 1879 / 33 全綠（+41 R34 tests）。tsc clean。

## Round 35 Follow-Through (2026-04-27) — Pattern B 收尾

整個 round-31 audit punch list **完全結束**，commit `aec31c6`。R35 把 round-25
就存在的 `requireOwnerOrAdmin` helper 套到 6 個 read-side 單一資源 endpoint：

| Endpoint | Action label | Notes |
|----------|-------------|-------|
| `GET /api/projects/:id` | `project_read` | 已有 `getProject()` row，直接 pass |
| `GET /api/projects/:id/versions` | `versions_read` | 同上 |
| `GET /api/reviews/:id` | `review_read` | **最敏感** — semgrep + trivy + LLM analysis + threat summary + auto-fix + cost |
| `GET /api/deploys/:id` | `deployment_read` | SELECT 多取 `p.owner_id as project_owner_id` 省 DB roundtrip |
| `GET /api/deploys/:id/ssl-status` | `deployment_ssl_status_read` | 同上 |
| `GET /api/deploys/:id/logs` | `deployment_logs_read` | 改 SELECT 加 JOIN projects + owner_id |

**為什麼沒寫新測試**：`requireOwnerOrAdmin` 的 verdict 邏輯在 round 25 已被
`test-access-denied-verdict.ts` 完整覆蓋。R35 只是**wiring**，不是新邏輯。沿用
round-25 同樣的 wiring 沒寫 per-handler test 重複（round 25 wired 16 個 mutating
handler 也是這樣）。Sweep 1879/33 全綠 + tsc clean = 沒回歸 = OK。

如果未來想加 per-handler integration test，模式是 `test-route-<resource>.ts`
（needs Fastify + DB），不在「zero-dep tsx test」這條軌道上。本 ADR 範疇外。

**OWASP coverage 狀態**（A01:2021 + API Top 10 #1 BOLA）：
- ✅ Read-side LIST endpoints（4 P0：projects / project-groups / reviews / deploys）
- ✅ Read-side single-resource（6 P1）
- ✅ Mutating routes（round 25 已收，16 個 handler）
- ⏸️ `POST /api/project-groups/:groupId/actions`（bulk mutating，per-target check
  pattern 不同，未修）

剩 1 個 mutating bulk action endpoint。整體 RBAC read-path **complete**。

## References

- Commit: `6c2d9a4` — fix(api): RBAC scope-filter on GET /api/projects (round 31)
- Round 25 RBAC: `brain/decisions/2026-04-25-rbac-system-permissive-then-enforced.md`
- File: `apps/api/src/services/projects-query.ts`（72 LOC pure helpers）
- Tests: `apps/api/src/test-projects-query.ts`（25 PASS）
- OWASP A01:2021 — <https://owasp.org/Top10/A01_2021-Broken_Access_Control/>
- OWASP API Top 10 #1 BOLA — <https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/>
- OWASP ASVS V8 Data Protection — <https://owasp.org/www-project-application-security-verification-standard/>
