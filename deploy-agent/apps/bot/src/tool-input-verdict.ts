// Tool-input validator for the Discord NL bot.
//
// Why a verdict module:
//   The LLM (Claude or GPT) emits tool calls as `{ name, input }` JSON.
//   The input is whatever the model decided to pass — there's no
//   guarantee it matches the tool schema. A confused model could send
//   `{ project: 12345, version: "latest" }` against publish_version
//   (project should be string, version should be int). Without
//   validation that goes straight to executeTool, which would either
//   throw a confusing TypeError or silently coerce the wrong field.
//
//   Worse: a prompt-injected LLM could emit a tool call with input
//   crafted to exploit downstream code (e.g. version=Number.MAX_VALUE
//   to wedge a query, or project containing path-traversal-like
//   characters). The zod schemas below cap string lengths and require
//   positive ints — first line of defense against malformed/malicious
//   tool input.
//
// Pattern: pure function, discriminated union return, zero side
// effects. Mirrors the verdict-module pattern used in round 21/23/24/25.
//
// Caller (nl-handler.ts) runs validateToolInput BEFORE the allowlist
// check and BEFORE confirmation flow. Invalid → reply with the zod
// errors, log audit as 'denied', skip executeTool entirely.

import { z } from 'zod';

// ─── Per-tool schemas ───────────────────────────────────────
//
// Each tool from TOOLS in nl-handler.ts gets a schema. Schemas cap
// string lengths to defuse prompt-injection bombs (e.g. a 50KB project
// name) and require positive ints for version numbers.

const SchemaListProjects = z.object({}).strict();

const SchemaGetProjectStatus = z.object({
  project: z.string().min(1).max(120),
}).strict();

const SchemaApproveDeploy = z.object({
  project: z.string().min(1).max(120),
  comments: z.string().max(500).optional(),
}).strict();

const SchemaRejectDeploy = z.object({
  project: z.string().min(1).max(120),
  reason: z.string().max(500).optional(),
}).strict();

const SchemaPublishVersion = z.object({
  project: z.string().min(1).max(120),
  version: z.number().int().positive(),
}).strict();

const SchemaRollbackVersion = z.object({
  project: z.string().min(1).max(120),
  version: z.number().int().positive().optional(),
}).strict();

const SchemaToggleDeployLock = z.object({
  project: z.string().min(1).max(120),
}).strict();

const SchemaDeleteProject = z.object({
  project: z.string().min(1).max(120),
}).strict();

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  list_projects: SchemaListProjects,
  get_project_status: SchemaGetProjectStatus,
  approve_deploy: SchemaApproveDeploy,
  reject_deploy: SchemaRejectDeploy,
  publish_version: SchemaPublishVersion,
  rollback_version: SchemaRollbackVersion,
  toggle_deploy_lock: SchemaToggleDeployLock,
  delete_project: SchemaDeleteProject,
};

// ─── Verdict ─────────────────────────────────────────────────

export type ToolInputVerdict<T = unknown> =
  | { kind: 'valid'; value: T }
  | { kind: 'invalid'; errors: string[] };

/**
 * Validate a tool call's input against the registered zod schema for
 * that tool. Pure function — no side effects.
 *
 * Unknown tool names return `{ kind: 'invalid', errors: ['Unknown tool: …'] }`
 * so a hallucinated tool from the LLM also gets rejected here (rather
 * than falling through to executeTool's `default` case).
 */
export function validateToolInput(
  toolName: string,
  input: unknown,
): ToolInputVerdict {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    return {
      kind: 'invalid',
      errors: [`Unknown tool: ${toolName}`],
    };
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return { kind: 'valid', value: result.data };
  }

  // Flatten zod errors into one-line strings: "field: message".
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  return { kind: 'invalid', errors };
}
