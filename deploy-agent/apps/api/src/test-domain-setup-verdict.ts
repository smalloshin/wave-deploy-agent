/**
 * Tests for domain-setup-verdict (round 17).
 *
 * Run: tsx src/test-domain-setup-verdict.ts
 *
 * Sections:
 *   1. Four verdict kinds (mapping/dns/cleanup matrix).
 *   2. verdictToSetupResult legacy-shape mapping.
 *   3. Regression guards (errorCode contract, phase ordering, conflict
 *      passthrough, message content invariants, defensive paths).
 *   4. Round-17-specific bug invariants (orphan must surface as critical,
 *      cleanup-success must NOT be critical, conflict carried through to
 *      route).
 */

import {
  buildDomainSetupVerdict,
  verdictToSetupResult,
  type CleanupOutcome,
  type DnsOutcome,
  type DomainSetupVerdict,
  type MappingOutcome,
} from './services/domain-setup-verdict';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: unknown, name: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

function assertEq<T>(actual: T, expected: T, name: string): void {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── helpers ───
const FQDN = 'kol-studio.punwave.com';

function mappingOk(): MappingOutcome {
  return { ok: true, error: null, conflict: null };
}
function mappingFail(error = 'mapping went boom'): MappingOutcome {
  return { ok: false, error, conflict: null };
}
function mappingConflict(existingRoute = 'old-service'): MappingOutcome {
  return {
    ok: false,
    error: `Domain ${FQDN} is already mapped to service "${existingRoute}". Pass force=true to replace.`,
    conflict: { existingRoute },
  };
}
function dnsOk(recordId = 'rec_abc'): DnsOutcome {
  return { ok: true, fqdn: FQDN, recordId, error: null };
}
function dnsFail(error = 'cloudflare 403'): DnsOutcome {
  return { ok: false, fqdn: FQDN, recordId: null, error };
}
function cleanupOk(): CleanupOutcome {
  return { ok: true, error: null };
}
function cleanupFail(error = 'GCP DELETE 500'): CleanupOutcome {
  return { ok: false, error };
}

// ─── Section 1: Four verdict kinds ───
console.log('\n=== Section 1: Verdict kinds ===');

// 1a — success
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsOk(),
    cleanup: null,
  });
  assertEq(v.kind, 'success', '1a.kind = success');
  assertEq(v.logLevel, 'info', '1a.logLevel = info');
  if (v.kind === 'success') {
    assertEq(v.fqdn, FQDN, '1a.fqdn');
    assertEq(v.customUrl, `https://${FQDN}`, '1a.customUrl');
  }
}

// 1b — mapping-failed (no DNS attempted)
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingFail('weird gcp 500'),
    dns: null,
    cleanup: null,
  });
  assertEq(v.kind, 'mapping-failed', '1b.kind = mapping-failed');
  assertEq(v.logLevel, 'warn', '1b.logLevel = warn');
  if (v.kind === 'mapping-failed') {
    assertEq(v.mappingError, 'weird gcp 500', '1b.mappingError');
    assertEq(v.conflict, null, '1b.conflict = null');
  }
}

// 1c — mapping-failed with conflict
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingConflict('legacy-app'),
    dns: null,
    cleanup: null,
  });
  assertEq(v.kind, 'mapping-failed', '1c.kind = mapping-failed');
  if (v.kind === 'mapping-failed') {
    assert(v.conflict !== null, '1c.conflict not null');
    assertEq(v.conflict?.existingRoute, 'legacy-app', '1c.conflict.existingRoute');
  }
}

// 1d — dns-failed-after-mapping, cleanup OK (warn)
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail('rate limited'),
    cleanup: cleanupOk(),
  });
  assertEq(v.kind, 'dns-failed-after-mapping', '1d.kind');
  assertEq(v.logLevel, 'warn', '1d.logLevel = warn (cleanup ok)');
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.cleanupOk, true, '1d.cleanupOk');
    assertEq(v.cleanupError, null, '1d.cleanupError = null');
    assertEq(v.errorCode, null, '1d.errorCode = null (no orphan)');
    assertEq(v.requiresManualCleanup, false, '1d.requiresManualCleanup = false');
    assertEq(v.dnsError, 'rate limited', '1d.dnsError');
  }
}

// 1e — dns-failed-after-mapping, cleanup FAILED (CRITICAL)
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail('cloudflare 403'),
    cleanup: cleanupFail('orphan delete 500'),
  });
  assertEq(v.kind, 'dns-failed-after-mapping', '1e.kind');
  assertEq(v.logLevel, 'critical', '1e.logLevel = critical');
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.cleanupOk, false, '1e.cleanupOk = false');
    assertEq(v.cleanupError, 'orphan delete 500', '1e.cleanupError');
    assertEq(v.errorCode, 'domain_mapping_orphan', '1e.errorCode');
    assertEq(v.requiresManualCleanup, true, '1e.requiresManualCleanup = true');
  }
}

// 1f — dns-failed-after-mapping, cleanup not attempted (treated as failed)
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: null,
  });
  assertEq(v.kind, 'dns-failed-after-mapping', '1f.kind');
  assertEq(v.logLevel, 'critical', '1f.logLevel = critical (no cleanup attempted)');
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.cleanupOk, false, '1f.cleanupOk = false');
    assertEq(v.errorCode, 'domain_mapping_orphan', '1f.errorCode');
    assertEq(v.requiresManualCleanup, true, '1f.requiresManualCleanup');
  }
}

// 1g — defensive: mapping-and-dns-both-failed
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingFail('m err'),
    dns: dnsFail('d err'),
    cleanup: null,
  });
  assertEq(v.kind, 'mapping-and-dns-both-failed', '1g.kind');
  assertEq(v.logLevel, 'warn', '1g.logLevel');
  if (v.kind === 'mapping-and-dns-both-failed') {
    assertEq(v.mappingError, 'm err', '1g.mappingError');
    assertEq(v.dnsError, 'd err', '1g.dnsError');
  }
}

// 1h — defensive: mapping-and-dns-both-failed with conflict carried
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingConflict('other'),
    dns: dnsFail('d err'),
    cleanup: null,
  });
  assertEq(v.kind, 'mapping-and-dns-both-failed', '1h.kind');
  if (v.kind === 'mapping-and-dns-both-failed') {
    assert(v.conflict !== null, '1h.conflict carried through');
    assertEq(v.conflict?.existingRoute, 'other', '1h.conflict.existingRoute');
  }
}

// 1i — defensive: null mapping error becomes 'unknown mapping error'
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: { ok: false, error: null, conflict: null },
    dns: null,
    cleanup: null,
  });
  if (v.kind === 'mapping-failed') {
    assertEq(v.mappingError, 'unknown mapping error', '1i.null mapping error fallback');
  } else {
    assert(false, '1i.kind = mapping-failed');
  }
}

// 1j — defensive: null dns error becomes 'unknown dns error'
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: { ok: false, fqdn: FQDN, recordId: null, error: null },
    cleanup: cleanupFail(),
  });
  if (v.kind === 'dns-failed-after-mapping') {
    assert(v.dnsError === 'unknown dns error', '1j.null dns error fallback');
  } else {
    assert(false, '1j.kind = dns-failed-after-mapping');
  }
}

// ─── Section 2: verdictToSetupResult ───
console.log('\n=== Section 2: verdictToSetupResult ===');

// 2a — success → success=true, customUrl set, error=null, no conflict field
{
  const v: DomainSetupVerdict = {
    kind: 'success',
    logLevel: 'info',
    fqdn: FQDN,
    customUrl: `https://${FQDN}`,
    message: 'ok',
  };
  const r = verdictToSetupResult(v);
  assertEq(r.success, true, '2a.success');
  assertEq(r.customUrl, `https://${FQDN}`, '2a.customUrl');
  assertEq(r.error, null, '2a.error null');
  assertEq(r.conflict, undefined, '2a.no conflict field');
}

// 2b — mapping-failed → success=false, customUrl='', error set, conflict=undefined
{
  const v: DomainSetupVerdict = {
    kind: 'mapping-failed',
    logLevel: 'warn',
    fqdn: FQDN,
    mappingError: 'gcp 500',
    conflict: null,
    message: 'Domain mapping failed: gcp 500',
  };
  const r = verdictToSetupResult(v);
  assertEq(r.success, false, '2b.success = false');
  assertEq(r.customUrl, '', '2b.customUrl empty');
  assertEq(r.error, 'Domain mapping failed: gcp 500', '2b.error');
  assertEq(r.conflict, undefined, '2b.conflict undefined when null');
}

// 2c — mapping-failed with conflict → conflict carried through
{
  const v: DomainSetupVerdict = {
    kind: 'mapping-failed',
    logLevel: 'warn',
    fqdn: FQDN,
    mappingError: 'already mapped',
    conflict: { existingRoute: 'old-svc' },
    message: 'Domain mapping failed: already mapped',
  };
  const r = verdictToSetupResult(v);
  assertEq(r.success, false, '2c.success');
  assert(r.conflict !== undefined, '2c.conflict present');
  assertEq(r.conflict?.existingRoute, 'old-svc', '2c.conflict.existingRoute');
}

// 2d — dns-failed-after-mapping → success=false, error set, no conflict field
{
  const v: DomainSetupVerdict = {
    kind: 'dns-failed-after-mapping',
    logLevel: 'critical',
    fqdn: FQDN,
    dnsError: 'cf 403',
    cleanupOk: false,
    cleanupError: 'cleanup 500',
    errorCode: 'domain_mapping_orphan',
    requiresManualCleanup: true,
    message: 'orphan!',
  };
  const r = verdictToSetupResult(v);
  assertEq(r.success, false, '2d.success false');
  assertEq(r.customUrl, '', '2d.customUrl empty');
  assertEq(r.error, 'orphan!', '2d.error from message');
  assertEq(r.conflict, undefined, '2d.no conflict field');
}

// 2e — mapping-and-dns-both-failed with conflict → conflict carried
{
  const v: DomainSetupVerdict = {
    kind: 'mapping-and-dns-both-failed',
    logLevel: 'warn',
    fqdn: FQDN,
    mappingError: 'm',
    dnsError: 'd',
    conflict: { existingRoute: 'svc-x' },
    message: 'both failed',
  };
  const r = verdictToSetupResult(v);
  assertEq(r.success, false, '2e.success');
  assert(r.conflict !== undefined, '2e.conflict carried');
  assertEq(r.conflict?.existingRoute, 'svc-x', '2e.conflict.existingRoute');
}

// 2f — mapping-and-dns-both-failed without conflict → conflict undefined
{
  const v: DomainSetupVerdict = {
    kind: 'mapping-and-dns-both-failed',
    logLevel: 'warn',
    fqdn: FQDN,
    mappingError: 'm',
    dnsError: 'd',
    conflict: null,
    message: 'both failed',
  };
  const r = verdictToSetupResult(v);
  assertEq(r.conflict, undefined, '2f.no conflict when null');
}

// ─── Section 3: Regression guards ───
console.log('\n=== Section 3: Regression guards ===');

// 3a — errorCode is the exact string the dashboard expects
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail(),
  });
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.errorCode, 'domain_mapping_orphan', '3a.errorCode contract');
  } else {
    assert(false, '3a.kind');
  }
}

// 3b — errorCode is null when cleanup succeeded (no orphan to surface)
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupOk(),
  });
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.errorCode, null, '3b.errorCode null when no orphan');
  }
}

// 3c — requiresManualCleanup uses literal `true` for narrowing
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail(),
  });
  if (v.kind === 'dns-failed-after-mapping' && v.requiresManualCleanup) {
    // TypeScript should narrow here. If this compiles, the discriminator works.
    assertEq(v.errorCode, 'domain_mapping_orphan', '3c.literal-true narrowing');
  } else {
    assert(false, '3c.discriminator narrowing');
  }
}

// 3d — message includes fqdn so operator can grep logs
{
  const v = buildDomainSetupVerdict({
    fqdn: 'test.example.com',
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail(),
  });
  assert(v.message.includes('test.example.com'), '3d.message includes fqdn');
}

// 3e — cleanup-failed message tells operator what to do
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail(),
  });
  assert(v.message.toLowerCase().includes('manual'), '3e.message mentions manual cleanup');
  assert(v.message.toLowerCase().includes('cloud run console') || v.message.toLowerCase().includes('console'),
    '3e.message points at console');
}

// 3f — cleanup-OK message says "safe to retry"
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupOk(),
  });
  assert(v.message.toLowerCase().includes('retry') || v.message.toLowerCase().includes('safe'),
    '3f.message reassures');
}

// 3g — phase ordering: mapping-failed surfaces even if dns is unset
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingFail(),
    dns: null,
    cleanup: null,
  });
  assertEq(v.kind, 'mapping-failed', '3g.phase ordering');
}

// 3h — defensive inconsistent input: mapping=false + dns=ok → mapping-failed
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: { ok: false, error: 'm', conflict: null },
    dns: dnsOk(),
    cleanup: null,
  });
  // The if-branch checks (!mapping.ok && (!dns || !dns.ok)) which is
  // false here (dns.ok=true). Then mapping.ok && (!dns || !dns.ok) is
  // false. Then mapping.ok && dns.ok is false. Falls into defensive branch.
  assertEq(v.kind, 'mapping-failed', '3h.defensive inconsistent → mapping-failed');
}

// 3i — success message identifies which steps succeeded
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsOk(),
    cleanup: null,
  });
  assert(v.message.toLowerCase().includes('live') || v.message.toLowerCase().includes('ok'),
    '3i.success message');
}

// 3j — every kind has a non-empty message
{
  const variants: Array<{ name: string; v: DomainSetupVerdict }> = [
    {
      name: 'success',
      v: buildDomainSetupVerdict({
        fqdn: FQDN, mapping: mappingOk(), dns: dnsOk(), cleanup: null,
      }),
    },
    {
      name: 'mapping-failed',
      v: buildDomainSetupVerdict({
        fqdn: FQDN, mapping: mappingFail(), dns: null, cleanup: null,
      }),
    },
    {
      name: 'dns-failed-after-mapping(cleanup-ok)',
      v: buildDomainSetupVerdict({
        fqdn: FQDN, mapping: mappingOk(), dns: dnsFail(), cleanup: cleanupOk(),
      }),
    },
    {
      name: 'dns-failed-after-mapping(cleanup-failed)',
      v: buildDomainSetupVerdict({
        fqdn: FQDN, mapping: mappingOk(), dns: dnsFail(), cleanup: cleanupFail(),
      }),
    },
    {
      name: 'mapping-and-dns-both-failed',
      v: buildDomainSetupVerdict({
        fqdn: FQDN, mapping: mappingFail(), dns: dnsFail(), cleanup: null,
      }),
    },
  ];
  for (const variant of variants) {
    assert(typeof variant.v.message === 'string' && variant.v.message.length > 0,
      `3j.${variant.name} has non-empty message`);
  }
}

// 3k — logLevel is one of 'info' | 'warn' | 'critical'
{
  const variants = [
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingOk(), dns: dnsOk(), cleanup: null }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingFail(), dns: null, cleanup: null }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingOk(), dns: dnsFail(), cleanup: cleanupOk() }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingOk(), dns: dnsFail(), cleanup: cleanupFail() }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingFail(), dns: dnsFail(), cleanup: null }),
  ];
  for (const v of variants) {
    assert(['info', 'warn', 'critical'].includes(v.logLevel), `3k.${v.kind} logLevel valid`);
  }
}

// ─── Section 4: Round-17-specific bug regressions ───
console.log('\n=== Section 4: Round-17 bug regressions ===');

// 4a — the exact bug: cloud run mapping ok, cloudflare cname fails, NO
//      cleanup happened (legacy behavior that round 17 fixes). Verdict
//      MUST be critical with errorCode set so the operator sees it.
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail('cloudflare API key invalid'),
    cleanup: null, // legacy code never attempted cleanup
  });
  assertEq(v.kind, 'dns-failed-after-mapping', '4a.kind');
  assertEq(v.logLevel, 'critical', '4a.legacy no-cleanup → critical');
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.errorCode, 'domain_mapping_orphan', '4a.errorCode');
    assertEq(v.requiresManualCleanup, true, '4a.requiresManualCleanup');
  }
}

// 4b — the round-17 fix: same scenario but with successful cleanup. Verdict
//      MUST drop to warn — orphan is gone, retry is safe.
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail('cloudflare API key invalid'),
    cleanup: cleanupOk(),
  });
  assertEq(v.logLevel, 'warn', '4b.cleanup-ok → warn');
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.errorCode, null, '4b.errorCode cleared');
    assertEq(v.requiresManualCleanup, false, '4b.no manual cleanup needed');
  }
}

// 4c — conflict object passes through verdictToSetupResult unchanged so
//      route handlers and dashboards can render the structured conflict
//      info without parsing strings.
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingConflict('billing-app'),
    dns: null,
    cleanup: null,
  });
  const r = verdictToSetupResult(v);
  assert(r.conflict !== undefined, '4c.conflict survived translation');
  assertEq(r.conflict?.existingRoute, 'billing-app', '4c.existingRoute preserved');
}

// 4d — cleanupError is a STRING (operator-readable), not an Error object
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail('socket hang up'),
  });
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.cleanupError, 'socket hang up', '4d.cleanupError is string');
  }
}

// 4e — cleanupError null when cleanup succeeded
{
  const v = buildDomainSetupVerdict({
    fqdn: FQDN,
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupOk(),
  });
  if (v.kind === 'dns-failed-after-mapping') {
    assertEq(v.cleanupError, null, '4e.cleanupError null on success');
  }
}

// 4f — different fqdns produce different messages (no hardcoded fqdn)
{
  const v1 = buildDomainSetupVerdict({
    fqdn: 'one.example.com',
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail(),
  });
  const v2 = buildDomainSetupVerdict({
    fqdn: 'two.example.com',
    mapping: mappingOk(),
    dns: dnsFail(),
    cleanup: cleanupFail(),
  });
  assert(v1.message !== v2.message, '4f.fqdn flows into message');
  assert(v1.message.includes('one.example.com'), '4f.v1 has correct fqdn');
  assert(v2.message.includes('two.example.com'), '4f.v2 has correct fqdn');
}

// 4g — fqdn flows into success.customUrl
{
  const v = buildDomainSetupVerdict({
    fqdn: 'kpis.dashboard.io',
    mapping: mappingOk(),
    dns: dnsOk(),
    cleanup: null,
  });
  if (v.kind === 'success') {
    assertEq(v.customUrl, 'https://kpis.dashboard.io', '4g.customUrl built from fqdn');
  }
}

// 4h — verdictToSetupResult never throws on any verdict shape (exhaustive switch)
{
  const verdicts: DomainSetupVerdict[] = [
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingOk(), dns: dnsOk(), cleanup: null }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingFail(), dns: null, cleanup: null }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingConflict(), dns: null, cleanup: null }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingOk(), dns: dnsFail(), cleanup: cleanupOk() }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingOk(), dns: dnsFail(), cleanup: cleanupFail() }),
    buildDomainSetupVerdict({ fqdn: FQDN, mapping: mappingFail(), dns: dnsFail(), cleanup: null }),
  ];
  let threw = false;
  for (const v of verdicts) {
    try {
      verdictToSetupResult(v);
    } catch (e) {
      threw = true;
      console.log(`    ! threw on kind=${v.kind}: ${(e as Error).message}`);
    }
  }
  assert(!threw, '4h.verdictToSetupResult never throws');
}

// ─── Summary ───
console.log('\n──────────────────────────');
console.log(`Pass: ${pass}`);
console.log(`Fail: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\nAll tests passed.');
