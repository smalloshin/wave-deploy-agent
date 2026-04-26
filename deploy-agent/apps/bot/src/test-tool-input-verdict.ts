/**
 * Pure-function tests for tool-input-verdict.ts (Round 26 Item #7).
 * Run via: bun src/test-tool-input-verdict.ts
 */

import { validateToolInput } from './tool-input-verdict.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, reason = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.error(`FAIL: ${name}: ${reason}`);
  }
}

// ─── list_projects (no args) ───
(() => {
  const v = validateToolInput('list_projects', {});
  check('list_projects: empty input → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('list_projects', { project: 'foo' });
  check('list_projects: extra field → invalid (strict)', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── get_project_status ───
(() => {
  const v = validateToolInput('get_project_status', { project: 'foo' });
  check('get_project_status: valid input → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('get_project_status', {});
  check('get_project_status: missing project → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('get_project_status', { project: 123 });
  check('get_project_status: wrong type (number) → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── approve_deploy ───
(() => {
  const v = validateToolInput('approve_deploy', { project: 'foo' });
  check('approve_deploy: valid (no comments) → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('approve_deploy', { project: 'foo', comments: 'lgtm' });
  check('approve_deploy: valid w/ comments → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('approve_deploy', {});
  check('approve_deploy: missing project → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('approve_deploy', {
    project: 'foo',
    comments: 'a'.repeat(501),
  });
  check('approve_deploy: comments=501 chars → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('approve_deploy', {
    project: 'foo',
    comments: 'a'.repeat(500),
  });
  check('approve_deploy: comments=500 chars → valid (boundary)', v.kind === 'valid', `got ${v.kind}`);
})();

// ─── reject_deploy ───
(() => {
  const v = validateToolInput('reject_deploy', { project: 'foo', reason: 'no good' });
  check('reject_deploy: valid → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('reject_deploy', {});
  check('reject_deploy: missing project → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── publish_version ───
(() => {
  const v = validateToolInput('publish_version', { project: 'foo', version: 3 });
  check('publish_version: valid → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('publish_version', { project: 'foo' });
  check('publish_version: missing version → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('publish_version', { project: 'foo', version: -1 });
  check('publish_version: negative version → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('publish_version', { project: 'foo', version: 0 });
  check('publish_version: version=0 → invalid (must be positive)', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('publish_version', { project: 'foo', version: 1.5 });
  check('publish_version: non-int → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('publish_version', { project: 'foo', version: '3' });
  check('publish_version: string version → invalid (no coercion)', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── rollback_version ───
(() => {
  const v = validateToolInput('rollback_version', { project: 'foo' });
  check('rollback_version: no version → valid (optional)', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('rollback_version', { project: 'foo', version: 2 });
  check('rollback_version: with version → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('rollback_version', { project: 'foo', version: -1 });
  check('rollback_version: negative version → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── toggle_deploy_lock ───
(() => {
  const v = validateToolInput('toggle_deploy_lock', { project: 'foo' });
  check('toggle_deploy_lock: valid → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('toggle_deploy_lock', {});
  check('toggle_deploy_lock: missing project → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── delete_project ───
(() => {
  const v = validateToolInput('delete_project', { project: 'foo' });
  check('delete_project: valid → valid', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('delete_project', {});
  check('delete_project: missing project → invalid', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── boundary: project name length ───
(() => {
  const v = validateToolInput('get_project_status', { project: 'a'.repeat(120) });
  check('project name=120 chars → valid (boundary)', v.kind === 'valid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('get_project_status', { project: 'a'.repeat(121) });
  check('project name=121 chars → invalid (over max)', v.kind === 'invalid', `got ${v.kind}`);
})();
(() => {
  const v = validateToolInput('get_project_status', { project: '' });
  check('project name=empty → invalid (min 1)', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── extra fields stripped or rejected (strict mode) ───
(() => {
  const v = validateToolInput('get_project_status', { project: 'foo', extra: 'bar' });
  check('extra field → invalid (strict mode rejects)', v.kind === 'invalid', `got ${v.kind}`);
})();

// ─── unknown tool name ───
(() => {
  const v = validateToolInput('not_a_real_tool', { project: 'foo' });
  check('unknown tool name → invalid', v.kind === 'invalid', `got ${v.kind}`);
  if (v.kind === 'invalid') {
    check('unknown tool error message mentions tool name',
      v.errors.some((e) => e.includes('not_a_real_tool')),
      `errors: ${v.errors.join(';')}`);
  }
})();

// ─── invalid → errors array is non-empty and well-formed ───
(() => {
  const v = validateToolInput('publish_version', { project: 'foo' });
  if (v.kind === 'invalid') {
    check('invalid: errors array is non-empty', v.errors.length > 0, `errors=${v.errors.length}`);
    check('invalid: errors are strings', v.errors.every((e) => typeof e === 'string'),
      'some error not a string');
  } else {
    check('invalid verdict (publish_version w/o version)', false, `got ${v.kind}`);
  }
})();

// ─── valid: value is the parsed input ───
(() => {
  const v = validateToolInput('publish_version', { project: 'foo', version: 3 });
  if (v.kind === 'valid') {
    check('valid: value matches input',
      JSON.stringify(v.value) === JSON.stringify({ project: 'foo', version: 3 }),
      `value=${JSON.stringify(v.value)}`);
  } else {
    check('valid verdict (publish_version)', false, `got ${v.kind}`);
  }
})();

// Summary
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
