'use client';

// Экран «Звонить»: одна карточка за раз, шторка итога после звонка, outbox итогов на устройстве.
// Порядок событий — ARCHITECTURE §7: «Позвонить» пишет намерение звонка и открывает `tel:`; при возврате шторка
// открывается сама; итог ложится в outbox и уходит на сервер после окна отмены; без сети копится и уходит позже.
import { WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatKzPhone, maskKzPhone } from '@/shared/tel';
import { Alert, Button, Chip, ChipGroup, EmptyState, Page, Stat, StatGrid, ToastProvider, useToast } from '@/ui/kit';
import type { WizardChoice } from '@/app/(op)/bookings/_wizard/choice';
import type { BookingWizardProps } from '@/app/(op)/bookings/_wizard/BookingWizard';
import type { WizardResult } from '@/app/(op)/bookings/_wizard/result';
import { bookingAgreement, laterAgreement, parseAgreementResponse } from './agreement';
import { createCallApi, isWrongUser, type CallApi } from './api';
import { CallCard } from './CallCard';
import { deviceHeaders, ensureDeviceId } from './device';
import { leaveForeignPage, markDeviceOwner, OWNER_CHANGED_EVENT, ownerChanged, sanitizeForeign } from './deviceOwner';
import { browserStorage, isLogoutPending, LOGOUT_PENDING_EVENT, LOGOUT_PENDING_KEY } from './logoutPending';
import { OutcomeSheet } from './OutcomeSheet';
import { hasFreeText } from './freeText';
import { Outbox } from './outbox';
import { createDeviceStore } from './outboxStore';
import { clearPending, readPending, writePending, type PendingState } from './pending';
import { isStaleShell, registerShell, reloadWhenOnline } from './serviceWorker';
import { callsInLastHour, forgetOutcome, readTally, recordOutcome, viewOf, withUnsent, type Tally } from './tally';
import {
  DEVICE_PING_MS,
  EMPTY_DRAFT,
  OUTBOX_TICK_MS,
  type CallConfig,
  type OutcomeButton,
  type PendingCall,
  type QueueCard,
  type QueueCounts,
  type QueuePhone,
  type SheetDraft,
  type TodaySummary,
} from './types';
import { buildRequest } from './validate';
import { localDay } from './zoned';

/** Сколько карточек держим в памяти страницы: текущая и следующие. Нужно, чтобы работать без сети (ARCHITECTURE §7). */
const DEPTH = 6;
const PAGE = 4;
/** Если звонилка не увела приложение в фон, шторка открывается сама через это время. */
const OPEN_FALLBACK_MS = 1200;

type GroupId = 'all' | 'callbacks' | 'retries' | 'new';
type Phase = 'loading' | 'ready' | 'offline' | 'error';

interface Runtime {
  outbox: Outbox;
  api: CallApi;
  persistent: boolean;
}

interface RejectedView {
  opId: string;
  title: string;
  code: string;
}

const uuid = (): string => globalThis.crypto.randomUUID();

/** Тосты у экрана свои: окно отмены итога не зависит от оболочки. */
export function CallScreen({ config }: { config: CallConfig }) {
  return (
    <ToastProvider>
      <CallScreenInner config={config} />
    </ToastProvider>
  );
}

function CallScreenInner({ config }: { config: CallConfig }) {
  const t = useTranslations('call');
  const te = useTranslations('calls');
  const router = useRouter();
  const toast = useToast();
  const { userId } = config;

  const [rt, setRt] = useState<Runtime | null>(null);
  const [version, setVersion] = useState(0);
  const [queue, setQueueState] = useState<QueueCard[]>([]);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [group, setGroup] = useState<GroupId>('all');
  const [pending, setPending] = useState<PendingState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [tally, setTally] = useState<Tally>({ day: '', items: [] });
  const [rejected, setRejected] = useState<RejectedView[]>([]);
  // «Сегодня» с сервера (по всем устройствам); до первого ответа показывается счётчик этого телефона
  const [serverToday, setServerToday] = useState<TodaySummary | null>(null);
  const [booking, setBooking] = useState<{ def: OutcomeButton; fieldValues: Record<string, string> } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Выход не завершён (в этой или другой вкладке): экран пуст, ничего не отправляется и не пишется на телефон
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);

  const queueRef = useRef(queue);
  const pendingRef = useRef(pending);
  const groupRef = useRef(group);
  const rtRef = useRef<Runtime | null>(null);
  const refillLock = useRef(false);
  const awayRef = useRef(false);
  const undoToast = useRef<string | null>(null);
  // Очередь меняется и из обработчиков, и из ответов сервера: ref обновляется сразу, до перерисовки
  const setQueue = useCallback((next: QueueCard[] | ((q: QueueCard[]) => QueueCard[])) => {
    const value = typeof next === 'function' ? next(queueRef.current) : next;
    queueRef.current = value;
    setQueueState(value);
  }, []);
  useEffect(() => {
    pendingRef.current = pending;
    groupRef.current = group;
  });

  // Страница устарела: на телефоне уже работает другой сотрудник (метка владельца, D-292)
  const foreign = useCallback(() => ownerChanged(browserStorage(), userId), [userId]);
  // Очередь из памяти убирается, страница прячется и перезагружается: сервер отдаст страницу текущей сессии
  const leave = useCallback(() => {
    lockedRef.current = true;
    setLocked(true);
    setQueue([]);
    leaveForeignPage({ reload: !isStaleShell() });
  }, [setQueue]);

  const today = useCallback(() => localDay(Date.now(), config.timeZone), [config.timeZone]);
  // Текстовые поля итогов: их значения — свободный текст оператора (D-293)
  const textFields = useMemo(() => new Set(Object.entries(config.outcomeFields).filter(([, f]) => f.type === 'text').map(([k]) => k)), [config.outcomeFields]);

  // ---- Очередь ----------------------------------------------------------------------------------------------

  const refill = useCallback(
    async (opts: { replace?: boolean; group?: GroupId } = {}) => {
      const r = rtRef.current;
      if (!r || refillLock.current) return;
      refillLock.current = true;
      const grp = opts.group ?? groupRef.current;
      // Что уже в памяти (или ничего при смене вкладки) плюс то, что принесёт сервер
      const have: QueueCard[] = opts.replace ? [] : queueRef.current;
      const fetched: QueueCard[] = [];
      try {
        let latest: QueueCounts | null = null;
        for (let i = 0; i < 2 && have.length + fetched.length < DEPTH; i++) {
          const known = [...have, ...fetched];
          const exclude = [...new Set([...r.outbox.cardIds(), ...known.map((c) => c.cardId)])];
          const res = await r.api.queue({ limit: Math.min(PAGE, DEPTH - known.length), exclude, group: grp });
          // Сессии нет: страница прячется и перезагружается — сервер уведёт на вход, карточки из памяти не видны
          if (res.status === 401) {
            leave();
            return;
          }
          // На телефоне вошёл другой сотрудник: его очередь этой странице не отдаётся (D-292)
          if (isWrongUser(res)) {
            leave();
            return;
          }
          if (!res.data) throw new Error(`queue ${res.status}`);
          latest = res.data.counts;
          if (res.data.items.length === 0) break;
          fetched.push(...res.data.items);
        }
        if (latest) setCounts(latest);
        // К моменту ответа оператор мог поставить итог: такие карточки не возвращаем
        const sent = new Set(r.outbox.cardIds());
        setQueue((cur) => {
          const base = opts.replace ? [] : cur;
          const ids = new Set(base.map((c) => c.cardId));
          return [...base, ...fetched.filter((c) => !ids.has(c.cardId) && !sent.has(c.cardId))];
        });
        setPhase('ready');
      } catch {
        // Без сети остаётся то, что уже в памяти страницы
        if (opts.replace) setQueue([]);
        setPhase(queueRef.current.length > 0 ? 'ready' : navigator.onLine ? 'error' : 'offline');
      } finally {
        refillLock.current = false;
      }
    },
    [setQueue, leave],
  );

  const loadRejected = useCallback(async () => {
    const r = rtRef.current;
    if (!r) return;
    setRejected((await r.outbox.rejectedList()).map((x) => ({ opId: x.opId, title: x.title, code: x.code })));
  }, []);

  const refreshToday = useCallback(async () => {
    const r = rtRef.current;
    if (!r) return;
    const res = await r.api.today();
    // Вошёл другой сотрудник или сессии больше нет (истекла, «выйти везде»): экран сотрудника не показываем ни секунды —
    // очередь из памяти убирается, страница прячется и перезагружается (сервер отдаст вход или страницу текущей сессии)
    if (isWrongUser(res) || res.status === 401) leave();
    else if (res.data) setServerToday(res.data);
  }, [leave]);

  const flushAndSync = useCallback(
    async (opts: { force?: boolean; ignoreBackoff?: boolean } = {}) => {
      const r = rtRef.current;
      if (!r || lockedRef.current) return;
      if (foreign()) {
        leave();
        return;
      }
      const rep = await r.outbox.flush(opts);
      // Сервер: вошёл другой сотрудник. Страница прежнего не годится — перезагрузка даст страницу текущей сессии
      if (rep.held.length > 0) {
        leave();
        return;
      }
      if (rep.rejected.length > 0) await loadRejected();
      if (rep.sent.length > 0 || rep.rejected.length > 0) {
        void refill();
        void refreshToday();
      }
    },
    [loadRejected, refill, refreshToday, foreign, leave],
  );

  // ---- Старт ------------------------------------------------------------------------------------------------

  useEffect(() => {
    let alive = true;
    let stopStale: (() => void) | null = null;
    void (async () => {
      // Выход не завершён: данные не грузим и не рисуем, экран блокировки (LogoutGuard) доводит выход
      if (isLogoutPending()) {
        lockedRef.current = true;
        setLocked(true);
        return;
      }
      // Страница из кэша service worker (нет сети): сессия могла смениться, поэтому на сервер ничего не уходит,
      // пока страница не перезагрузится под текущей сессией (итоги отправляются только под той, что их создала)
      // Пока выход не завершён (флаг мог появиться позже, из другой вкладки), запросы тоже не уходят
      const stale = isStaleShell();
      const { store, persistent } = createDeviceStore();
      if (stale) {
        // Оболочка прежнего сотрудника, а на телефоне уже другой: ни данных, ни уборки — ждём сеть и перезагрузку
        if (foreign()) {
          stopStale = reloadWhenOnline();
          leave();
          return;
        }
      } else {
        // Страница пришла с сервера: её сотрудник — владелец телефона (D-292). Данные другого сотрудника на этом
        // телефоне (его сессия истекла без выхода) убираются до чтения своих (D-291)
        markDeviceOwner(browserStorage(), userId);
        await sanitizeForeign(userId, { storage: browserStorage(), store: persistent ? store : null });
      }
      const deviceId = await ensureDeviceId(store);
      const holder: { outbox?: Outbox } = {};
      const guardedFetch: typeof fetch = (...a) => (stale || isLogoutPending() ? Promise.reject(new Error('blocked')) : fetch(...a));
      if (stale) stopStale = reloadWhenOnline();
      const api = createCallApi(() => deviceHeaders(deviceId, holder.outbox?.pendingCount() ?? 0, holder.outbox?.lastFlushAt() ?? null), userId, guardedFetch);
      const onChange = () => {
        setVersion((v) => v + 1);
        setNow(Date.now());
      };
      // Автор итога — из записи outbox: сервер сверяет его с сессией (D-291)
      const outbox = new Outbox({ store, send: (req, author) => api.sendOutcome(req, author), userId, onChange });
      holder.outbox = outbox;
      await outbox.load();
      if (!alive) return;
      const runtime: Runtime = { outbox, api, persistent };
      rtRef.current = runtime;
      setRt(runtime);

      let p = readPending(window.localStorage, userId);
      setTally(readTally(window.localStorage, userId, today()));
      // Шторка, оставшаяся после перезапуска приложения, открывается сама
      if (p) p = { ...p, draft: { ...p.draft, open: true } };
      setPending(p);
      setHydrated(true);
      await loadRejected();
      registerShell();
      await refill({ replace: true });
      if (lockedRef.current) return;
      void outbox.flush({ ignoreBackoff: true }).then((rep) => {
        if (rep.held.length > 0) {
          leave();
          return;
        }
        if (rep.rejected.length > 0) void loadRejected();
        void refreshToday();
      });
    })();
    return () => {
      alive = false;
      stopStale?.();
    };
    // Старт один раз: зависимости стабильны
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Выход начат в другой вкладке или в этой: очередь из памяти убирается, экран пустеет
  useEffect(() => {
    const lock = () => {
      lockedRef.current = true;
      setLocked(true);
      setQueue([]);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOGOUT_PENDING_KEY && e.newValue !== null) lock();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(LOGOUT_PENDING_EVENT, lock);
    // Сотрудник сменился (метка владельца, DeviceOwnerGuard): страница прячется и перезагружается
    window.addEventListener(OWNER_CHANGED_EVENT, lock);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(LOGOUT_PENDING_EVENT, lock);
      window.removeEventListener(OWNER_CHANGED_EVENT, lock);
    };
  }, [setQueue]);

  // Намерение звонка и черновик шторки сохраняются при каждом изменении; во время выхода — нет (очистка не отменяется)
  useEffect(() => {
    if (!hydrated || lockedRef.current || isLogoutPending() || foreign()) return;
    if (pending) writePending(window.localStorage, userId, pending);
    else clearPending(window.localStorage, userId);
  }, [pending, hydrated, userId, foreign]);

  // ---- Отправка: таймеры и события --------------------------------------------------------------------------

  // Ближайший срок отправки: конец окна отмены или конец паузы после ошибки
  useEffect(() => {
    if (!rt) return;
    const due = rt.outbox.nextDueAt();
    if (due === null) return;
    const h = setTimeout(() => void flushAndSync(), Math.max(0, due - Date.now()) + 20);
    return () => clearTimeout(h);
  }, [rt, version, flushAndSync]);

  useEffect(() => {
    if (!rt) return;
    const tick = setInterval(() => {
      setNow(Date.now());
      void flushAndSync({ ignoreBackoff: true });
    }, OUTBOX_TICK_MS);
    // Пинг статуса устройства: обычный запрос очереди несёт X-Outbox-Pending (D-063)
    const ping = setInterval(() => {
      void refill();
      void refreshToday();
    }, DEVICE_PING_MS);
    return () => {
      clearInterval(tick);
      clearInterval(ping);
    };
  }, [rt, flushAndSync, refill, refreshToday]);

  const openSheetIfPending = useCallback(() => {
    setPending((p) => (p && !p.draft.open ? { ...p, draft: { ...p.draft, open: true } } : p));
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (pendingRef.current) awayRef.current = true;
        return;
      }
      // Вкладка прежнего сотрудника: на телефоне уже другой — ничего не показываем и не шлём (D-292)
      if (foreign()) {
        leave();
        return;
      }
      setNow(Date.now());
      if (awayRef.current && pendingRef.current) {
        awayRef.current = false;
        openSheetIfPending();
      }
      void flushAndSync();
      // Сверка с сервером: метки владельца может не быть (хранилище недоступно), а сессия смениться — 409 wrong_user
      void refreshToday();
    };
    const onPageShow = () => {
      if (foreign()) {
        leave();
        return;
      }
      if (pendingRef.current && awayRef.current) {
        awayRef.current = false;
        openSheetIfPending();
      }
    };
    const onOnline = () => {
      if (foreign()) {
        leave();
        return;
      }
      void flushAndSync({ ignoreBackoff: true });
      void refill();
      void refreshToday();
    };
    const onFocus = () => void flushAndSync();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
    };
  }, [flushAndSync, openSheetIfPending, refill, refreshToday, foreign, leave]);

  // ---- Действия ---------------------------------------------------------------------------------------------

  const current: QueueCard | null = useMemo(() => {
    if (pending) return queue.find((c) => c.cardId === pending.call.cardId) ?? null;
    return queue[0] ?? null;
  }, [queue, pending]);

  const startCall = (card: QueueCard, phone: QueuePhone) => {
    // Страница прежнего сотрудника: «намерение звонка» с названием компании на телефон не пишем (D-292)
    if (lockedRef.current) return;
    if (foreign()) {
      leave();
      return;
    }
    const r = rtRef.current;
    // Оператор идёт дальше: итоги из окна отмены уходят сразу (PROCESS 2.5, «Следующая»)
    if (r && r.outbox.pendingCount() > 0) {
      if (undoToast.current) toast.dismiss(undoToast.current);
      undoToast.current = null;
      void flushAndSync({ force: true });
    }
    const prev = pendingRef.current;
    const same = prev && prev.call.cardId === card.cardId ? prev : null;
    const call: PendingCall = {
      opId: same?.call.opId ?? uuid(),
      cardId: card.cardId,
      clientId: card.clientId,
      tappedAt: Date.now(),
      title: card.name,
      phoneId: phone.id,
      phoneMasked: maskKzPhone(phone.digits),
      phones: card.phones.map((p) => ({ id: p.id, masked: maskKzPhone(p.digits) })),
    };
    const draft: SheetDraft = { ...(same?.draft ?? { ...EMPTY_DRAFT, target: card.isTarget === 'yes' }), phoneId: phone.id, open: false };
    const next = { call, draft };
    // Запись в localStorage синхронна и идёт до перехода по tel: — приложение могут выгрузить сразу
    writePending(window.localStorage, userId, next);
    setPending(next);
    awayRef.current = false;
    setTimeout(() => {
      if (document.visibilityState === 'visible' && pendingRef.current?.call.opId === call.opId) openSheetIfPending();
    }, OPEN_FALLBACK_MS);
  };

  const patchDraft = (patch: Partial<SheetDraft>) => setPending((p) => (p ? { ...p, draft: { ...p.draft, ...patch } } : p));

  const closeSheet = () => {
    setBooking(null);
    patchDraft({ open: false });
  };

  const undo = async (opId: string, p: PendingState, card: QueueCard | null) => {
    const r = rtRef.current;
    if (!r || lockedRef.current) return;
    if (!(await r.outbox.cancel(opId))) {
      toast.show({ message: t('toast.alreadySent'), tone: 'info' });
      return;
    }
    setTally(forgetOutcome(window.localStorage, userId, today(), opId));
    if (card) setQueue((q) => [card, ...q.filter((c) => c.cardId !== card.cardId)]);
    setPending({ call: p.call, draft: { ...p.draft, open: true } });
    toast.show({ message: t('toast.undone'), tone: 'neutral' });
  };

  /** Контакт ЛПР из очереди: уходит в `agreement.contactId` итога «Договорились». */
  const contactId = (): string | null => {
    const p = pendingRef.current;
    const card = p ? queueRef.current.find((c) => c.cardId === p.call.cardId) : null;
    return card?.decisionMaker?.contactId ?? null;
  };

  const submit = async (def: OutcomeButton, fieldValues: Record<string, string>, opts: { later?: boolean } = {}) => {
    const r = rtRef.current;
    const p = pendingRef.current;
    if (!r || !p || lockedRef.current) return;
    // Итог со страницы прежнего сотрудника не ложится в outbox этого телефона: другой сотрудник уже работает (D-292)
    if (foreign()) {
      leave();
      return;
    }
    const nowMs = Date.now();
    const request = buildRequest({
      opId: p.call.opId,
      cardId: p.call.cardId,
      def,
      draft: p.draft,
      tappedAt: p.call.tappedAt,
      now: nowMs,
      online: navigator.onLine,
      fieldValues,
      callbackV2: config.callbackV2,
      ...(opts.later ? { agreement: laterAgreement(contactId(), config, nowMs) } : {}),
    });
    try {
      await r.outbox.enqueue({ request, title: p.call.title, kind: def.kind, undoMs: config.undoMs, freeText: hasFreeText(request, textFields) });
    } catch {
      toast.show({ message: t('toast.notSaved'), tone: 'danger' });
      return;
    }
    const card = queueRef.current.find((c) => c.cardId === p.call.cardId) ?? null;
    setTally(recordOutcome(window.localStorage, userId, today(), { opId: p.call.opId, kind: def.kind, at: p.call.tappedAt, booked: false }));
    setBooking(null);
    setPending(null);
    setQueue((q) => q.filter((c) => c.cardId !== p.call.cardId));
    setCounts((c) => (c ? { ...c, dueNow: Math.max(0, c.dueNow - 1) } : c));
    const withUndo = config.undoMs > 0;
    undoToast.current = toast.show({
      message: opts.later ? t('toast.savedLater') : t('toast.saved'),
      tone: 'success',
      ...(withUndo ? { undo: { label: t('toast.undo'), onUndo: () => void undo(p.call.opId, p, card) }, durationMs: config.undoMs } : {}),
    });
    void refill();
  };

  // ---- «Договорились — записать»: мастер в шторке, итог и запись одним запросом (D-202) ----------------------

  /** Итог принят вместе с записью (или без неё, если карточку передали): шторка закрывается, карточка уходит из очереди. */
  const finishAgreement = (p: PendingState, booked: boolean) => {
    if (lockedRef.current) return;
    const def = config.outcomes.find((o) => o.key === p.draft.outcomeKey);
    setTally(recordOutcome(window.localStorage, userId, today(), { opId: p.call.opId, kind: def?.kind ?? 'agreed', at: p.call.tappedAt, booked }));
    setBooking(null);
    setPending(null);
    setQueue((q) => q.filter((c) => c.cardId !== p.call.cardId));
    setCounts((c) => (c ? { ...c, dueNow: Math.max(0, c.dueNow - 1) } : c));
    void refill();
    void refreshToday();
  };

  const submitBooking: NonNullable<BookingWizardProps['submit']> = async (choice: WizardChoice): Promise<WizardResult> => {
    const r = rtRef.current;
    const p = pendingRef.current;
    const b = booking;
    if (!r || !p || !b) return { ok: false, code: 'handled' };
    const request = buildRequest({
      opId: p.call.opId,
      cardId: p.call.cardId,
      def: b.def,
      draft: p.draft,
      tappedAt: p.call.tappedAt,
      now: Date.now(),
      online: true,
      fieldValues: b.fieldValues,
      agreement: bookingAgreement(contactId(), choice),
    });
    let res: Awaited<ReturnType<CallApi['postOutcome']>>;
    try {
      res = await r.api.postOutcome(request);
    } catch {
      return { ok: false, code: 'network' };
    }
    if (isWrongUser({ status: res.status, code: (res.json as { code?: string } | null)?.code })) {
      leave();
      return { ok: false, code: 'handled' };
    }
    const verdict = parseAgreementResponse(res.status, res.json);
    switch (verdict.kind) {
      case 'result':
        return verdict.result;
      case 'login':
        router.replace('/login');
        return { ok: false, code: 'handled' };
      case 'fact_only':
        // Карточку успели передать: итог в истории, записи нет (PROCESS 12.5)
        finishAgreement(p, false);
        toast.show({ message: t('toast.transferred'), tone: 'info' });
        return { ok: false, code: 'handled' };
      case 'rejected':
        setBooking(null);
        toast.show({ message: te.has(`errors.${verdict.code}`) ? te(`errors.${verdict.code}`) : te('errors.not_found'), tone: 'danger' });
        return { ok: false, code: 'handled' };
    }
  };

  const onBooked: NonNullable<BookingWizardProps['onDone']> = () => {
    const p = pendingRef.current;
    if (p) finishAgreement(p, true);
  };

  const skip = async (card: QueueCard) => {
    const r = rtRef.current;
    if (!r) return;
    try {
      const res = await r.api.skip({ opId: uuid(), cardId: card.cardId });
      if (res.data) {
        setCounts((c) => (c ? { ...c, skippedToday: res.data!.skipsToday, skipLimit: res.data!.skipLimit } : c));
        setQueue((q) => [...q.filter((c) => c.cardId !== card.cardId), { ...card, skippedToday: true }]);
      } else if (isWrongUser(res)) {
        leave();
      } else if (res.code === 'skip_limit') {
        setCounts((c) => (c ? { ...c, skippedToday: c.skipLimit } : c));
        toast.show({ message: te('errors.skip_limit'), tone: 'danger' });
      } else {
        toast.show({ message: te('errors.not_found'), tone: 'danger' });
        void refill({ replace: true });
      }
    } catch {
      toast.show({ message: t('toast.skipOffline'), tone: 'info' });
    }
  };

  const changeGroup = (g: GroupId) => {
    setGroup(g);
    groupRef.current = g;
    void refill({ replace: true, group: g });
  };

  const dismissRejected = async (opId: string) => {
    await rtRef.current?.outbox.dismissRejected(opId);
    setRejected((x) => x.filter((r) => r.opId !== opId));
  };

  // ---- Разметка ---------------------------------------------------------------------------------------------

  // Серверная сводка точнее (все устройства) плюс итоги, которые ещё в outbox; локальный счётчик — пока ответа нет
  const view = serverToday ? withUnsent(serverToday, rt ? rt.outbox.list().map((e) => e.kind) : []) : viewOf(tally);
  const skipsToday = counts?.skippedToday ?? serverToday?.skips ?? 0;
  const skipLimit = counts?.skipLimit ?? serverToday?.skipLimit ?? 0;
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const pace = callsInLastHour(tally, now);
  const waiting = rt ? rt.outbox.list().filter((e) => e.notBefore <= now).length : 0;
  void version;

  const sheetPhones = pending
    ? current && current.phones.length > 0
      ? current.phones.map((p) => ({ id: p.id, label: formatKzPhone(p.digits) }))
      : pending.call.phones.map((p) => ({ id: p.id, label: p.masked }))
    : [];

  if (locked) return null;

  return (
    <Page width="focus" data-testid="call-screen">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold" data-testid="call-counts">
          {counts ? t('head.counts', { due: counts.dueNow, overdue: counts.overdue }) : t('head.loading')}
        </p>
        <ChipGroup label={t('groups.label')}>
          {(['all', 'callbacks', 'retries', 'new'] as const).map((g) => (
            <Chip key={g} active={group === g} onClick={() => changeGroup(g)} count={counts ? (g === 'all' ? counts.dueNow : counts[g]) : undefined}>
              {t(`groups.${g}`)}
            </Chip>
          ))}
        </ChipGroup>
      </header>

      {rejected.map((r) => (
        <Alert key={r.opId} tone="danger" title={t('outbox.rejected', { title: r.title || '—' })}>
          <span>{te.has(`errors.${r.code}`) ? te(`errors.${r.code}`) : te('errors.not_found')}</span>
          <Button variant="quiet" size="sm" onClick={() => void dismissRejected(r.opId)}>
            {t('outbox.dismiss')}
          </Button>
        </Alert>
      ))}

      {phase === 'loading' && (
        <p role="status" className="py-8 text-center" style={{ color: 'var(--text-2)' }}>
          {t('state.loading')}
        </p>
      )}

      {phase !== 'loading' && !current && !pending && (
        <EmptyState
          icon={!online || phase === 'offline' ? <WifiOff /> : undefined}
          title={phase === 'offline' ? t('state.offlineTitle') : phase === 'error' ? t('state.errorTitle') : t('state.emptyTitle')}
          description={phase === 'offline' ? t('state.offlineText') : phase === 'error' ? t('state.errorText') : t('state.emptyText')}
          action={
            phase !== 'ready' ? (
              <Button variant="secondary" onClick={() => void refill({ replace: true })}>
                {t('state.retry')}
              </Button>
            ) : undefined
          }
        />
      )}

      {current && (
        <CallCard
          card={current}
          config={config}
          hasPendingCall={pending?.call.cardId === current.cardId}
          canSkip={online && !pending && skipLimit > 0 && skipsToday < skipLimit}
          onCall={(phone) => startCall(current, phone)}
          onResume={openSheetIfPending}
          onSkip={() => void skip(current)}
        />
      )}

      {!current && pending && (
        <EmptyState
          title={pending.call.title}
          description={pending.call.phoneMasked}
          action={
            <Button onClick={openSheetIfPending} data-testid="call-resume">
              {t('call.resume')}
            </Button>
          }
        />
      )}

      <StatGrid variant="strip" aria-label={t('today.label')} data-testid="call-today">
        <Stat value={view.outcomes} label={t('today.outcomes', { count: view.outcomes })} />
        <Stat value={view.connected} label={t('today.connected', { count: view.connected })} />
        <Stat value={view.booked} label={t('today.booked', { count: view.booked })} />
        <Stat value={t('today.skipsValue', { skips: skipsToday, limit: skipLimit })} label={t('today.skips')} />
      </StatGrid>
      {config.callsPerHourTarget !== null && (
        <p className="text-sm" style={{ color: 'var(--text-3)' }} data-testid="call-pace">
          {t('today.pace', { count: pace, target: config.callsPerHourTarget })}
        </p>
      )}

      {waiting > 0 && (
        <div
          className="fixed inset-x-0 bottom-[var(--bottom-nav-h)] z-20 mx-auto flex max-w-[calc(var(--page-w-focus)+2*var(--gutter))] items-center gap-2 px-[var(--gutter)] pb-2"
          role="status"
          data-testid="outbox-banner"
        >
          <Alert tone="warning" className="w-full">
            {t('outbox.pending', { count: waiting })}
          </Alert>
        </div>
      )}
      {rt && !rt.persistent && <Alert tone="warning">{t('outbox.volatile')}</Alert>}

      {pending && pending.draft.open && (
        <OutcomeSheet
          config={config}
          pending={pending}
          phones={sheetPhones}
          onChange={patchDraft}
          onClose={closeSheet}
          onSubmit={(d, f) => void submit(d, f)}
          hasContact={current?.decisionMaker != null}
          touches={queue.find((c) => c.cardId === pending.call.cardId)?.callbackTouches ?? 0}
          booking={booking !== null}
          onBookingOpen={(def, fieldValues) => setBooking({ def, fieldValues })}
          onBookingBack={() => setBooking(null)}
          onLater={(d, f) => void submit(d, f, { later: true })}
          submitBooking={submitBooking}
          onBooked={onBooked}
        />
      )}
    </Page>
  );
}
