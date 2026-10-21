'use client';

// Экран блокировки «выход не завершён» (D-063, ARCHITECTURE §7). Стоит в корневом layout, поэтому есть на любой
// странице, включая вход и оболочку /call из кэша. Разметка рендерится всегда, но видна только при атрибуте
// data-logout-pending на <html> (его ставит скрипт в <head> до первой отрисовки); всё остальное CSS прячет.
// Пока флаг стоит, запрос выхода повторяется при событии online и по таймеру; ответ сервера — флаг снят, вход.
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import {
  browserStorage,
  clearLogoutPending,
  completePendingLogout,
  isLogoutPending,
  LOGOUT_PENDING_ATTR,
  LOGOUT_PENDING_EVENT,
  LOGOUT_PENDING_KEY,
  LOGOUT_RETRY_MS,
  postLogout,
} from '@/ui/call/logoutPending';
import { clearShellCache, unblockShell } from '@/ui/call/serviceWorker';

export function LogoutGuard() {
  const t = useTranslations('shell.logout');

  useEffect(() => {
    let stop: (() => void) | null = null;
    // Флага в хранилище может не быть (приватный режим): тогда блокировка держится, пока открыта эта вкладка
    let forced = false;

    const start = () => {
      if (stop) return;
      document.documentElement.setAttribute(LOGOUT_PENDING_ATTR, '');
      let busy = false;
      const attempt = async () => {
        if (busy) return;
        busy = true;
        try {
          const storage = browserStorage();
          const done = forced && !isLogoutPending(storage) ? await postLogout() : await completePendingLogout({
            storage,
            post: () => postLogout(),
            cleanup: async () => {
              await clearShellCache();
              await unblockShell();
            },
          });
          if (done) {
            // Без хранилища флага не было, но метка для сервера (D-310) стоит: снимаем и её
            clearLogoutPending(storage);
            stop?.();
            window.location.replace('/login');
          }
        } finally {
          busy = false;
        }
      };
      const onOnline = () => void attempt();
      const timer = setInterval(() => void attempt(), LOGOUT_RETRY_MS);
      window.addEventListener('online', onOnline);
      stop = () => {
        clearInterval(timer);
        window.removeEventListener('online', onOnline);
      };
      void attempt();
    };

    if (isLogoutPending()) start();
    // Выход начат в другой вкладке этого телефона или в этой (запрос не прошёл)
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOGOUT_PENDING_KEY && e.newValue !== null) start();
    };
    const onLocal = () => {
      forced = true;
      start();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(LOGOUT_PENDING_EVENT, onLocal);
    return () => {
      stop?.();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(LOGOUT_PENDING_EVENT, onLocal);
    };
  }, []);

  return (
    <div data-logout-lock="" role="alert" aria-live="assertive" className="logout-lock" data-testid="logout-lock">
      <div className="logout-lock__box">
        <p className="logout-lock__title">{t('lockTitle')}</p>
        <p className="logout-lock__text">{t('lockText')}</p>
      </div>
    </div>
  );
}
