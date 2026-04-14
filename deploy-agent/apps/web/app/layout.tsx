import './globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

export const metadata: Metadata = {
  title: 'Wave Deploy Agent',
  description: 'AI 驅動的安全部署平台',
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations('nav');

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <div style={{ display: 'flex', minHeight: '100vh' }}>
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
                <NavLink href="/" label={t('projects')} />
                <NavLink href="/reviews" label={t('reviews')} />
                <NavLink href="/deploys" label={t('deploys')} />
                <NavLink href="/infra" label={t('infra')} />
                <NavLink href="/settings" label={t('settings')} />
              </div>
            </nav>
            <main style={{ flex: 1, padding: '24px 32px', overflow: 'auto' }}>
              {children}
            </main>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} style={{
      display: 'block',
      padding: '8px 16px',
      color: 'var(--text-secondary)',
      fontSize: 14,
      borderLeft: '2px solid transparent',
    }}>
      {label}
    </a>
  );
}
