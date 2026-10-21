'use client';

// Смена сотрудника на общем телефоне без выхода (D-291, D-292). При загрузке любой страницы оболочки:
// - страница ставит метку владельца телефона (её сотрудник — тот, под чьей сессией сервер её отдал);
// - данные экрана «Звонить» других сотрудников удаляются или обезличиваются (src/ui/call/deviceOwner.ts).
// Пока страница открыта, она сверяет метку при смене метки в другой вкладке, возврате на вкладку, фокусе и показе из
// bfcache: не совпала — страница прежнего сотрудника прячется и перезагружается. Ничего не рисует.
import { useEffect } from 'react';
import { leaveForeignPage, markDeviceOwner, ownerChanged, DEVICE_OWNER_KEY, sanitizeForeign } from '@/ui/call/deviceOwner';
import { browserStorage } from '@/ui/call/logoutPending';
import { createDeviceStore } from '@/ui/call/outboxStore';
import { isStaleShell } from '@/ui/call/serviceWorker';

export function DeviceOwnerGuard({ userId }: { userId: string }) {
  useEffect(() => {
    // Оболочку из кэша service worker отдал не сервер: её сотрудник мог смениться, метку она не ставит
    const stale = isStaleShell();
    const leave = () => leaveForeignPage({ reload: !stale });
    if (stale) {
      // Уборку «чужих» данных тоже не делает: под меткой может работать уже другой сотрудник, и чужой для страницы — он
      if (ownerChanged(browserStorage(), userId)) leave();
    } else {
      markDeviceOwner(browserStorage(), userId);
      void sanitizeForeign(userId, { storage: browserStorage(), store: typeof indexedDB === 'undefined' ? null : createDeviceStore().store });
    }

    const check = () => {
      if (ownerChanged(browserStorage(), userId)) leave();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === DEVICE_OWNER_KEY && e.newValue !== null && e.newValue !== userId) leave();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    return () => {
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
    };
  }, [userId]);
  return null;
}
