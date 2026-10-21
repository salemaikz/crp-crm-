// Окружение установки: чтение переменных и проверки конфигурации (fail closed).
// Нормативно: docs/CONFIG.md §7. Секреты читаются только здесь и в secrets/ (позже).
// Источник: платформа LMS 2cd8a2b src/lib/env.ts (без режима демо: встроенной БД в продукте нет).
import type { Watermark } from '@crm/core/license';
import { appOrigin } from './auth/csrf';
import { clientIpConfigProblem } from './http/clientIp';
import { buildWatermark, isVercelStand, standRequested, vercelStandOverlay } from './stand';

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

/** Разработка и тесты: только здесь допустимы умолчания «включено». Пустое окружение — как бой. */
export function isDevOrTest(e: Env = process.env): boolean {
  return e.NODE_ENV === 'development' || e.NODE_ENV === 'test';
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

/**
 * Что в окружении не даёт запустить веб-приложение (пусто — можно). Проверяет src/instrumentation.ts при
 * старте сервера Next; в production нужны APP_ORIGIN (иначе 403 на любую мутацию, D-153) и
 * CRM_PROXY_SECRET (иначе IP клиентов неизвестен и лимиты входа общие, D-155). Обе строки пишет crmctl.
 * Режим стенда на Vercel (D-318) вместо CRM_PROXY_SECRET требует то, без чего стенд не работает (база,
 * CRM_DEMO_SECRET для выведенных секретов); в сборке клиента просьба о нём — отказ запуска.
 */
export function startupConfigProblems(e: Env = process.env, watermark: Pick<Watermark, 'customer'> = buildWatermark()): string[] {
  const problems: string[] = [];
  if (standRequested(e) && watermark.customer !== null) {
    problems.push('VERCEL=1 и CRM_STAND=1 в сборке клиента: режим стенда на Vercel только для общей сборки на синтетике (D-318). Уберите CRM_STAND из окружения');
  }
  const stand = isVercelStand(e, watermark);
  if (stand) problems.push(...vercelStandOverlay(e).problems);
  if (isProduction(e) && !appOrigin(e) && !(stand && problems.some((p) => p.startsWith('APP_ORIGIN')))) {
    problems.push('APP_ORIGIN не задан или не адрес http(s): без него любая мутация получает 403 (docs/CONFIG.md §7)');
  }
  const ip = clientIpConfigProblem(e, watermark);
  if (ip) problems.push(ip);
  return problems;
}
