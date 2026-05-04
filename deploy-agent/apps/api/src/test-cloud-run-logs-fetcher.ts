/**
 * Tests: cloud-run-logs-fetcher (R53)
 *
 * Pure-helper coverage only. The async `fetchContainerLogs` calls Cloud
 * Logging API + GCP auth; smoke-testing it requires real credentials so
 * we exercise it manually post-deploy via the deploy-worker integration.
 *
 * What we lock in here:
 *   - extractCloudRunMetaFromError handles the actual error string format
 *     Cloud Run produces (URL-encoded labels in Logs URL)
 *   - Plain quoted-form fallback also works
 *   - Empty / non-string input doesn't throw
 *   - formatLogEntries reverses chronologically (LLM reads top-to-bottom
 *     traceback)
 *   - Truncation keeps the END (crash signal at bottom of stack)
 *   - Truncation marker is present
 *   - jsonPayload.message rendered when textPayload missing
 *
 * Run: bun run src/test-cloud-run-logs-fetcher.ts
 */

import assert from 'node:assert/strict';
import {
  extractCloudRunMetaFromError,
  formatLogEntries,
  type CloudLogEntry,
} from './services/cloud-run-logs-fetcher';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

console.log('\n=== cloud-run-logs-fetcher unit tests ===\n');

// ─── extractCloudRunMetaFromError ────────────────────────────

test('extracts service + revision from real Cloud Run timeout error (URL-encoded form)', () => {
  // Real-world wavenet-ai-gateway-backend error:
  const errorMsg = `Cloud Run operation failed: The user-provided container failed to start and listen on the port defined provided by the PORT=8080 environment variable within the allocated timeout. This can happen when the container port is misconfigured or if the timeout is too short. The health check timeout can be extended. Logs for this revision might contain more information.

Logs URL: https://console.cloud.google.com/logs/viewer?project=wave-deploy-agent&resource=cloud_run_revision/service_name/da-wavenet-ai-gateway-backend/revision_name/da-wavenet-ai-gateway-backend-00003-2x7&advancedFilter=resource.type%3D%22cloud_run_revision%22%0Aresource.labels.service_name%3D%22da-wavenet-ai-gateway-backend%22%0Aresource.labels.revision_name%3D%22da-wavenet-ai-gateway-backend-00003-2x7%22`;
  const meta = extractCloudRunMetaFromError(errorMsg);
  assert.equal(meta.serviceName, 'da-wavenet-ai-gateway-backend');
  assert.equal(meta.revisionName, 'da-wavenet-ai-gateway-backend-00003-2x7');
});

test('extracts from plain quoted form (older Cloud Run error format)', () => {
  const msg = `Some error... resource.labels.service_name="my-svc" and resource.labels.revision_name="my-svc-00007-abc" something`;
  const meta = extractCloudRunMetaFromError(msg);
  assert.equal(meta.serviceName, 'my-svc');
  assert.equal(meta.revisionName, 'my-svc-00007-abc');
});

test('returns empty object when neither label is present', () => {
  const meta = extractCloudRunMetaFromError('some random error message with no Cloud Run details');
  assert.deepEqual(meta, {});
});

test('returns service-only when only service_name is present', () => {
  const msg = 'partial error: service_name="svc-a" but no revision';
  const meta = extractCloudRunMetaFromError(msg);
  assert.equal(meta.serviceName, 'svc-a');
  assert.equal(meta.revisionName, undefined);
});

test('returns revision-only when only revision_name is present', () => {
  const msg = 'partial error: revision_name="rev-only-00002-xyz"';
  const meta = extractCloudRunMetaFromError(msg);
  assert.equal(meta.serviceName, undefined);
  assert.equal(meta.revisionName, 'rev-only-00002-xyz');
});

test('empty string input → empty object, no throw', () => {
  const meta = extractCloudRunMetaFromError('');
  assert.deepEqual(meta, {});
});

test('null/undefined input → empty object, no throw', () => {
  // @ts-expect-error testing defensive guard
  const meta1 = extractCloudRunMetaFromError(null);
  assert.deepEqual(meta1, {});
  // @ts-expect-error testing defensive guard
  const meta2 = extractCloudRunMetaFromError(undefined);
  assert.deepEqual(meta2, {});
});

test('case-insensitive label key match (defensive)', () => {
  const msg = 'Service_Name="upper-case-key" revision_NAME="rev-upper-00001-aaa"';
  const meta = extractCloudRunMetaFromError(msg);
  assert.equal(meta.serviceName, 'upper-case-key');
  assert.equal(meta.revisionName, 'rev-upper-00001-aaa');
});

test('extracts only first match if duplicates present', () => {
  const msg = 'service_name="first-svc" service_name="second-svc"';
  const meta = extractCloudRunMetaFromError(msg);
  assert.equal(meta.serviceName, 'first-svc');
});

// ─── formatLogEntries ────────────────────────────────────────

test('returns empty string for empty input array', () => {
  assert.equal(formatLogEntries([]), '');
});

test('returns empty string for null/undefined input', () => {
  // @ts-expect-error testing defensive guard
  assert.equal(formatLogEntries(null), '');
  // @ts-expect-error testing defensive guard
  assert.equal(formatLogEntries(undefined), '');
});

test('reverses chronological order (Cloud Logging returns newest first; we want oldest first for LLM)', () => {
  const entries: CloudLogEntry[] = [
    { timestamp: '2026-05-04T00:30:05Z', textPayload: 'newest line', severity: 'ERROR' },
    { timestamp: '2026-05-04T00:30:00Z', textPayload: 'oldest line', severity: 'INFO' },
  ];
  const out = formatLogEntries(entries);
  // Oldest should appear first in formatted output
  assert.ok(
    out.indexOf('oldest line') < out.indexOf('newest line'),
    'oldest should be before newest',
  );
});

test('renders [timestamp severity] textPayload format', () => {
  const entries: CloudLogEntry[] = [
    { timestamp: '2026-05-04T00:30:00Z', textPayload: 'hello world', severity: 'WARNING' },
  ];
  const out = formatLogEntries(entries);
  assert.match(out, /\[2026-05-04T00:30:00 WARNING\] hello world/);
});

test('renders jsonPayload.message when textPayload is missing', () => {
  const entries: CloudLogEntry[] = [
    {
      timestamp: '2026-05-04T00:30:00Z',
      jsonPayload: { message: 'from json payload' },
      severity: 'INFO',
    },
  ];
  const out = formatLogEntries(entries);
  assert.match(out, /from json payload/);
});

test('skips entries with no textPayload AND no jsonPayload.message', () => {
  const entries: CloudLogEntry[] = [
    { timestamp: '2026-05-04T00:30:00Z', textPayload: 'kept', severity: 'INFO' },
    { timestamp: '2026-05-04T00:30:01Z', jsonPayload: { other: 'field' }, severity: 'INFO' }, // no message
  ];
  const out = formatLogEntries(entries);
  assert.match(out, /kept/);
  assert.equal(out.split('\n').length, 1);
});

test('truncation: keeps the END (crash signals are at bottom of stack)', () => {
  // Simulate a long log: 100 lines, each ~20 bytes
  const entries: CloudLogEntry[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: '2026-05-04T00:30:00Z',
    textPayload: `line ${i.toString().padStart(3, '0')}`,
    severity: 'INFO',
  }));
  // Reversed by formatter, so oldest line will be `line 099`, newest `line 000`.
  // Cap at 200 bytes — should keep last few lines (line 002, 001, 000).
  const out = formatLogEntries(entries, 200);
  assert.match(out, /\[\.\.\. earlier logs truncated/, 'should include truncation marker');
  // The newest entries (line 000-002) should survive (they're at the bottom after reverse).
  assert.match(out, /line 000/);
});

test('truncation marker says how many bytes', () => {
  const entries: CloudLogEntry[] = Array.from({ length: 200 }, (_, i) => ({
    timestamp: '2026-05-04T00:30:00Z',
    textPayload: `line ${i}`.padEnd(50, 'X'),
    severity: 'INFO',
  }));
  const out = formatLogEntries(entries, 1000);
  assert.match(out, /truncated to fit 1000 byte cap/);
});

test('no truncation if total fits under maxBytes', () => {
  const entries: CloudLogEntry[] = [
    { timestamp: '2026-05-04T00:30:00Z', textPayload: 'short', severity: 'INFO' },
  ];
  const out = formatLogEntries(entries, 30_000);
  assert.equal(out.includes('truncated'), false);
});

test('default severity is INFO when entry omits it', () => {
  const entries: CloudLogEntry[] = [
    { timestamp: '2026-05-04T00:30:00Z', textPayload: 'no severity field' },
  ];
  const out = formatLogEntries(entries);
  assert.match(out, /\[2026-05-04T00:30:00 INFO\]/);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
