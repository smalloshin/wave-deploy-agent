'use client';

import { usePathname } from 'next/navigation';

interface NavItem {
  href: string;
  label: string;
}

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

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
    </nav>
  );
}
