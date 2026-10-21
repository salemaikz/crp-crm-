// Адрес CRM с учётом режима стенда на Vercel (D-318). Без импортов: модуль читает src/proxy.ts (первый рубеж CSRF),
// а прокси на Vercel может работать отдельной функцией, где хук старта (instrumentation) окружение не дополнял.
// Водяной знак клиента здесь не проверяется: сборка клиента признака стенда не получает, а с VERCEL=1 и CRM_STAND=1 не
// стартует вовсе (startupConfigProblems); второй рубеж CSRF — в обёртках маршрутов того же процесса.

type Env = Record<string, string | undefined>;

const trimmed = (e: Env, name: string): string | undefined => {
  const v = e[name]?.trim();
  return v ? v : undefined;
};

/**
 * Признак сборки стенда (D-318): его вшивает в бандл только `npm run vercel-build` (next.config.ts, `env`), поэтому
 * обычная сборка — общая или клиента — режим не включает, какие бы переменные ни задали при запуске. Обращение
 * строго `process.env.CRM_VERCEL_STAND_BUILD`: так его подставляет сборка. В tsx (тесты, скрипты) — из окружения.
 */
export function standBuildMarked(): boolean {
  return process.env.CRM_VERCEL_STAND_BUILD === '1';
}

/** Просьба о режиме стенда на Vercel по окружению: VERCEL=1 (ставит сама платформа) и CRM_STAND=1. */
export function standRequested(e: Env): boolean {
  return trimmed(e, 'VERCEL') === '1' && trimmed(e, 'CRM_STAND') === '1';
}

/** Имя хоста с необязательным портом, без схемы и пути: так Vercel передаёт VERCEL_PROJECT_PRODUCTION_URL. */
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;

/** https://<домен проекта> из VERCEL_PROJECT_PRODUCTION_URL или null (не задан, не имя хоста). */
export function standDefaultOrigin(e: Env): string | null {
  const host = trimmed(e, 'VERCEL_PROJECT_PRODUCTION_URL');
  return host && HOST_RE.test(host) ? `https://${host.toLowerCase()}` : null;
}

/** Строка адреса CRM: явный APP_ORIGIN, иначе в сборке стенда на Vercel — адрес проекта; иначе undefined. */
export function configuredAppOrigin(e: Env, standBuild: boolean = standBuildMarked()): string | undefined {
  return trimmed(e, 'APP_ORIGIN') ?? (standBuild && standRequested(e) ? (standDefaultOrigin(e) ?? undefined) : undefined);
}
