import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { query, getOne } from '../db/index.js';
import { safePositiveInt } from '../utils/safe-number.js';
import type { AuthUser, Permission, Role, ApiKey, ApiKeyCreated } from '@deploy-agent/shared';

// SESSION_TTL_DAYS comes from env — guard against `Number("abc")` → NaN, which
// would silently make every session unverifiable (TTL math becomes NaN).
const SESSION_TTL_DAYS = safePositiveInt(process.env.SESSION_TTL_DAYS, 7, { max: 365 });
const BCRYPT_COST = 12;
const API_KEY_PREFIX = 'da_k_';

// ─── Hashing ───────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

// ─── Users ──────────────────────────────────────────────────

export async function getUserByEmail(email: string): Promise<(AuthUser & { password_hash: string }) | null> {
  return getOne<AuthUser & { password_hash: string }>(
    `SELECT u.id, u.email, u.display_name, u.password_hash, u.role_id, u.is_active,
            u.last_login_at, u.created_at,
            r.name AS role_name, r.permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE LOWER(u.email) = LOWER($1)`,
    [email]
  );
}

export async function getUserById(id: string): Promise<AuthUser | null> {
  return getOne<AuthUser>(
    `SELECT u.id, u.email, u.display_name, u.role_id, u.is_active,
            u.last_login_at, u.created_at,
            r.name AS role_name, r.permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1`,
    [id]
  );
}

export async function listUsers(): Promise<AuthUser[]> {
  const result = await query<AuthUser>(
    `SELECT u.id, u.email, u.display_name, u.role_id, u.is_active,
            u.last_login_at, u.created_at,
            r.name AS role_name, r.permissions
       FROM users u
       JOIN roles r ON r.id = u.role_id
      ORDER BY u.created_at ASC`
  );
  return result.rows;
}

export async function createUser(input: {
  email: string;
  password: string;
  role_name: string;
  display_name?: string | null;
}): Promise<AuthUser> {
  const role = await getOne<Role>(`SELECT * FROM roles WHERE name = $1`, [input.role_name]);
  if (!role) throw new Error(`Unknown role: ${input.role_name}`);
  const hash = await hashPassword(input.password);
  const result = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, role_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.email.toLowerCase(), hash, input.display_name ?? null, role.id]
  );
  const created = await getUserById(result.rows[0].id);
  if (!created) throw new Error('User creation failed');
  return created;
}

export async function updateUser(id: string, patch: {
  display_name?: string | null;
  role_name?: string;
  is_active?: boolean;
  password?: string;
}): Promise<AuthUser> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (patch.display_name !== undefined) {
    sets.push(`display_name = $${idx++}`);
    values.push(patch.display_name);
  }
  if (patch.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(patch.is_active);
  }
  if (patch.password !== undefined) {
    sets.push(`password_hash = $${idx++}`);
    values.push(await hashPassword(patch.password));
  }
  if (patch.role_name !== undefined) {
    const role = await getOne<Role>(`SELECT * FROM roles WHERE name = $1`, [patch.role_name]);
    if (!role) throw new Error(`Unknown role: ${patch.role_name}`);
    sets.push(`role_id = $${idx++}`);
    values.push(role.id);
  }
  if (sets.length === 0) {
    const existing = await getUserById(id);
    if (!existing) throw new Error('User not found');
    return existing;
  }
  sets.push(`updated_at = NOW()`);
  values.push(id);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, values);
  const updated = await getUserById(id);
  if (!updated) throw new Error('User not found');
  return updated;
}

export async function deleteUser(id: string): Promise<void> {
  await query(`DELETE FROM users WHERE id = $1`, [id]);
}

// ─── Sessions ───────────────────────────────────────────────

export async function createSession(
  user_id: string,
  meta: { ip?: string; userAgent?: string } = {}
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const token_hash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [user_id, token_hash, expiresAt, meta.ip ?? null, meta.userAgent ?? null]
  );

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user_id]);
  return { token, expiresAt };
}

export async function validateSession(token: string): Promise<AuthUser | null> {
  const token_hash = sha256(token);
  const row = await getOne<{ user_id: string }>(
    `SELECT user_id FROM sessions
      WHERE token_hash = $1 AND expires_at > NOW()`,
    [token_hash]
  );
  if (!row) return null;
  return getUserById(row.user_id);
}

export async function deleteSession(token: string): Promise<void> {
  const token_hash = sha256(token);
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [token_hash]);
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await query(`DELETE FROM sessions WHERE expires_at <= NOW()`);
  return result.rowCount ?? 0;
}

// ─── API Keys ───────────────────────────────────────────────

export async function createApiKey(input: {
  user_id: string;
  name: string;
  permissions: Permission[];
  expires_at?: Date | null;
}): Promise<ApiKeyCreated> {
  const raw = API_KEY_PREFIX + randomToken(24);
  const key_hash = sha256(raw);
  const key_prefix = raw.slice(0, 12); // "da_k_xxxxxxx"

  const result = await query<{ id: string }>(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, permissions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.user_id, input.name, key_hash, key_prefix, input.permissions, input.expires_at ?? null]
  );
  const created = await getOne<ApiKey>(
    `SELECT id, user_id, name, key_prefix, permissions,
            last_used_at, expires_at, is_active, created_at
       FROM api_keys WHERE id = $1`,
    [result.rows[0].id]
  );
  if (!created) throw new Error('API key creation failed');
  return { ...created, raw_key: raw };
}

export async function validateApiKey(rawKey: string): Promise<{ user: AuthUser; key_permissions: Permission[] } | null> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return null;
  const key_hash = sha256(rawKey);
  const row = await getOne<{ user_id: string; permissions: Permission[]; id: string }>(
    `SELECT id, user_id, permissions
       FROM api_keys
      WHERE key_hash = $1
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [key_hash]
  );
  if (!row) return null;

  // Async best-effort update of last_used_at (don't block request)
  query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id])
    .catch(err => console.error('[auth] api_key last_used update failed:', err));

  const user = await getUserById(row.user_id);
  if (!user || !user.is_active) return null;
  return { user, key_permissions: row.permissions };
}

export async function listApiKeysForUser(user_id: string): Promise<ApiKey[]> {
  const result = await query<ApiKey>(
    `SELECT id, user_id, name, key_prefix, permissions,
            last_used_at, expires_at, is_active, created_at
       FROM api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [user_id]
  );
  return result.rows;
}

export async function revokeApiKey(id: string, user_id: string): Promise<boolean> {
  const result = await query(
    `UPDATE api_keys SET is_active = false
      WHERE id = $1 AND user_id = $2`,
    [id, user_id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Audit log ───────────────────────────────────────────────

export async function logAuth(entry: {
  user_id?: string | null;
  action: string;
  resource?: string | null;
  ip_address?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO auth_audit_log (user_id, action, resource, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.user_id ?? null,
        entry.action,
        entry.resource ?? null,
        entry.ip_address ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ]
    );
  } catch (err) {
    console.error('[auth] audit log write failed:', err);
  }
}

export async function listAuditLog(limit = 100): Promise<unknown[]> {
  const result = await query(
    `SELECT al.id, al.user_id, u.email, al.action, al.resource,
            al.ip_address, al.metadata, al.created_at
       FROM auth_audit_log al
       LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ─── Permission check ───────────────────────────────────────

export function hasPermission(perms: Permission[], required: Permission): boolean {
  if (perms.includes('*')) return true;
  return perms.includes(required);
}

export function effectivePermissions(
  userPerms: Permission[],
  keyPerms?: Permission[] | null
): Permission[] {
  if (!keyPerms || keyPerms.length === 0) return userPerms;
  // API key permissions are an ALLOW list: intersect with user's role
  if (userPerms.includes('*')) return keyPerms;
  return userPerms.filter(p => keyPerms.includes(p) || keyPerms.includes('*'));
}

// ─── Bootstrap admin ────────────────────────────────────────

/**
 * Ensure an admin user exists. Called on startup when ADMIN_EMAIL + ADMIN_PASSWORD are set.
 * Idempotent: only creates if no user with that email exists.
 */
export async function ensureAdmin(email: string, password: string, display_name?: string): Promise<void> {
  const existing = await getUserByEmail(email);
  if (existing) {
    console.log(`[auth] Admin user already exists: ${email}`);
    return;
  }
  await createUser({
    email,
    password,
    role_name: 'admin',
    display_name: display_name ?? 'Admin',
  });
  console.log(`[auth] Bootstrapped admin user: ${email}`);
}
