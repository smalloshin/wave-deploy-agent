/**
 * Tests for monorepo-link-verdict.ts (round 19).
 *
 * Run: npx tsx src/test-monorepo-link-verdict.ts
 *
 * Sections:
 *   1. All 6 verdict kinds × outcome matrix
 *   2. logMonorepoLinkVerdict via console-capture
 *   3. errorCode contract + literal-true narrowing + message invariants
 *   4. Round-19 specific bug regressions
 */

import {
  buildMonorepoLinkVerdict,
  logMonorepoLinkVerdict,
  type MonorepoLinkVerdict,
  type BuildMonorepoLinkVerdictInput,
  type SiblingUpdateOutcome,
} from './services/monorepo-link-verdict.js';

// ─── Test harness ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(label: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label} (expected true)`);
  }
}

function assertContains(label: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}\n  string did not contain: "${needle}"\n  actual: "${haystack}"`);
  }
}

// ─── Console capture helper ──────────────────────────────────────────────
interface CapturedLog {
  level: 'log' | 'warn' | 'error';
  message: string;
}

function captureConsole(fn: () => void): CapturedLog[] {
  const logs: CapturedLog[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push({ level: 'log', message: args.map(String).join(' ') });
  };
  console.warn = (...args: unknown[]) => {
    logs.push({ level: 'warn', message: args.map(String).join(' ') });
  };
  console.error = (...args: unknown[]) => {
    logs.push({ level: 'error', message: args.map(String).join(' ') });
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return logs;
}

// ─── Helpers to build inputs ──────────────────────────────────────────────
const baseApplicableInput = (
  overrides: Partial<BuildMonorepoLinkVerdictInput> = {}
): BuildMonorepoLinkVerdictInput => ({
  applicable: true,
  backendName: 'api-server',
  backendUrl: 'https://api-abc123.run.app',
  backendConfigWrite: { ok: true, error: null },
  siblingDiscovery: { ok: true, error: null, totalSiblings: 0, liveSiblings: 0 },
  siblingUpdates: [],
  ...overrides,
});

const sibling = (
  id: string,
  name: string,
  ok: boolean,
  error: string | null = null
): SiblingUpdateOutcome => ({ siblingId: id, siblingName: name, ok, error });

// ─── Section 1: 6 verdict kinds × outcome matrix ─────────────────────────
console.log('--- Section 1: verdict kinds × outcome matrix ---');

// 1.1 not-applicable: applicable=false short-circuits regardless of other inputs
{
  const v = buildMonorepoLinkVerdict({
    applicable: false,
    backendName: 'whatever',
    backendUrl: 'whatever',
    backendConfigWrite: null,
    siblingDiscovery: null,
    siblingUpdates: [],
  });
  assertEq('1.1a not-applicable kind', v.kind, 'not-applicable');
  assertEq('1.1b not-applicable logLevel', v.logLevel, 'info');
  assertContains('1.1c not-applicable message', v.message, 'not applicable');
}

// 1.2 not-applicable wins even when other fields look valid
{
  const v = buildMonorepoLinkVerdict({
    applicable: false,
    backendName: 'api',
    backendUrl: 'https://x',
    backendConfigWrite: { ok: true, error: null },
    siblingDiscovery: { ok: true, error: null, totalSiblings: 5, liveSiblings: 5 },
    siblingUpdates: [sibling('s1', 'frontend-1', true)],
  });
  assertEq('1.2 applicable=false short-circuits even with valid downstream', v.kind, 'not-applicable');
}

// 1.3 success: backend OK + discovery OK + 1 live sibling all OK
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
      siblingUpdates: [sibling('s1', 'web-frontend', true)],
    })
  );
  assertEq('1.3a success kind', v.kind, 'success');
  assertEq('1.3b success logLevel', v.logLevel, 'info');
  if (v.kind === 'success') {
    assertEq('1.3c success backendName', v.backendName, 'api-server');
    assertEq('1.3d success backendUrl', v.backendUrl, 'https://api-abc123.run.app');
    assertEq('1.3e success siblingsUpdated', v.siblingsUpdated, 1);
  }
}

// 1.4 success with multiple siblings
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 3, liveSiblings: 3 },
      siblingUpdates: [
        sibling('s1', 'web-1', true),
        sibling('s2', 'web-2', true),
        sibling('s3', 'web-3', true),
      ],
    })
  );
  assertEq('1.4a success multi kind', v.kind, 'success');
  if (v.kind === 'success') {
    assertEq('1.4b success siblingsUpdated count', v.siblingsUpdated, 3);
    assertContains('1.4c success message has count', v.message, '3 frontend sibling');
  }
}

// 1.5 success-no-live-siblings: discovery found 0 live
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 2, liveSiblings: 0 },
      siblingUpdates: [],
    })
  );
  assertEq('1.5a no-live kind', v.kind, 'success-no-live-siblings');
  assertEq('1.5b no-live logLevel', v.logLevel, 'info');
  if (v.kind === 'success-no-live-siblings') {
    assertContains('1.5c no-live message', v.message, 'No live frontend siblings');
  }
}

// 1.6 success-no-live-siblings: total siblings=0 (no monorepo siblings at all)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 0, liveSiblings: 0 },
    })
  );
  assertEq('1.6 no-live with totalSiblings=0 kind', v.kind, 'success-no-live-siblings');
}

// 1.7 backend-config-failed: backend write threw
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      backendConfigWrite: { ok: false, error: 'DB connection refused' },
      siblingDiscovery: null,
      siblingUpdates: [],
    })
  );
  assertEq('1.7a backend-fail kind', v.kind, 'backend-config-failed');
  assertEq('1.7b backend-fail logLevel', v.logLevel, 'critical');
  if (v.kind === 'backend-config-failed') {
    assertEq('1.7c backend-fail errorCode', v.errorCode, 'monorepo_backend_url_not_stored');
    assertEq('1.7d backend-fail requiresOperatorAction', v.requiresOperatorAction, true);
    assertEq('1.7e backend-fail backendConfigError', v.backendConfigError, 'DB connection refused');
    assertContains('1.7f backend-fail message has error', v.message, 'DB connection refused');
  }
}

// 1.8 backend-config-failed: backend write null (defensive — orchestrator
//     contract says null only when applicable=false, but verdict should still
//     fail safe)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      backendConfigWrite: null,
      siblingDiscovery: null,
      siblingUpdates: [],
    })
  );
  assertEq('1.8a backend-fail with null write kind', v.kind, 'backend-config-failed');
  if (v.kind === 'backend-config-failed') {
    assertContains('1.8b backend-fail null write fallback', v.backendConfigError, 'not attempted');
  }
}

// 1.9 backend-config-failed: backend write ok=false with null error string
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      backendConfigWrite: { ok: false, error: null },
      siblingDiscovery: null,
      siblingUpdates: [],
    })
  );
  if (v.kind === 'backend-config-failed') {
    assertContains('1.9 backend-fail null error string fallback', v.backendConfigError, 'not attempted');
  } else {
    failed++;
    failures.push('1.9 expected backend-config-failed');
  }
}

// 1.10 sibling-discovery-failed: backend OK but listProjects threw
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: false, error: 'listProjects timeout', totalSiblings: 0, liveSiblings: 0 },
      siblingUpdates: [],
    })
  );
  assertEq('1.10a discovery-fail kind', v.kind, 'sibling-discovery-failed');
  assertEq('1.10b discovery-fail logLevel', v.logLevel, 'warn');
  if (v.kind === 'sibling-discovery-failed') {
    assertEq('1.10c discovery-fail errorCode', v.errorCode, 'monorepo_sibling_discovery_failed');
    assertEq('1.10d discovery-fail discoveryError', v.discoveryError, 'listProjects timeout');
    assertContains('1.10e discovery-fail message', v.message, 'listProjects timeout');
    assertContains('1.10f discovery-fail mentions cold lookup', v.message, 'next own-deploy');
  }
}

// 1.11 sibling-discovery-failed: discovery null with backend OK (defensive)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: null,
      siblingUpdates: [],
    })
  );
  assertEq('1.11a discovery-fail null kind', v.kind, 'sibling-discovery-failed');
  if (v.kind === 'sibling-discovery-failed') {
    assertContains('1.11b discovery-fail null fallback', v.discoveryError, 'not attempted');
  }
}

// 1.12 sibling-discovery-failed with null error string
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: false, error: null, totalSiblings: 0, liveSiblings: 0 },
    })
  );
  if (v.kind === 'sibling-discovery-failed') {
    assertContains('1.12 discovery-fail null error fallback', v.discoveryError, 'not attempted');
  }
}

// 1.13 partial-sibling-update-failures: 2 OK + 1 failed
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 3, liveSiblings: 3 },
      siblingUpdates: [
        sibling('s1', 'web-1', true),
        sibling('s2', 'web-2', false, 'patch-failed: HTTP 403'),
        sibling('s3', 'web-3', true),
      ],
    })
  );
  assertEq('1.13a partial kind', v.kind, 'partial-sibling-update-failures');
  assertEq('1.13b partial logLevel', v.logLevel, 'warn');
  if (v.kind === 'partial-sibling-update-failures') {
    assertEq('1.13c partial errorCode', v.errorCode, 'monorepo_sibling_url_drift');
    assertEq('1.13d partial requiresOperatorAction', v.requiresOperatorAction, false);
    assertEq('1.13e partial successful count', v.successfulSiblings.length, 2);
    assertEq('1.13f partial failed count', v.failedSiblings.length, 1);
    assertEq('1.13g partial failed sibling id', v.failedSiblings[0]!.id, 's2');
    assertEq('1.13h partial failed sibling name', v.failedSiblings[0]!.name, 'web-2');
    assertContains('1.13i partial failed sibling error', v.failedSiblings[0]!.error, 'HTTP 403');
    assertContains('1.13j partial message includes failed name', v.message, 'web-2');
  }
}

// 1.14 partial: all 3 failed (no successful)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 3, liveSiblings: 3 },
      siblingUpdates: [
        sibling('s1', 'web-1', false, 'svc-fetch-failed: HTTP 500'),
        sibling('s2', 'web-2', false, 'patch-failed: HTTP 403'),
        sibling('s3', 'web-3', false, 'throw: ECONNREFUSED'),
      ],
    })
  );
  assertEq('1.14a all-fail kind', v.kind, 'partial-sibling-update-failures');
  if (v.kind === 'partial-sibling-update-failures') {
    assertEq('1.14b all-fail successful count', v.successfulSiblings.length, 0);
    assertEq('1.14c all-fail failed count', v.failedSiblings.length, 3);
    assertContains('1.14d all-fail message has svc-fetch', v.message, 'svc-fetch-failed');
    assertContains('1.14e all-fail message has patch-failed', v.message, 'patch-failed');
    assertContains('1.14f all-fail message has throw', v.message, 'throw');
  }
}

// 1.15 partial: per-sibling null error fallback
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
      siblingUpdates: [sibling('s1', 'web-1', false, null)],
    })
  );
  if (v.kind === 'partial-sibling-update-failures') {
    assertContains('1.15 partial null error fallback', v.failedSiblings[0]!.error, 'unknown');
  }
}

// ─── Section 2: logMonorepoLinkVerdict via console-capture ─────────────
console.log('--- Section 2: logMonorepoLinkVerdict via console-capture ---');

// 2.1 not-applicable → log
{
  const v = buildMonorepoLinkVerdict({
    applicable: false,
    backendName: '',
    backendUrl: '',
    backendConfigWrite: null,
    siblingDiscovery: null,
    siblingUpdates: [],
  });
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('2.1a not-applicable single log', logs.length, 1);
  assertEq('2.1b not-applicable level', logs[0]!.level, 'log');
  assertContains('2.1c not-applicable prefix', logs[0]!.message, '[Deploy]');
}

// 2.2 success → log
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 2, liveSiblings: 2 },
      siblingUpdates: [sibling('s1', 'a', true), sibling('s2', 'b', true)],
    })
  );
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('2.2a success single log', logs.length, 1);
  assertEq('2.2b success level', logs[0]!.level, 'log');
}

// 2.3 success-no-live-siblings → log
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 0, liveSiblings: 0 },
    })
  );
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('2.3a no-live single log', logs.length, 1);
  assertEq('2.3b no-live level', logs[0]!.level, 'log');
}

// 2.4 backend-config-failed → error with [CRITICAL] + errorCode
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      backendConfigWrite: { ok: false, error: 'DB down' },
      siblingDiscovery: null,
    })
  );
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('2.4a backend-fail single log', logs.length, 1);
  assertEq('2.4b backend-fail level=error', logs[0]!.level, 'error');
  assertContains('2.4c backend-fail [CRITICAL]', logs[0]!.message, '[CRITICAL');
  assertContains('2.4d backend-fail errorCode in log', logs[0]!.message, 'monorepo_backend_url_not_stored');
  assertContains('2.4e backend-fail [Deploy] prefix', logs[0]!.message, '[Deploy]');
}

// 2.5 sibling-discovery-failed → warn with [WARN errorCode=...]
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: false, error: 'list timeout', totalSiblings: 0, liveSiblings: 0 },
    })
  );
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('2.5a discovery-fail single log', logs.length, 1);
  assertEq('2.5b discovery-fail level=warn', logs[0]!.level, 'warn');
  assertContains('2.5c discovery-fail [WARN', logs[0]!.message, '[WARN');
  assertContains('2.5d discovery-fail errorCode', logs[0]!.message, 'monorepo_sibling_discovery_failed');
}

// 2.6 partial-sibling-update-failures → warn with errorCode
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 2, liveSiblings: 2 },
      siblingUpdates: [sibling('s1', 'a', true), sibling('s2', 'b', false, 'patch-failed: 500')],
    })
  );
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('2.6a partial single log', logs.length, 1);
  assertEq('2.6b partial level=warn', logs[0]!.level, 'warn');
  assertContains('2.6c partial errorCode', logs[0]!.message, 'monorepo_sibling_url_drift');
}

// 2.7 logger never throws on any kind
{
  const kinds: MonorepoLinkVerdict[] = [
    buildMonorepoLinkVerdict({
      applicable: false,
      backendName: '',
      backendUrl: '',
      backendConfigWrite: null,
      siblingDiscovery: null,
      siblingUpdates: [],
    }),
    buildMonorepoLinkVerdict(
      baseApplicableInput({
        siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
        siblingUpdates: [sibling('s1', 'a', true)],
      })
    ),
    buildMonorepoLinkVerdict(baseApplicableInput()),
    buildMonorepoLinkVerdict(
      baseApplicableInput({ backendConfigWrite: { ok: false, error: 'x' }, siblingDiscovery: null })
    ),
    buildMonorepoLinkVerdict(
      baseApplicableInput({
        siblingDiscovery: { ok: false, error: 'x', totalSiblings: 0, liveSiblings: 0 },
      })
    ),
    buildMonorepoLinkVerdict(
      baseApplicableInput({
        siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
        siblingUpdates: [sibling('s1', 'a', false, 'x')],
      })
    ),
  ];
  for (let i = 0; i < kinds.length; i++) {
    let threw = false;
    captureConsole(() => {
      try {
        logMonorepoLinkVerdict(kinds[i]!);
      } catch {
        threw = true;
      }
    });
    assertTrue(`2.7.${i} log helper does not throw on kind=${kinds[i]!.kind}`, !threw);
  }
}

// 2.8 backend name + URL appears in critical message
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      backendName: 'special-backend',
      backendUrl: 'https://special-xyz.run.app',
      backendConfigWrite: { ok: false, error: 'oops' },
      siblingDiscovery: null,
    })
  );
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertContains('2.8a backendName in log', logs[0]!.message, 'special-backend');
  assertContains('2.8b backendUrl in log', logs[0]!.message, 'https://special-xyz.run.app');
}

// ─── Section 3: errorCode contract + literal narrowing + invariants ─────
console.log('--- Section 3: errorCode contract + invariants ---');

// 3.1 The 3 errorCode strings are stable (dashboard contract)
{
  const backendFail = buildMonorepoLinkVerdict(
    baseApplicableInput({ backendConfigWrite: { ok: false, error: 'x' }, siblingDiscovery: null })
  );
  if (backendFail.kind === 'backend-config-failed') {
    assertEq('3.1a errorCode pin: backend', backendFail.errorCode, 'monorepo_backend_url_not_stored');
  }
  const discoveryFail = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: false, error: 'x', totalSiblings: 0, liveSiblings: 0 },
    })
  );
  if (discoveryFail.kind === 'sibling-discovery-failed') {
    assertEq('3.1b errorCode pin: discovery', discoveryFail.errorCode, 'monorepo_sibling_discovery_failed');
  }
  const partial = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
      siblingUpdates: [sibling('s1', 'a', false, 'x')],
    })
  );
  if (partial.kind === 'partial-sibling-update-failures') {
    assertEq('3.1c errorCode pin: partial', partial.errorCode, 'monorepo_sibling_url_drift');
  }
}

// 3.2 requiresOperatorAction is literal-true on backend-config-failed
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({ backendConfigWrite: { ok: false, error: 'x' }, siblingDiscovery: null })
  );
  if (v.kind === 'backend-config-failed') {
    // TypeScript would fail compile if we tried to assign anything other than true here
    const t: true = v.requiresOperatorAction;
    assertEq('3.2 requiresOperatorAction literal true on backend-fail', t, true);
  }
}

// 3.3 requiresOperatorAction is literal-false on partial
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
      siblingUpdates: [sibling('s1', 'a', false, 'x')],
    })
  );
  if (v.kind === 'partial-sibling-update-failures') {
    const f: false = v.requiresOperatorAction;
    assertEq('3.3 requiresOperatorAction literal false on partial', f, false);
  }
}

// 3.4 sibling-discovery-failed has no requiresOperatorAction (warn but no manual action needed)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: false, error: 'x', totalSiblings: 0, liveSiblings: 0 },
    })
  );
  // Type contract: discovery-fail kind has no requiresOperatorAction field
  if (v.kind === 'sibling-discovery-failed') {
    // @ts-expect-error -- field intentionally absent
    const _maybeUndefined = v.requiresOperatorAction;
    void _maybeUndefined;
    assertTrue('3.4 sibling-discovery-failed kind exists', true);
  }
}

// 3.5 backendName/backendUrl flow into all applicable verdicts
{
  const cases: Array<[string, BuildMonorepoLinkVerdictInput]> = [
    [
      'success',
      baseApplicableInput({
        siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
        siblingUpdates: [sibling('s1', 'a', true)],
      }),
    ],
    ['no-live', baseApplicableInput()],
    [
      'backend-fail',
      baseApplicableInput({ backendConfigWrite: { ok: false, error: 'x' }, siblingDiscovery: null }),
    ],
    [
      'discovery-fail',
      baseApplicableInput({
        siblingDiscovery: { ok: false, error: 'x', totalSiblings: 0, liveSiblings: 0 },
      }),
    ],
    [
      'partial',
      baseApplicableInput({
        siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
        siblingUpdates: [sibling('s1', 'a', false, 'x')],
      }),
    ],
  ];
  for (const [label, input] of cases) {
    const v = buildMonorepoLinkVerdict({
      ...input,
      backendName: 'unique-name-' + label,
      backendUrl: 'https://unique-url-' + label + '.run.app',
    });
    assertContains(`3.5.${label} backendName in message`, v.message, 'unique-name-' + label);
    assertContains(`3.5.${label} backendUrl in message`, v.message, 'unique-url-' + label);
  }
}

// 3.6 partial verdict surfaces both successful AND failed sibling lists
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 4, liveSiblings: 4 },
      siblingUpdates: [
        sibling('id-A', 'name-A', true),
        sibling('id-B', 'name-B', false, 'svc-fetch-failed: 500'),
        sibling('id-C', 'name-C', true),
        sibling('id-D', 'name-D', false, 'patch-failed: 403'),
      ],
    })
  );
  if (v.kind === 'partial-sibling-update-failures') {
    assertEq('3.6a successful list size', v.successfulSiblings.length, 2);
    assertEq('3.6b failed list size', v.failedSiblings.length, 2);
    const okIds = v.successfulSiblings.map(s => s.id).sort();
    const failedIds = v.failedSiblings.map(s => s.id).sort();
    assertEq('3.6c successful ids', okIds, ['id-A', 'id-C']);
    assertEq('3.6d failed ids', failedIds, ['id-B', 'id-D']);
  }
}

// 3.7 not-applicable kind has no errorCode field
{
  const v = buildMonorepoLinkVerdict({
    applicable: false,
    backendName: '',
    backendUrl: '',
    backendConfigWrite: null,
    siblingDiscovery: null,
    siblingUpdates: [],
  });
  if (v.kind === 'not-applicable') {
    // @ts-expect-error -- field intentionally absent
    const _none = v.errorCode;
    void _none;
    assertTrue('3.7 not-applicable has no errorCode field', true);
  }
}

// ─── Section 4: round-19 specific bug regressions ────────────────────────
console.log('--- Section 4: round-19 specific regressions ---');

// 4.1 REGRESSION: backend config write failure MUST be CRITICAL
//     (legacy code: console.warn; round 19: critical because future siblings
//     won't find the URL on cold lookup)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      backendConfigWrite: { ok: false, error: 'whatever' },
      siblingDiscovery: null,
    })
  );
  assertEq('4.1a backend-fail logLevel must be critical (was warn in legacy)', v.logLevel, 'critical');
  if (v.kind === 'backend-config-failed') {
    assertEq('4.1b backend-fail requiresOperatorAction must be true', v.requiresOperatorAction, true);
  }
}

// 4.2 REGRESSION: sibling-discovery-failed MUST be WARN, not critical
//     (cold-lookup path still works; existing siblings keep serving with
//     their previous env vars; not user-visible until future deploys)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: false, error: 'x', totalSiblings: 0, liveSiblings: 0 },
    })
  );
  assertEq('4.2a discovery-fail logLevel must be warn (NOT critical)', v.logLevel, 'warn');
  // Sanity: not classified as backend-config-failed accidentally
  assertEq('4.2b discovery-fail kind correct', v.kind, 'sibling-discovery-failed');
}

// 4.3 REGRESSION: partial-sibling-update-failures MUST be WARN
//     (failed siblings still serve with previous env vars; new URL propagates
//     on next deploy; not blocking)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
      siblingUpdates: [sibling('s1', 'web-1', false, 'patch-failed: 403')],
    })
  );
  assertEq('4.3 partial logLevel must be warn', v.logLevel, 'warn');
}

// 4.4 REGRESSION: per-sibling sub-failure-mode discriminators are preserved
//     verbatim through to the verdict (operator needs to know which step
//     failed: svc-fetch vs patch vs throw)
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 3, liveSiblings: 3 },
      siblingUpdates: [
        sibling('s1', 'web-1', false, 'svc-fetch-failed: HTTP 500 Internal Server Error'),
        sibling('s2', 'web-2', false, 'patch-failed: HTTP 403 Forbidden'),
        sibling('s3', 'web-3', false, 'throw: ECONNREFUSED 127.0.0.1:443'),
      ],
    })
  );
  if (v.kind === 'partial-sibling-update-failures') {
    const errors = v.failedSiblings.map(f => f.error);
    assertTrue('4.4a svc-fetch-failed preserved', errors.some(e => e.includes('svc-fetch-failed')));
    assertTrue('4.4b patch-failed preserved', errors.some(e => e.includes('patch-failed')));
    assertTrue('4.4c throw preserved', errors.some(e => e.includes('throw')));
    // Specific error details preserved
    assertTrue('4.4d HTTP 500 preserved', errors.some(e => e.includes('HTTP 500')));
    assertTrue('4.4e HTTP 403 preserved', errors.some(e => e.includes('HTTP 403')));
    assertTrue('4.4f ECONNREFUSED preserved', errors.some(e => e.includes('ECONNREFUSED')));
  }
}

// 4.5 REGRESSION: legacy svcRes-not-ok case (which had NO log at all) MUST
//     now produce a verdict with the failure surfaced via partial kind
{
  const v = buildMonorepoLinkVerdict(
    baseApplicableInput({
      siblingDiscovery: { ok: true, error: null, totalSiblings: 1, liveSiblings: 1 },
      siblingUpdates: [sibling('s1', 'web-1', false, 'svc-fetch-failed: HTTP 500')],
    })
  );
  assertEq('4.5a svc-fetch-failed must produce partial verdict', v.kind, 'partial-sibling-update-failures');
  if (v.kind === 'partial-sibling-update-failures') {
    assertEq('4.5b failed sibling count = 1', v.failedSiblings.length, 1);
  }
  // And the log helper actually emits something (legacy: zero output)
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('4.5c svc-fetch-failed MUST produce a log line (legacy: 0)', logs.length, 1);
  assertEq('4.5d log level is warn', logs[0]!.level, 'warn');
}

// 4.6 REGRESSION: a successful no-live-siblings path is INFO, not WARN
//     (operator deploys backend with no frontends yet — totally normal,
//     not noise)
{
  const v = buildMonorepoLinkVerdict(baseApplicableInput());
  assertEq('4.6a no-live MUST be info (not warn — normal flow)', v.logLevel, 'info');
  const logs = captureConsole(() => logMonorepoLinkVerdict(v));
  assertEq('4.6b no-live emits log not warn', logs[0]!.level, 'log');
}

// 4.7 REGRESSION: the verdict planner's phase-ordering — backend-fail must
//     dominate even if downstream fields are ALSO populated (defensive: if
//     orchestrator misses the early-exit, verdict still classifies safely)
{
  const v = buildMonorepoLinkVerdict({
    applicable: true,
    backendName: 'b',
    backendUrl: 'https://b',
    backendConfigWrite: { ok: false, error: 'backend-write-failed' },
    siblingDiscovery: { ok: true, error: null, totalSiblings: 5, liveSiblings: 5 },
    siblingUpdates: [
      sibling('s1', 'a', true),
      sibling('s2', 'b', true),
      sibling('s3', 'c', true),
      sibling('s4', 'd', true),
      sibling('s5', 'e', true),
    ],
  });
  assertEq('4.7a backend-fail dominates even with valid downstream', v.kind, 'backend-config-failed');
  if (v.kind === 'backend-config-failed') {
    assertContains('4.7b backend error preserved', v.backendConfigError, 'backend-write-failed');
  }
}

// 4.8 REGRESSION: sibling-discovery-failed dominates over per-sibling
//     updates (defensive: shouldn't have any per-sibling outcomes if
//     discovery failed, but verdict classifies safely if orchestrator slips)
{
  const v = buildMonorepoLinkVerdict({
    applicable: true,
    backendName: 'b',
    backendUrl: 'https://b',
    backendConfigWrite: { ok: true, error: null },
    siblingDiscovery: { ok: false, error: 'list-broke', totalSiblings: 0, liveSiblings: 0 },
    siblingUpdates: [sibling('s1', 'a', true)], // shouldn't happen but be defensive
  });
  assertEq('4.8 discovery-fail dominates over stray sibling updates', v.kind, 'sibling-discovery-failed');
}

// ─── Report ──────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('All monorepo-link-verdict tests passed ✓');
