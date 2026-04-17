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
      <h1 style={{ marginTop: 0 }}>{t('title')}</h1>

      <div style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
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
        padding: '8px 16px',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent-blue, #58a6ff)' : '2px solid transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        fontSize: 14,
        marginBottom: -1,
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

  if (error) return <div style={{ color: '#d1242f' }}>{error}</div>;
  if (!users) return <div>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
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
                    color: u.is_active ? '#1a7f37' : '#9a9a9a',
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
      {error && <div style={{ color: '#d1242f', marginBottom: 12, fontSize: 13 }}>{error}</div>}
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

  if (error) return <div style={{ color: '#d1242f' }}>{error}</div>;
  if (!keys) return <div>Loading...</div>;

  return (
    <div>
      {newKey && (
        <div style={{ ...card, background: '#fff8c5', borderColor: '#d4a72c', marginBottom: 16 }}>
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
                <span style={{ color: k.is_active ? '#1a7f37' : '#9a9a9a' }}>
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
      {error && <div style={{ color: '#d1242f', marginBottom: 12, fontSize: 13 }}>{error}</div>}
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

  if (error) return <div style={{ color: '#d1242f' }}>{error}</div>;
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
                    e.action === 'login' ? '#dafbe1' :
                    e.action === 'login_failed' ? '#ffebe9' :
                    e.action === 'permission_denied' ? '#ffebe9' :
                    e.action === 'anonymous_request' ? '#fff8c5' :
                    '#ddf4ff',
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
  fontSize: 13,
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  fontSize: 12,
  borderBottom: '1px solid var(--border)',
};
const td: React.CSSProperties = {
  padding: '8px 12px',
  verticalAlign: 'middle',
};
const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 13,
};
const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 12,
  background: 'white',
};
const btnPrimary: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--accent-blue, #0969da)',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 500,
};
const btnGhost: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
  color: 'var(--text-primary)',
};
const pillStyle: React.CSSProperties = {
  padding: '2px 8px',
  background: '#ddf4ff',
  borderRadius: 10,
  fontSize: 11,
  fontFamily: 'monospace',
  color: 'var(--text-primary)',
};
const card: React.CSSProperties = {
  padding: 16,
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-secondary)',
};
