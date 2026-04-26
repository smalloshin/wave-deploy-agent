/**
 * RBAC Phase 1 — owner-or-admin check helper.
 *
 * The plumbing layer between route handlers and access-denied-verdict.
 * Each destructive route handler calls `requireOwnerOrAdmin(req, reply,
 * project, action)` AFTER `getProject(id)` returns a row, BEFORE the
 * destructive action.
 *
 * Returns `{ ok: true }` on grant; on deny, ALREADY sends the HTTP
 * reply (401 / 403 with errorCode envelope) and returns `{ ok: false }`
 * — caller short-circuits with `return`.
 *
 * Audit log writes go through the same `logAuth` helper that
 * middleware/auth.ts uses, so dashboards see consistent shape:
 *   { action: 'admin_override' | 'permission_denied' | 'anonymous_request'
 *     | 'legacy_unowned_access', resource: '<METHOD>:/path', ... }
 *
 * Failure surface (NOT silent):
 *   - 401 + JSON envelope { error: 'auth_required', ... } when anonymous in enforced mode
 *   - 403 + JSON envelope { error: 'not_owner', ... } when authenticated non-owner non-admin
 *   - WARN log + audit row in every case where a non-trivial path was taken
 *
 * Mirrors the round-21 IAM and round-24 url-env-redeploy verdict
 * orchestration helpers: caller passes inputs, helper builds verdict +
 * logs + side-effects (audit + reply), returns boolean for control flow.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Project } from '@deploy-agent/shared';
import {
  buildAccessVerdict,
  logAccessVerdict,
  isGranted,
  type AccessCheckInput,
  type AccessVerdict,
} from './access-denied-verdict.js';
import { logAuth } from './auth-service.js';

export interface OwnerCheckResult {
  ok: boolean;
  verdict: AccessVerdict;
}

/** The full check: build verdict, log, audit, reply if denied.
 *
 *  Caller pattern:
 *    const owner = await requireOwnerOrAdmin(request, reply, project, 'delete');
 *    if (!owner.ok) return;  // reply already sent
 *    // ... proceed with destructive action ...
 */
export async function requireOwnerOrAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  project: Pick<Project, 'id' | 'ownerId'>,
  action: string,
): Promise<OwnerCheckResult> {
  const mode = (process.env.AUTH_MODE ?? 'permissive') as 'permissive' | 'enforced';
  const auth = request.auth;

  const verdictInput: AccessCheckInput = {
    mode,
    via: auth.via,
    actorUserId: auth.user?.id ?? null,
    actorEmail: auth.user?.email ?? null,
    actorRoleName: auth.user?.role_name ?? null,
    resourceOwnerId: project.ownerId,
    resourceId: project.id,
    resourceKind: 'project',
    action,
  };

  const verdict = buildAccessVerdict(verdictInput);
  logAccessVerdict(verdict);

  // Audit log for every non-trivial path (skip granted-as-owner since
  // owner self-action is the common case and would flood the log).
  if (verdict.kind !== 'granted-as-owner') {
    await safeLogAuth({
      user_id: auth.user?.id ?? null,
      action: extractAuditAction(verdict),
      resource: `${request.method}:${request.url.split('?')[0]}`,
      ip_address: extractClientIp(request),
      metadata: {
        verdictKind: verdict.kind,
        resourceId: project.id,
        resourceKind: 'project',
        action,
        resourceOwnerId: project.ownerId,
        ...(verdict.kind === 'granted-as-admin' || verdict.kind === 'granted-legacy-unowned'
          ? { override: true }
          : {}),
      },
    });
  }

  if (!isGranted(verdict)) {
    // verdict is one of: denied-anonymous (401) | denied-not-owner (403)
    if (verdict.kind === 'denied-anonymous' || verdict.kind === 'denied-not-owner') {
      reply.status(verdict.httpStatus).send({
        error: verdict.errorCode,
        message: verdict.message,
        resourceId: project.id,
      });
    } else {
      // Defensive: shouldn't happen because isGranted covers all 4 grant kinds
      reply.status(403).send({ error: 'access_denied', message: verdict.message });
    }
    return { ok: false, verdict };
  }

  return { ok: true, verdict };
}

/** Extracts the audit action string for logAuth. Different from the
 *  verdict.kind — verdict is internal taxonomy, audit action is the
 *  string that goes into auth_audit_log.action column for dashboards. */
function extractAuditAction(verdict: AccessVerdict): string {
  switch (verdict.kind) {
    case 'granted-as-owner':
      return 'owner_action'; // unused (we skip audit for this kind), defensive
    case 'granted-as-admin':
      return verdict.auditAction;
    case 'granted-permissive-anonymous':
      return verdict.auditAction;
    case 'granted-legacy-unowned':
      return verdict.auditAction;
    case 'denied-anonymous':
      return verdict.auditAction;
    case 'denied-not-owner':
      return verdict.auditAction;
  }
}

/** Best-effort audit log. Never throws — audit log failure must NOT
 *  abort the request. */
async function safeLogAuth(entry: {
  user_id: string | null;
  action: string;
  resource: string;
  ip_address: string | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await logAuth(entry);
  } catch (err) {
    console.warn(
      `[Access] audit log write failed (continuing): ${(err as Error).message}`,
    );
  }
}

function extractClientIp(req: FastifyRequest): string | null {
  // Prefer X-Forwarded-For first hop (Cloud Run sets it).
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  return req.ip || null;
}
