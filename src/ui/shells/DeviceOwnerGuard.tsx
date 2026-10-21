'use client';

// Смена сотрудника на общем телефоне без выхода (D-291, D-292, D-293). При загрузке любой страницы с сессией (оболочка
// и личный кабинет):
// - страница ставит метку владельца телефона (её сотрудник — тот, под чьей сессией сервер её отдал);
// - данные экрана «Звонить» других сотрудников удаляются или обезличиваются, их итоги со свободным текстом старше
//   срока удаляются с записью в журнал (src/ui/call/deviceOwner.ts).
// Пока страница открыта, она сверяет метку при смене метки в другой вкладке, возврате на вкладку, фокусе, показе из
// bfcache и появлении сети, а на возврат ещё и спрашивает сервер, чья сессия у cookie: метки может не быть (вход
// запросом, хранилище недоступно), а сессия — истечь без входа другого. Не совпало или сессии нет — страница прячется
// и перезагружается: сервер отдаст страницу текущей сессии или вход. Ничего не рисует.
import { useEffect } from 'react';
import {
  checkPageSession,
  createExpiredReporter,
  DEVICE_OWNER_KEY,
  leaveForeignPage,
  markDeviceOwner,
  ownerChanged,
  sanitizeForeign,
} from '@/ui/call/deviceOwner';
import { browserStorage, isLogoutPending } from '@/ui/call/logoutPending';
import { createDeviceStore } from '@/ui/call/outboxStore';
import { isStaleShell } from '@/ui/call/serviceWorker';

/** Не чаще одной сверки с сервером за это время: возврат на вкладку даёт сразу видимость, фокус и показ. */
const SESSION_CHECK_GAP_MS = 2_000;

export function DeviceOwnerGuard({ userId, outboxTtlMs }: { userId: string; outboxTtlMs: number | null }) {
  useEffect(() => {
    // Оболочку из кэша service worker отдал не сервер: её сотрудник мог смениться, метку она не ставит
    const stale = isStaleShell();
    let left = false;
    const leave = (reload: boolean) => {
      if (left) return;
      left = true;
      leaveForeignPage({ reload });
    };
    if (stale) {
      // Уборку «чужих» данных тоже не делает: под меткой может работать уже другой сотрудник, и чужой для страницы — он
      if (ownerChanged(browserStorage(), userId)) leave(false);
    } else {
      markDeviceOwner(browserStorage(), userId);
      const store = typeof indexedDB === 'undefined' ? null : createDeviceStore().store;
      void sanitizeForeign(userId, {
        storage: browserStorage(),
        store,
        expire: store && outboxTtlMs !== null ? { now: Date.now(), ttlMs: outboxTtlMs, report: createExpiredReporter(store) } : undefined,
      });
    }

    let inFlight = false;
    let lastCheck = 0;
    const check = (opts: { server?: boolean } = {}) => {
      if (left) return;
      if (ownerChanged(browserStorage(), userId)) {
        leave(!stale);
        return;
      }
      if (opts.server === false) return;
      // Выход не завершён: им занимается экран блокировки (LogoutGuard)
      if (isLogoutPending() || inFlight || Date.now() - lastCheck < SESSION_CHECK_GAP_MS) return;
      inFlight = true;
      lastCheck = Date.now();
      void checkPageSession(userId).then((s) => {
        inFlight = false;
        // Ответ пришёл — сеть есть, поэтому перезагрузка даст страницу текущей сессии и для оболочки из кэша
        if (s === 'other' || s === 'gone') leave(true);
      });
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === DEVICE_OWNER_KEY && e.newValue !== null && e.newValue !== userId) leave(!stale);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    const onEvent = () => check();
    // Первый показ страницы — это загрузка, её сессию сервер только что проверил; сервер спрашиваем при показе из bfcache
    const onPageShow = (e: PageTransitionEvent) => check({ server: e.persisted });
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onEvent);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onEvent);
    return () => {
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onEvent);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onEvent);
    };
  }, [userId, outboxTtlMs]);
  return null;
}
