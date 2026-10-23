'use client';

// Устройство оператора на доске: очередь итогов (Outbox), защита общего телефона и отправка. Те же правила, что у экрана
// «Звонить» (ARCHITECTURE §7, D-063, D-291, D-292): итог сначала ложится в очередь на устройстве, уходит после окна
// «Отменить», без сети копится; страница прежнего сотрудника ничего не показывает и не шлёт; оболочка из кэша без сети
// ничего не отправляет, пока не получит себя заново с сервера.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createCallApi, type CallApi } from '@/ui/call/api';
import { deviceHeaders, ensureDeviceId } from '@/ui/call/device';
import { leaveForeignPage, markDeviceOwner, OWNER_CHANGED_EVENT, ownerChanged, sanitizeForeign } from '@/ui/call/deviceOwner';
import { browserStorage, isLogoutPending, LOGOUT_PENDING_EVENT, LOGOUT_PENDING_KEY } from '@/ui/call/logoutPending';
import { Outbox } from '@/ui/call/outbox';
import { createDeviceStore } from '@/ui/call/outboxStore';
import { clearPending, readPending, type PendingState } from '@/ui/call/pending';
import { isStaleShell, registerShell, reloadWhenOnline } from '@/ui/call/serviceWorker';
import { DEVICE_PING_MS, OUTBOX_TICK_MS } from '@/ui/call/types';

export interface BoardRuntime {
  outbox: Outbox;
  api: CallApi;
  persistent: boolean;
}

export interface RejectedView {
  opId: string;
  title: string;
  code: string;
}

export interface RuntimeEvents {
  /** Итоги ушли или отклонены: доска перечитывается. */
  onSettled: (sent: readonly string[], rejected: readonly string[]) => void;
  /** Раз в несколько минут и при возвращении сети: освежить доску. */
  onPing: () => void;
}

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useBoardRuntime(userId: string, events: RuntimeEvents) {
  const [rt, setRt] = useState<BoardRuntime | null>(null);
  const [version, setVersion] = useState(0);
  const [locked, setLocked] = useState(false);
  const [rejected, setRejected] = useState<RejectedView[]>([]);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [stale, setStale] = useState(false);
  const rtRef = useRef<BoardRuntime | null>(null);
  const lockedRef = useRef(false);
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  });

  const foreign = useCallback(() => ownerChanged(browserStorage(), userId), [userId]);
  const leave = useCallback(() => {
    lockedRef.current = true;
    setLocked(true);
    leaveForeignPage({ reload: !isStaleShell() });
  }, []);

  const loadRejected = useCallback(async () => {
    const r = rtRef.current;
    if (!r) return;
    setRejected((await r.outbox.rejectedList()).map((x) => ({ opId: x.opId, title: x.title, code: x.code })));
  }, []);

  const flush = useCallback(
    async (opts: { force?: boolean; ignoreBackoff?: boolean } = {}) => {
      const r = rtRef.current;
      if (!r || lockedRef.current) return;
      if (foreign()) return leave();
      const rep = await r.outbox.flush(opts);
      if (rep.held.length > 0) return leave();
      if (rep.rejected.length > 0) await loadRejected();
      if (rep.sent.length > 0 || rep.rejected.length > 0) eventsRef.current.onSettled(rep.sent, rep.rejected.map((x) => x.opId));
    },
    [foreign, leave, loadRejected],
  );

  // Старт: один раз
  useEffect(() => {
    let alive = true;
    let stopStale: (() => void) | null = null;
    void (async () => {
      if (isLogoutPending()) {
        lockedRef.current = true;
        setLocked(true);
        return;
      }
      const isStale = isStaleShell();
      setStale(isStale);
      const { store, persistent } = createDeviceStore();
      if (isStale) {
        if (foreign()) {
          stopStale = reloadWhenOnline();
          leave();
          return;
        }
        stopStale = reloadWhenOnline();
      } else {
        markDeviceOwner(browserStorage(), userId);
        await sanitizeForeign(userId, { storage: browserStorage(), store: persistent ? store : null });
      }
      const deviceId = await ensureDeviceId(store);
      const holder: { outbox?: Outbox } = {};
      const guardedFetch: typeof fetch = (...a) => (isStale || isLogoutPending() ? Promise.reject(new Error('blocked')) : fetch(...a));
      const api = createCallApi(() => deviceHeaders(deviceId, holder.outbox?.pendingCount() ?? 0, holder.outbox?.lastFlushAt() ?? null), userId, guardedFetch);
      const outbox = new Outbox({ store, send: (req, author) => api.sendOutcome(req, author), userId, onChange: () => setVersion((v) => v + 1) });
      holder.outbox = outbox;
      await outbox.load();
      if (!alive) return;
      const runtime = { outbox, api, persistent };
      rtRef.current = runtime;
      setRt(runtime);
      await loadRejected();
      registerShell();
      void outbox.flush({ ignoreBackoff: true }).then((rep) => {
        if (rep.held.length > 0) return leave();
        if (rep.rejected.length > 0) void loadRejected();
        if (rep.sent.length > 0 || rep.rejected.length > 0) eventsRef.current.onSettled(rep.sent, rep.rejected.map((x) => x.opId));
      });
    })();
    return () => {
      alive = false;
      stopStale?.();
    };
    // Старт один раз: зависимости стабильны
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Выход начат в этой или другой вкладке; сотрудник на телефоне сменился
  useEffect(() => {
    const lock = () => {
      lockedRef.current = true;
      setLocked(true);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOGOUT_PENDING_KEY && e.newValue !== null) lock();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(LOGOUT_PENDING_EVENT, lock);
    window.addEventListener(OWNER_CHANGED_EVENT, lock);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(LOGOUT_PENDING_EVENT, lock);
      window.removeEventListener(OWNER_CHANGED_EVENT, lock);
    };
  }, []);

  // Ближайшая отправка: конец окна «Отменить» или паузы после ошибки
  useEffect(() => {
    if (!rt) return;
    const due = rt.outbox.nextDueAt();
    if (due === null) return;
    const h = setTimeout(() => void flush(), Math.max(0, due - Date.now()) + 20);
    return () => clearTimeout(h);
  }, [rt, version, flush]);

  useEffect(() => {
    if (!rt) return;
    const tick = setInterval(() => void flush({ ignoreBackoff: true }), OUTBOX_TICK_MS);
    const ping = setInterval(() => eventsRef.current.onPing(), DEVICE_PING_MS);
    return () => {
      clearInterval(tick);
      clearInterval(ping);
    };
  }, [rt, flush]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (foreign()) return leave();
      void flush();
    };
    const onOnline = () => {
      if (foreign()) return leave();
      void flush({ ignoreBackoff: true });
      eventsRef.current.onPing();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisibility);
    };
  }, [flush, foreign, leave]);

  const dismissRejected = useCallback(async (opId: string) => {
    await rtRef.current?.outbox.dismissRejected(opId);
    setRejected((x) => x.filter((r) => r.opId !== opId));
  }, []);

  /** Намерение звонка этой карточки на устройстве (плитка или экран «Звонить»); чужого сотрудника не бывает. */
  const intentFor = useCallback(
    (cardId: string): PendingState | null => {
      if (lockedRef.current || foreign()) return null;
      const p = readPending(window.localStorage, userId);
      return p && p.call.cardId === cardId ? p : null;
    },
    [foreign, userId],
  );
  const clearIntent = useCallback(() => clearPending(window.localStorage, userId), [userId]);

  return { rt, rtRef, version, locked, lockedRef, rejected, dismissRejected, online, stale, flush, leave, foreign, intentFor, clearIntent };
}
