// Zod schemas for ScanReport persistence boundary.
//
// Why this file exists:
//   rowToScanReport() in orchestrator.ts reads findings/autoFixes from DB JSON
//   columns. The original code used `as unknown as ScanReport['findings']` to
//   skip validation. That cast hides three real failure modes:
//
//   1. Schema drift — we change ScanFinding's shape but old scan rows in the DB
//      still have the old shape. UI breaks silently because the cast lies to
//      TypeScript.
//   2. LLM analysis drift — llm_analysis column carries LLM output, which is
//      structurally unpredictable. Without validation, malformed LLM findings
//      are merged into the same array as semgrep/trivy findings and break
//      downstream rendering (severity icon, action button) with no log line.
//   3. Migration bugs — a bad UPSERT writes partial data; we read it back as
//      if it were valid; downstream consumers crash on `finding.severity`.
//
// What this does:
//   - Defines per-item schemas matching the @deploy-agent/shared types
//   - parseFindings() / parseAutoFixes() use safeParse PER ITEM, drop invalid
//     entries with one warn-log, return only the valid ones
//   - "Drop and continue" not "throw" — a malformed finding shouldn't kill the
//     entire scan response. The reviewer sees fewer items + a server log.
//
// Where this is used:
//   orchestrator.ts:rowToScanReport() — only place. If you add another DB-read
//   path that reconstructs a ScanReport, route it through here too.

import { z } from 'zod';
import type { ScanFinding, AutoFixRecord } from '@deploy-agent/shared';

// Mirror types.ts: 'critical' | 'high' | 'medium' | 'low' | 'info'
const ScanSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

// Mirror types.ts: 'auto_fix' | 'report_only'
const AutoFixActionSchema = z.enum(['auto_fix', 'report_only']);

// Mirror ScanFinding (types.ts:157)
//
// Each field uses the loosest schema that still catches drift:
//   - tool: literal union — wrong values are real bugs, fail loud
//   - severity / action: literal union — same
//   - lineStart/lineEnd: number, finite (NaN would crash UI math)
//   - everything else: string with a default of '' so a missing field becomes ''
//     (matches the original `?? ''` fallbacks in scanner.ts)
const ScanFindingSchema: z.ZodType<ScanFinding> = z.object({
  id: z.string(),
  tool: z.enum(['semgrep', 'trivy', 'llm']),
  category: z.string(),
  severity: ScanSeveritySchema,
  title: z.string(),
  description: z.string(),
  filePath: z.string(),
  lineStart: z.number().finite(),
  lineEnd: z.number().finite(),
  action: AutoFixActionSchema,
  fix: z
    .object({
      applied: z.boolean(),
      diff: z.string(),
      explanation: z.string(),
      verificationPassed: z.boolean().nullable(),
    })
    .optional(),
});

// Mirror AutoFixRecord (types.ts:191) — every field optional except explanation
const AutoFixRecordSchema: z.ZodType<AutoFixRecord> = z.object({
  findingId: z.string().optional(),
  filePath: z.string().optional(),
  originalCode: z.string().optional(),
  fixedCode: z.string().optional(),
  explanation: z.string(),
  applied: z.boolean().optional(),
  diff: z.string().optional(),
});

/**
 * Validate a list of unknown values against ScanFindingSchema. Drop invalid
 * entries with a single warn log (one per drop, not one summary — easier to
 * grep when debugging). Always returns a valid ScanFinding[].
 */
export function parseFindings(raw: unknown[], context: string): ScanFinding[] {
  const valid: ScanFinding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = ScanFindingSchema.safeParse(raw[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.warn(
        `[scan-report:${context}] dropped malformed finding[${i}]: ${result.error.issues
          .map(e => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}`,
      );
    }
  }
  return valid;
}

/**
 * Same idea for AutoFixRecord. Drop-and-warn on malformed entries.
 */
export function parseAutoFixes(raw: unknown[], context: string): AutoFixRecord[] {
  const valid: AutoFixRecord[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = AutoFixRecordSchema.safeParse(raw[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.warn(
        `[scan-report:${context}] dropped malformed autoFix[${i}]: ${result.error.issues
          .map(e => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}`,
      );
    }
  }
  return valid;
}
