// Параметры cookie сессии без Next (D-091). Set-Cookie ставит src/server/platform/http/sessionCookie.ts.
import { configuredAppOrigin } from '../stand/origin';
import type { SessionCookieSpec } from './types';

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE_SECURE = '__Host-crm_sid';
export const SESSION_COOKIE_PLAIN = 'crm_sid';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Secure и префикс `__Host-` — если APP_ORIGIN начинается с https:. В production APP_ORIGIN по
 * http допустим только для localhost/127.0.0.1/::1 (e2e на собранном приложении); иначе — ошибка
 * конфигурации при старте (fail closed). Нет APP_ORIGIN в production — тоже ошибка.
 */
export function sessionCookieSpec(env: Env = process.env): SessionCookieSpec {
  const production = env.NODE_ENV === 'production';
  const raw = configuredAppOrigin(env);
  if (!raw) {
    if (production) throw new Error('APP_ORIGIN is not set in production (docs/CONFIG.md §7): cookie сессии не выдаётся.');
    return { name: SESSION_COOKIE_PLAIN, httpOnly: true, secure: false, sameSite: 'lax', path: '/' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_ORIGIN is not a valid URL.');
  }
  if (url.protocol === 'https:') return { name: SESSION_COOKIE_SECURE, httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
  if (url.protocol !== 'http:') throw new Error('APP_ORIGIN must be an http(s) origin.');
  if (production && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('APP_ORIGIN must be https in production (http допустим только для localhost).');
  }
  return { name: SESSION_COOKIE_PLAIN, httpOnly: true, secure: false, sameSite: 'lax', path: '/' };
}

/**
 * Метка «выход не завершён» (D-310). Ставит телефон из скрипта (не httpOnly, `SameSite=Strict`, `Path=/`, без ПДн,
 * значение не важно) при «Всё равно выйти» и пока висит флаг незавершённого выхода. Сервер, увидев её на запросе с
 * сессией, закрывает эту сессию в БД и стирает cookie; снимает метку успешный вход или выход. Имя продублировано в
 * src/ui/call/logoutPending.ts (интерфейс не импортирует сервер) — равенство проверяет тест.
 */
export const LOGOUT_MARKER_COOKIE = 'crm_logout';

/** Оба имени: выход и чтение принимают любое (смена схемы при переезде на https не оставит мусор). */
export function sessionCookieNames(): readonly string[] {
  return [SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN];
}
