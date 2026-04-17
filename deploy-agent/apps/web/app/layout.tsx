import './globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Sidebar } from './sidebar';
import { AuthProvider } from '../lib/auth';

export const metadata: Metadata = {
  title: 'Wave Deploy Agent',
  description: 'AI 驅動的安全部署平台',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations('nav');

  const navItems = [
    { href: '/', label: t('projects') },
    { href: '/reviews', label: t('reviews') },
    { href: '/deploys', label: t('deploys') },
    { href: '/infra', label: t('infra') },
    { href: '/settings', label: t('settings') },
  ];

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <AuthProvider>
            <div style={{ display: 'flex', minHeight: '100vh' }}>
              <Sidebar items={navItems} />
              <main style={{ flex: 1, padding: '24px 32px', overflow: 'auto' }}>
                {children}
              </main>
            </div>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
