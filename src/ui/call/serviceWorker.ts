// Регистрация service worker (public/sw.js): только оболочка приложения, без кэша API. В разработке не нужен.

/** Регистрация идемпотентна; промис завершается, когда регистрация создана (или невозможна) — ошибок наружу нет. */
export function registerShell(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return Promise.resolve();
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve();
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
    () => undefined,
    () => undefined,
  );
}

const SHELL_CACHE_PREFIX = 'crm-shell-';

/**
 * Выход из приложения: кэш оболочки удаляется прямо со страницы и ждётся (на общем телефоне после смены сотрудника).
 * Сообщение service worker — запасной путь для кэшей, которых страница не видит; результата от него не ждём.
 */
export async function clearShellCache(): Promise<void> {
  if (typeof caches !== 'undefined') {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(SHELL_CACHE_PREFIX)).map((n) => caches.delete(n)));
  }
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration('/');
    reg?.active?.postMessage({ type: 'clear' });
  }
}

/** Метка в Cache Storage «выход не завершён»: localStorage service worker не видит, а кэш — видит (public/sw.js). */
export const LOGOUT_BLOCK_CACHE = 'crm-logout-pending';

/** Пока выход не завершён, service worker не отдаёт и не кэширует оболочку /call. */
export async function blockShell(): Promise<void> {
  if (typeof caches !== 'undefined') await caches.open(LOGOUT_BLOCK_CACHE);
}

export async function unblockShell(): Promise<void> {
  if (typeof caches !== 'undefined') await caches.delete(LOGOUT_BLOCK_CACHE);
}

/**
 * Страницу отдал кэш service worker (нет сети), а не сервер: сессия на ней могла смениться (userId в странице —
 * прежнего сотрудника). Пока так, ничего не уходит на сервер: итоги отправляются только под сессией, которая их создала.
 */
export function isStaleShell(): boolean {
  return typeof document !== 'undefined' && document.querySelector('meta[name="crm-shell"][content="stale"]') !== null;
}

/** Страница из кэша: ждём сеть и перезагружаем, чтобы получить страницу под текущей сессией (или вход). */
export function reloadWhenOnline(intervalMs = 5_000): () => void {
  const h = setInterval(() => {
    void fetch('/call', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok || res.redirected) window.location.reload();
      })
      .catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(h);
}
