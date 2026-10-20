// Локали и пространства имён сообщений. Код казахского — `kk` везде (Intl, <html lang>, файлы).
// Пока включён только ru; kk добавляется в LOCALES вместе с messages/kk/ и проходит тест паритета.

export const LOCALES = ['ru'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'ru';

/**
 * Пространства имён: messages/<locale>/<ns>.json → ключ верхнего уровня <ns>. Файл по модулю;
 * новый модуль добавляет свою строку сюда. Каждая строка обязана иметь файл (проверяет тест паритета).
 */
export const NAMESPACES = ['common', 'auth'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Пояс по умолчанию; рабочий пояс установки берётся из настроек (CONFIG), а не отсюда. */
export const DEFAULT_TIME_ZONE = 'Asia/Almaty';
