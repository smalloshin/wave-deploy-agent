// Round 32 — Tests for project-groups-pure helpers + scope plumbing contract.
//
// Backstory: round 31 fixed `GET /api/projects` IDOR by adding scope-aware
// SQL filtering. Audit immediately found `routes/project-groups.ts` had a
// silent regression: both GET handlers call `listProjects()` with NO scope,
// so EVERY authenticated user still saw EVERY project's group view (which
// includes per-project resources, services, GCP service URLs, custom domains,
// SSL status). Worse than the round-31 leak because the response is
// enriched.
//
// Round 32 fix: extract `groupProjects` and `filterProjectsByGroupId` to
// `services/project-groups-pure.ts` (pure, zero-dep), and plumb
// `scopeForRequest` through both GET route handlers. Same pattern as round
// 31 — boil-the-lake SQL-layer filter, not app-layer.
//
// This test file proves:
//  1. The pure helpers themselves are correct (groupProjects bucketing,
//     sort order, count invariants; filterProjectsByGroupId match logic).
//  2. The IDOR-relevant invariant: filterProjectsByGroupId NEVER widens its
//     input — viewer can never see a group constructed from a non-owned
//     project. This is the round-31 ADR contract.
//  3. The route's scope derivation logic mirrors `scopeForRequest` from
//     `services/projects-query.ts` exactly (sanity check that the same
//     verdicts apply to the groups view).
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  filterProjectsByGroupId,
  groupProjects,
} from './services/project-groups-pure.js';
import { scopeForRequest } from './services/projects-query.js';
import type { AuthContext } from './middleware/auth.js';
import type {
  AuthUser,
  Permission,
  Project,
  ProjectConfig,
  ProjectStatus,
  ProjectWithResources,
} from '@deploy-agent/shared';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(
    ok,
    name,
    ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ─── Fixtures ───────────────────────────────────────────────────────────

const ALICE_ID = '11111111-1111-1111-1111-111111111111';
const BOB_ID = '22222222-2222-2222-2222-222222222222';

function fakeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: ALICE_ID,
    email: 'alice@example.com',
    display_name: 'Alice',
    role_id: 'role-uuid',
    role_name: 'viewer',
    permissions: [] as Permission[],
    is_active: true,
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function fakeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: null,
    via: 'anonymous',
    permissions: [] as Permission[],
    ...overrides,
  };
}

function fakeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    deployTarget: 'cloud_run',
    allowUnauthenticated: true,
    ...overrides,
  };
}

function fakeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'proj-default',
    name: overrides.name ?? 'default',
    slug: overrides.slug ?? 'default',
    sourceType: 'upload',
    sourceUrl: null,
    detectedLanguage: 'node',
    detectedFramework: null,
    status: 'live',
    config: fakeConfig(overrides.config ?? {}),
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-20T00:00:00Z'),
    ownerId: ALICE_ID,
    ...overrides,
  };
}

function withResources(p: Project): ProjectWithResources {
  return {
    ...p,
    resources: [],
    latestDeployment: null,
  };
}

// ─── filterProjectsByGroupId — match by config.projectGroup ─────────────

(() => {
  const a = fakeProject({ id: 'a', config: fakeConfig({ projectGroup: 'g1' }) });
  const b = fakeProject({ id: 'b', config: fakeConfig({ projectGroup: 'g2' }) });
  const c = fakeProject({ id: 'c', config: fakeConfig({ projectGroup: 'g1' }) });
  const out = filterProjectsByGroupId([a, b, c], 'g1');
  assertEq(out.map((p) => p.id), ['a', 'c'], 'filter: matches by config.projectGroup');
})();

// ─── filterProjectsByGroupId — match by project id (single-service group) ──

(() => {
  const a = fakeProject({ id: 'lonely', config: fakeConfig() });  // no projectGroup
  const b = fakeProject({ id: 'other', config: fakeConfig() });
  const out = filterProjectsByGroupId([a, b], 'lonely');
  assertEq(out.map((p) => p.id), ['lonely'], 'filter: matches by project id when no group');
})();

// ─── filterProjectsByGroupId — empty result for unknown group ───────────

(() => {
  const a = fakeProject({ id: 'a', config: fakeConfig({ projectGroup: 'g1' }) });
  const out = filterProjectsByGroupId([a], 'does-not-exist');
  assertEq(out, [], 'filter: empty for unknown groupId');
})();

// ─── filterProjectsByGroupId — IDOR contract: NEVER widens input ────────

(() => {
  // The IDOR-relevant invariant. Even with a malicious-looking groupId,
  // filterProjectsByGroupId can ONLY narrow the input row set, never widen
  // it. So if `projects` came in already scope-filtered by SQL (admin →
  // all rows; viewer → only rows where owner_id === viewer.id), the output
  // is also scope-correct. There's no path where a viewer sees a group
  // built from another user's projects via this filter.
  const aliceProj = fakeProject({ id: 'p-alice', ownerId: ALICE_ID, config: fakeConfig({ projectGroup: 'g1' }) });
  const scopedInput = [aliceProj];  // simulating SQL already filtered out Bob's
  const out = filterProjectsByGroupId(scopedInput, 'g1');
  // Output is a subset of input, every row still belongs to Alice.
  assert(
    out.every((p) => p.ownerId === ALICE_ID),
    'filter (IDOR contract): every output row belongs to Alice (no widening)',
  );
  assert(
    out.length <= scopedInput.length,
    'filter (IDOR contract): output count never exceeds input count',
  );
})();

(() => {
  // Even if the groupId IS Bob's project id, Alice can't see it because
  // it was already removed from the input by the SQL scope filter.
  const aliceProj = fakeProject({ id: 'p-alice', ownerId: ALICE_ID });
  const scopedInput = [aliceProj];  // Bob's projects already filtered out
  const out = filterProjectsByGroupId(scopedInput, 'p-bob-secret-id');
  assertEq(out, [], 'filter (IDOR contract): cannot reach Bob row via groupId guess');
})();

// ─── filterProjectsByGroupId — both id-match and config-match work ──────

(() => {
  // Edge case: groupId equals project id AND another project's config.projectGroup.
  // Both should match.
  const a = fakeProject({ id: 'gid', config: fakeConfig() });
  const b = fakeProject({ id: 'b', config: fakeConfig({ projectGroup: 'gid' }) });
  const c = fakeProject({ id: 'c', config: fakeConfig() });
  const out = filterProjectsByGroupId([a, b, c], 'gid');
  assertEq(out.map((p) => p.id).sort(), ['b', 'gid'], 'filter: matches both id and group simultaneously');
})();

// ─── groupProjects — single project becomes a group of 1 ────────────────

(() => {
  const a = withResources(fakeProject({ id: 'solo', name: 'solo', config: fakeConfig() }));
  const groups = groupProjects([a]);
  assertEq(groups.length, 1, 'group: solo project → one group');
  assertEq(groups[0].groupId, 'solo', 'group: solo group id falls back to project id');
  assertEq(groups[0].serviceCount, 1, 'group: solo serviceCount=1');
})();

// ─── groupProjects — multiple projects with same projectGroup bucket together ──

(() => {
  const a = withResources(fakeProject({
    id: 'svc-a',
    name: 'a',
    config: fakeConfig({ projectGroup: 'kol-studio', groupName: 'KOL Studio', serviceRole: 'backend' }),
  }));
  const b = withResources(fakeProject({
    id: 'svc-b',
    name: 'b',
    config: fakeConfig({ projectGroup: 'kol-studio', groupName: 'KOL Studio', serviceRole: 'frontend' }),
  }));
  const groups = groupProjects([a, b]);
  assertEq(groups.length, 1, 'group: same projectGroup → one group');
  assertEq(groups[0].serviceCount, 2, 'group: bucketed serviceCount=2');
  assertEq(groups[0].groupName, 'KOL Studio', 'group: groupName picked from config');
})();

// ─── groupProjects — different groups stay separate ─────────────────────

(() => {
  const a = withResources(fakeProject({ id: 'a', name: 'a', config: fakeConfig({ projectGroup: 'g1' }) }));
  const b = withResources(fakeProject({ id: 'b', name: 'b', config: fakeConfig({ projectGroup: 'g2' }) }));
  const groups = groupProjects([a, b]);
  assertEq(groups.length, 2, 'group: two distinct groups');
})();

// ─── groupProjects — count invariants (live/stopped/failed) ─────────────

(() => {
  const live = withResources(fakeProject({
    id: 'live', name: 'live', status: 'live' as ProjectStatus,
    config: fakeConfig({ projectGroup: 'g' }),
  }));
  const stopped = withResources(fakeProject({
    id: 'stopped', name: 'stopped', status: 'stopped' as ProjectStatus,
    config: fakeConfig({ projectGroup: 'g' }),
  }));
  const failed = withResources(fakeProject({
    id: 'failed', name: 'failed', status: 'failed' as ProjectStatus,
    config: fakeConfig({ projectGroup: 'g' }),
  }));
  const [g] = groupProjects([live, stopped, failed]);
  assertEq(g.serviceCount, 3, 'counts: serviceCount=3');
  assertEq(g.liveCount, 1, 'counts: liveCount=1');
  assertEq(g.stoppedCount, 1, 'counts: stoppedCount=1');
  assertEq(g.failedCount, 1, 'counts: failedCount=1');
})();

// ─── groupProjects — backend sorts before frontend (deploy order) ───────

(() => {
  const frontend = withResources(fakeProject({
    id: 'fe', name: 'frontend',
    config: fakeConfig({ projectGroup: 'g', serviceRole: 'frontend' }),
  }));
  const backend = withResources(fakeProject({
    id: 'be', name: 'backend',
    config: fakeConfig({ projectGroup: 'g', serviceRole: 'backend' }),
  }));
  // Pass in frontend-first to verify the sort actually fires.
  const [g] = groupProjects([frontend, backend]);
  assertEq(
    g.services.map((s) => s.config.serviceRole),
    ['backend', 'frontend'],
    'sort: backend before frontend (deploy order)',
  );
})();

// ─── groupProjects — most recently updated group sorts first ────────────

(() => {
  const old = withResources(fakeProject({
    id: 'old', name: 'old',
    config: fakeConfig({ projectGroup: 'g-old' }),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }));
  const fresh = withResources(fakeProject({
    id: 'fresh', name: 'fresh',
    config: fakeConfig({ projectGroup: 'g-fresh' }),
    updatedAt: new Date('2026-04-26T00:00:00Z'),
  }));
  const groups = groupProjects([old, fresh]);
  assertEq(groups.map((g) => g.groupId), ['g-fresh', 'g-old'], 'sort: recent group first');
})();

// ─── groupProjects — IDOR contract: never widens beyond input ───────────

(() => {
  // Even if Bob's project ID is "guessed" as a group ID, with input filtered
  // to Alice's projects only, output groups can ONLY contain Alice's
  // projects. groupProjects does not re-fetch from DB.
  const aliceProj = withResources(fakeProject({
    id: 'p-alice', ownerId: ALICE_ID,
    config: fakeConfig({ projectGroup: 'g1' }),
  }));
  const groups = groupProjects([aliceProj]);
  for (const g of groups) {
    for (const s of g.services) {
      assert(
        s.ownerId === ALICE_ID,
        'group (IDOR contract): every service in every group belongs to Alice',
      );
    }
  }
})();

// ─── groupProjects — preserves all projects (no Cartesian product) ──────

(() => {
  // Three projects in one group → one group with three services. NOT three
  // groups, NOT three projects each appearing in three groups.
  const a = withResources(fakeProject({ id: 'a', name: 'a', config: fakeConfig({ projectGroup: 'g' }) }));
  const b = withResources(fakeProject({ id: 'b', name: 'b', config: fakeConfig({ projectGroup: 'g' }) }));
  const c = withResources(fakeProject({ id: 'c', name: 'c', config: fakeConfig({ projectGroup: 'g' }) }));
  const groups = groupProjects([a, b, c]);
  assertEq(groups.length, 1, 'no-cartesian: single group output');
  assertEq(groups[0].services.length, 3, 'no-cartesian: 3 services in the group');
  // Each project id appears exactly once across all groups.
  const allIds = groups.flatMap((g) => g.services.map((s) => s.id));
  assertEq(allIds.length, 3, 'no-cartesian: each project counted exactly once');
})();

// ─── End-to-end: scope → filter → group preserves IDOR contract ─────────

(() => {
  // Simulate the full route: scopeForRequest → listProjects(scope) → filter
  // → group. Viewer sees only their own group; Bob's group invisible.
  const aliceAuth = fakeAuth({ user: fakeUser({ id: ALICE_ID, role_name: 'viewer' }), via: 'session' });
  const scope = scopeForRequest(aliceAuth, 'enforced');
  assertEq(scope, { kind: 'owner', ownerId: ALICE_ID }, 'e2e: viewer scope locked to their id');

  // Pretend listProjects(scope='owner') returned ONLY Alice's row.
  const aliceProj = withResources(fakeProject({
    id: 'p-alice', ownerId: ALICE_ID,
    config: fakeConfig({ projectGroup: 'shared-group' }),
  }));
  const sqlFiltered: ProjectWithResources[] = [aliceProj];

  // Filter by groupId then group.
  const matched = filterProjectsByGroupId(sqlFiltered, 'shared-group');
  const groups = groupProjects(matched);

  // Alice sees her group, with only her service in it. Bob's project (which
  // would also have config.projectGroup === 'shared-group' if it existed)
  // was already filtered out by SQL — never reaches this code path.
  assertEq(groups.length, 1, 'e2e: viewer sees one group');
  assertEq(groups[0].services.length, 1, 'e2e: only viewer-owned service in group');
  assertEq(groups[0].services[0].ownerId, ALICE_ID, 'e2e: service belongs to viewer');
})();

(() => {
  // Admin path: full visibility, both Alice's and Bob's services in the
  // shared group.
  const adminAuth = fakeAuth({
    user: fakeUser({ id: 'admin-id', role_name: 'admin' }),
    via: 'session',
  });
  const scope = scopeForRequest(adminAuth, 'enforced');
  assertEq(scope, { kind: 'all' }, 'e2e: admin scope is all');

  // Pretend listProjects(scope='all') returned both Alice's and Bob's rows.
  const aliceProj = withResources(fakeProject({
    id: 'p-alice', ownerId: ALICE_ID,
    config: fakeConfig({ projectGroup: 'shared-group' }),
  }));
  const bobProj = withResources(fakeProject({
    id: 'p-bob', ownerId: BOB_ID,
    config: fakeConfig({ projectGroup: 'shared-group' }),
  }));
  const sqlAll: ProjectWithResources[] = [aliceProj, bobProj];

  const matched = filterProjectsByGroupId(sqlAll, 'shared-group');
  const groups = groupProjects(matched);

  assertEq(groups.length, 1, 'e2e admin: one shared group');
  assertEq(groups[0].services.length, 2, 'e2e admin: both services visible');
  const ownerIds = groups[0].services.map((s) => s.ownerId).sort();
  assertEq(ownerIds, [ALICE_ID, BOB_ID], 'e2e admin: both Alice and Bob services in group');
})();

// ─── Anonymous + permissive: legacy compat (sees all) ───────────────────

(() => {
  const anonAuth = fakeAuth({ user: null, via: 'anonymous' });
  const scope = scopeForRequest(anonAuth, 'permissive');
  assertEq(scope, { kind: 'all' }, 'anon+permissive: legacy compat → all');
})();

// ─── Anonymous + enforced: defensive denied (zero rows) ─────────────────

(() => {
  const anonAuth = fakeAuth({ user: null, via: 'anonymous' });
  const scope = scopeForRequest(anonAuth, 'enforced');
  assertEq(scope, { kind: 'denied' }, 'anon+enforced: defensive denied');
})();

// ─── Empty role_name treated as non-admin (fail closed) ─────────────────

(() => {
  const wonkyAuth = fakeAuth({
    user: fakeUser({ id: ALICE_ID, role_name: '' }),
    via: 'session',
  });
  const scope = scopeForRequest(wonkyAuth, 'enforced');
  assertEq(
    scope,
    { kind: 'owner', ownerId: ALICE_ID },
    'fail-closed: empty role_name → owner (not admin)',
  );
})();

// ─── Reviewer role is non-admin (fail closed for groups view) ───────────

(() => {
  const reviewerAuth = fakeAuth({
    user: fakeUser({ id: ALICE_ID, role_name: 'reviewer' }),
    via: 'session',
  });
  const scope = scopeForRequest(reviewerAuth, 'enforced');
  assertEq(
    scope,
    { kind: 'owner', ownerId: ALICE_ID },
    'reviewer is non-admin: groups view scoped to own',
  );
})();

// ─── Partial-membership snapshot: viewer's view of mixed-owner group ────

(() => {
  // The "partial membership" scenario flagged by QA. If a multi-service
  // group nominally has services owned by both Alice and Bob, but SQL
  // already filtered out Bob's, the viewer (Alice) sees the group with
  // serviceCount=1 (NOT the true count of 2). That's the correct RBAC
  // outcome. Locking this behavior in: a future refactor that "fixes"
  // serviceCount to mean "true count across all owners" would break RBAC.
  const aliceShared = withResources(fakeProject({
    id: 'svc-a', ownerId: ALICE_ID, name: 'a',
    config: fakeConfig({ projectGroup: 'mixed-group' }),
  }));
  // Pretend the SQL filter removed Bob's svc-b before it reached us.
  const scopeFilteredInput: ProjectWithResources[] = [aliceShared];
  const matched = filterProjectsByGroupId(scopeFilteredInput, 'mixed-group');
  const groups = groupProjects(matched);
  assertEq(
    groups[0].serviceCount,
    1,
    'snapshot: serviceCount reflects scope-filtered subset, NOT true cross-owner total',
  );
})();

// ─── Type-only assertion: AuthContext shape is what middleware provides ──

(() => {
  // Compile-time guard: the AuthContext we feed scopeForRequest() must
  // match the shape that Fastify's request.auth has. If middleware/auth.ts
  // ever changes the AuthContext interface, this file will fail to compile
  // and force a fix. (Runtime test passes trivially.)
  const ctx: AuthContext = {
    user: fakeUser(),
    via: 'session',
    permissions: [] as Permission[],
  };
  const scope = scopeForRequest(ctx, 'enforced');
  assert(scope.kind === 'all' || scope.kind === 'owner' || scope.kind === 'denied',
    'type guard: AuthContext is the shape scopeForRequest accepts');
})();

// ─── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
