// Round 40 — Wire-contract lock for `upload-draft-storage.ts`.
//
// Target: 5 exported helpers + 2 internal (covered indirectly).
//   - saveDraft(projectId, formData, fileMeta?)
//   - loadDraft(projectId) → UploadDraft | null
//   - clearDraft(projectId)
//   - gcExpiredDrafts()
//   - makeDebouncedSave(delayMs?)
//   internal:
//   - isBrowser()  — covered via SSR no-op tests
//   - key(projectId) — covered via stored-key inspection
//
// Lockdown rationale (same as R37/R38/R39):
//   - This is the "you don't lose 5 minutes of form data on upload
//     failure" layer. If saveDraft / loadDraft regress, users silently
//     lose state on retry. No exception, no log line — just a confused
//     user who has to re-type everything.
//   - The 50 KB safety cap on serialized draft is what protects against
//     storing a base64-thumb that pushes localStorage to QuotaExceeded.
//     If the cap silently moves or the fallback (drop fileMeta) breaks,
//     the whole save no-ops on big drafts.
//   - The 7-day expiry is what protects users from being shown stale
//     data from another session. If the expiry check regresses, users
//     see ghost form data weeks later.
//   - Schema versioning (v: 1) is the migration safety net. If a future
//     v2 ships and v1 drafts aren't cleared, deserialization could
//     surface invalid form data shapes.
//
// Mock: globalThis.window.localStorage is a fake in-memory map. Reset
// before each test block.
//
// Zero-dep test runner. PASS / FAIL lines + summary. Exit 1 on failure.

import {
  saveDraft,
  loadDraft,
  clearDraft,
  gcExpiredDrafts,
  makeDebouncedSave,
} from './upload-draft-storage.js';
import type { UploadDraft } from '@deploy-agent/shared';

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

// ─── Fake localStorage harness ────────────────────────────────────────────
//
// Designed to:
//   - Track all set/remove operations (for assertions)
//   - Optionally throw on setItem (simulate quota exceeded / private mode)
//   - Be reset between blocks

type Op = { kind: 'set' | 'remove'; key: string };

interface FakeStorage {
  store: Map<string, string>;
  ops: Op[];
  setShouldThrow: boolean;
  removeShouldThrow: boolean;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

function makeFakeStorage(): FakeStorage {
  const fs: any = {
    store: new Map<string, string>(),
    ops: [] as Op[],
    setShouldThrow: false,
    removeShouldThrow: false,
    getItem(k: string) {
      return fs.store.has(k) ? fs.store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (fs.setShouldThrow) throw new Error('QuotaExceededError');
      fs.store.set(k, v);
      fs.ops.push({ kind: 'set', key: k });
    },
    removeItem(k: string) {
      if (fs.removeShouldThrow) throw new Error('removal failed');
      fs.store.delete(k);
      fs.ops.push({ kind: 'remove', key: k });
    },
    key(i: number) {
      return Array.from(fs.store.keys())[i] ?? null;
    },
    get length() {
      return fs.store.size;
    },
  };
  return fs as FakeStorage;
}

const ORIG_WINDOW = (globalThis as any).window;

function installWindow(localStorage: FakeStorage | null): void {
  if (localStorage === null) {
    delete (globalThis as any).window;
  } else {
    (globalThis as any).window = { localStorage };
  }
}
function restoreWindow(): void {
  if (ORIG_WINDOW === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = ORIG_WINDOW;
}

// Helper: build a storage with `window` installed, run fn, return storage.
function withStorage<T>(fn: (s: FakeStorage) => T): { storage: FakeStorage; result: T } {
  const s = makeFakeStorage();
  installWindow(s);
  try {
    const result = fn(s);
    return { storage: s, result };
  } finally {
    restoreWindow();
  }
}

// ─── isBrowser guard: SSR / no-window must be a no-op for ALL functions ──

{
  installWindow(null);
  // None of these may throw in SSR / no-window environments
  saveDraft('p1', { name: 'x' });
  const got = loadDraft('p1');
  assertEq(got, null, 'no-window: loadDraft returns null');
  clearDraft('p1');
  gcExpiredDrafts();
  // makeDebouncedSave still creates a closure (the debounce timer is
  // process-level; the actual save call no-ops because isBrowser=false)
  const debounced = makeDebouncedSave(1);
  debounced('p1', { name: 'x' });
  assert(true, 'no-window: saveDraft / loadDraft / clearDraft / gcExpiredDrafts / debounced never throw');
  restoreWindow();
}

// ─── saveDraft: writes correct shape under namespaced key ─────────────────

{
  const { storage } = withStorage((s) => {
    saveDraft('proj_42', { name: 'My App', domain: 'example.com' }, {
      name: 'app.zip',
      size: 12345,
      lastModified: 1000,
    });
  });
  assertEq(storage.store.size, 1, 'saveDraft: writes exactly one key');
  const storedKey = Array.from(storage.store.keys())[0];
  assertEq(storedKey, 'wda:upload:draft:proj_42', 'saveDraft: key follows wda:upload:draft:{projectId}');
  const draft = JSON.parse(storage.store.get(storedKey!)!) as UploadDraft;
  assertEq(draft.v, 1, 'saveDraft: stores schema version 1');
  assertEq(draft.projectId, 'proj_42', 'saveDraft: stores projectId');
  assertEq(draft.formData?.name, 'My App', 'saveDraft: stores formData.name');
  assertEq(draft.formData?.domain, 'example.com', 'saveDraft: stores formData.domain');
  assertEq(draft.fileMeta?.name, 'app.zip', 'saveDraft: stores fileMeta.name');
  assertEq(draft.fileMeta?.size, 12345, 'saveDraft: stores fileMeta.size');
  assertEq(draft.fileMeta?.lastModified, 1000, 'saveDraft: stores fileMeta.lastModified');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(draft.savedAt), 'saveDraft: savedAt is ISO 8601');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(draft.expiresAt), 'saveDraft: expiresAt is ISO 8601');
  // expiresAt should be ~7 days after savedAt
  const ttlMs = new Date(draft.expiresAt).getTime() - new Date(draft.savedAt).getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert(
    ttlMs === sevenDaysMs,
    `saveDraft: expiresAt = savedAt + 7 days exactly (got ${ttlMs} ms, want ${sevenDaysMs} ms)`,
  );
}

// ─── saveDraft: handles "new" projectId literal ───────────────────────────

{
  const { storage } = withStorage(() => saveDraft('new', { name: 'fresh' }));
  const storedKey = Array.from(storage.store.keys())[0];
  assertEq(storedKey, 'wda:upload:draft:new', 'saveDraft: key works for "new" projectId');
  const draft = JSON.parse(storage.store.get(storedKey!)!) as UploadDraft;
  assertEq(draft.projectId, 'new', 'saveDraft: stores "new" as projectId literal');
}

// ─── saveDraft: 50 KB cap → drops fileMeta on overflow ────────────────────

{
  // Build a formData blob ~60 KB so the with-fileMeta serialization > 50 KB
  const big = 'x'.repeat(55_000);
  const { storage } = withStorage(() =>
    saveDraft('p1', { name: big }, { name: 'huge.zip', size: 1, lastModified: 1 }),
  );
  const stored = storage.store.get('wda:upload:draft:p1');
  assert(stored !== undefined, 'saveDraft: still wrote something on overflow');
  const draft = JSON.parse(stored!) as UploadDraft;
  assertEq(
    draft.fileMeta,
    undefined,
    'saveDraft: dropped fileMeta when full draft > 50 KB (minimal fallback)',
  );
  assertEq(draft.formData?.name, big, 'saveDraft: minimal fallback STILL preserves formData');
  assertEq(draft.v, 1, 'saveDraft: minimal fallback keeps schema version');
}

// ─── saveDraft: small draft KEEPS fileMeta (cap is upper bound only) ──────

{
  const { storage } = withStorage(() =>
    saveDraft('p1', { name: 'small' }, { name: 'tiny.zip', size: 1, lastModified: 1 }),
  );
  const draft = JSON.parse(storage.store.get('wda:upload:draft:p1')!) as UploadDraft;
  assertEq(draft.fileMeta?.name, 'tiny.zip', 'saveDraft: small draft retains fileMeta');
}

// ─── saveDraft: silent on localStorage throw (private mode / quota) ───────

{
  const s = makeFakeStorage();
  s.setShouldThrow = true;
  installWindow(s);
  let threw = false;
  try {
    saveDraft('p1', { name: 'x' });
  } catch {
    threw = true;
  }
  restoreWindow();
  assert(!threw, 'saveDraft: swallows setItem throw (private mode / quota)');
  assertEq(s.store.size, 0, 'saveDraft: nothing persisted on throw');
}

// ─── loadDraft: returns null when key missing ─────────────────────────────

{
  const { result } = withStorage(() => loadDraft('p1'));
  assertEq(result, null, 'loadDraft: missing key → null');
}

// ─── loadDraft: round-trips a fresh draft ─────────────────────────────────

{
  const { storage, result } = withStorage((s) => {
    saveDraft('p1', { name: 'roundtrip', domain: 'r.example' });
    return loadDraft('p1');
  });
  assert(result !== null, 'loadDraft: round-trip returns non-null');
  assertEq(result?.formData?.name, 'roundtrip', 'loadDraft: round-trip preserves formData.name');
  assertEq(result?.formData?.domain, 'r.example', 'loadDraft: round-trip preserves formData.domain');
  assertEq(result?.projectId, 'p1', 'loadDraft: round-trip preserves projectId');
}

// ─── loadDraft: expired draft → null + auto-removes key ───────────────────

{
  const expired: UploadDraft = {
    v: 1,
    projectId: 'p1',
    formData: { name: 'old' },
    savedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 1).toISOString(), // expired 1 ms ago
  };
  const { storage, result } = withStorage((s) => {
    s.store.set('wda:upload:draft:p1', JSON.stringify(expired));
    return loadDraft('p1');
  });
  assertEq(result, null, 'loadDraft: expired → null');
  assertEq(storage.store.has('wda:upload:draft:p1'), false, 'loadDraft: expired key auto-cleaned');
  assert(
    storage.ops.some((o) => o.kind === 'remove' && o.key === 'wda:upload:draft:p1'),
    'loadDraft: expired triggers removeItem',
  );
}

// ─── loadDraft: schema mismatch (v != 1) → null + auto-removes ───────────

{
  const futureDraft = {
    v: 2,
    projectId: 'p1',
    formData: { name: 'future' },
    savedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1_000_000).toISOString(),
  };
  const { storage, result } = withStorage((s) => {
    s.store.set('wda:upload:draft:p1', JSON.stringify(futureDraft));
    return loadDraft('p1');
  });
  assertEq(result, null, 'loadDraft: v=2 (schema mismatch) → null');
  assertEq(
    storage.store.has('wda:upload:draft:p1'),
    false,
    'loadDraft: schema-mismatch key auto-cleaned',
  );
}

// ─── loadDraft: bad JSON → null (does not throw) ─────────────────────────

{
  const { result } = withStorage((s) => {
    s.store.set('wda:upload:draft:p1', '{not valid json');
    return loadDraft('p1');
  });
  assertEq(result, null, 'loadDraft: malformed JSON → null (no throw)');
}

// ─── loadDraft: bad expiresAt date string → null ─────────────────────────

{
  const badExpiry = {
    v: 1,
    projectId: 'p1',
    formData: { name: 'x' },
    savedAt: new Date().toISOString(),
    expiresAt: 'not a real date',
  };
  const { storage, result } = withStorage((s) => {
    s.store.set('wda:upload:draft:p1', JSON.stringify(badExpiry));
    return loadDraft('p1');
  });
  assertEq(result, null, 'loadDraft: bad expiresAt → null');
  assertEq(
    storage.store.has('wda:upload:draft:p1'),
    false,
    'loadDraft: bad expiresAt key auto-cleaned',
  );
}

// ─── clearDraft: removes the key ──────────────────────────────────────────

{
  const { storage } = withStorage(() => {
    saveDraft('p1', { name: 'x' });
    clearDraft('p1');
  });
  assertEq(storage.store.size, 0, 'clearDraft: key removed');
  assert(
    storage.ops.some((o) => o.kind === 'remove' && o.key === 'wda:upload:draft:p1'),
    'clearDraft: emits removeItem op',
  );
}

// ─── clearDraft: silent if removeItem throws ──────────────────────────────

{
  const s = makeFakeStorage();
  s.removeShouldThrow = true;
  installWindow(s);
  let threw = false;
  try {
    clearDraft('p1');
  } catch {
    threw = true;
  }
  restoreWindow();
  assert(!threw, 'clearDraft: swallows removeItem throw');
}

// ─── gcExpiredDrafts: removes ONLY expired keys, preserves fresh ──────────

{
  const fresh: UploadDraft = {
    v: 1,
    projectId: 'fresh',
    formData: { name: 'fresh' },
    savedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const expired: UploadDraft = {
    v: 1,
    projectId: 'expired',
    formData: { name: 'expired' },
    savedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 1).toISOString(),
  };
  const { storage } = withStorage((s) => {
    s.store.set('wda:upload:draft:fresh', JSON.stringify(fresh));
    s.store.set('wda:upload:draft:expired', JSON.stringify(expired));
    s.store.set('unrelated:other-app:key', 'do-not-touch');
    s.store.set('wda:upload:draft:bad-json', '{garbage');
    s.store.set('wda:upload:draft:bad-expiry', JSON.stringify({ ...fresh, expiresAt: 'nope' }));
    gcExpiredDrafts();
  });
  assert(storage.store.has('wda:upload:draft:fresh'), 'gc: fresh draft preserved');
  assert(!storage.store.has('wda:upload:draft:expired'), 'gc: expired draft removed');
  assert(storage.store.has('unrelated:other-app:key'), 'gc: non-prefix keys untouched');
  assert(!storage.store.has('wda:upload:draft:bad-json'), 'gc: corrupt JSON entry removed');
  assert(!storage.store.has('wda:upload:draft:bad-expiry'), 'gc: bad expiresAt entry removed');
}

// ─── gcExpiredDrafts: silent on storage exception ─────────────────────────

{
  const s = makeFakeStorage();
  // Pretend `length` access throws
  Object.defineProperty(s, 'length', {
    get() {
      throw new Error('storage explosion');
    },
  });
  installWindow(s);
  let threw = false;
  try {
    gcExpiredDrafts();
  } catch {
    threw = true;
  }
  restoreWindow();
  assert(!threw, 'gc: outer try/catch swallows storage exception');
}

// ─── makeDebouncedSave: fires once after delay ────────────────────────────
//
// Use a small but not-zero delay (5ms) so the timer actually clears.

await new Promise<void>((resolve) => {
  const s = makeFakeStorage();
  installWindow(s);
  const debounced = makeDebouncedSave(5);
  debounced('p1', { name: 'first' });
  // Verify NOT saved yet (synchronously)
  assertEq(s.store.size, 0, 'debounced: nothing saved before delay elapses');
  setTimeout(() => {
    assertEq(s.store.size, 1, 'debounced: exactly one save after delay');
    const draft = JSON.parse(s.store.get('wda:upload:draft:p1')!) as UploadDraft;
    assertEq(draft.formData?.name, 'first', 'debounced: saves correct payload');
    restoreWindow();
    resolve();
  }, 30);
});

// ─── makeDebouncedSave: cancels previous timer on rapid retrigger ─────────

await new Promise<void>((resolve) => {
  const s = makeFakeStorage();
  installWindow(s);
  const debounced = makeDebouncedSave(20);
  debounced('p1', { name: 'first' });
  // Schedule a second call before the first fires
  setTimeout(() => debounced('p1', { name: 'second' }), 5);
  // Schedule a third before the second fires
  setTimeout(() => debounced('p1', { name: 'third' }), 10);
  // Wait for the (cancelled) first + second to have fired, then verify
  setTimeout(() => {
    assertEq(s.store.size, 1, 'debounced rapid retrigger: only ONE save lands');
    const draft = JSON.parse(s.store.get('wda:upload:draft:p1')!) as UploadDraft;
    assertEq(draft.formData?.name, 'third', 'debounced rapid retrigger: last value wins');
    // ops history: only one set
    const setOps = s.ops.filter((o) => o.kind === 'set');
    assertEq(setOps.length, 1, 'debounced rapid retrigger: exactly one setItem op recorded');
    restoreWindow();
    resolve();
  }, 80);
});

// ─── makeDebouncedSave: independent debouncers don't share timers ─────────

await new Promise<void>((resolve) => {
  const s = makeFakeStorage();
  installWindow(s);
  const debouncedA = makeDebouncedSave(5);
  const debouncedB = makeDebouncedSave(5);
  debouncedA('p1', { name: 'A' });
  debouncedB('p2', { name: 'B' });
  setTimeout(() => {
    assertEq(s.store.size, 2, 'debounced: independent closures save independently');
    const draftA = JSON.parse(s.store.get('wda:upload:draft:p1')!) as UploadDraft;
    const draftB = JSON.parse(s.store.get('wda:upload:draft:p2')!) as UploadDraft;
    assertEq(draftA.formData?.name, 'A', 'debounced: A landed for p1');
    assertEq(draftB.formData?.name, 'B', 'debounced: B landed for p2');
    restoreWindow();
    resolve();
  }, 30);
});

// ─── makeDebouncedSave: default delay (500ms) is the documented default ──

{
  // We don't actually wait 500 ms — just verify the closure exists and
  // accepts the call. Functional behavior already verified at delay=5/20.
  const s = makeFakeStorage();
  installWindow(s);
  const debounced = makeDebouncedSave(); // no arg → default
  debounced('p1', { name: 'x' });
  assert(typeof debounced === 'function', 'makeDebouncedSave: returns a function with default delay');
  restoreWindow();
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
