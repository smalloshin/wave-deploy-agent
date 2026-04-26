/**
 * Pure-function tests for access-denied-verdict.ts (RBAC Phase 1).
 *
 * Mirrors round 21 / 23 / 24 test patterns:
 *   - input() helper with sensible defaults (admin actor, owned project)
 *   - Section 1: kind matrix (all 6 kinds × representative inputs)
 *   - Section 2: console-capture for logAccessVerdict
 *   - Section 3: errorCode + httpStatus literal narrowing
 *   - Section 4: cross-mode regression (anonymous in permissive vs enforced)
 *   - Section 5: edge cases (legacy unowned × admin/non-admin/anonymous)
 */

import {
  buildAccessVerdict,
  logAccessVerdict,
  isGranted,
  type AccessCheckInput,
  type AccessVerdict,
} from './services/access-denied-verdict.js';

// ─── Test plumbing ─────────────────────────────────────────────

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}`);
  }
}

function input(overrides: Partial<AccessCheckInput> = {}): AccessCheckInput {
  return {
    mode: 'enforced',
    via: 'session',
    actorUserId: 'actor-uuid-aaa',
    actorEmail: 'alice@example.com',
    actorRoleName: 'reviewer',
    resourceOwnerId: 'actor-uuid-aaa',
    resourceId: 'proj-uuid-111',
    resourceKind: 'project',
    action: 'delete',
    ...overrides,
  };
}

interface ConsoleCapture {
  logs: string[];
  warns: string[];
  errors: string[];
  restore: () => void;
}
function captureConsole(): ConsoleCapture {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  return {
    logs,
    warns,
    errors,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Section 1 — Kind matrix
// ═══════════════════════════════════════════════════════════════
console.log('\n=== Section 1: kind matrix ===\n');

(() => {
  // 1a. owner match → granted-as-owner
  const v = buildAccessVerdict(input({
    actorUserId: 'u-1',
    resourceOwnerId: 'u-1',
    actorRoleName: 'reviewer',
  }));
  check('1a kind=granted-as-owner', v.kind === 'granted-as-owner');
  check('1a logLevel=info', v.logLevel === 'info');
  check('1a message names owner email', v.message.includes('alice@example.com'));
  check('1a message names resourceId', v.message.includes('proj-uuid-111'));
  check('1a message names action', v.message.includes('delete'));
  check('1a isGranted=true', isGranted(v) === true);
})();

(() => {
  // 1b. admin acting on someone else's project → granted-as-admin
  const v = buildAccessVerdict(input({
    actorUserId: 'admin-1',
    actorEmail: 'admin@example.com',
    actorRoleName: 'admin',
    resourceOwnerId: 'someone-else',
  }));
  check('1b kind=granted-as-admin', v.kind === 'granted-as-admin');
  check('1b logLevel=info', v.logLevel === 'info');
  if (v.kind === 'granted-as-admin') {
    check('1b auditAction=admin_override', v.auditAction === 'admin_override');
    check('1b message says admin override', v.message.includes('admin override'));
    check('1b message names actor', v.message.includes('admin@example.com'));
    check('1b message names other-owner uuid', v.message.includes('someone-else'));
  }
  check('1b isGranted=true', isGranted(v) === true);
})();

(() => {
  // 1c. admin on own project → still granted-as-OWNER, not admin (self-action)
  const v = buildAccessVerdict(input({
    actorUserId: 'admin-1',
    actorEmail: 'admin@example.com',
    actorRoleName: 'admin',
    resourceOwnerId: 'admin-1',
  }));
  check('1c admin-on-own-project = granted-as-owner', v.kind === 'granted-as-owner');
  check('1c admin self-action does NOT trigger admin_override audit',
    !('auditAction' in v) || (v as { auditAction?: string }).auditAction !== 'admin_override');
})();

(() => {
  // 1d. anonymous + permissive → granted-permissive-anonymous
  const v = buildAccessVerdict(input({
    mode: 'permissive',
    via: 'anonymous',
    actorUserId: null,
    actorEmail: null,
    actorRoleName: null,
    resourceOwnerId: 'someone-else',
  }));
  check('1d kind=granted-permissive-anonymous', v.kind === 'granted-permissive-anonymous');
  check('1d logLevel=warn', v.logLevel === 'warn');
  if (v.kind === 'granted-permissive-anonymous') {
    check('1d auditAction=anonymous_request', v.auditAction === 'anonymous_request');
    check('1d message says permissive mode', v.message.includes('permissive mode'));
    check('1d message warns about enforced mode', v.message.includes('enforced mode'));
  }
  check('1d isGranted=true', isGranted(v) === true);
})();

(() => {
  // 1e. anonymous + enforced → denied-anonymous (401)
  const v = buildAccessVerdict(input({
    mode: 'enforced',
    via: 'anonymous',
    actorUserId: null,
    actorEmail: null,
    actorRoleName: null,
  }));
  check('1e kind=denied-anonymous', v.kind === 'denied-anonymous');
  check('1e logLevel=warn', v.logLevel === 'warn');
  if (v.kind === 'denied-anonymous') {
    check('1e httpStatus=401', v.httpStatus === 401);
    check('1e errorCode=auth_required', v.errorCode === 'auth_required');
    check('1e auditAction=permission_denied', v.auditAction === 'permission_denied');
    check('1e message says anonymous request', v.message.includes('anonymous'));
    check('1e message says AUTH_MODE=enforced', v.message.includes('AUTH_MODE=enforced'));
  }
  check('1e isGranted=false', isGranted(v) === false);
})();

(() => {
  // 1f. authenticated non-owner non-admin → denied-not-owner (403)
  const v = buildAccessVerdict(input({
    actorUserId: 'u-bob',
    actorEmail: 'bob@example.com',
    actorRoleName: 'reviewer',
    resourceOwnerId: 'u-alice',
  }));
  check('1f kind=denied-not-owner', v.kind === 'denied-not-owner');
  check('1f logLevel=warn', v.logLevel === 'warn');
  if (v.kind === 'denied-not-owner') {
    check('1f httpStatus=403', v.httpStatus === 403);
    check('1f errorCode=not_owner', v.errorCode === 'not_owner');
    check('1f auditAction=permission_denied', v.auditAction === 'permission_denied');
    check('1f message names actor email', v.message.includes('bob@example.com'));
    check('1f message names true owner', v.message.includes('u-alice'));
    check('1f message says not an admin', v.message.includes('not an admin'));
  }
  check('1f isGranted=false', isGranted(v) === false);
})();

(() => {
  // 1g. admin acting on legacy unowned row → granted-legacy-unowned
  const v = buildAccessVerdict(input({
    actorUserId: 'admin-1',
    actorEmail: 'admin@example.com',
    actorRoleName: 'admin',
    resourceOwnerId: null,
  }));
  check('1g kind=granted-legacy-unowned', v.kind === 'granted-legacy-unowned');
  check('1g logLevel=warn', v.logLevel === 'warn');
  if (v.kind === 'granted-legacy-unowned') {
    check('1g auditAction=legacy_unowned_access', v.auditAction === 'legacy_unowned_access');
    check('1g message warns backfill missed', v.message.includes('backfill missed'));
    check('1g message includes runnable backfill SQL',
      v.message.includes('UPDATE projects SET owner_id'));
  }
  check('1g isGranted=true', isGranted(v) === true);
})();

(() => {
  // 1h. NON-admin on legacy unowned row → denied-not-owner (CRITICAL: not granted)
  const v = buildAccessVerdict(input({
    actorUserId: 'u-bob',
    actorEmail: 'bob@example.com',
    actorRoleName: 'reviewer',
    resourceOwnerId: null,
  }));
  check('1h non-admin on unowned → denied-not-owner', v.kind === 'denied-not-owner');
  if (v.kind === 'denied-not-owner') {
    check('1h httpStatus=403', v.httpStatus === 403);
    check('1h errorCode=not_owner', v.errorCode === 'not_owner');
    check('1h message says no owner_id', v.message.includes('no owner_id'));
    check('1h message says ask an admin', v.message.includes('Ask an admin'));
  }
  check('1h NOT granted (privilege escalation prevented)', isGranted(v) === false);
})();

// ═══════════════════════════════════════════════════════════════
// Section 2 — Console-capture for logAccessVerdict
// ═══════════════════════════════════════════════════════════════
console.log('\n=== Section 2: log helper ===\n');

(() => {
  // 2a. info → console.log with [Access] prefix
  const cap = captureConsole();
  try {
    logAccessVerdict({
      kind: 'granted-as-owner',
      logLevel: 'info',
      message: 'demo owner',
    });
    check('2a info → console.log fires once', cap.logs.length === 1);
    check('2a info → no console.warn', cap.warns.length === 0);
    check('2a info → no console.error', cap.errors.length === 0);
    check('2a info → has [Access] prefix', cap.logs[0].includes('[Access]'));
  } finally {
    cap.restore();
  }
})();

(() => {
  // 2b. warn (granted-permissive-anonymous) → console.warn
  const cap = captureConsole();
  try {
    logAccessVerdict({
      kind: 'granted-permissive-anonymous',
      logLevel: 'warn',
      auditAction: 'anonymous_request',
      message: 'anonymous in permissive',
    });
    check('2b warn (no errorCode) → console.warn fires once', cap.warns.length === 1);
    check('2b warn (no errorCode) → no [errorCode=] prefix',
      !cap.warns[0].includes('errorCode='));
    check('2b warn → has [Access] prefix', cap.warns[0].includes('[Access]'));
  } finally {
    cap.restore();
  }
})();

(() => {
  // 2c. denied-anonymous → console.warn with errorCode
  const cap = captureConsole();
  try {
    logAccessVerdict({
      kind: 'denied-anonymous',
      logLevel: 'warn',
      httpStatus: 401,
      errorCode: 'auth_required',
      auditAction: 'permission_denied',
      message: 'no auth',
    });
    check('2c denied-anonymous → console.warn fires', cap.warns.length === 1);
    check('2c denied-anonymous → has errorCode= prefix',
      cap.warns[0].includes('errorCode=auth_required'));
  } finally {
    cap.restore();
  }
})();

(() => {
  // 2d. denied-not-owner → console.warn with errorCode=not_owner
  const cap = captureConsole();
  try {
    logAccessVerdict({
      kind: 'denied-not-owner',
      logLevel: 'warn',
      httpStatus: 403,
      errorCode: 'not_owner',
      auditAction: 'permission_denied',
      message: 'not yours',
    });
    check('2d denied-not-owner → has errorCode=not_owner',
      cap.warns[0].includes('errorCode=not_owner'));
  } finally {
    cap.restore();
  }
})();

(() => {
  // 2e. granted-as-admin → info log (no errorCode prefix)
  const cap = captureConsole();
  try {
    logAccessVerdict({
      kind: 'granted-as-admin',
      logLevel: 'info',
      auditAction: 'admin_override',
      message: 'admin reach',
    });
    check('2e admin override → info log', cap.logs.length === 1);
    check('2e admin override → no errorCode', !cap.logs[0].includes('errorCode='));
  } finally {
    cap.restore();
  }
})();

(() => {
  // 2f. granted-legacy-unowned → console.warn (NOT info; surfaces backfill miss)
  const cap = captureConsole();
  try {
    logAccessVerdict({
      kind: 'granted-legacy-unowned',
      logLevel: 'warn',
      auditAction: 'legacy_unowned_access',
      message: 'admin on unowned',
    });
    check('2f legacy-unowned → warn (not log)', cap.warns.length === 1 && cap.logs.length === 0);
  } finally {
    cap.restore();
  }
})();

// ═══════════════════════════════════════════════════════════════
// Section 3 — errorCode + httpStatus literal narrowing
// ═══════════════════════════════════════════════════════════════
console.log('\n=== Section 3: errorCode + literal narrowing ===\n');

(() => {
  // 3a. denied-anonymous has errorCode literal 'auth_required'
  const v: AccessVerdict = {
    kind: 'denied-anonymous',
    logLevel: 'warn',
    httpStatus: 401,
    errorCode: 'auth_required',
    auditAction: 'permission_denied',
    message: '',
  };
  if (v.kind === 'denied-anonymous') {
    // Literal narrowing: TS knows errorCode is 'auth_required'
    const code: 'auth_required' = v.errorCode;
    check('3a denied-anonymous errorCode literal preserved', code === 'auth_required');
    const status: 401 = v.httpStatus;
    check('3a denied-anonymous httpStatus literal=401', status === 401);
  }
})();

(() => {
  // 3b. denied-not-owner has errorCode literal 'not_owner'
  const v: AccessVerdict = {
    kind: 'denied-not-owner',
    logLevel: 'warn',
    httpStatus: 403,
    errorCode: 'not_owner',
    auditAction: 'permission_denied',
    message: '',
  };
  if (v.kind === 'denied-not-owner') {
    const code: 'not_owner' = v.errorCode;
    check('3b denied-not-owner errorCode literal preserved', code === 'not_owner');
    const status: 403 = v.httpStatus;
    check('3b denied-not-owner httpStatus literal=403', status === 403);
  }
})();

(() => {
  // 3c. errorCodes are runtime-distinct
  const v1 = buildAccessVerdict(input({ via: 'anonymous', actorUserId: null, actorEmail: null, actorRoleName: null, mode: 'enforced' }));
  const v2 = buildAccessVerdict(input({ actorUserId: 'u-bob', actorEmail: 'bob@x.com', actorRoleName: 'reviewer', resourceOwnerId: 'u-alice' }));
  const e1 = (v1 as { errorCode?: string }).errorCode;
  const e2 = (v2 as { errorCode?: string }).errorCode;
  check('3c auth_required !== not_owner at runtime', e1 !== e2);
  check('3c distinct errorCodes both present', e1 === 'auth_required' && e2 === 'not_owner');
})();

(() => {
  // 3d. grants do NOT carry errorCode field
  const owner = buildAccessVerdict(input({ actorUserId: 'u-1', resourceOwnerId: 'u-1' }));
  const adminOverride = buildAccessVerdict(input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: 'someone-else' }));
  const permissive = buildAccessVerdict(input({ mode: 'permissive', via: 'anonymous', actorUserId: null, actorEmail: null, actorRoleName: null }));
  const legacy = buildAccessVerdict(input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: null }));
  check('3d granted-as-owner has NO errorCode', !('errorCode' in owner));
  check('3d granted-as-admin has NO errorCode', !('errorCode' in adminOverride));
  check('3d granted-permissive-anonymous has NO errorCode', !('errorCode' in permissive));
  check('3d granted-legacy-unowned has NO errorCode', !('errorCode' in legacy));
})();

// ═══════════════════════════════════════════════════════════════
// Section 4 — Cross-mode regression
// ═══════════════════════════════════════════════════════════════
console.log('\n=== Section 4: cross-mode regression ===\n');

(() => {
  // 4a. same anonymous input in permissive vs enforced → different verdicts
  const baseInput = input({
    via: 'anonymous',
    actorUserId: null,
    actorEmail: null,
    actorRoleName: null,
    resourceOwnerId: 'someone',
  });
  const v_permissive = buildAccessVerdict({ ...baseInput, mode: 'permissive' });
  const v_enforced = buildAccessVerdict({ ...baseInput, mode: 'enforced' });
  check('4a permissive anonymous = grant', v_permissive.kind === 'granted-permissive-anonymous');
  check('4a enforced anonymous = deny', v_enforced.kind === 'denied-anonymous');
  check('4a permissive isGranted=true', isGranted(v_permissive) === true);
  check('4a enforced isGranted=false', isGranted(v_enforced) === false);
})();

(() => {
  // 4b. authenticated owner verdict is mode-INDEPENDENT
  const baseInput = input({ actorUserId: 'u-1', resourceOwnerId: 'u-1' });
  const v_permissive = buildAccessVerdict({ ...baseInput, mode: 'permissive' });
  const v_enforced = buildAccessVerdict({ ...baseInput, mode: 'enforced' });
  check('4b owner in permissive = granted-as-owner', v_permissive.kind === 'granted-as-owner');
  check('4b owner in enforced = granted-as-owner', v_enforced.kind === 'granted-as-owner');
})();

(() => {
  // 4c. authenticated non-owner verdict is mode-INDEPENDENT (denied either way)
  const baseInput = input({ actorUserId: 'u-bob', actorRoleName: 'reviewer', resourceOwnerId: 'u-alice' });
  const v_permissive = buildAccessVerdict({ ...baseInput, mode: 'permissive' });
  const v_enforced = buildAccessVerdict({ ...baseInput, mode: 'enforced' });
  check('4c non-owner in permissive = denied-not-owner (not granted by mode)',
    v_permissive.kind === 'denied-not-owner');
  check('4c non-owner in enforced = denied-not-owner', v_enforced.kind === 'denied-not-owner');
})();

(() => {
  // 4d. authenticated admin override is mode-INDEPENDENT
  const baseInput = input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: 'u-alice' });
  const v_permissive = buildAccessVerdict({ ...baseInput, mode: 'permissive' });
  const v_enforced = buildAccessVerdict({ ...baseInput, mode: 'enforced' });
  check('4d admin in permissive = granted-as-admin', v_permissive.kind === 'granted-as-admin');
  check('4d admin in enforced = granted-as-admin', v_enforced.kind === 'granted-as-admin');
})();

// ═══════════════════════════════════════════════════════════════
// Section 5 — RBAC Phase 1 regressions
// ═══════════════════════════════════════════════════════════════
console.log('\n=== Section 5: RBAC Phase 1 regressions ===\n');

(() => {
  // R-1: legacy unowned rows are NOT a privilege escalation surface.
  // For every non-admin actor (any role except 'admin'), unowned row → denied.
  const roles = ['reviewer', 'viewer', 'developer', null];
  let allDenied = true;
  for (const role of roles) {
    const v = buildAccessVerdict(input({
      actorUserId: 'u-x',
      actorRoleName: role,
      resourceOwnerId: null,
    }));
    if (v.kind !== 'denied-not-owner') allDenied = false;
  }
  check('R-1 every non-admin role denied on unowned row', allDenied);
})();

(() => {
  // R-2: every grant kind passes isGranted=true
  const grants: AccessVerdict[] = [
    buildAccessVerdict(input({ actorUserId: 'u-1', resourceOwnerId: 'u-1' })),
    buildAccessVerdict(input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: 'someone' })),
    buildAccessVerdict(input({ mode: 'permissive', via: 'anonymous', actorUserId: null, actorEmail: null, actorRoleName: null })),
    buildAccessVerdict(input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: null })),
  ];
  let allGranted = true;
  for (const v of grants) if (!isGranted(v)) allGranted = false;
  check('R-2 every grant kind isGranted=true', allGranted);
})();

(() => {
  // R-3: every deny kind passes isGranted=false
  const denies: AccessVerdict[] = [
    buildAccessVerdict(input({ via: 'anonymous', actorUserId: null, actorEmail: null, actorRoleName: null, mode: 'enforced' })),
    buildAccessVerdict(input({ actorUserId: 'u-bob', actorRoleName: 'reviewer', resourceOwnerId: 'u-alice' })),
    buildAccessVerdict(input({ actorUserId: 'u-bob', actorRoleName: 'viewer', resourceOwnerId: null })),
  ];
  let allDenied = true;
  for (const v of denies) if (isGranted(v)) allDenied = false;
  check('R-3 every deny kind isGranted=false', allDenied);
})();

(() => {
  // R-4: actor email is propagated into ALL grant + deny messages
  const cases: AccessVerdict[] = [
    buildAccessVerdict(input({ actorUserId: 'u-1', actorEmail: 'alice@x.com', resourceOwnerId: 'u-1' })),
    buildAccessVerdict(input({ actorUserId: 'admin', actorEmail: 'admin@x.com', actorRoleName: 'admin', resourceOwnerId: 'someone' })),
    buildAccessVerdict(input({ actorUserId: 'admin', actorEmail: 'admin@x.com', actorRoleName: 'admin', resourceOwnerId: null })),
    buildAccessVerdict(input({ actorUserId: 'u-bob', actorEmail: 'bob@x.com', actorRoleName: 'reviewer', resourceOwnerId: 'u-alice' })),
  ];
  let allHaveEmail = true;
  for (const v of cases) {
    if (!v.message.includes('@x.com')) allHaveEmail = false;
  }
  check('R-4 actor email propagated into messages', allHaveEmail);
})();

(() => {
  // R-5: anonymous deny does NOT carry actor email (none to propagate)
  const v = buildAccessVerdict(input({
    via: 'anonymous',
    actorUserId: null,
    actorEmail: null,
    actorRoleName: null,
    mode: 'enforced',
  }));
  check('R-5 anonymous deny: message has no leaked email', !v.message.includes('@'));
})();

(() => {
  // R-6: resourceId is in every message (audit trail)
  const cases: AccessVerdict[] = [
    buildAccessVerdict(input({ actorUserId: 'u-1', resourceOwnerId: 'u-1', resourceId: 'PROJ-AAA' })),
    buildAccessVerdict(input({ actorUserId: 'u-bob', actorRoleName: 'reviewer', resourceOwnerId: 'u-alice', resourceId: 'PROJ-AAA' })),
    buildAccessVerdict(input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: null, resourceId: 'PROJ-AAA' })),
    buildAccessVerdict(input({ via: 'anonymous', actorUserId: null, actorEmail: null, actorRoleName: null, mode: 'enforced', resourceId: 'PROJ-AAA' })),
  ];
  let allHaveResourceId = true;
  for (const v of cases) if (!v.message.includes('PROJ-AAA')) allHaveResourceId = false;
  check('R-6 resourceId propagated into all messages', allHaveResourceId);
})();

(() => {
  // R-7: action verb is in every message
  const cases: AccessVerdict[] = [
    buildAccessVerdict(input({ actorUserId: 'u-1', resourceOwnerId: 'u-1', action: 'publish' })),
    buildAccessVerdict(input({ actorUserId: 'admin', actorRoleName: 'admin', resourceOwnerId: 'someone', action: 'publish' })),
    buildAccessVerdict(input({ actorUserId: 'u-bob', actorRoleName: 'reviewer', resourceOwnerId: 'u-alice', action: 'publish' })),
  ];
  let allHaveAction = true;
  for (const v of cases) if (!v.message.includes('publish')) allHaveAction = false;
  check('R-7 action verb propagated into all messages', allHaveAction);
})();

(() => {
  // R-8: idempotency — same input → same kind/message/level
  const inp = input({ actorUserId: 'u-1', resourceOwnerId: 'u-1' });
  const v1 = buildAccessVerdict(inp);
  const v2 = buildAccessVerdict(inp);
  check('R-8 idempotent kind', v1.kind === v2.kind);
  check('R-8 idempotent logLevel', v1.logLevel === v2.logLevel);
  check('R-8 idempotent message', v1.message === v2.message);
})();

(() => {
  // R-9: errorCodes are distinct from prior verdict modules' codes
  const v1 = buildAccessVerdict(input({ via: 'anonymous', actorUserId: null, actorEmail: null, actorRoleName: null }));
  const v2 = buildAccessVerdict(input({ actorUserId: 'u-bob', actorRoleName: 'viewer', resourceOwnerId: 'u-alice' }));
  const code1 = (v1 as { errorCode?: string }).errorCode;
  const code2 = (v2 as { errorCode?: string }).errorCode;
  check('R-9 auth_required !== iam_policy_drift', code1 !== 'iam_policy_drift');
  check('R-9 not_owner !== url_env_redeploy_drift', code2 !== 'url_env_redeploy_drift');
  check('R-9 not_owner !== db_dump_restore_drift', code2 !== 'db_dump_restore_drift');
})();

(() => {
  // R-10: admin override audit_action is 'admin_override' (NOT 'permission_denied')
  // Critical for compliance audit log: cross-user admin reach must be loggable.
  const v = buildAccessVerdict(input({
    actorUserId: 'admin',
    actorRoleName: 'admin',
    resourceOwnerId: 'someone-else',
  }));
  if (v.kind === 'granted-as-admin') {
    check('R-10 admin override auditAction = admin_override', v.auditAction === 'admin_override');
  } else {
    check('R-10 admin override path produces granted-as-admin', false);
  }
})();

(() => {
  // R-11: legacy unowned row backfill SQL is runnable shape
  const v = buildAccessVerdict(input({
    actorUserId: 'admin',
    actorRoleName: 'admin',
    resourceOwnerId: null,
    resourceId: 'PROJ-XYZ',
  }));
  if (v.kind === 'granted-legacy-unowned') {
    check('R-11 backfill SQL has UPDATE projects',
      v.message.includes('UPDATE projects'));
    check('R-11 backfill SQL has SET owner_id',
      v.message.includes('SET owner_id'));
    check('R-11 backfill SQL has WHERE id with this resource',
      v.message.includes("WHERE id = 'PROJ-XYZ'"));
    check('R-11 backfill SQL has placeholder <user-id>',
      v.message.includes('<user-id>'));
  }
})();

(() => {
  // R-12: deny verdicts carry httpStatus that maps directly to Fastify reply
  const denyAnon = buildAccessVerdict(input({
    via: 'anonymous',
    actorUserId: null,
    actorEmail: null,
    actorRoleName: null,
    mode: 'enforced',
  }));
  const denyOwner = buildAccessVerdict(input({
    actorUserId: 'u-bob',
    actorRoleName: 'viewer',
    resourceOwnerId: 'u-alice',
  }));
  if (denyAnon.kind === 'denied-anonymous' && denyOwner.kind === 'denied-not-owner') {
    check('R-12 deny-anonymous httpStatus=401', denyAnon.httpStatus === 401);
    check('R-12 deny-not-owner httpStatus=403', denyOwner.httpStatus === 403);
    check('R-12 deny-anonymous and deny-not-owner have DIFFERENT httpStatus',
      (denyAnon.httpStatus as number) !== (denyOwner.httpStatus as number));
  }
})();

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log('\n--- Summary ---');
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
if (fail > 0) process.exit(1);
