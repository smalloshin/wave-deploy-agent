/**
 * Access verdict — RBAC Phase 1 (owner-or-admin gate).
 *
 * Why this is its own file:
 *   The auth middleware (middleware/auth.ts) does the COARSE filter:
 *     - public route? skip
 *     - anonymous + permissive? allow with log
 *     - anonymous + enforced? 401
 *     - has role-permission for this route? continue : 403
 *
 *   But role-permission is per-ROUTE, not per-RESOURCE. Anyone with
 *   `projects:delete` (today: only admin) could before this round delete
 *   ANY project. With the eventual multi-user world, a non-admin with
 *   `projects:delete` would be able to delete projects they don't own.
 *
 *   This module is the per-resource second hop. It runs INSIDE each
 *   destructive route handler, AFTER `getProject(id)` returns a row,
 *   BEFORE the destructive action. Inputs:
 *     - actor identity (req.auth.user.id, role, email, via)
 *     - mode (permissive vs enforced)
 *     - resource owner_id (project.owner_id; may be NULL for legacy rows)
 *
 *   Output: discriminated union with 6 kinds. Caller (owner-check.ts)
 *   maps each kind to (a) HTTP status if denied, (b) audit log entry,
 *   (c) console line.
 *
 *   Six kinds:
 *
 *     1. `granted-as-owner` — actor.id === resource.owner_id. Common
 *        path; info log only (no audit row needed for self-action).
 *
 *     2. `granted-as-admin` — actor.role_name === 'admin'. Override path:
 *        admins can act on anyone's resources, including unowned legacy
 *        rows. logLevel=info but auditAction='admin_override' so the
 *        audit log captures admin reaches across user boundaries (a
 *        compliance requirement once we have >1 user).
 *
 *     3. `granted-permissive-anonymous` — mode=permissive AND no actor.
 *        We can't owner-check because there's no actor.id. Allowed but
 *        WARN-logged so flip-day audit can count remaining anonymous
 *        traffic. auditAction='anonymous_request'.
 *
 *     4. `granted-legacy-unowned` — actor IS admin AND resource.owner_id
 *        IS NULL. Subset of granted-as-admin but distinct kind so logs
 *        can flag "we touched a row that should have been backfilled".
 *        auditAction='legacy_unowned_access'. CRITICAL: non-admins on
 *        unowned rows go to denied-not-owner, NOT here. Otherwise an
 *        un-backfilled row would silently grant access to everyone.
 *
 *     5. `denied-anonymous` — mode=enforced AND no actor. 401.
 *        errorCode='auth_required'. Emitted from owner-check helper
 *        because middleware already 401'd before reaching us in
 *        practice; this exists for cases where the route bypassed
 *        middleware (e.g. internal callers wrongly invoking the helper).
 *
 *     6. `denied-not-owner` — actor authenticated, NOT admin, NOT owner.
 *        403. errorCode='not_owner'. auditAction='permission_denied'.
 *        Carries actorEmail + resourceOwnerId for log forensics.
 *
 *   Verdict shape mirrors round 21 / 23 / 24 verdicts: pure function,
 *   no DB / no Fastify imports, fully testable with synthetic inputs.
 *
 *   Like round 21 IAM and round 24 url-env-redeploy, deny verdicts have
 *   `httpStatus` field instead of a `blockDeploy` flag — the request is
 *   already mid-handler, the operator-facing response is the HTTP error.
 */

export interface AccessCheckInput {
  /** Auth mode at the time of the check. */
  mode: 'permissive' | 'enforced';
  /** How the actor authenticated. 'anonymous' = no auth resolved. */
  via: 'session' | 'api_key' | 'anonymous';
  /** Actor's user UUID. null when anonymous. */
  actorUserId: string | null;
  /** Actor's email. null when anonymous. */
  actorEmail: string | null;
  /** Actor's role name. 'admin' grants override on any resource. */
  actorRoleName: string | null;
  /** Resource owner's UUID. null = legacy unbackfilled row. */
  resourceOwnerId: string | null;
  /** Resource UUID — for audit metadata. */
  resourceId: string;
  /** Resource kind — extension point for non-project resources. */
  resourceKind: 'project';
  /** What the actor is trying to do — for audit log. */
  action: string;
}

export type AccessVerdict =
  | {
      kind: 'granted-as-owner';
      logLevel: 'info';
      message: string;
    }
  | {
      kind: 'granted-as-admin';
      logLevel: 'info';
      auditAction: 'admin_override';
      message: string;
    }
  | {
      kind: 'granted-permissive-anonymous';
      logLevel: 'warn';
      auditAction: 'anonymous_request';
      message: string;
    }
  | {
      kind: 'granted-legacy-unowned';
      logLevel: 'warn';
      auditAction: 'legacy_unowned_access';
      message: string;
    }
  | {
      kind: 'denied-anonymous';
      logLevel: 'warn';
      httpStatus: 401;
      errorCode: 'auth_required';
      auditAction: 'permission_denied';
      message: string;
    }
  | {
      kind: 'denied-not-owner';
      logLevel: 'warn';
      httpStatus: 403;
      errorCode: 'not_owner';
      auditAction: 'permission_denied';
      message: string;
    };

export function buildAccessVerdict(input: AccessCheckInput): AccessVerdict {
  const {
    mode,
    actorUserId,
    actorEmail,
    actorRoleName,
    resourceOwnerId,
    resourceId,
    resourceKind,
    action,
  } = input;

  const isAdmin = actorRoleName === 'admin';
  const isAuthenticated = actorUserId !== null;

  // Anonymous paths first: no actor.id means no owner comparison possible.
  if (!isAuthenticated) {
    if (mode === 'enforced') {
      return {
        kind: 'denied-anonymous',
        logLevel: 'warn',
        httpStatus: 401,
        errorCode: 'auth_required',
        auditAction: 'permission_denied',
        message:
          `Access denied: anonymous request to ${action} ${resourceKind}/${resourceId} ` +
          `rejected (AUTH_MODE=enforced; bring a session cookie or API key).`,
      };
    }
    return {
      kind: 'granted-permissive-anonymous',
      logLevel: 'warn',
      auditAction: 'anonymous_request',
      message:
        `Access granted (permissive mode): anonymous ${action} ${resourceKind}/${resourceId} ` +
        `(would 401 in enforced mode).`,
    };
  }

  // Authenticated paths: owner check first, then admin override, then deny.
  // (Owner check first because a user who is BOTH admin and owner should
  //  log as `granted-as-owner`, not `granted-as-admin` — admin_override
  //  audit is for cross-user reach, not self-action.)
  if (resourceOwnerId !== null && actorUserId === resourceOwnerId) {
    return {
      kind: 'granted-as-owner',
      logLevel: 'info',
      message:
        `Access granted: ${actorEmail ?? actorUserId} is the owner of ` +
        `${resourceKind}/${resourceId}; ${action} allowed.`,
    };
  }

  // Resource has an owner that doesn't match — admin override or 403.
  if (resourceOwnerId !== null) {
    if (isAdmin) {
      return {
        kind: 'granted-as-admin',
        logLevel: 'info',
        auditAction: 'admin_override',
        message:
          `Access granted (admin override): ${actorEmail ?? actorUserId} acted on ` +
          `${resourceKind}/${resourceId} owned by user ${resourceOwnerId}; ${action} allowed.`,
      };
    }
    return {
      kind: 'denied-not-owner',
      logLevel: 'warn',
      httpStatus: 403,
      errorCode: 'not_owner',
      auditAction: 'permission_denied',
      message:
        `Access denied: ${actorEmail ?? actorUserId} is not the owner of ` +
        `${resourceKind}/${resourceId} (owner=${resourceOwnerId}) and not an admin; ` +
        `${action} rejected.`,
    };
  }

  // Resource has NO owner (legacy unbackfilled row).
  // Critical: only admins may touch unowned rows. Otherwise un-backfilled
  // rows would become a privilege escalation surface.
  if (isAdmin) {
    return {
      kind: 'granted-legacy-unowned',
      logLevel: 'warn',
      auditAction: 'legacy_unowned_access',
      message:
        `Access granted (admin on legacy unowned row): ${actorEmail ?? actorUserId} acted on ` +
        `${resourceKind}/${resourceId} which has NO owner_id (backfill missed); ${action} allowed. ` +
        `Operator should backfill: UPDATE projects SET owner_id = '<user-id>' WHERE id = '${resourceId}';`,
    };
  }

  return {
    kind: 'denied-not-owner',
    logLevel: 'warn',
    httpStatus: 403,
    errorCode: 'not_owner',
    auditAction: 'permission_denied',
    message:
      `Access denied: ${actorEmail ?? actorUserId} is not an admin and ` +
      `${resourceKind}/${resourceId} has no owner_id (legacy unbackfilled row); ` +
      `${action} rejected. Ask an admin to assign ownership.`,
  };
}

/** Side-effect helper: log the verdict at the appropriate level.
 *  Mirrors round 21 / 23 / 24 verdict log helpers. Audit-log writes
 *  are the caller's responsibility (owner-check.ts) because that
 *  helper has the FastifyRequest context for IP / user-agent.
 */
export function logAccessVerdict(verdict: AccessVerdict): void {
  switch (verdict.logLevel) {
    case 'info':
      console.log(`[Access] ${verdict.message}`);
      return;
    case 'warn':
      // Denials and anonymous/legacy paths use console.warn so the dashboard
      // log filter ('warning') picks them up. Critical errors with errorCode
      // get the standard '[CRITICAL errorCode=X]' prefix on the front-line
      // verdict modules; here, denials are EXPECTED (a non-owner trying a
      // delete) so we don't escalate to console.error.
      if ('errorCode' in verdict) {
        console.warn(`[Access] [errorCode=${verdict.errorCode}] ${verdict.message}`);
      } else {
        console.warn(`[Access] ${verdict.message}`);
      }
      return;
  }
}

/** Quick predicate: did this verdict allow the request to proceed? */
export function isGranted(verdict: AccessVerdict): boolean {
  return (
    verdict.kind === 'granted-as-owner' ||
    verdict.kind === 'granted-as-admin' ||
    verdict.kind === 'granted-permissive-anonymous' ||
    verdict.kind === 'granted-legacy-unowned'
  );
}
