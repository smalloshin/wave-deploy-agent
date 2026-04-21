'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '../lib/auth';
import { LocaleSwitcher } from '../lib/locale-switcher';

interface NavItem {
  href: string;
  label: string;
  requiresPermission?: string;
}

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout, hasPermission } = useAuth();
  const t = useTranslations('auth');

  const visibleItems = items.filter(item =>
    !item.requiresPermission || hasPermission(item.requiresPermission)
  );

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  return (
    <nav style={{
      width: 240,
      background: 'var(--surface-1)',
      borderRight: '1px solid var(--border)',
      padding: 'var(--sp-4) 0',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ padding: '0 var(--sp-4) var(--sp-4)', borderBottom: '1px solid var(--border)' }}>
        <h1 style={{
          fontSize: 'var(--fs-md)',
          fontWeight: 700,
          letterSpacing: '-0.01em',
          color: 'var(--ink-900)',
        }}>Wave Deploy Agent</h1>
      </div>
      <div style={{ padding: 'var(--sp-3) var(--sp-3)', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visibleItems.map((item) => {
          const active = item.href === '/'
            ? pathname === '/'
            : pathname.startsWith(item.href);
          return (
            <a
              key={item.href}
              href={item.href}
              style={{
                display: 'block',
                padding: 'var(--sp-3) var(--sp-4)',
                borderRadius: 'var(--r-md)',
                color: active ? 'var(--sea-600)' : 'var(--ink-700)',
                fontSize: 'var(--fs-md)',
                fontWeight: active ? 600 : 500,
                background: active ? 'var(--sea-50)' : 'transparent',
                textDecoration: 'none',
                transition: 'background 0.12s, color 0.12s',
                lineHeight: 1.3,
              }}
            >
              {item.label}
            </a>
          );
        })}
      </div>

      {/* Locale switcher */}
      <div style={{
        padding: 'var(--sp-3) var(--sp-4)',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}>
        <LocaleSwitcher />
      </div>

      {/* User info / auth controls */}
      <div style={{
        padding: 'var(--sp-4)',
        borderTop: '1px solid var(--border)',
        fontSize: 'var(--fs-sm)',
      }}>
        {loading ? (
          <span style={{ color: 'var(--ink-400)' }}>—</span>
        ) : user ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <div>
              <div style={{
                fontWeight: 600,
                fontSize: 'var(--fs-sm)',
                color: 'var(--ink-900)',
                lineHeight: 1.3,
              }}>
                {user.display_name ?? user.email}
              </div>
              <div style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--ink-500)',
                marginTop: 2,
              }}>
                {user.role_name}
              </div>
            </div>
            <button
              onClick={handleLogout}
              style={{
                padding: '6px var(--sp-3)',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--ink-500)',
                cursor: 'pointer',
                fontSize: 'var(--fs-xs)',
                fontWeight: 500,
                textAlign: 'left',
                fontFamily: 'inherit',
                transition: 'background 0.12s, border-color 0.12s',
              }}
            >
              {t('signOut')}
            </button>
          </div>
        ) : (
          <a
            href="/login"
            style={{
              color: 'var(--sea-500)',
              textDecoration: 'none',
              fontSize: 'var(--fs-sm)',
              fontWeight: 500,
            }}
          >
            {t('signInLink')}
          </a>
        )}
      </div>
    </nav>
  );
}
