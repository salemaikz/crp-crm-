// Локали и пространства имён сообщений. Код казахского — `kk` везде (Intl, <html lang>, файлы).
// Пока включён только ru; kk добавляется в LOCALES вместе с messages/kk/ и проходит тест паритета.

export const LOCALES = ['ru'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'ru';

/**
 * Пространства имён: messages/<locale>/<ns>.json → ключ верхнего уровня <ns>. Файл по модулю;
 * новый модуль добавляет свою строку сюда. Каждая строка обязана иметь файл (проверяет тест паритета).
 */
export const NAMESPACES = ['common', 'auth', 'team', 'clients', 'booking', 'distribution', 'calls', 'import', 'shell', 'reports', 'notify', 'call', 'deals'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Запасной пояс только для установки без настроек (до `crmctl config apply`). Рабочий пояс клиента
 * берётся из `global.org.timezone` активных настроек (src/i18n/request.ts).
 */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Пояс установки: из настроек. Нет настроек (пусто) — запасной. Неверный пояс — ошибка, а не тихий
 * UTC: часы расписания и отчёты сдвинулись бы без видимой причины. Схема настроек не пропускает
 * такой пояс при записи (TimeZone в ConfigV1), эта проверка — страховка на пути чтения.
 */
export function resolveTimeZone(configured?: string | null): string {
  const tz = configured?.trim();
  if (!tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new Error(`настройки: неизвестный часовой пояс IANA «${tz}»`);
  }
  return tz;
}
