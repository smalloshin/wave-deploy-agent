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
  ['GET:/api/projects/:id/detail', 'projects:read'],
  ['GET:/api/projects/:id/scan/report', 'projects:read'],
  ['GET:/api/projects/:id/source-download', 'projects:read'],
  ['POST:/api/projects', 'projects:write'],
  ['POST:/api/upload/init', 'projects:write'],
  ['POST:/api/upload/diagnose', 'projects:write'],
  ['POST:/api/projects/submit-gcs', 'projects:write'],
  // env-vars + webhook URL contain per-project secrets — gate on write, not read
  ['GET:/api/projects/:id/env-vars', 'projects:write'],
  ['PUT:/api/projects/:id/env-vars', 'projects:write'],
  ['GET:/api/projects/:id/github-webhook', 'projects:write'],
  ['POST:/api/projects/:id/start', 'projects:deploy'],
  ['POST:/api/projects/:id/stop', 'projects:deploy'],
  ['POST:/api/projects/:id/scan', 'projects:deploy'],
  ['POST:/api/projects/:id/resubmit', 'projects:deploy'],
  ['POST:/api/projects/:id/retry-domain', 'projects:deploy'],
  ['POST:/api/projects/:id/new-version', 'projects:deploy'],
  ['POST:/api/projects/:id/deploy-lock', 'projects:deploy'],
  ['POST:/api/projects/:id/versions/cleanup', 'projects:deploy'],
  ['POST:/api/projects/:id/reanalyze-failure', 'projects:deploy'],
  // Risk-bypass endpoints — separation of duties: reviewer-only, NOT projects:deploy
  ['POST:/api/projects/:id/skip-scan', 'reviews:decide'],
  ['POST:/api/projects/:id/force-fail', 'reviews:decide'],
  ['POST:/api/projects/:id/versions/:did/publish', 'versions:publish'],
  ['GET:/api/projects/:id/versions', 'versions:read'],
  ['GET:/api/projects/:id/versions/:did/download', 'versions:read'],
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
  ['GET:/api/deploys/:id/timeline', 'deploys:read'],
  ['GET:/api/deploys/:id/stream', 'deploys:read'],
  ['GET:/api/deploys/:id/build-log', 'deploys:read'],

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

  // Discord NL audit (bot writes pending+result rows around every tool exec).
  // Uses projects:deploy because that's already in the bot's API-key
  // permission set (reviews:*, versions:*, projects:deploy). Not a security-
  // sensitive endpoint — the bot is the only writer and the data is
  // sanitized at both bot-side and API-side ingress.
  ['POST:/api/discord-audit', 'projects:deploy'],
  ['PATCH:/api/discord-audit/:id', 'projects:deploy'],
  // Read endpoints power the admin dashboard's Discord-audit tab — same
  // sensitivity bar as the auth audit log (users:manage).
  ['GET:/api/discord-audit', 'users:manage'],
  ['GET:/api/discord-audit/:id', 'users:manage'],

  // Users management (auth routes handle their own granular permissions,
  // but users CRUD requires users:manage)
  ['GET:/api/auth/users', 'users:manage'],
  ['POST:/api/auth/users', 'users:manage'],
  ['PATCH:/api/auth/users/:id', 'users:manage'],
  ['DELETE:/api/auth/users/:id', 'users:manage'],
  ['GET:/api/auth/audit-log', 'users:manage'],
  ['GET:/api/auth/audit-log/:id', 'users:manage'],
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

// Exported for unit testing — converts ":param" placeholders to "[^/]+" regex.
export function patternToRegex(pattern: string): RegExp {
  // Convert ":param" → "[^/]+", escape slashes
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

export function lookupRequiredPermission(method: string, url: string): Permission | null {
  const path = url.split('?')[0];
  for (const [key, perm] of ROUTE_PERMISSIONS) {
    const colonIdx = key.indexOf(':');
    const m = key.slice(0, colonIdx);
    const p = key.slice(colonIdx + 1);
    if (m !== method) continue;
    if (patternToRegex(p).test(path)) return perm;
  }
  return null;
}

export function isPublic(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path));
}

export function isAuthenticatedOnly(method: string, url: string): boolean {
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
    // Unmapped routes: this is a developer error — every route should declare its
    // required permission. Behavior:
    //   - permissive mode: log loudly, allow (migration aid)
    //   - enforced mode: fail closed with 403 — refuse to silently grant access
    //
    // Rationale: the previous "any authenticated user passes" default let viewers
    // hit /api/projects/:id/start and /env-vars before those routes were mapped.
    // Fail-closed means adding a new route without an RBAC entry surfaces as a
    // loud 403 in staging instead of a silent privilege escalation in prod.
    if (mode === 'enforced') {
      await logAuth({
        user_id: req.auth.user?.id ?? null,
        action: 'permission_denied',
        resource: `${method} ${url}`,
        ip_address: req.ip,
        metadata: { reason: 'route_not_mapped', via: req.auth.via, mode },
      });
      return reply.code(403).send({
        error: 'Forbidden',
        reason: 'route_not_mapped',
        hint: 'This route is missing from ROUTE_PERMISSIONS — file a bug.',
      });
    }
    // Permissive: log + allow
    if (!authenticated) {
      req.log.warn({ method, url }, '[auth] unmapped anonymous request allowed (permissive mode)');
    } else {
      req.log.warn({ method, url, user: req.auth.user?.email }, '[auth] unmapped authenticated request allowed (permissive mode)');
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

/**
 * Startup-time RBAC coverage check.
 *
 * Fastify's `onRoute` hook fires when each route is registered. We walk every
 * registered route and check whether it's covered by ROUTE_PERMISSIONS,
 * PUBLIC_ROUTES, or AUTHENTICATED_ROUTES. Anything else is a developer error
 * — log a loud warning so it shows up in boot logs.
 *
 * In enforced mode unmapped routes return 403 with `route_not_mapped`, so this
 * is "advance warning" (devs see it before users do). In permissive mode this
 * is the only signal that something needs attention.
 *
 * Call this BEFORE registering route plugins so the hook catches all of them.
 */
export function registerAuthCoverageCheck(app: FastifyInstance): void {
  const unmapped: Array<{ method: string; url: string }> = [];

  app.addHook('onRoute', (route) => {
    // route.method can be string or string[] (when a route declares multiple)
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const rawMethod of methods) {
      const method = String(rawMethod).toUpperCase();
      const url = route.url;

      // HEAD/OPTIONS auto-generated by Fastify, skip
      if (method === 'HEAD' || method === 'OPTIONS') continue;

      if (isPublic(method, url)) continue;
      if (isAuthenticatedOnly(method, url)) continue;
      if (lookupRequiredPermission(method, url) !== null) continue;

      unmapped.push({ method, url });
    }
  });

  // Print summary on ready (after all plugins registered)
  app.addHook('onReady', async () => {
    if (unmapped.length === 0) {
      app.log.info('[auth] route coverage check: all routes mapped');
      return;
    }
    app.log.warn(
      { unmapped },
      `[auth] route coverage check: ${unmapped.length} route(s) have no RBAC mapping. ` +
        `In enforced mode these return 403 { reason: 'route_not_mapped' }. ` +
        `Add them to ROUTE_PERMISSIONS / PUBLIC_ROUTES / AUTHENTICATED_ROUTES in middleware/auth.ts.`,
    );
  });
}
