import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

const SUPPORTED = ['zh-TW', 'en'] as const;
type Locale = typeof SUPPORTED[number];
const DEFAULT_LOCALE: Locale = 'zh-TW';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

function normalize(input: string | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  // Exact match
  if ((SUPPORTED as readonly string[]).includes(input)) return input as Locale;
  // Prefix match (e.g. "en-US" → "en")
  const prefix = input.split('-')[0].toLowerCase();
  if (prefix === 'en') return 'en';
  if (prefix === 'zh') return 'zh-TW';
  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  // 1. Cookie override (set by locale switcher)
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  if (cookieLocale) {
    const locale = normalize(cookieLocale);
    return {
      locale,
      messages: (await import(`../messages/${locale}.json`)).default,
    };
  }
  // 2. Fallback to Accept-Language header
  const hdrs = await headers();
  const accept = hdrs.get('accept-language') ?? '';
  const first = accept.split(',')[0]?.trim();
  const locale = normalize(first);
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
