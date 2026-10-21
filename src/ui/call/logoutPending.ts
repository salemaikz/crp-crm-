// «Выход не завершён» (D-063, ARCHITECTURE §7): «Всё равно выйти» без сети не может закрыть сессию на сервере
// (cookie httpOnly, удалить её со страницы нельзя). Поэтому до запроса выхода в localStorage ставится флаг, без ПДн.
// Пока флаг стоит, любая страница приложения вместо данных показывает экран блокировки, outbox ничего не отправляет,
// а запрос выхода повторяется (событие online и таймер). После ответа сервера флаг снимается и открывается вход.
import type { StorageLike } from './tally';

export const LOGOUT_PENDING_KEY = 'crm.logout.pending';
/** Атрибут <html>: CSS прячет всё, кроме экрана блокировки (globals.css). */
export const LOGOUT_PENDING_ATTR = 'data-logout-pending';
/** Событие страницы: выход в этой вкладке не завершился, экран блокировки начинает повторы. */
export const LOGOUT_PENDING_EVENT = 'crm:logout-pending';
/** Повтор запроса выхода, пока флаг стоит. */
export const LOGOUT_RETRY_MS = 5_000;

/**
 * Метка для сервера (D-310): cookie без ПДн, не httpOnly — её ставит страница. Сервер на любом запросе с меткой
 * закрывает сессию по cookie, даже если HTML приложения больше не откроют (следующий человек сразу идёт на адрес API).
 * Снимают её успешный вход и выход (сервер) и снятие флага (страница). Имя — то же, что в
 * src/server/platform/auth/cookie.ts (проверяет тест).
 */
export const LOGOUT_MARKER_COOKIE = 'crm_logout';
/** Срок метки: дольше любого простоя сессии; снимается раньше — входом или выходом. */
const LOGOUT_MARKER_MAX_AGE_SEC = 30 * 86_400;

/** Строка document.cookie метки; maxAge 0 — стереть. Secure — только на https (на http браузер её не примет). */
export function logoutMarkerCookie(maxAgeSec: number, https: boolean): string {
  return `${LOGOUT_MARKER_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

function writeMarker(maxAgeSec: number): void {
  try {
    if (typeof document === 'undefined') return;
    document.cookie = logoutMarkerCookie(maxAgeSec, location.protocol === 'https:');
  } catch {
    // cookie недоступны: остаются флаг и экран блокировки
  }
}

/**
 * Скрипт в <head> корневого layout: выполняется до первой отрисовки любой страницы, в том числе оболочки /call из
 * кэша service worker, и прячет страницу, если выход не завершён. Пока флаг стоит, он же ставит метку для сервера
 * (D-310): сервер мог снять её, закрыв сессию, а флаг снимается только после ответа на запрос выхода. Ключ, атрибут и
 * метка — те же, что выше.
 */
export const LOGOUT_GUARD_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(LOGOUT_PENDING_KEY)})){document.documentElement.setAttribute(${JSON.stringify(LOGOUT_PENDING_ATTR)},'');document.cookie=${JSON.stringify(`${LOGOUT_MARKER_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=${LOGOUT_MARKER_MAX_AGE_SEC}`)}+(location.protocol==='https:'?'; Secure':'')}}catch(e){}`;

/** localStorage, если доступен (SSR, приватный режим и запрет хранилища дают null). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isLogoutPending(storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(LOGOUT_PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Поставить флаг и метку для сервера (D-310). Метка ставится первой и без хранилища: закроют вкладку — сервер всё
 * равно закроет сессию на первом же запросе. false — хранилище недоступно: экран блокировки держится только в этой
 * вкладке, но метка стоит.
 */
export function markLogoutPending(storage: StorageLike | null = browserStorage()): boolean {
  writeMarker(LOGOUT_MARKER_MAX_AGE_SEC);
  if (!storage) return false;
  try {
    storage.setItem(LOGOUT_PENDING_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Снять флаг и метку: сервер ответил на запрос выхода, сессии нет. */
export function clearLogoutPending(storage: StorageLike | null = browserStorage()): void {
  writeMarker(0);
  try {
    storage?.removeItem(LOGOUT_PENDING_KEY);
  } catch {
    // не критично: флаг снимет следующий успешный выход
  }
}

/**
 * Запрос выхода. true — сессии на сервере больше нет: 2xx или 401 (её и не было). Нет сети, 5xx и прочее — false,
 * флаг остаётся и запрос повторится.
 */
export async function postLogout(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

export interface CompleteDeps {
  storage: StorageLike | null;
  post: () => Promise<boolean>;
  /** После успеха: убрать кэш оболочки и метку для service worker. Ошибка не мешает завершить выход. */
  cleanup: () => Promise<void>;
}

/** Довести незавершённый выход. true — выхода нет или он завершён (флаг снят); false — повторить позже. */
export async function completePendingLogout(deps: CompleteDeps): Promise<boolean> {
  if (!isLogoutPending(deps.storage)) return true;
  if (!(await deps.post())) return false;
  await deps.cleanup().catch(() => undefined);
  clearLogoutPending(deps.storage);
  return true;
}
