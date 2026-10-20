// Проверка Origin мутирующих запросов (CSRF поверх SameSite=Lax, D-095, ARCHITECTURE §5.2 п. 3).
// Чистая функция от заголовков и env: её зовут src/proxy.ts (первый рубеж) и обёртки
// route()/publicRoute()/action() (второй рубеж — Next пропускает server action без Origin).
import type { OriginVerdict } from './types';

type HeaderGetter = { get(name: string): string | null | undefined };
type Env = Record<string, string | undefined>;

/** Методы без побочных эффектов: Origin не проверяется. GET-обработчики ничего не меняют. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Машинные входы со своим ключом или подписью: Origin не требуется (publicRoute origin: 'skip'). */
export const ORIGIN_EXEMPT_PREFIXES: readonly string[] = ['/api/ingest/', '/api/hooks/'];

/**
 * 'ok' — Origin есть и точно равен origin из APP_ORIGIN (схема, хост, порт); при наличии
 * Sec-Fetch-Site он `same-origin`. 'missing' — нет Origin или он 'null'; 'mismatch' — другой
 * origin; 'cross_site' — Sec-Fetch-Site `cross-site`/`same-site`. Всё кроме 'ok' → 403.
 */
export function checkOrigin(headers: HeaderGetter, env: Env = process.env): OriginVerdict {
  const origin = headers.get('origin')?.trim();
  if (!origin || origin === 'null') return 'missing';
  const expected = expectedOrigin(headers, env);
  if (!expected || origin !== expected) return 'mismatch';
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return 'cross_site';
  return 'ok';
}

/** origin из APP_ORIGIN; вне production без него — из Host (разработка, тесты). Иначе null (fail closed). */
function expectedOrigin(headers: HeaderGetter, env: Env): string | null {
  const raw = env.APP_ORIGIN?.trim();
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }
  if (env.NODE_ENV === 'production') return null;
  const host = headers.get('host')?.trim();
  return host ? `http://${host}` : null;
}

/** Нужна ли проверка: метод не из SAFE_METHODS и путь не из ORIGIN_EXEMPT_PREFIXES. */
export function originCheckRequired(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !ORIGIN_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}
