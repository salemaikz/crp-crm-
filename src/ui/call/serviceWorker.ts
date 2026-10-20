// Регистрация service worker (public/sw.js): только оболочка приложения, без кэша API. В разработке не нужен.

export function registerShell(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}

/** Выход из приложения: кэш оболочки очищается (на общем телефоне после смены сотрудника). */
export async function clearShellCache(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  reg?.active?.postMessage({ type: 'clear' });
}
