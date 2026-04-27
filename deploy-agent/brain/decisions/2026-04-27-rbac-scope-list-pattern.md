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
- ✅ R32: `GET /api/project-groups` LIST + GET-by-id (this round)
- ⏸️ R33: `GET /api/reviews`（要 join scan_reports → projects 才能拿 owner_id）
- ⏸️ R34: `GET /api/deploys`（直接 join projects 就行）
- ⏸️ R35+: 6 個 P1 single-resource endpoint (Pattern B)
- ⏸️ R??: `POST /api/project-groups/:groupId/actions` per-target check (mutating, 出 list 範疇)

**5th-caller-trigger for `audit-query-core` abstraction**：目前 4 callers
（discord-audit / auth-audit / reviews / projects）。如果 R33 reviews refactor
後仍是「parser + SQL builder + scope」這同樣三件事，且 R34 deploys 也是同樣
shape，那 R34 就是觸發點，再決定要不要抽 generic `audit-query-core`。在那之前
deferred。

## References

- Commit: `6c2d9a4` — fix(api): RBAC scope-filter on GET /api/projects (round 31)
- Round 25 RBAC: `brain/decisions/2026-04-25-rbac-system-permissive-then-enforced.md`
- File: `apps/api/src/services/projects-query.ts`（72 LOC pure helpers）
- Tests: `apps/api/src/test-projects-query.ts`（25 PASS）
- OWASP A01:2021 — <https://owasp.org/Top10/A01_2021-Broken_Access_Control/>
- OWASP API Top 10 #1 BOLA — <https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/>
- OWASP ASVS V8 Data Protection — <https://owasp.org/www-project-application-security-verification-standard/>
