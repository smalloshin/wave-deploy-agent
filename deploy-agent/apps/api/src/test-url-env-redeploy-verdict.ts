/**
 * Tests for services/url-env-redeploy-verdict.ts (round 24).
 *
 * Run with: npx tsx src/test-url-env-redeploy-verdict.ts
 *
 * Sections:
 *   1. Verdict kinds × outcome matrix
 *   2. logUrlEnvRedeployVerdict console-capture
 *   3. errorCode contract + literal-true narrowing
 *   5. Round-24 specific regressions (surface-only contract, recoveryCommand shape)
 */

import {
  buildUrlEnvRedeployVerdict,
  logUrlEnvRedeployVerdict,
  type UrlEnvRedeployVerdict,
  type BuildUrlEnvRedeployVerdictInput,
} from './services/url-env-redeploy-verdict';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function input(overrides: Partial<BuildUrlEnvRedeployVerdictInput> = {}): BuildUrlEnvRedeployVerdictInput {
  return {
    applicable: true,
    serviceName: 'da-myapp',
    gcpProject: 'wave-deploy-agent',
    gcpRegion: 'asia-east1',
    serviceUrl: 'https://da-myapp-abc123-de.a.run.app',
    patchedKeys: ['NEXTAUTH_URL', 'APP_URL'],
    redeployOutcome: { success: true, error: null },
    ...overrides,
  };
}

// ── Section 1: verdict kinds × outcome matrix ──
console.log('--- Section 1: verdict kinds × outcome matrix ---');

(() => {
  // 1a. applicable=false → not-applicable
  const v = buildUrlEnvRedeployVerdict(input({ applicable: false, patchedKeys: [], redeployOutcome: null }));
  check('applicable=false → not-applicable', v.kind === 'not-applicable');
  check('not-applicable logLevel=info', v.logLevel === 'info');
  check('not-applicable message names service', v.message.includes('da-myapp'));
  check('not-applicable message says skipping', v.message.includes('skipping'));
  check('not-applicable message mentions reason',
    v.message.includes('no localhost') || v.message.includes('custom domain'));
})();

(() => {
  // 1b. happy path → redeploy-ok
  const v = buildUrlEnvRedeployVerdict(input());
  check('all-ok → redeploy-ok', v.kind === 'redeploy-ok');
  check('redeploy-ok logLevel=info', v.logLevel === 'info');
  if (v.kind === 'redeploy-ok') {
    check('redeploy-ok carries serviceName', v.serviceName === 'da-myapp');
    check('redeploy-ok carries patchedKeys verbatim', v.patchedKeys.join(',') === 'NEXTAUTH_URL,APP_URL');
    check('redeploy-ok message says OK', v.message.includes('OK'));
    check('redeploy-ok message includes patched count', v.message.includes('patched 2'));
    check('redeploy-ok message lists keys', v.message.includes('NEXTAUTH_URL') && v.message.includes('APP_URL'));
  }
})();

(() => {
  // 1c. redeploy success=false → redeploy-failed
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'Cloud Run quota exceeded (429)' },
  }));
  check('redeploy success=false → redeploy-failed', v.kind === 'redeploy-failed');
  check('redeploy-failed logLevel=critical', v.logLevel === 'critical');
  if (v.kind === 'redeploy-failed') {
    check('redeploy-failed errorCode=url_env_redeploy_drift', v.errorCode === 'url_env_redeploy_drift');
    check('redeploy-failed requiresOperatorAction=true', v.requiresOperatorAction === true);
    check('redeploy-failed carries redeployError verbatim', v.redeployError === 'Cloud Run quota exceeded (429)');
    check('redeploy-failed carries serviceName', v.serviceName === 'da-myapp');
    check('redeploy-failed carries serviceUrl', v.serviceUrl?.includes('run.app') === true);
    check('redeploy-failed carries patchedKeys', v.patchedKeys.length === 2);
    check('redeploy-failed message says FAILED', v.message.includes('FAILED'));
    check('redeploy-failed message says service IS LIVE', v.message.includes('IS LIVE'));
    check('redeploy-failed message warns about login flow', v.message.includes('login flow') || v.message.includes('OAuth'));
    check('redeploy-failed message mentions revision-1', v.message.includes('revision-1'));
    check('redeploy-failed message says deploy notification claims success',
      v.message.includes('deploy notification claims success') || v.message.includes('claims success'));
    check('redeploy-failed message has Recover with',
      v.message.includes('Recover with'));
  }
})();

(() => {
  // 1d. redeployOutcome=null but applicable=true → redeploy-failed (defensive)
  const v = buildUrlEnvRedeployVerdict(input({ redeployOutcome: null }));
  check('null outcome + applicable=true → redeploy-failed', v.kind === 'redeploy-failed');
  if (v.kind === 'redeploy-failed') {
    check('null outcome → fallback error string',
      v.redeployError.includes('not reported') || v.redeployError.includes('null') || v.redeployError.includes('threw before'));
  }
})();

(() => {
  // 1e. error=null + success=false → defensive fallback
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: null },
  }));
  check('error=null + success=false → redeploy-failed', v.kind === 'redeploy-failed');
  if (v.kind === 'redeploy-failed') {
    check('null error → fallback string', v.redeployError.includes('not reported'));
  }
})();

(() => {
  // 1f. empty error string → fallback
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: '' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('empty error → fallback string', v.redeployError.includes('not reported'));
  }
})();

(() => {
  // 1g. serviceUrl=null + redeploy-failed → message uses (URL unknown) placeholder
  const v = buildUrlEnvRedeployVerdict(input({
    serviceUrl: null,
    redeployOutcome: { success: false, error: 'patch failed' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('serviceUrl=null → message has (URL unknown)', v.message.includes('(URL unknown)'));
    check('serviceUrl=null → recoveryCommand has <service-url> placeholder',
      v.recoveryCommand.includes('<service-url>'));
  }
})();

(() => {
  // 1h. single-key patched (one URL var)
  const v = buildUrlEnvRedeployVerdict(input({
    patchedKeys: ['NEXTAUTH_URL'],
  }));
  if (v.kind === 'redeploy-ok') {
    check('single-key patchedKeys', v.patchedKeys.length === 1);
    check('single-key message uses singular "key"', v.message.includes('1 key'));
    check('single-key message does NOT use plural', !v.message.includes('1 keys'));
  }
})();

// ── Section 2: log helper console-capture ──
console.log('--- Section 2: log helper console-capture ---');

function captureConsole(): { logs: string[]; errors: string[]; warns: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  return {
    logs, errors, warns,
    restore: () => { console.log = origLog; console.error = origErr; console.warn = origWarn; },
  };
}

(() => {
  // 2a. not-applicable → console.log
  const cap = captureConsole();
  logUrlEnvRedeployVerdict(buildUrlEnvRedeployVerdict(input({ applicable: false, patchedKeys: [], redeployOutcome: null })));
  cap.restore();
  check('not-applicable → 1 console.log line', cap.logs.length === 1);
  check('not-applicable → 0 console.error', cap.errors.length === 0);
  check('not-applicable log has [Deploy] prefix', cap.logs[0].includes('[Deploy]'));
})();

(() => {
  // 2b. redeploy-ok → console.log
  const cap = captureConsole();
  logUrlEnvRedeployVerdict(buildUrlEnvRedeployVerdict(input()));
  cap.restore();
  check('redeploy-ok → 1 console.log', cap.logs.length === 1);
  check('redeploy-ok → 0 console.error', cap.errors.length === 0);
})();

(() => {
  // 2c. redeploy-failed → console.error with [CRITICAL errorCode=url_env_redeploy_drift]
  const cap = captureConsole();
  logUrlEnvRedeployVerdict(buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'boom' },
  })));
  cap.restore();
  check('redeploy-failed → 1 console.error', cap.errors.length === 1);
  check('redeploy-failed → 0 console.log', cap.logs.length === 0);
  check('redeploy-failed has [Deploy] prefix', cap.errors[0].includes('[Deploy]'));
  check('redeploy-failed has [CRITICAL errorCode=url_env_redeploy_drift]',
    cap.errors[0].includes('[CRITICAL errorCode=url_env_redeploy_drift]'));
})();

(() => {
  // 2d. null outcome → console.error
  const cap = captureConsole();
  logUrlEnvRedeployVerdict(buildUrlEnvRedeployVerdict(input({ redeployOutcome: null })));
  cap.restore();
  check('null outcome → 1 console.error', cap.errors.length === 1);
})();

// ── Section 3: errorCode + literal-true narrowing ──
console.log('--- Section 3: errorCode + literal-true narrowing ---');

(() => {
  // 3a. not-applicable has NO errorCode/requiresOperatorAction/recoveryCommand
  const v: UrlEnvRedeployVerdict = buildUrlEnvRedeployVerdict(input({ applicable: false, patchedKeys: [], redeployOutcome: null }));
  if (v.kind === 'not-applicable') {
    check('not-applicable has no errorCode', !('errorCode' in v));
    check('not-applicable has no requiresOperatorAction', !('requiresOperatorAction' in v));
    check('not-applicable has no recoveryCommand', !('recoveryCommand' in v));
    check('not-applicable has no blockDeploy', !('blockDeploy' in v));
    check('not-applicable has no blockPipeline', !('blockPipeline' in v));
  }
})();

(() => {
  // 3b. redeploy-ok has NO errorCode/recoveryCommand
  const v: UrlEnvRedeployVerdict = buildUrlEnvRedeployVerdict(input());
  if (v.kind === 'redeploy-ok') {
    check('redeploy-ok has no errorCode', !('errorCode' in v));
    check('redeploy-ok has no requiresOperatorAction', !('requiresOperatorAction' in v));
    check('redeploy-ok has no recoveryCommand', !('recoveryCommand' in v));
    check('redeploy-ok has no blockDeploy', !('blockDeploy' in v));
    check('redeploy-ok has no blockPipeline', !('blockPipeline' in v));
  }
})();

(() => {
  // 3c. redeploy-failed: errorCode literal, requiresOperatorAction literal true
  const v: UrlEnvRedeployVerdict = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    const ec: 'url_env_redeploy_drift' = v.errorCode;
    const ra: true = v.requiresOperatorAction;
    check('redeploy-failed errorCode literal', ec === 'url_env_redeploy_drift');
    check('redeploy-failed requiresOperatorAction literal true', ra === true);
    check('redeploy-failed has NO blockDeploy field (surface-only contract)', !('blockDeploy' in v));
    check('redeploy-failed has NO blockPipeline field', !('blockPipeline' in v));
  }
})();

(() => {
  // 3d. extra string fields all string-typed
  const v: UrlEnvRedeployVerdict = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'boom' },
  }));
  if (v.kind === 'redeploy-failed') {
    const a: string = v.serviceName;
    const b: string = v.gcpProject;
    const c: string = v.gcpRegion;
    const d: string = v.redeployError;
    const e: string = v.recoveryCommand;
    check('redeploy-failed serviceName non-empty', a.length > 0);
    check('redeploy-failed gcpProject non-empty', b.length > 0);
    check('redeploy-failed gcpRegion non-empty', c.length > 0);
    check('redeploy-failed redeployError non-empty', d.length > 0);
    check('redeploy-failed recoveryCommand non-empty', e.length > 0);
  }
})();

// ── Section 5: round-24 specific regressions ──
console.log('--- Section 5: round-24 regressions ---');

(() => {
  // R-1: redeploy-failed has NO blockDeploy AND NO blockPipeline.
  //      Surface-only spectrum point — service is live, bailing would orphan revision.
  const errs = [
    'Cloud Run quota exceeded (429)',
    'PATCH RPS limit hit',
    'image-pull race: not-found',
    'auth blip: 401 Unauthorized',
    'connection reset by peer',
    'deploy timed out after 5m',
  ];
  for (const err of errs) {
    const v = buildUrlEnvRedeployVerdict(input({ redeployOutcome: { success: false, error: err } }));
    if (v.kind === 'redeploy-failed') {
      check(`R-1 NO blockDeploy field for "${err.slice(0, 30)}..."`, !('blockDeploy' in v));
      check(`R-1 NO blockPipeline field for "${err.slice(0, 30)}..."`, !('blockPipeline' in v));
    }
  }
})();

(() => {
  // R-2: recoveryCommand is runnable shell — gcloud run services update
  //      with --update-env-vars=KEY=URL,KEY2=URL,...
  const v = buildUrlEnvRedeployVerdict(input({
    serviceName: 'da-myapp',
    gcpProject: 'wave-deploy-agent',
    gcpRegion: 'asia-east1',
    serviceUrl: 'https://da-myapp-abc.a.run.app',
    patchedKeys: ['NEXTAUTH_URL', 'APP_URL', 'BASE_URL'],
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('R-2 recoveryCommand starts with gcloud run services update',
      v.recoveryCommand.startsWith('gcloud run services update da-myapp'));
    check('R-2 recoveryCommand has --region', v.recoveryCommand.includes('--region=asia-east1'));
    check('R-2 recoveryCommand has --project', v.recoveryCommand.includes('--project=wave-deploy-agent'));
    check('R-2 recoveryCommand has --update-env-vars', v.recoveryCommand.includes('--update-env-vars='));
    check('R-2 recoveryCommand sets NEXTAUTH_URL=<serviceUrl>',
      v.recoveryCommand.includes('NEXTAUTH_URL=https://da-myapp-abc.a.run.app'));
    check('R-2 recoveryCommand sets APP_URL=<serviceUrl>',
      v.recoveryCommand.includes('APP_URL=https://da-myapp-abc.a.run.app'));
    check('R-2 recoveryCommand sets BASE_URL=<serviceUrl>',
      v.recoveryCommand.includes('BASE_URL=https://da-myapp-abc.a.run.app'));
    check('R-2 recoveryCommand uses comma between key=val pairs',
      v.recoveryCommand.includes(',NEXTAUTH_URL=') ||
      v.recoveryCommand.includes(',APP_URL=') ||
      v.recoveryCommand.includes(',BASE_URL='));
    check('R-2 recoveryCommand has NO template placeholders',
      !v.recoveryCommand.includes('${') && !v.recoveryCommand.includes('{{'));
  }
})();

(() => {
  // R-3: critical message embeds the full recoveryCommand verbatim
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('R-3 message embeds the recoveryCommand', v.message.includes(v.recoveryCommand));
  }
})();

(() => {
  // R-4: message tells the operator the DEPLOY notification was a lie
  //      (system says success, URL is broken for end users)
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'boom' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('R-4 message says service IS LIVE', v.message.includes('IS LIVE'));
    check('R-4 message says serving with localhost values',
      v.message.includes('localhost'));
    check('R-4 message names the patched keys',
      v.message.includes('NEXTAUTH_URL') && v.message.includes('APP_URL'));
    check('R-4 message warns deploy notification claims success',
      v.message.includes('claims success'));
    check('R-4 message says URL is broken for end users',
      v.message.includes('broken for end users'));
  }
})();

(() => {
  // R-5: idempotent — same input → same verdict
  const i = input({ redeployOutcome: { success: false, error: 'repeat-me' } });
  const a = buildUrlEnvRedeployVerdict(i);
  const b = buildUrlEnvRedeployVerdict(i);
  check('R-5 idempotent: same kind', a.kind === b.kind);
  check('R-5 idempotent: same logLevel', a.logLevel === b.logLevel);
  check('R-5 idempotent: same message', a.message === b.message);
  if (a.kind === 'redeploy-failed' && b.kind === 'redeploy-failed') {
    check('R-5 idempotent: same recoveryCommand', a.recoveryCommand === b.recoveryCommand);
  }
})();

(() => {
  // R-6: dashboard-grep — log line carries unique greppable signature
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    const cap = captureConsole();
    logUrlEnvRedeployVerdict(v);
    cap.restore();
    check('R-6 log line contains [CRITICAL', cap.errors[0].includes('[CRITICAL'));
    check('R-6 log line contains errorCode=url_env_redeploy_drift',
      cap.errors[0].includes('errorCode=url_env_redeploy_drift'));
    check('R-6 log line contains [Deploy] module tag', cap.errors[0].includes('[Deploy]'));
  }
})();

(() => {
  // R-7: empty patchedKeys but applicable=true (defensive — caller bug)
  //      → recoveryCommand falls back to NEXTAUTH_URL=<url>
  const v = buildUrlEnvRedeployVerdict(input({
    patchedKeys: [],
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('R-7 empty patchedKeys → recoveryCommand still has --update-env-vars',
      v.recoveryCommand.includes('--update-env-vars='));
    check('R-7 empty patchedKeys → fallback to NEXTAUTH_URL',
      v.recoveryCommand.includes('NEXTAUTH_URL='));
  }
})();

(() => {
  // R-8: distinct from round-21 IAM verdict's errorCode (different concern)
  const v = buildUrlEnvRedeployVerdict(input({
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    const ec: 'url_env_redeploy_drift' = v.errorCode;
    check('R-8 errorCode is url_env_redeploy_drift (NOT iam_policy_drift)',
      (ec as string) === 'url_env_redeploy_drift');
    check('R-8 errorCode is NOT monorepo_link_drift',
      (ec as string) !== 'monorepo_link_drift');
  }
})();

(() => {
  // R-9: not-applicable does NOT pollute critical log channel
  const cap = captureConsole();
  logUrlEnvRedeployVerdict(buildUrlEnvRedeployVerdict(input({ applicable: false, patchedKeys: [], redeployOutcome: null })));
  cap.restore();
  check('R-9 not-applicable produces 0 console.error', cap.errors.length === 0);
})();

(() => {
  // R-10: redeploy-failed message references all 5 URL key names operators
  //       might patch (NEXTAUTH_URL, APP_URL, BASE_URL, SITE_URL, PUBLIC_URL)
  //       when those keys were the ones being patched
  const v = buildUrlEnvRedeployVerdict(input({
    patchedKeys: ['NEXTAUTH_URL', 'APP_URL', 'BASE_URL', 'SITE_URL', 'PUBLIC_URL'],
    redeployOutcome: { success: false, error: 'x' },
  }));
  if (v.kind === 'redeploy-failed') {
    check('R-10 message lists all 5 keys',
      v.message.includes('NEXTAUTH_URL') &&
      v.message.includes('APP_URL') &&
      v.message.includes('BASE_URL') &&
      v.message.includes('SITE_URL') &&
      v.message.includes('PUBLIC_URL'));
    check('R-10 recoveryCommand sets all 5 to serviceUrl',
      v.recoveryCommand.includes('NEXTAUTH_URL=https://') &&
      v.recoveryCommand.includes('APP_URL=https://') &&
      v.recoveryCommand.includes('BASE_URL=https://') &&
      v.recoveryCommand.includes('SITE_URL=https://') &&
      v.recoveryCommand.includes('PUBLIC_URL=https://'));
  }
})();

// ── Summary ──
console.log(`\n--- Summary ---`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
