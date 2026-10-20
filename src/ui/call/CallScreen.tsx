'use client';

// Экран «Звонить»: одна карточка за раз, шторка итога после звонка, outbox итогов на устройстве.
// Порядок событий — ARCHITECTURE §7: «Позвонить» пишет намерение звонка и открывает `tel:`; при возврате шторка
// открывается сама; итог ложится в outbox и уходит на сервер после окна отмены; без сети копится и уходит позже.
import { WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatKzPhone, maskKzPhone } from '@/shared/tel';
import { Alert, Button, Chip, ChipGroup, EmptyState, ToastProvider, useToast } from '@/ui/kit';
import { createCallApi, type CallApi } from './api';
import { CallCard } from './CallCard';
import { deviceHeaders, ensureDeviceId } from './device';
import { OutcomeSheet } from './OutcomeSheet';
import { Outbox } from './outbox';
import { createDeviceStore } from './outboxStore';
import { clearPending, readPending, writePending, type PendingState } from './pending';
import { registerShell } from './serviceWorker';
import { callsInLastHour, forgetOutcome, markBooked, readTally, recordOutcome, viewOf, type Tally } from './tally';
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
  const [now, setNow] = useState(() => Date.now());

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

  const today = useCallback(() => localDay(Date.now(), config.timeZone), [config.timeZone]);

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
          if (res.status === 401) {
            router.replace('/login');
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
    [router, setQueue],
  );

  const loadRejected = useCallback(async () => {
    const r = rtRef.current;
    if (!r) return;
    setRejected((await r.outbox.rejectedList()).map((x) => ({ opId: x.opId, title: x.title, code: x.code })));
  }, []);

  const flushAndSync = useCallback(
    async (opts: { force?: boolean; ignoreBackoff?: boolean } = {}) => {
      const r = rtRef.current;
      if (!r) return;
      const rep = await r.outbox.flush(opts);
      if (rep.rejected.length > 0) await loadRejected();
      if (rep.sent.length > 0 || rep.rejected.length > 0) void refill();
    },
    [loadRejected, refill],
  );

  // ---- Старт ------------------------------------------------------------------------------------------------

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { store, persistent } = createDeviceStore();
      const deviceId = await ensureDeviceId(store);
      const holder: { outbox?: Outbox } = {};
      const api = createCallApi(() => deviceHeaders(deviceId, holder.outbox?.pendingCount() ?? 0, holder.outbox?.lastFlushAt() ?? null));
      const onChange = () => {
        setVersion((v) => v + 1);
        setNow(Date.now());
      };
      const outbox = new Outbox({ store, send: (req) => api.sendOutcome(req), userId, onChange });
      holder.outbox = outbox;
      await outbox.load();
      if (!alive) return;
      const runtime: Runtime = { outbox, api, persistent };
      rtRef.current = runtime;
      setRt(runtime);

      // Возврат из мастера записи: ?booked=<opId>
      const url = new URL(window.location.href);
      const booked = url.searchParams.get('booked');
      let p = readPending(window.localStorage, userId);
      if (booked) {
        setTally(markBooked(window.localStorage, userId, today(), booked, Date.now()));
        if (p?.call.opId === booked) {
          clearPending(window.localStorage, userId);
          p = null;
        }
        url.searchParams.delete('booked');
        window.history.replaceState(null, '', url.pathname + url.search);
      } else {
        setTally(readTally(window.localStorage, userId, today()));
      }
      // Шторка, оставшаяся после перезапуска приложения, открывается сама
      if (p) p = { ...p, draft: { ...p.draft, open: true } };
      setPending(p);
      setHydrated(true);
      await loadRejected();
      registerShell();
      await refill({ replace: true });
      void outbox.flush({ ignoreBackoff: true }).then((rep) => {
        if (rep.rejected.length > 0) void loadRejected();
      });
    })();
    return () => {
      alive = false;
    };
    // Старт один раз: зависимости стабильны
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Намерение звонка и черновик шторки сохраняются при каждом изменении
  useEffect(() => {
    if (!hydrated) return;
    if (pending) writePending(window.localStorage, userId, pending);
    else clearPending(window.localStorage, userId);
  }, [pending, hydrated, userId]);

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
    const ping = setInterval(() => void refill(), DEVICE_PING_MS);
    return () => {
      clearInterval(tick);
      clearInterval(ping);
    };
  }, [rt, flushAndSync, refill]);

  const openSheetIfPending = useCallback(() => {
    setPending((p) => (p && !p.draft.open ? { ...p, draft: { ...p.draft, open: true } } : p));
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (pendingRef.current) awayRef.current = true;
        return;
      }
      setNow(Date.now());
      if (awayRef.current && pendingRef.current) {
        awayRef.current = false;
        openSheetIfPending();
      }
      void flushAndSync();
    };
    const onPageShow = () => {
      if (pendingRef.current && awayRef.current) {
        awayRef.current = false;
        openSheetIfPending();
      }
    };
    const onOnline = () => {
      void flushAndSync({ ignoreBackoff: true });
      void refill();
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
  }, [flushAndSync, openSheetIfPending, refill]);

  // ---- Действия ---------------------------------------------------------------------------------------------

  const current: QueueCard | null = useMemo(() => {
    if (pending) return queue.find((c) => c.cardId === pending.call.cardId) ?? null;
    return queue[0] ?? null;
  }, [queue, pending]);

  const startCall = (card: QueueCard, phone: QueuePhone) => {
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

  const closeSheet = () => patchDraft({ open: false });

  const undo = async (opId: string, p: PendingState, card: QueueCard | null) => {
    const r = rtRef.current;
    if (!r) return;
    if (!(await r.outbox.cancel(opId))) {
      toast.show({ message: t('toast.alreadySent'), tone: 'info' });
      return;
    }
    setTally(forgetOutcome(window.localStorage, userId, today(), opId));
    if (card) setQueue((q) => [card, ...q.filter((c) => c.cardId !== card.cardId)]);
    setPending({ call: p.call, draft: { ...p.draft, open: true } });
    toast.show({ message: t('toast.undone'), tone: 'neutral' });
  };

  const submit = async (def: OutcomeButton, fieldValues: Record<string, string>) => {
    const r = rtRef.current;
    const p = pendingRef.current;
    if (!r || !p) return;
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
    });
    try {
      await r.outbox.enqueue({ request, title: p.call.title, kind: def.kind, undoMs: config.undoMs });
    } catch {
      toast.show({ message: t('toast.notSaved'), tone: 'danger' });
      return;
    }
    const card = queueRef.current.find((c) => c.cardId === p.call.cardId) ?? null;
    setTally(recordOutcome(window.localStorage, userId, today(), { opId: p.call.opId, kind: def.kind, at: p.call.tappedAt, booked: false }));
    setPending(null);
    setQueue((q) => q.filter((c) => c.cardId !== p.call.cardId));
    setCounts((c) => (c ? { ...c, dueNow: Math.max(0, c.dueNow - 1) } : c));
    const withUndo = config.undoMs > 0;
    undoToast.current = toast.show({
      message: t('toast.saved'),
      tone: 'success',
      ...(withUndo ? { undo: { label: t('toast.undo'), onUndo: () => void undo(p.call.opId, p, card) }, durationMs: config.undoMs } : {}),
    });
    void refill();
  };

  const book = (def: OutcomeButton) => {
    const p = pendingRef.current;
    if (!p) return;
    writePending(window.localStorage, userId, { call: p.call, draft: { ...p.draft, outcomeKey: def.key, open: false } });
    const qs = new URLSearchParams({ card: p.call.cardId, opId: p.call.opId, from: 'call' });
    router.push(`${config.bookHref}?${qs}`);
  };

  const skip = async (card: QueueCard) => {
    const r = rtRef.current;
    if (!r) return;
    try {
      const res = await r.api.skip({ opId: uuid(), cardId: card.cardId });
      if (res.data) {
        setCounts((c) => (c ? { ...c, skippedToday: res.data!.skipsToday, skipLimit: res.data!.skipLimit } : c));
        setQueue((q) => [...q.filter((c) => c.cardId !== card.cardId), { ...card, skippedToday: true }]);
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

  const view = viewOf(tally);
  const skipsToday = counts?.skippedToday ?? 0;
  const skipLimit = counts?.skipLimit ?? 0;
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const pace = callsInLastHour(tally, now);
  const waiting = rt ? rt.outbox.list().filter((e) => e.notBefore <= now).length : 0;
  void version;

  const sheetPhones = pending
    ? current && current.phones.length > 0
      ? current.phones.map((p) => ({ id: p.id, label: formatKzPhone(p.digits) }))
      : pending.call.phones.map((p) => ({ id: p.id, label: p.masked }))
    : [];

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-3" data-testid="call-screen">
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
        <Alert key={r.opId} tone="danger" title={t('outbox.rejected', { title: r.title })}>
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

      <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="call-today">
        {t('today.line', { outcomes: view.outcomes, connected: view.connected, booked: view.booked, skips: skipsToday, limit: skipLimit })}
      </p>
      {config.callsPerHourTarget !== null && (
        <p className="text-sm" style={{ color: 'var(--text-3)' }} data-testid="call-pace">
          {t('today.pace', { count: pace, target: config.callsPerHourTarget })}
        </p>
      )}

      {waiting > 0 && (
        <div
          className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-xl items-center gap-2 px-4"
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
        <OutcomeSheet config={config} pending={pending} phones={sheetPhones} onChange={patchDraft} onClose={closeSheet} onSubmit={(d, f) => void submit(d, f)} onBook={book} />
      )}
    </main>
  );
}
