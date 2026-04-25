/**
 * Tests: analyzePublishSplit (reconciler.ts) — round 10
 *
 * Background:
 *   Round 9 wrapped publishDeployment() in a transaction so the three DB
 *   writes are atomic, AND added a fatal log + 500 error in the versioning
 *   route when publishRevision() (Cloud Run traffic switch) succeeds but
 *   publishDeployment() (DB write) fails. But the route handler can only
 *   warn at the moment of failure — if the operator misses the log and the
 *   API restarts, the split state stays forever. Round 10 makes the
 *   reconciler scan all `live` projects each cycle, compare DB.is_published
 *   to Cloud Run's actual 100%-traffic revision, and auto-fix when safe.
 *
 *   The IO orchestrator (`detectAndReconcilePublishSplit`) is thin glue —
 *   read state, call analyze, dispatch on the verdict. The decision logic
 *   lives in `analyzePublishSplit`, which is pure and gets all 9 test cases.
 *
 * Run: tsx src/test-publish-split.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import type { Deployment, Project } from '@deploy-agent/shared';
import { analyzePublishSplit } from './services/reconciler.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

// ─── Builders ──────────────────────────────────────────────────────

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'demo',
    slug: 'demo',
    sourceType: 'upload',
    sourceUrl: null,
    detectedLanguage: null,
    detectedFramework: null,
    status: 'live',
    config: {
      deployTarget: 'cloud_run',
      allowUnauthenticated: true,
      gcpProject: 'my-gcp-proj',
      gcpRegion: 'asia-east1',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'd-1',
    projectId: 'proj-1',
    reviewId: null,
    cloudRunService: 'da-demo',
    cloudRunUrl: 'https://da-demo.a.run.app',
    customDomain: null,
    sslStatus: null,
    terraformConfig: null,
    healthStatus: 'healthy',
    canaryResults: null,
    gitPrUrl: null,
    deployedAt: new Date(),
    createdAt: new Date(),
    version: 1,
    imageUri: null,
    revisionName: 'da-demo-00001-aaa',
    previewUrl: null,
    isPublished: false,
    publishedAt: null,
    deployedSourceGcsUri: null,
    ...overrides,
  };
}

// ─── Skip cases ────────────────────────────────────────────────────

console.log('\n=== analyzePublishSplit: skip cases ===\n');

await test('no GCP project configured → skipped', () => {
  // Defensively wipe env in case the dev's shell has GCP_PROJECT set.
  const savedEnv = process.env.GCP_PROJECT;
  delete process.env.GCP_PROJECT;
  try {
    const v = analyzePublishSplit(
      project({ config: { deployTarget: 'cloud_run', allowUnauthenticated: true } }),
      [],
      null,
    );
    assert.equal(v.kind, 'skipped');
    if (v.kind === 'skipped') assert.match(v.reason, /no GCP project/);
  } finally {
    if (savedEnv !== undefined) process.env.GCP_PROJECT = savedEnv;
  }
});

await test('no deployments at all → skipped', () => {
  const v = analyzePublishSplit(project(), [], 'da-demo-00001-aaa');
  assert.equal(v.kind, 'skipped');
  if (v.kind === 'skipped') assert.match(v.reason, /no deployments/);
});

await test('no published deployment in list → skipped', () => {
  const v = analyzePublishSplit(
    project(),
    [deployment({ isPublished: false }), deployment({ id: 'd-2', isPublished: false })],
    'da-demo-00001-aaa',
  );
  assert.equal(v.kind, 'skipped');
  if (v.kind === 'skipped') assert.match(v.reason, /no published deployment/);
});

await test('published deployment missing cloudRunService → skipped', () => {
  const v = analyzePublishSplit(
    project(),
    [deployment({ isPublished: true, cloudRunService: null })],
    'da-demo-00001-aaa',
  );
  assert.equal(v.kind, 'skipped');
  if (v.kind === 'skipped') assert.match(v.reason, /no cloudRunService/);
});

await test('published deployment missing revisionName → skipped', () => {
  const v = analyzePublishSplit(
    project(),
    [deployment({ isPublished: true, revisionName: null })],
    'da-demo-00001-aaa',
  );
  assert.equal(v.kind, 'skipped');
  if (v.kind === 'skipped') assert.match(v.reason, /no revisionName/);
});

await test('liveRevision is null (Cloud Run unreachable / mid-rollout) → skipped', () => {
  // Important: when traffic is split (mid canary), getServiceLiveTraffic
  // returns no single 100% revision and we get null here. We MUST skip,
  // not auto-fix — auto-fixing during a canary would clobber the rollout.
  const v = analyzePublishSplit(
    project(),
    [deployment({ isPublished: true, revisionName: 'da-demo-00001-aaa' })],
    null,
  );
  assert.equal(v.kind, 'skipped');
  if (v.kind === 'skipped') assert.match(v.reason, /Cloud Run live revision unknown/);
});

// ─── Healthy cases ─────────────────────────────────────────────────

console.log('\n=== analyzePublishSplit: healthy ===\n');

await test('liveRevision matches DB published revision → no-split', () => {
  const v = analyzePublishSplit(
    project(),
    [deployment({ isPublished: true, revisionName: 'da-demo-00007-xyz' })],
    'da-demo-00007-xyz',
  );
  assert.equal(v.kind, 'no-split');
  if (v.kind === 'no-split') assert.equal(v.revision, 'da-demo-00007-xyz');
});

await test('matches even when several other unpublished deployments exist', () => {
  const v = analyzePublishSplit(
    project(),
    [
      deployment({ id: 'd-old1', version: 1, isPublished: false, revisionName: 'da-demo-00001-aaa' }),
      deployment({ id: 'd-old2', version: 2, isPublished: false, revisionName: 'da-demo-00002-bbb' }),
      deployment({ id: 'd-live', version: 3, isPublished: true, revisionName: 'da-demo-00003-ccc' }),
    ],
    'da-demo-00003-ccc',
  );
  assert.equal(v.kind, 'no-split');
});

// ─── Split: known revision (auto-fixable) ──────────────────────────

console.log('\n=== analyzePublishSplit: split, known revision (auto-fix) ===\n');

await test('Cloud Run serves a different but-known DB revision → split-known-revision', () => {
  // This is exactly the round-9 partial-publish case: publishRevision()
  // succeeded (Cloud Run is on v3) but publishDeployment() failed (DB still
  // says v2 is published). DB knows about v3, so we can auto-fix safely.
  const v = analyzePublishSplit(
    project(),
    [
      deployment({ id: 'd-v2', version: 2, isPublished: true,  revisionName: 'da-demo-00002-bbb' }),
      deployment({ id: 'd-v3', version: 3, isPublished: false, revisionName: 'da-demo-00003-ccc' }),
    ],
    'da-demo-00003-ccc',
  );
  assert.equal(v.kind, 'split-known-revision');
  if (v.kind === 'split-known-revision') {
    assert.equal(v.dbPublishedDeploymentId, 'd-v2');
    assert.equal(v.dbPublishedRevision, 'da-demo-00002-bbb');
    assert.equal(v.dbPublishedVersion, 2);
    assert.equal(v.cloudRunDeploymentId, 'd-v3');
    assert.equal(v.cloudRunRevision, 'da-demo-00003-ccc');
    assert.equal(v.cloudRunVersion, 3);
    assert.equal(v.cloudRunService, 'da-demo');
  }
});

await test('split where Cloud Run is on the OLDER revision (rollback case)', () => {
  // Operator manually rolled back via gcloud while the DB still says v3 live.
  // DB knows v2, so auto-fix safely points DB back at v2.
  const v = analyzePublishSplit(
    project(),
    [
      deployment({ id: 'd-v2', version: 2, isPublished: false, revisionName: 'da-demo-00002-bbb' }),
      deployment({ id: 'd-v3', version: 3, isPublished: true,  revisionName: 'da-demo-00003-ccc' }),
    ],
    'da-demo-00002-bbb',
  );
  assert.equal(v.kind, 'split-known-revision');
  if (v.kind === 'split-known-revision') {
    assert.equal(v.cloudRunDeploymentId, 'd-v2');
    assert.equal(v.dbPublishedDeploymentId, 'd-v3');
  }
});

// ─── Split: unknown revision (manual reconcile) ────────────────────

console.log('\n=== analyzePublishSplit: split, unknown revision (no auto-fix) ===\n');

await test('Cloud Run serves a revision we have no DB record for → split-unknown-revision', () => {
  // This happens if someone deployed via gcloud directly, or a deployment
  // row was deleted while traffic stayed pinned to its revision. We MUST
  // NOT auto-fix — pointing at the wrong DB row would make state worse.
  const v = analyzePublishSplit(
    project(),
    [deployment({ isPublished: true, revisionName: 'da-demo-00002-bbb' })],
    'da-demo-99999-mystery',
  );
  assert.equal(v.kind, 'split-unknown-revision');
  if (v.kind === 'split-unknown-revision') {
    assert.equal(v.cloudRunRevision, 'da-demo-99999-mystery');
    assert.equal(v.dbPublishedRevision, 'da-demo-00002-bbb');
    assert.equal(v.cloudRunService, 'da-demo');
  }
});

// ─── Edge cases ────────────────────────────────────────────────────

console.log('\n=== analyzePublishSplit: edge cases ===\n');

await test('uses GCP_PROJECT env var when project.config.gcpProject not set', () => {
  const saved = process.env.GCP_PROJECT;
  process.env.GCP_PROJECT = 'env-fallback-project';
  try {
    const v = analyzePublishSplit(
      project({ config: { deployTarget: 'cloud_run', allowUnauthenticated: true } }),
      [deployment({ isPublished: true, revisionName: 'r1' })],
      'r1',
    );
    // Should NOT skip with "no GCP project"; should reach the comparison.
    assert.equal(v.kind, 'no-split');
  } finally {
    if (saved === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = saved;
  }
});

await test('multiple is_published=true rows: picks the first found, treats rest as candidates', () => {
  // The DB shouldn't have multiple is_published=true rows after round 9
  // (the transaction unsets the old before setting the new). But if it does
  // happen — corrupted state from a pre-round-9 deploy — we still want a
  // sensible verdict, not a crash. Find returns the first; the comparison
  // proceeds normally.
  const v = analyzePublishSplit(
    project(),
    [
      deployment({ id: 'd-a', version: 1, isPublished: true, revisionName: 'r-a' }),
      deployment({ id: 'd-b', version: 2, isPublished: true, revisionName: 'r-b' }),
    ],
    'r-a',
  );
  assert.equal(v.kind, 'no-split');
  if (v.kind === 'no-split') assert.equal(v.revision, 'r-a');
});

await test('does not crash on empty config object', () => {
  const saved = process.env.GCP_PROJECT;
  delete process.env.GCP_PROJECT;
  try {
    const v = analyzePublishSplit(
      // @ts-expect-error - intentionally probe with a minimal config to verify defensive handling
      { id: 'p', name: 'p', config: {} },
      [],
      null,
    );
    assert.equal(v.kind, 'skipped');
  } finally {
    if (saved !== undefined) process.env.GCP_PROJECT = saved;
  }
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
