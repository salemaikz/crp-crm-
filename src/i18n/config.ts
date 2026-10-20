// Локали и пространства имён сообщений. Код казахского — `kk` везде (Intl, <html lang>, файлы).
// Пока включён только ru; kk добавляется в LOCALES вместе с messages/kk/ и проходит тест паритета.

export const LOCALES = ['ru'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'ru';

/**
 * Пространства имён: messages/<locale>/<ns>.json → ключ верхнего уровня <ns>. Файл по модулю;
 * новый модуль добавляет свою строку сюда. Каждая строка обязана иметь файл (проверяет тест паритета).
 */
export const NAMESPACES = ['common', 'auth', 'booking'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Запасной пояс, пока настроек установки нет. Не рабочий пояс клиента: он берётся из настроек (CONFIG).
 * TODO: заменить на значение из активной конфигурации, когда появится getActiveConfig.
 */
export const DEFAULT_TIME_ZONE = 'UTC';

/** Пояс установки: из настроек, если заданы и валидны, иначе запасной. */
export function resolveTimeZone(configured?: string | null): string {
  const tz = configured?.trim();
  if (!tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}
