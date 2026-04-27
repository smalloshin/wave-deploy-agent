/**
 * Pure permission predicates — single source of truth for RBAC checks.
 *
 * Round 38: extracted from auth-service.ts (server) and auth.tsx (web)
 * because the same predicate logic was duplicated in two places. Drift
 * between server and client gating is a security regression: a UI button
 * shown when the server denies = confused user; a button hidden when the
 * server allows = lost feature. One implementation, locked by tests.
 *
 * Behavioral contract:
 *
 * 1. `hasPermission(perms, required)`:
 *    - If `perms` includes the wildcard `'*'` → grant.
 *    - Else if `perms` includes the literal `required` → grant.
 *    - Else deny.
 *    - Empty `perms` → deny.
 *
 * 2. `effectivePermissions(userPerms, keyPerms)`:
 *    - When the request authenticates via API key, the key's permissions
 *      (if any) act as an ALLOW LIST that intersects with the user's
 *      role permissions.
 *    - No key (null/undefined/empty) → user perms unchanged.
 *    - Admin user (`*`) + scoped key → key perms only (key narrows admin).
 *    - Non-admin user + key with `*` → all of user perms (key allows all).
 *    - Non-admin user + scoped key → intersection.
 *
 * 3. `checkUserPermission(user, required)`:
 *    - Convenience for UI gating where the user object may be null.
 *    - Null user → deny.
 *    - Otherwise delegate to `hasPermission(user.permissions, required)`.
 *
 * Keep these functions PURE: no globals, no side effects, no DB. They
 * are the single point that both apps/api middleware and apps/web auth
 * context depend on, and the only way to keep them in sync is to keep
 * them stateless and well-tested.
 */

import type { Permission } from './auth-types.js';

/**
 * Minimal user shape needed by `checkUserPermission`. Avoids forcing
 * web callers to pull the full server-side `AuthUser` (which includes
 * DB-only fields like `created_at`).
 */
export interface PermissionSubject {
  permissions: Permission[];
}

export function hasPermission(perms: Permission[], required: Permission): boolean {
  if (perms.includes('*')) return true;
  return perms.includes(required);
}

export function effectivePermissions(
  userPerms: Permission[],
  keyPerms?: Permission[] | null,
): Permission[] {
  if (!keyPerms || keyPerms.length === 0) return userPerms;
  // API key permissions are an ALLOW list: intersect with user's role.
  if (userPerms.includes('*')) return keyPerms;
  return userPerms.filter((p) => keyPerms.includes(p) || keyPerms.includes('*'));
}

export function checkUserPermission(
  user: PermissionSubject | null | undefined,
  required: Permission,
): boolean {
  if (!user) return false;
  return hasPermission(user.permissions, required);
}
