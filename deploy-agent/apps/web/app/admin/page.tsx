'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Tab = 'users' | 'keys' | 'audit';

interface User {
  id: string;
  email: string;
  display_name: string | null;
  role_name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  permissions: string[];
  last_used_at: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

interface AuditEntry {
  id: number;
  user_id: string | null;
  email: string | null;
  action: string;
  resource: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ─── API helpers ─────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `${path}: ${res.status}`);
  }
  return res.json();
}

// ─── Main component ─────────────────────────────────────────

export default function AdminPage() {
  const t = useTranslations('admin');
  const { user, loading, hasPermission } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('users');

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading || !user) return <div>Loading...</div>;

  const canManageUsers = hasPermission('users:manage');

  return (
    <div>
      <h1 style={{
        marginTop: 0,
        fontSize: 'var(--fs-2xl)',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 'var(--lh-tight)',
        color: 'var(--ink-900)',
        marginBottom: 'var(--sp-5)',
      }}>{t('title')}</h1>

      <div style={{ display: 'flex', gap: 'var(--sp-5)', borderBottom: '1px solid var(--border)', marginBottom: 'var(--sp-5)' }}>
        {canManageUsers && (
          <TabButton active={tab === 'users'} onClick={() => setTab('users')}>
            {t('tabs.users')}
          </TabButton>
        )}
        <TabButton active={tab === 'keys'} onClick={() => setTab('keys')}>
          {t('tabs.apiKeys')}
        </TabButton>
        {canManageUsers && (
          <TabButton active={tab === 'audit'} onClick={() => setTab('audit')}>
            {t('tabs.auditLog')}
          </TabButton>
        )}
      </div>

      {tab === 'users' && canManageUsers && <UsersSection />}
      {tab === 'keys' && <ApiKeysSection />}
      {tab === 'audit' && canManageUsers && <AuditLogSection />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--sea-500)' : '2px solid transparent',
        color: active ? 'var(--sea-600)' : 'var(--ink-500)',
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        fontSize: 'var(--fs-md)',
        marginBottom: -1,
        fontFamily: 'inherit',
        transition: 'color 0.12s, border-color 0.12s',
      }}
    >
      {children}
    </button>
  );
}

// ─── Users ───────────────────────────────────────────────────

function UsersSection() {
  const t = useTranslations('admin.users');
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);

  async function refresh() {
    try {
      const data = await apiGet<{ users: User[] }>('/api/auth/users');
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleDelete(id: string) {
    if (id === me?.id) return;
    if (!confirm(t('confirmDelete'))) return;
    try {
      await apiSend(`/api/auth/users/${id}`, 'DELETE');
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleToggle(u: User) {
    try {
      await apiSend(`/api/auth/users/${u.id}`, 'PATCH', { is_active: !u.is_active });
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function handleChangeRole(u: User, role: string) {
    try {
      await apiSend(`/api/auth/users/${u.id}`, 'PATCH', { role_name: role });
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Update failed');
    }
  }

  if (error) return <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-md)' }}>{error}</div>;
  if (!users) return <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-md)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-4)' }}>
        <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-sm)' }}>
          {t('count', { count: users.length })}
        </div>
        <button
          onClick={() => setCreating(true)}
          style={btnPrimary}
        >
          + {t('addUser')}
        </button>
      </div>

      {creating && (
        <CreateUserForm
          onDone={() => { setCreating(false); refresh(); }}
          onCancel={() => setCreating(false)}
        />
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={th}>{t('email')}</th>
            <th style={th}>{t('displayName')}</th>
            <th style={th}>{t('role')}</th>
            <th style={th}>{t('status')}</th>
            <th style={th}>{t('lastLogin')}</th>
            <th style={th}>{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={td}>{u.email}{u.id === me?.id && <span style={{ color: 'var(--text-secondary)', fontSize: 11, marginLeft: 6 }}>({t('you')})</span>}</td>
              <td style={td}>{u.display_name ?? '—'}</td>
              <td style={td}>
                <select
                  value={u.role_name}
                  onChange={e => handleChangeRole(u, e.target.value)}
                  disabled={u.id === me?.id}
                  style={selectStyle}
                >
                  <option value="admin">admin</option>
                  <option value="reviewer">reviewer</option>
                  <option value="viewer">viewer</option>
                </select>
              </td>
              <td style={td}>
                <button
                  onClick={() => handleToggle(u)}
                  disabled={u.id === me?.id}
                  style={{
                    ...btnGhost,
                    color: u.is_active ? 'var(--status-success)' : 'var(--text-muted)',
                  }}
                >
                  {u.is_active ? t('active') : t('inactive')}
                </button>
              </td>
              <td style={td}>
                {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
              </td>
              <td style={td}>
                <button
                  onClick={() => setPasswordUser(u)}
                  style={{ ...btnGhost, marginRight: 4 }}
                >
                  {t('changePassword')}
                </button>
                <button
                  onClick={() => handleDelete(u.id)}
                  disabled={u.id === me?.id}
                  className="btn-delete"
                  style={btnGhost}
                >
                  {t('delete')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {passwordUser && (
        <ChangePasswordModal
          user={passwordUser}
          onClose={() => setPasswordUser(null)}
          onDone={() => { setPasswordUser(null); refresh(); }}
        />
      )}
    </div>
  );
}

function ChangePasswordModal({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('admin.users');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError(t('passwordMismatch')); return; }
    if (password.length < 8) { setError(t('passwordTooShort')); return; }
    setSubmitting(true);
    setError(null);
    try {
      await apiSend(`/api/auth/users/${user.id}`, 'PATCH', { password });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(11,14,20,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }} onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={e => e.stopPropagation()}
        style={{ ...card, width: 400, background: 'var(--surface-raised)' }}
      >
        <h3 style={{ margin: '0 0 4px 0', fontSize: 16 }}>{t('changePasswordTitle')}</h3>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>{user.email}</div>
        <input
          required type="password" placeholder={t('newPassword')}
          value={password} onChange={e => setPassword(e.target.value)}
          style={{ ...inputStyle, marginBottom: 8 }} minLength={8} autoFocus
        />
        <input
          required type="password" placeholder={t('confirmPassword')}
          value={confirm} onChange={e => setConfirm(e.target.value)}
          style={{ ...inputStyle, marginBottom: 12 }} minLength={8}
        />
        {error && <div style={{ color: 'var(--status-critical)', marginBottom: 12, fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnGhost}>{t('cancel')}</button>
          <button type="submit" disabled={submitting} style={btnPrimary}>
            {submitting ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function CreateUserForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('admin.users');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'admin' | 'reviewer' | 'viewer'>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiSend('/api/auth/users', 'POST', {
        email, password, display_name: displayName || undefined, role_name: role,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ ...card, marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <input required type="email" placeholder={t('email')} value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        <input required type="password" placeholder={t('password')} value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} minLength={8} />
        <input placeholder={t('displayName')} value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} />
        <select value={role} onChange={e => setRole(e.target.value as typeof role)} style={inputStyle}>
          <option value="viewer">viewer</option>
          <option value="reviewer">reviewer</option>
          <option value="admin">admin</option>
        </select>
      </div>
      {error && <div style={{ color: 'var(--status-critical)', marginBottom: 12, fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={btnGhost}>{t('cancel')}</button>
        <button type="submit" disabled={submitting} style={btnPrimary}>
          {submitting ? t('creating') : t('create')}
        </button>
      </div>
    </form>
  );
}

// ─── API Keys ────────────────────────────────────────────────

function ApiKeysSection() {
  const t = useTranslations('admin.apiKeys');
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function refresh() {
    try {
      const data = await apiGet<{ keys: ApiKeyRow[] }>('/api/auth/api-keys');
      setKeys(data.keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleRevoke(id: string) {
    if (!confirm(t('confirmRevoke'))) return;
    try {
      await apiSend(`/api/auth/api-keys/${id}`, 'DELETE');
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Revoke failed');
    }
  }

  if (error) return <div style={{ color: 'var(--status-critical)' }}>{error}</div>;
  if (!keys) return <div>Loading...</div>;

  return (
    <div>
      {newKey && (
        <div style={{ ...card, background: 'var(--status-warning-bg)', borderColor: 'var(--status-warning)', marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('keyCreated')}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {t('keyCreatedWarning')}
          </div>
          <code style={{
            display: 'block',
            padding: 10,
            background: 'white',
            borderRadius: 4,
            fontFamily: 'monospace',
            fontSize: 13,
            wordBreak: 'break-all',
            userSelect: 'all',
          }}>
            {newKey}
          </code>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              onClick={() => { navigator.clipboard.writeText(newKey); }}
              style={btnGhost}
            >
              {t('copy')}
            </button>
            <button onClick={() => setNewKey(null)} style={btnPrimary}>
              {t('dismiss')}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          {t('count', { count: keys.length })}
        </div>
        <button onClick={() => setCreating(true)} style={btnPrimary}>
          + {t('newKey')}
        </button>
      </div>

      {creating && (
        <CreateApiKeyForm
          onDone={(rawKey) => { setCreating(false); setNewKey(rawKey); refresh(); }}
          onCancel={() => setCreating(false)}
        />
      )}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={th}>{t('name')}</th>
            <th style={th}>{t('prefix')}</th>
            <th style={th}>{t('permissions')}</th>
            <th style={th}>{t('lastUsed')}</th>
            <th style={th}>{t('status')}</th>
            <th style={th}>{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(k => (
            <tr key={k.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={td}>{k.name}</td>
              <td style={td}><code style={{ fontSize: 12 }}>{k.key_prefix}…</code></td>
              <td style={td}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {k.permissions.map(p => (
                    <span key={p} style={pillStyle}>{p}</span>
                  ))}
                </div>
              </td>
              <td style={td}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td>
              <td style={td}>
                <span style={{ color: k.is_active ? 'var(--status-success)' : 'var(--text-muted)' }}>
                  {k.is_active ? t('active') : t('revoked')}
                </span>
              </td>
              <td style={td}>
                {k.is_active && (
                  <button onClick={() => handleRevoke(k.id)} className="btn-delete" style={btnGhost}>
                    {t('revoke')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ALL_PERMISSIONS = [
  'projects:read', 'projects:write', 'projects:deploy', 'projects:delete',
  'reviews:read', 'reviews:decide',
  'deploys:read',
  'versions:read', 'versions:publish',
  'infra:read', 'infra:admin',
  'settings:read', 'settings:write',
  'users:manage',
  'mcp:access',
] as const;

function CreateApiKeyForm({ onDone, onCancel }: { onDone: (rawKey: string) => void; onCancel: () => void }) {
  const t = useTranslations('admin.apiKeys');
  const { hasPermission } = useAuth();
  const [name, setName] = useState('');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggle(p: string) {
    const next = new Set(perms);
    if (next.has(p)) next.delete(p); else next.add(p);
    setPerms(next);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (perms.size === 0) { setError(t('errorNoPerms')); return; }
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiSend<{ key: { raw_key: string } }>(
        '/api/auth/api-keys', 'POST',
        { name, permissions: Array.from(perms) }
      );
      onDone(data.key.raw_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ ...card, marginBottom: 16 }}>
      <input
        required
        placeholder={t('keyNamePlaceholder')}
        value={name}
        onChange={e => setName(e.target.value)}
        style={{ ...inputStyle, marginBottom: 12, width: '100%' }}
      />
      <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--text-secondary)' }}>
        {t('selectPerms')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 12 }}>
        {ALL_PERMISSIONS.map(p => {
          const available = hasPermission('*') || hasPermission(p);
          return (
            <label
              key={p}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                opacity: available ? 1 : 0.4,
                cursor: available ? 'pointer' : 'not-allowed',
              }}
            >
              <input
                type="checkbox"
                disabled={!available}
                checked={perms.has(p)}
                onChange={() => toggle(p)}
              />
              <code>{p}</code>
            </label>
          );
        })}
      </div>
      {error && <div style={{ color: 'var(--status-critical)', marginBottom: 12, fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={btnGhost}>{t('cancel')}</button>
        <button type="submit" disabled={submitting} style={btnPrimary}>
          {submitting ? t('creating') : t('create')}
        </button>
      </div>
    </form>
  );
}

// ─── Audit Log ───────────────────────────────────────────────

function AuditLogSection() {
  const t = useTranslations('admin.audit');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  async function refresh() {
    try {
      const data = await apiGet<{ entries: AuditEntry[] }>('/api/auth/audit-log?limit=500');
      setEntries(data.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    }
  }

  useEffect(() => { refresh(); }, []);

  if (error) return <div style={{ color: 'var(--status-critical)' }}>{error}</div>;
  if (!entries) return <div>Loading...</div>;

  const shown = filter
    ? entries.filter(e => e.action === filter)
    : entries;

  const actionCounts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.action] = (acc[e.action] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button onClick={() => setFilter('')} style={filter === '' ? btnPrimary : btnGhost}>
          {t('all')} ({entries.length})
        </button>
        {Object.entries(actionCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([action, count]) => (
            <button
              key={action}
              onClick={() => setFilter(action)}
              style={filter === action ? btnPrimary : btnGhost}
            >
              {action} ({count})
            </button>
          ))
        }
        <button onClick={refresh} style={btnGhost}>{t('refresh')}</button>
      </div>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={th}>{t('time')}</th>
            <th style={th}>{t('user')}</th>
            <th style={th}>{t('action')}</th>
            <th style={th}>{t('resource')}</th>
            <th style={th}>{t('ip')}</th>
            <th style={th}>{t('metadata')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(e => (
            <tr key={e.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ ...td, fontSize: 12 }}>{new Date(e.created_at).toLocaleString()}</td>
              <td style={{ ...td, fontSize: 12 }}>{e.email ?? '—'}</td>
              <td style={{ ...td, fontSize: 12 }}>
                <span style={{
                  ...pillStyle,
                  background:
                    e.action === 'login' ? 'var(--status-success-bg)' :
                    e.action === 'login_failed' ? 'var(--status-critical-bg)' :
                    e.action === 'permission_denied' ? 'var(--status-critical-bg)' :
                    e.action === 'anonymous_request' ? 'var(--status-warning-bg)' :
                    'var(--accent-blue-bg)',
                }}>
                  {e.action}
                </span>
              </td>
              <td style={{ ...td, fontSize: 12, fontFamily: 'monospace' }}>{e.resource ?? '—'}</td>
              <td style={{ ...td, fontSize: 12 }}>{e.ip_address ?? '—'}</td>
              <td style={{ ...td, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', maxWidth: 320 }}>
                {Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Shared styles ───────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--fs-sm)',
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  overflow: 'hidden',
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--sp-3) var(--sp-4)',
  fontWeight: 600,
  color: 'var(--ink-500)',
  fontSize: 'var(--fs-sm)',
  borderBottom: '1px solid var(--border)',
  background: 'var(--ink-50)',
};
const td: React.CSSProperties = {
  padding: 'var(--sp-3) var(--sp-4)',
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--ink-100)',
  color: 'var(--ink-700)',
  fontSize: 'var(--fs-sm)',
};
const inputStyle: React.CSSProperties = {
  padding: '8px var(--sp-3)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-md)',
  fontFamily: 'inherit',
  background: 'var(--surface-1)',
  color: 'var(--ink-900)',
  outline: 'none',
};
const selectStyle: React.CSSProperties = {
  padding: '6px var(--sp-3)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-sm)',
  background: 'var(--surface-1)',
  color: 'var(--ink-900)',
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const btnPrimary: React.CSSProperties = {
  padding: '8px var(--sp-4)',
  background: 'var(--sea-500)',
  color: 'var(--text-inverse)',
  border: '1px solid var(--sea-500)',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
  fontWeight: 600,
  fontFamily: 'inherit',
};
const btnGhost: React.CSSProperties = {
  padding: '8px var(--sp-4)',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
  color: 'var(--ink-700)',
  fontFamily: 'inherit',
  fontWeight: 500,
};
const pillStyle: React.CSSProperties = {
  padding: '2px var(--sp-2)',
  background: 'var(--sea-50)',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-xs)',
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--sea-700)',
  fontWeight: 500,
};
const card: React.CSSProperties = {
  padding: 'var(--sp-5)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--surface-1)',
};
