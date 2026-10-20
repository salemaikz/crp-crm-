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
 * 'ok' — Origin есть и точно равен origin из APP_ORIGIN (схема, хост, порт; APP_ORIGIN нормализуется:
 * `https://crm.x.kz/` = `https://crm.x.kz`); при наличии Sec-Fetch-Site он `same-origin` или `none`.
 * 'missing' — нет Origin или он 'null'; 'mismatch' — другой origin или APP_ORIGIN не задан в
 * production; 'cross_site' — Sec-Fetch-Site `cross-site`/`same-site`. Всё кроме 'ok' → 403.
 * `opts.requestOrigin` — только вне production и только без APP_ORIGIN: origin самого запроса
 * (обёртки берут его из req.url, где нет заголовка Host — например, в тестах).
 */
export function checkOrigin(headers: HeaderGetter, env: Env = process.env, opts: { requestOrigin?: string } = {}): OriginVerdict {
  const origin = headers.get('origin')?.trim();
  if (!origin || origin === 'null') return 'missing';
  const expected = expectedOrigin(headers, env, opts.requestOrigin);
  if (!expected || origin !== expected) return 'mismatch';
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return 'cross_site';
  return 'ok';
}

/** origin из APP_ORIGIN (нормализованный) или null: не задан или не URL. */
export function appOrigin(env: Env = process.env): string | null {
  const raw = env.APP_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** origin из APP_ORIGIN; вне production без него — из запроса или Host (разработка, тесты). Иначе null (fail closed). */
function expectedOrigin(headers: HeaderGetter, env: Env, requestOrigin: string | undefined): string | null {
  if (env.APP_ORIGIN?.trim()) return appOrigin(env);
  if (env.NODE_ENV === 'production') return null;
  if (requestOrigin) return requestOrigin;
  const host = headers.get('host')?.trim();
  return host ? `http://${host}` : null;
}

/** Нужна ли проверка: метод не из SAFE_METHODS и путь не из ORIGIN_EXEMPT_PREFIXES. */
export function originCheckRequired(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !ORIGIN_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}
