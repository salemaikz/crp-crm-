// Единственное место, где cookie сессии читается и ставится через Next (D-091).
// Имя и флаги — из auth/cookie.ts; значение — сырой токен (в БД его sha256).
import { cookies } from 'next/headers';
import { LOGOUT_MARKER_COOKIE, SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE, sessionCookieSpec } from '../auth/cookie';
import type { IssuedSession } from '../auth/types';

/**
 * Токен из cookie запроса или null. Читается только cookie с именем текущей схемы: при https
 * это `__Host-crm_sid`, которую поддомен или http-страница подложить не могут.
 */
export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(sessionCookieSpec().name)?.value ?? null;
}

/** На запросе стоит метка «выход не завершён» (D-310). */
export async function hasLogoutMarker(): Promise<boolean> {
  const store = await cookies();
  return store.get(LOGOUT_MARKER_COOKIE) !== undefined;
}

/**
 * Поставить cookie сессии (route handler или server action). Cookie другой схемы удаляется. Метка «выход не
 * завершён» снимается (D-310): её место — до входа, а по ней сервер закрыл бы и эту сессию. Перевыпуск при продлении
 * идёт тем же путём, но с меткой до продления не доходит: getSession() закрывает сессию раньше.
 */
export async function setSessionCookie(s: Pick<IssuedSession, 'token' | 'maxAgeSec'>): Promise<void> {
  const spec = sessionCookieSpec();
  const store = await cookies();
  for (const name of [SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN]) {
    if (name !== spec.name) expireCookie(store, name);
  }
  if (store.get(LOGOUT_MARKER_COOKIE) !== undefined) expireMarker(store);
  store.set(spec.name, s.token, {
    httpOnly: spec.httpOnly,
    secure: spec.secure,
    sameSite: spec.sameSite,
    path: spec.path,
    maxAge: s.maxAgeSec,
  });
}

/** Удалить cookie сессии под обоими именами и метку «выход не завершён» (выход завершён). */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  for (const name of [SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN]) expireCookie(store, name);
  if (store.get(LOGOUT_MARKER_COOKIE) !== undefined) expireMarker(store);
}

function expireMarker(store: Awaited<ReturnType<typeof cookies>>): void {
  // cookie определяется именем, доменом и путём: путь тот же, что ставит телефон (`/`)
  store.set(LOGOUT_MARKER_COOKIE, '', { httpOnly: false, secure: sessionCookieSpec().secure, sameSite: 'strict', path: '/', maxAge: 0 });
}

function expireCookie(store: Awaited<ReturnType<typeof cookies>>, name: string): void {
  // __Host- принимается браузером только с Secure и Path=/, даже когда cookie гасится
  store.set(name, '', { httpOnly: true, secure: name === SESSION_COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 0 });
}
