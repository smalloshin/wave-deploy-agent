'use client';

import { useTransition } from 'react';
import { useLocale } from 'next-intl';

// Keep in sync with i18n/request.ts SUPPORTED list
const LOCALES = [
  { code: 'zh-TW', label: '繁' },
  { code: 'en', label: 'EN' },
] as const;

export function LocaleSwitcher() {
  const current = useLocale();
  const [isPending, startTransition] = useTransition();

  function setLocale(code: string) {
    // Set cookie (1 year)
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `NEXT_LOCALE=${code}; path=/; max-age=${maxAge}; samesite=lax`;
    // Full reload so next-intl server reads new cookie
    startTransition(() => {
      window.location.reload();
    });
  }

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {LOCALES.map(l => {
        const active = l.code === current;
        return (
          <button
            key={l.code}
            onClick={() => !active && setLocale(l.code)}
            disabled={isPending || active}
            style={{
              padding: '4px 10px',
              background: active ? 'var(--sea-500)' : 'transparent',
              color: active ? 'var(--text-inverse)' : 'var(--ink-500)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              cursor: active ? 'default' : 'pointer',
              fontSize: 'var(--fs-xs)',
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
