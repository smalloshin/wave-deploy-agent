import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@deploy-agent/shared';
import {
  getUserByEmail,
  createSession,
  deleteSession,
  verifyPassword,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  createApiKey,
  listApiKeysForUser,
  revokeApiKey,
  listAuditLog,
  listAuditLogFiltered,
  countAuditLogFiltered,
  getAuditLogEntry,
  logAuth,
} from '../services/auth-service.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
import { safePositiveInt } from '../utils/safe-number.js';
import {
  parseAuthAuditQuery,
  buildAuthAuditListSql,
  buildAuthAuditCountSql,
} from '../services/auth-audit-query.js';

const VALID_PERMISSIONS: Permission[] = [
  'projects:read','projects:write','projects:deploy','projects:delete',
  'reviews:read','reviews:decide',
  'deploys:read',
  'versions:read','versions:publish',
  'infra:read','infra:admin',
  'settings:read','settings:write',
  'users:manage',
  'mcp:access','*',
];

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().optional(),
  role_name: z.enum(['admin', 'reviewer', 'viewer']),
});

const UpdateUserSchema = z.object({
  display_name: z.string().nullable().optional(),
  role_name: z.enum(['admin', 'reviewer', 'viewer']).optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  permissions: z.array(z.string()).min(1),
  expires_at: z.string().datetime().nullable().optional(),
});

function cookieOptions(expiresAt: Date) {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/login
  app.post('/api/auth/login', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input' });
    }
    const { email, password } = parsed.data;
    const user = await getUserByEmail(email);
    if (!user || !user.is_active) {
      await logAuth({
        action: 'login_failed',
        resource: '/api/auth/login',
        ip_address: request.ip,
        metadata: { email, reason: 'user_not_found' },
      });
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await logAuth({
        user_id: user.id,
        action: 'login_failed',
        resource: '/api/auth/login',
        ip_address: request.ip,
        metadata: { email, reason: 'bad_password' },
      });
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const { token, expiresAt } = await createSession(user.id, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    await logAuth({
      user_id: user.id,
      action: 'login',
      resource: '/api/auth/login',
      ip_address: request.ip,
    });

    reply.setCookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role_name: user.role_name,
        permissions: user.permissions,
      },
      // Also return token for Authorization header use (SPA can choose cookie OR header)
      token,
      expires_at: expiresAt.toISOString(),
    };
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', async (request, reply) => {
    const cookieToken = (request as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    const authHeader = request.headers['authorization'];
    const bearer = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader)?.[1] : null;
    const token = cookieToken ?? bearer;
    if (token) {
      await deleteSession(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (request.auth.user) {
      await logAuth({
        user_id: request.auth.user.id,
        action: 'logout',
        resource: '/api/auth/logout',
        ip_address: request.ip,
      });
    }
    return { ok: true };
  });

  // GET /api/auth/me
  app.get('/api/auth/me', async (request, reply) => {
    if (!request.auth.user) return reply.code(401).send({ error: 'Not authenticated' });
    const u = request.auth.user;
    return {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      role_name: u.role_name,
      permissions: request.auth.permissions,
      via: request.auth.via,
    };
  });

  // GET /api/auth/users (users:manage)
  app.get('/api/auth/users', async () => {
    const users = await listUsers();
    return { users };
  });

  // POST /api/auth/users (users:manage)
  app.post('/api/auth/users', async (request, reply) => {
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const user = await createUser(parsed.data);
      await logAuth({
        user_id: request.auth.user?.id ?? null,
        action: 'user_created',
        metadata: { target_user_id: user.id, email: user.email, role: user.role_name },
        ip_address: request.ip,
      });
      return { user };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return reply.code(409).send({ error: 'Email already exists' });
      }
      return reply.code(400).send({ error: msg });
    }
  });

  // PATCH /api/auth/users/:id (users:manage)
  app.patch<{ Params: { id: string } }>('/api/auth/users/:id', async (request, reply) => {
    const parsed = UpdateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const user = await updateUser(request.params.id, parsed.data);
      await logAuth({
        user_id: request.auth.user?.id ?? null,
        action: 'user_updated',
        metadata: { target_user_id: user.id, patch: Object.keys(parsed.data) },
        ip_address: request.ip,
      });
      return { user };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  // DELETE /api/auth/users/:id (users:manage)
  app.delete<{ Params: { id: string } }>('/api/auth/users/:id', async (request, reply) => {
    if (request.params.id === request.auth.user?.id) {
      return reply.code(400).send({ error: 'Cannot delete yourself' });
    }
    await deleteUser(request.params.id);
    await logAuth({
      user_id: request.auth.user?.id ?? null,
      action: 'user_deleted',
      metadata: { target_user_id: request.params.id },
      ip_address: request.ip,
    });
    return { ok: true };
  });

  // GET /api/auth/api-keys (current user's keys)
  app.get('/api/auth/api-keys', async (request, reply) => {
    if (!request.auth.user) return reply.code(401).send({ error: 'Not authenticated' });
    const keys = await listApiKeysForUser(request.auth.user.id);
    return { keys };
  });

  // POST /api/auth/api-keys (current user creates a key)
  app.post('/api/auth/api-keys', async (request, reply) => {
    if (!request.auth.user) return reply.code(401).send({ error: 'Not authenticated' });
    const parsed = CreateApiKeySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    // Validate requested permissions
    const perms = parsed.data.permissions as Permission[];
    for (const p of perms) {
      if (!VALID_PERMISSIONS.includes(p)) {
        return reply.code(400).send({ error: `Unknown permission: ${p}` });
      }
    }

    // Non-admin users cannot grant permissions they don't have
    const userPerms = request.auth.permissions;
    const isAdmin = userPerms.includes('*');
    if (!isAdmin) {
      for (const p of perms) {
        if (p === '*' || !userPerms.includes(p)) {
          return reply.code(403).send({
            error: `Cannot grant permission you don't have: ${p}`,
          });
        }
      }
    }

    const key = await createApiKey({
      user_id: request.auth.user.id,
      name: parsed.data.name,
      permissions: perms,
      expires_at: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
    });

    await logAuth({
      user_id: request.auth.user.id,
      action: 'api_key_created',
      metadata: { key_id: key.id, name: key.name, permissions: perms },
      ip_address: request.ip,
    });

    return { key };  // includes raw_key — shown ONCE
  });

  // DELETE /api/auth/api-keys/:id (current user revokes their own key)
  app.delete<{ Params: { id: string } }>('/api/auth/api-keys/:id', async (request, reply) => {
    if (!request.auth.user) return reply.code(401).send({ error: 'Not authenticated' });
    const ok = await revokeApiKey(request.params.id, request.auth.user.id);
    if (!ok) return reply.code(404).send({ error: 'API key not found' });
    await logAuth({
      user_id: request.auth.user.id,
      action: 'api_key_revoked',
      metadata: { key_id: request.params.id },
      ip_address: request.ip,
    });
    return { ok: true };
  });

  // GET /api/auth/audit-log (users:manage)
  // Backwards-compatible: with no query params returns the same {entries} shape.
  // With filters or paginate=true returns {entries, total, limit, offset} for
  // admin dashboard pagination UI.
  app.get('/api/auth/audit-log', async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;

    // Legacy mode: only ?limit, no other filter, no paginate=true → keep old shape.
    const onlyLegacyLimit =
      Object.keys(raw).length === 0 ||
      (Object.keys(raw).length === 1 && 'limit' in raw && raw.paginate !== 'true');
    if (onlyLegacyLimit) {
      const limit = safePositiveInt(raw.limit, 100, { max: 1000 });
      const entries = await listAuditLog(limit);
      return { entries };
    }

    const verdict = parseAuthAuditQuery(raw);
    if (verdict.kind === 'invalid') {
      reply.code(400);
      return { error: verdict.reason };
    }
    const listSql = buildAuthAuditListSql(verdict.query);
    const countSql = buildAuthAuditCountSql(verdict.query);
    const [entries, total] = await Promise.all([
      listAuditLogFiltered(listSql),
      countAuditLogFiltered(countSql),
    ]);
    return {
      entries,
      total,
      limit: verdict.query.limit,
      offset: verdict.query.offset,
    };
  });

  // GET /api/auth/audit-log/:id (users:manage) — drill-down
  app.get<{ Params: { id: string } }>('/api/auth/audit-log/:id', async (request, reply) => {
    const entry = await getAuditLogEntry(request.params.id);
    if (!entry) {
      reply.code(404);
      return { error: 'audit log entry not found' };
    }
    return { entry };
  });
}
