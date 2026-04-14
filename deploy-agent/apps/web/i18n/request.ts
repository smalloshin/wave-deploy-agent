import {getRequestConfig} from 'next-intl/server';

export default getRequestConfig(async () => {
  const locale = 'zh-TW'; // TODO: detect from cookie/header
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default
  };
});
