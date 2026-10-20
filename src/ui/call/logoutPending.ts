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
 * Скрипт в <head> корневого layout: выполняется до первой отрисовки любой страницы, в том числе оболочки /call из
 * кэша service worker, и прячет страницу, если выход не завершён. Ключ и атрибут — те же, что выше.
 */
export const LOGOUT_GUARD_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(LOGOUT_PENDING_KEY)}))document.documentElement.setAttribute(${JSON.stringify(LOGOUT_PENDING_ATTR)},'')}catch(e){}`;

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

/** Поставить флаг. false — хранилище недоступно: блокировка держится только в этой вкладке. */
export function markLogoutPending(storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LOGOUT_PENDING_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function clearLogoutPending(storage: StorageLike | null = browserStorage()): void {
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
