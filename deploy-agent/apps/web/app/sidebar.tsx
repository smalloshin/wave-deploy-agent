'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth';

interface NavItem {
  href: string;
  label: string;
}

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  return (
    <nav style={{
      width: 220,
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border)',
      padding: '16px 0',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ padding: '0 16px 16px', borderBottom: '1px solid var(--border)' }}>
        <h1 style={{ fontSize: 16, fontWeight: 600 }}>Wave Deploy Agent</h1>
      </div>
      <div style={{ padding: '8px 0', flex: 1 }}>
        {items.map((item) => {
          const active = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);
          return (
            <a
              key={item.href}
              href={item.href}
              style={{
                display: 'block',
                padding: '8px 16px',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 14,
                fontWeight: active ? 600 : 400,
                borderLeft: active ? '2px solid var(--accent-blue, #58a6ff)' : '2px solid transparent',
                background: active ? 'rgba(88,166,255,0.08)' : 'transparent',
                textDecoration: 'none',
                transition: 'all 0.15s ease',
              }}
            >
              {item.label}
            </a>
          );
        })}
      </div>

      {/* User info / auth controls */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        fontSize: 13,
      }}>
        {loading ? (
          <span style={{ color: 'var(--text-secondary)' }}>—</span>
        ) : user ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div>
              <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                {user.display_name ?? user.email}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {user.role_name}
              </div>
            </div>
            <button
              onClick={handleLogout}
              style={{
                padding: '4px 8px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 12,
                textAlign: 'left',
              }}
            >
              登出
            </button>
          </div>
        ) : (
          <a
            href="/login"
            style={{
              color: 'var(--accent-blue, #58a6ff)',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            登入 →
          </a>
        )}
      </div>
    </nav>
  );
}
