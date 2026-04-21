import './globals.css';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Sidebar } from './sidebar';
import { AuthProvider } from '../lib/auth';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

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
    { href: '/admin', label: t('admin'), requiresPermission: 'users:manage' },
  ];

  return (
    <html lang={locale} className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <AuthProvider>
            <div style={{ display: 'flex', minHeight: '100vh' }}>
              <Sidebar items={navItems} />
              <main style={{ flex: 1, padding: '32px 48px 64px', overflow: 'auto', maxWidth: 1400, width: '100%' }}>
                {children}
              </main>
            </div>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
