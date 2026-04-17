import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Permission, AuthUser } from '@deploy-agent/shared';
import {
  validateSession,
  validateApiKey,
  effectivePermissions,
  hasPermission,
  logAuth,
} from '../services/auth-service.js';

export const SESSION_COOKIE = 'deploy_agent_session';

// ─── Route → permission map ─────────────────────────────────

// Each entry: "METHOD:/path/pattern" → required permission
// Patterns use :param placeholders (matched as [^/]+ segments).
export const ROUTE_PERMISSIONS: Array<[string, Permission]> = [
  // Projects
  ['GET:/api/projects', 'projects:read'],
  ['GET:/api/projects/:id', 'projects:read'],
  ['POST:/api/projects', 'projects:write'],
  ['POST:/api/upload/init', 'projects:write'],
  ['POST:/api/projects/submit-gcs', 'projects:write'],
  ['POST:/api/projects/:id/new-version', 'projects:deploy'],
  ['POST:/api/projects/:id/deploy-lock', 'projects:deploy'],
  ['POST:/api/projects/:id/versions/cleanup', 'projects:deploy'],
  ['POST:/api/projects/:id/versions/:did/publish', 'versions:publish'],
  ['GET:/api/projects/:id/versions', 'versions:read'],
  ['DELETE:/api/projects/:id', 'projects:delete'],

  // Project groups
  ['GET:/api/project-groups', 'projects:read'],
  ['GET:/api/project-groups/:id', 'projects:read'],
  ['POST:/api/project-groups/:id/actions', 'projects:delete'],

  // Deploys
  ['GET:/api/deploys', 'deploys:read'],
  ['GET:/api/deploys/:id', 'deploys:read'],
  ['GET:/api/deploys/:id/ssl-status', 'deploys:read'],
  ['GET:/api/deploys/:id/logs', 'deploys:read'],

  // Reviews
  ['GET:/api/reviews', 'reviews:read'],
  ['GET:/api/reviews/:id', 'reviews:read'],
  ['POST:/api/reviews/:id/decide', 'reviews:decide'],

  // Infra
  ['GET:/api/infra/check-domain', 'infra:read'],
  ['GET:/api/infra/overview', 'infra:read'],
  ['GET:/api/infra/orphans', 'infra:read'],
  ['POST:/api/infra/cleanup-orphans', 'infra:admin'],
  ['POST:/api/infra/migrate', 'infra:admin'],
  ['POST:/api/infra/reconcile', 'infra:admin'],

  // Settings
  ['GET:/api/settings', 'settings:read'],
  ['PUT:/api/settings', 'settings:write'],

  // MCP
  ['POST:/mcp/tools/list', 'mcp:access'],
  ['POST:/mcp/tools/call', 'mcp:access'],

  // Users management (auth routes handle their own granular permissions,
  // but users CRUD requires users:manage)
  ['GET:/api/auth/users', 'users:manage'],
  ['POST:/api/auth/users', 'users:manage'],
  ['PATCH:/api/auth/users/:id', 'users:manage'],
  ['DELETE:/api/auth/users/:id', 'users:manage'],
  ['GET:/api/auth/audit-log', 'users:manage'],
];

// Public routes — skip auth entirely.
const PUBLIC_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/health$/],
  ['POST', /^\/api\/webhooks\/github/],
  ['POST', /^\/api\/auth\/login$/],
];

// Authenticated-only (any logged-in user) — require a valid session/key but no specific permission.
const AUTHENTICATED_ROUTES: Array<[string, RegExp]> = [
  ['POST', /^\/api\/auth\/logout$/],
  ['GET', /^\/api\/auth\/me$/],
  ['GET', /^\/api\/auth\/api-keys$/],
  ['POST', /^\/api\/auth\/api-keys$/],
  ['DELETE', /^\/api\/auth\/api-keys\/[^/]+$/],
];

function patternToRegex(pattern: string): RegExp {
  // Convert ":param" → "[^/]+", escape slashes
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function lookupRequiredPermission(method: string, url: string): Permission | null {
  const path = url.split('?')[0];
  for (const [key, perm] of ROUTE_PERMISSIONS) {
    const [m, p] = key.split(':');
    if (m !== method) continue;
    if (patternToRegex(p).test(path)) return perm;
  }
  return null;
}

function isPublic(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path));
}

function isAuthenticatedOnly(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return AUTHENTICATED_ROUTES.some(([m, re]) => m === method && re.test(path));
}

// ─── Auth hook ──────────────────────────────────────────────

export interface AuthContext {
  user: AuthUser | null;
  permissions: Permission[];
  via: 'session' | 'api_key' | 'anonymous';
}

// Extend Fastify request types
declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function extractCookieToken(req: FastifyRequest): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const method = req.method.toUpperCase();
  const url = req.url;
  const mode = (process.env.AUTH_MODE ?? 'permissive') as 'permissive' | 'enforced';

  // Default: anonymous
  req.auth = { user: null, permissions: [], via: 'anonymous' };

  // Public routes always pass
  if (isPublic(method, url)) return;

  // Try to authenticate via Bearer → API key; fallback to session cookie
  const bearer = extractBearer(req);
  if (bearer) {
    // Try API key first
    const apiKeyResult = await validateApiKey(bearer);
    if (apiKeyResult) {
      req.auth = {
        user: apiKeyResult.user,
        permissions: effectivePermissions(apiKeyResult.user.permissions, apiKeyResult.key_permissions),
        via: 'api_key',
      };
    } else {
      // Could be a session token in header instead of cookie (for SPA custom)
      const sessionUser = await validateSession(bearer);
      if (sessionUser) {
        req.auth = {
          user: sessionUser,
          permissions: sessionUser.permissions,
          via: 'session',
        };
      }
    }
  } else {
    const cookieToken = extractCookieToken(req);
    if (cookieToken) {
      const sessionUser = await validateSession(cookieToken);
      if (sessionUser) {
        req.auth = {
          user: sessionUser,
          permissions: sessionUser.permissions,
          via: 'session',
        };
      }
    }
  }

  const authenticated = req.auth.user !== null;

  // In enforced mode, anonymous requests get 401 (except public routes above)
  if (!authenticated && mode === 'enforced') {
    await logAuth({
      action: 'permission_denied',
      resource: `${method} ${url}`,
      ip_address: req.ip,
      metadata: { reason: 'no_credentials', mode },
    });
    return reply.code(401).send({ error: 'Authentication required' });
  }

  // Authenticated-only routes (don't need specific permission)
  if (isAuthenticatedOnly(method, url)) {
    if (!authenticated) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    return;
  }

  const required = lookupRequiredPermission(method, url);
  if (!required) {
    // Unmapped routes: permissive mode lets them through, enforced mode requires auth
    if (mode === 'enforced' && !authenticated) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    return;
  }

  // In permissive mode, anonymous requests are logged but allowed (migration aid)
  if (!authenticated) {
    if (mode === 'permissive') {
      req.log.warn({ method, url, required }, '[auth] anonymous request allowed (permissive mode)');
      await logAuth({
        action: 'anonymous_request',
        resource: `${method} ${url}`,
        ip_address: req.ip,
        metadata: { required_permission: required, mode },
      });
      return;
    }
    return reply.code(401).send({ error: 'Authentication required' });
  }

  // Check permission
  if (!hasPermission(req.auth.permissions, required)) {
    await logAuth({
      user_id: req.auth.user?.id ?? null,
      action: 'permission_denied',
      resource: `${method} ${url}`,
      ip_address: req.ip,
      metadata: { required_permission: required, via: req.auth.via },
    });
    return reply.code(403).send({
      error: 'Forbidden',
      required_permission: required,
    });
  }
}

export function registerAuthHook(app: FastifyInstance): void {
  app.addHook('onRequest', authHook);
}
