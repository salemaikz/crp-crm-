import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE, NAMESPACES, type AppLocale, type Namespace } from './config';

type Messages = Record<string, unknown>;

async function loadNamespace(locale: AppLocale, ns: Namespace): Promise<Messages> {
  const mod = (await import(`../../messages/${locale}/${ns}.json`)) as { default: Messages };
  return mod.default;
}

/** Все сообщения локали одним деревом: { common: {…}, … }. */
export async function loadMessages(locale: AppLocale): Promise<Messages> {
  const parts = await Promise.all(NAMESPACES.map(async (ns) => [ns, await loadNamespace(locale, ns)] as const));
  return Object.fromEntries(parts);
}

// Маршруты без префикса локали: язык интерфейса пока один. Выбор языка пользователя появится с kk.
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: await loadMessages(DEFAULT_LOCALE),
  timeZone: DEFAULT_TIME_ZONE,
}));
