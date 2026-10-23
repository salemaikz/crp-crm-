// Выбор вида (светлый / тёмный / как в системе): чистые функции без Next и DOM.
// Выбор лежит в cookie `crm_theme` на устройстве (D-342): тема — не данные, ПДн в ней нет.

export type ThemeMode = 'light' | 'dark' | 'system';
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];
export const THEME_COOKIE = 'crm_theme';
/** Срок cookie — год, секунды. */
export const THEME_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export function parseThemeMode(value: unknown): ThemeMode | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

/**
 * Выбранный вид: cookie → вид по умолчанию установки → «как в системе».
 * Флаг выключен — всегда светлая (прежнее поведение): cookie и настройка игнорируются.
 */
export function effectiveMode(cookie: unknown, defaultMode: ThemeMode | null, enabled: boolean): ThemeMode {
  if (!enabled) return 'light';
  return parseThemeMode(cookie) ?? defaultMode ?? 'system';
}

/** Значение атрибута `data-theme` на <html>: у «как в системе» атрибута нет, решает медиазапрос. */
export function themeAttribute(mode: ThemeMode): 'light' | 'dark' | undefined {
  return mode === 'system' ? undefined : mode;
}

/** Строка для document.cookie. */
export function themeCookieString(mode: ThemeMode): string {
  return `${THEME_COOKIE}=${mode}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** Атрибут для <html>: флаг выключен — атрибута нет совсем (разметка прежняя), иначе по выбранному виду. */
export function htmlThemeAttribute(cookie: unknown, defaultMode: ThemeMode | null, enabled: boolean): 'light' | 'dark' | undefined {
  return enabled ? themeAttribute(effectiveMode(cookie, defaultMode, true)) : undefined;
}
