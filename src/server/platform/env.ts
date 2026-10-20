// Окружение установки: чтение переменных и проверки конфигурации (fail closed).
// Нормативно: docs/CONFIG.md §7. Секреты читаются только здесь и в secrets/ (позже).
// Источник: платформа LMS 2cd8a2b src/lib/env.ts (без режима демо: встроенной БД в продукте нет).

/** Окружение как словарь: совместимо с process.env, тестам можно передать любой объект. */
export type Env = Record<string, string | undefined>;

/** Значение переменной без пробелов по краям; пустая строка = не задана. */
export function readEnv(e: Env, name: string): string | undefined {
  const v = e[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function isProduction(e: Env = process.env): boolean {
  return e.NODE_ENV === 'production';
}

/**
 * Адрес БД приложения. Без DATABASE_URL приложение не стартует ни в production, ни в разработке:
 * встроенной БД «на всякий случай» нет, иначе данные тихо пропали бы при перезапуске.
 */
export function databaseUrl(e: Env = process.env): string {
  const url = readEnv(e, 'DATABASE_URL');
  if (url) return url;
  throw new Error(
    isProduction(e)
      ? 'DATABASE_URL is not set in production. Set it in the installation env file (docs/CONFIG.md §7).'
      : 'DATABASE_URL is not set. Point it at a local PostgreSQL 16 (see README: «Запуск локально»).',
  );
}

/** Проверка конфигурации БД перед открытием драйвера. */
export function assertDbConfigured(e: Env = process.env): void {
  databaseUrl(e);
}

/**
 * Адрес БД для миграций: MIGRATE_DATABASE_URL (роль crm_owner с правом на DDL), иначе DATABASE_URL.
 * Приложение работает под crm_app без DDL, поэтому на сервере migrate берёт отдельный адрес.
 */
export function migrateDatabaseUrl(e: Env = process.env): string {
  return readEnv(e, 'MIGRATE_DATABASE_URL') ?? databaseUrl(e);
}
