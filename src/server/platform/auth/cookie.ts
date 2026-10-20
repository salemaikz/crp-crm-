// Параметры cookie сессии без Next (D-091). Set-Cookie ставит src/server/platform/http/sessionCookie.ts.
import type { SessionCookieSpec } from './types';

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE_SECURE = '__Host-crm_sid';
export const SESSION_COOKIE_PLAIN = 'crm_sid';

/**
 * Secure и префикс `__Host-` — если APP_ORIGIN начинается с https:. В production APP_ORIGIN по
 * http допустим только для localhost/127.0.0.1/::1 (e2e на собранном приложении); иначе — ошибка
 * конфигурации при старте (fail closed). Нет APP_ORIGIN в production — тоже ошибка.
 */
export function sessionCookieSpec(env: Env = process.env): SessionCookieSpec {
  void env;
  throw new Error('sessionCookieSpec: P3');
}

/** Оба имени: выход и чтение принимают любое (смена схемы при переезде на https не оставит мусор). */
export function sessionCookieNames(): readonly string[] {
  return [SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN];
}
