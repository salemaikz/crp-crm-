'use client';

// Доска оператора (pipeline-v2 §9.1–§9.4, этап Б). Ноутбук: сетка колонок по ролям до низа окна, у каждой своя прокрутка,
// перетаскивание мышью (ui-polish §9.2). Телефон: липкие
// вкладки колонок, свайп (scroll-snap), перенос через «⋯ → Перенести в…». Над доской — поиск, сортировка, фильтры.
// Охват карточек проверяет сервер в SQL каждого запроса; данные доски нигде не кэшируются.
import { WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { formatKzt } from './money';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatKzPhone } from '@/shared/tel';
import { OutcomeSheet } from '@/ui/call/OutcomeSheet';
import { Alert, Button, EmptyState, Page, ToastProvider, useToast } from '@/ui/kit';
import { AgreedExitSheet } from './AgreedExitSheet';
import { BoardColumn } from './BoardColumn';
import { BoardControls } from './BoardControls';
import { ColumnTabs, type TabDrop } from './ColumnTabs';
import { LeadDrawer, cardHref } from './LeadDrawer';
import { LeadTile } from './LeadTile';
import { MoveMenu, useBlockedText } from './MoveMenu';
import { ATTEND_KINDS, attendedOf } from './attend';
import { SearchResults } from './SearchResults';
import { TrashSheet } from './TrashSheet';
import { CALLBACK_KINDS, callBlockedBy, callbackReasonsFor, canMoveAnywhere } from './moves';
import { isWorkingRole, trackTemplate } from './columns';
import { useFillHeight } from './useFillHeight';
import { activeCount, parseView, writeView, type ViewLimits } from './boardQuery';
import { SORT_LIMIT, availableFilters, sortCards, sortLimited } from './order';
import { useBoardData } from './useBoardData';
import { useBoardMoves } from './useBoardMoves';
import { useBoardRuntime } from './useBoardRuntime';
import { exitCallConfig } from './exit';
import { ConfirmSheet } from './ConfirmSheet';
import { confirmColumnKey, confirmEventsFor, eventsText, needsAnswer, remainingOf } from './confirm';
import { useBoardConfirm } from './useBoardConfirm';
import { fadeMask, rowEdges, rowStep, rowTarget } from './rowScroll';
import { useAttendance } from './useAttendance';
import { useMonthPurchases } from './useMonthPurchases';
import { useMouseDrag } from './useMouseDrag';
import { useTouchDrag } from './useTouchDrag';
import { NO_EXTRA, type BoardCardDto, type BoardColumnConfig, type BoardConfig, type BoardExtra, type BoardFilter, type BoardSort } from './types';

export function BoardScreen({ config, userId, header }: { config: BoardConfig; userId: string; header?: ReactNode }) {
  return (
    <ToastProvider>
      <BoardScreenInner config={config} userId={userId} header={header} />
    </ToastProvider>
  );
}

const noop = () => undefined;
const noopAsync = async () => ({ ok: false as const, code: 'handled' as const });

function BoardScreenInner({ config, userId, header }: { config: BoardConfig; userId: string; header?: ReactNode }) {
  const t = useTranslations('board');
  const f = useFormatter();
  const router = useRouter();
  // Вид доски живёт в адресе (контракт К1): «Назад» из карточки и ссылки из сводки открывают тот же вид
  const searchParams = useSearchParams();
  const limits = useMemo<ViewLimits>(
    () => ({
      tabs: config.columns.map((c) => c.key),
      filters: availableFilters(config.canPurchases, true),
      owners: config.manager ? config.manager.owners.map((o) => o.userId) : null,
      reasons: config.manager ? Object.keys(config.reasonLabels) : null,
    }),
    [config.columns, config.canPurchases, config.manager, config.reasonLabels],
  );
  const [initial] = useState(() => parseView(searchParams, limits));
  const [q, setQ] = useState(initial.q);
  const [sort, setSort] = useState<BoardSort>(initial.sort);
  const [rawFilters, setFilters] = useState<BoardFilter[]>(initial.filters);
  const [extra, setExtra] = useState<BoardExtra>(initial.extra);
  const [now, setNow] = useState(() => Date.now());
  const [drawerFor, setDrawerFor] = useState<BoardCardDto | null>(null);
  const [activeTab, setActiveTab] = useState(initial.tab);
  // Обзвон «подтвердить явку»: «Другой итог…» открыл обычную шторку (opId звонка); «Придёт/Не придёт» из «⋯» без звонка
  const [otherFor, setOtherFor] = useState<string | null>(null);
  const [askFor, setAskFor] = useState<{ id: string; decline: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // За краем ряда есть ещё колонки: затухание 24 px и кнопки «‹ ›» (ui-polish §9.2, D-358 п. 1)
  const [edges, setEdges] = useState({ before: false, after: false });
  const reloadRef = useRef<() => void>(noop);
  const dropOpsRef = useRef<(ops: readonly string[]) => void>(noop);

  const runtime = useBoardRuntime(userId, {
    onSettled: (sent, rejected) => {
      dropOpsRef.current([...sent, ...rejected]);
      reloadRef.current();
    },
    onPing: () => reloadRef.current(),
  });
  const data = useBoardData(q, rawFilters, !runtime.locked, runtime.safeFetch, extra);
  useEffect(() => {
    reloadRef.current = () => void data.reload();
    dropOpsRef.current = data.unplaceOps;
  });
  useEffect(() => {
    if (data.phase === 'login') router.replace('/login');
  }, [data.phase, router]);
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);

  // Сортировка на устройстве честна только над целой колонкой: рабочие колонки догружаются до предела (§9.4)
  const fill = data.fill;
  useEffect(() => {
    if (sort === 'heat' || data.phase !== 'ready') return;
    for (const c of config.columns) if (isWorkingRole(c.role)) void fill(c.key, SORT_LIMIT);
  }, [sort, data.phase, data.board, config.columns, fill]);

  // Плитки колонок с сортировкой; найденные поиском подсвечиваются
  const sorted = useMemo(
    () => Object.fromEntries(config.columns.map((c) => [c.key, sortCards(data.view[c.key] ?? [], sort, c.role)])),
    [config.columns, data.view, sort],
  );
  const cardOf = useCallback((id: string) => Object.values(sorted).flat().find((c) => c.id === id), [sorted]);
  // «Открыт WhatsApp» в ленту: без ожидания и без влияния на открытие ссылки; офлайн не шлём
  const safeFetch = runtime.safeFetch;
  const reportOpened = useCallback(
    (card: BoardCardDto) => {
      if (!navigator.onLine) return;
      void safeFetch('/api/messenger/opened', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: card.id, templateKey: null }), keepalive: true }).catch(() => undefined);
    },
    [safeFetch],
  );
  const titleOf = useCallback((c: BoardColumnConfig) => (c.label !== '' ? c.label : t(`state.${c.states[0] ?? 'new'}`)), [t]);
  const titleOfKey = useCallback(
    (key: string | null) => {
      const c = config.columns.find((x) => x.key === key);
      return c ? titleOf(c) : '';
    },
    [config.columns, titleOf],
  );
  const titleOfRole = (role: BoardColumnConfig['role']) => {
    const c = config.columns.find((x) => x.role === role);
    return c ? titleOf(c) : '';
  };
  const toast = useToast();
  const agreedLabel = config.call.outcomes.find((o) => o.kind === 'agreed')?.label ?? '';
  const blockedText = useBlockedText(agreedLabel);
  const moves = useBoardMoves({ config, userId, runtime, data, findCard: cardOf, columnTitle: titleOfKey });
  const attendance = useAttendance({ config, runtime, data });
  const confirmInfo = data.board?.confirm;
  const dayText = useCallback((at: number) => `${f.dateTime(at, { weekday: 'short', timeZone: config.call.timeZone })} ${f.dateTime(at, { day: '2-digit', month: '2-digit', timeZone: config.call.timeZone })}`, [f, config.call.timeZone]);
  const confirm = useBoardConfirm({ runtime, data, declineReason: confirmInfo?.declineReason ?? '', finishCall: moves.finishCall, dayText });
  // Фильтр «Подтвердить явку» живёт только в день обзвона: после загрузки без `confirm` значение из адреса не действует
  const filters = useMemo(() => (data.phase === 'ready' && !data.board?.confirm ? rawFilters.filter((x) => x !== 'confirm') : rawFilters), [data.phase, data.board, rawFilters]);
  const month = useMonthPurchases(config.canPurchases && config.scope === 'own', runtime.safeFetch);

  const matchIds = useMemo(() => new Set(data.board?.search?.matches.map((m) => m.id) ?? []), [data.board]);

  // Отпустили плитку на запрещённой колонке или вкладке: тост с той же причиной, что и в «Перенести в…»
  const rejectDrop = (id: string, col: string) => {
    const c = cardOf(id);
    const tg = c ? moves.targetsOf(c).find((x) => x.column === col) : undefined;
    if (!tg || tg.available || !tg.blocked || tg.blocked === 'same') return;
    toast.show({ message: blockedText(tg.blocked), tone: 'info' });
  };

  const drag = useMouseDrag({
    enabled: config.canMove,
    scroller,
    canDrag: (id) => {
      const c = cardOf(id);
      return !!c && !moves.locked.has(id) && canMoveAnywhere(moves.targetsOf(c));
    },
    canDrop: (id, col) => {
      const c = cardOf(id);
      return !!c && (moves.targetsOf(c).find((x) => x.column === col)?.available ?? false);
    },
    onDrop: (id, col) => {
      const c = cardOf(id);
      if (c) moves.startMove(c, col);
    },
    onReject: (id, col) => rejectDrop(id, col),
  });

  // Телефон: долгое нажатие поднимает плитку, вкладки колонок становятся целями (§9.2, этап В)
  const touch = useTouchDrag({
    enabled: config.canMove,
    scroller,
    canDrag: (id) => {
      const c = cardOf(id);
      return !!c && !moves.locked.has(id) && canMoveAnywhere(moves.targetsOf(c));
    },
    canDrop: (id, col) => {
      const c = cardOf(id);
      return !!c && (moves.targetsOf(c).find((x) => x.column === col)?.available ?? false);
    },
    onDrop: (id, col) => {
      const c = cardOf(id);
      if (c) moves.startMove(c, col);
    },
    onReject: (id, col) => rejectDrop(id, col),
  });
  const active = touch.drag ?? drag.drag;
  const consumeClick = () => touch.consumeClick() || drag.consumeClick();

  // Телефон: свайп переключает колонку, вкладки синхронизированы
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.scrollWidth <= el.clientWidth * 1.5 || el.clientWidth > 767) return;
        const i = Math.round(el.scrollLeft / el.clientWidth);
        const key = config.columns[Math.min(config.columns.length - 1, Math.max(0, i))]?.key;
        if (key) setActiveTab(key);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [config.columns]);
  const selectTab = (key: string) => {
    setActiveTab(key);
    const el = scroller.current;
    const i = config.columns.findIndex((c) => c.key === key);
    if (el && i >= 0 && el.clientWidth <= 767) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  // Адрес без новой записи истории: replaceState встроен в роутер Next и не делает запрос к серверу
  useEffect(() => {
    const qs = writeView({ tab: activeTab, q, sort, filters, extra }, limits);
    if (qs === window.location.search.replace(/^\?/, '')) return;
    window.history.replaceState(null, '', qs === '' ? window.location.pathname : `?${qs}`);
  }, [activeTab, q, sort, filters, extra, limits]);
  // Открыли по адресу с вкладкой: колонка выезжает на экран (телефон) или в видимую часть ряда (ноутбук), один раз
  const scrolledToTab = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (scrolledToTab.current || !el || data.phase !== 'ready') return;
    scrolledToTab.current = true;
    const i = config.columns.findIndex((c) => c.key === activeTab);
    if (i <= 0) return;
    if (el.clientWidth <= 767) el.scrollTo({ left: i * el.clientWidth });
    else el.querySelector<HTMLElement>(`[data-column-key="${CSS.escape(activeTab)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [data.phase, activeTab, config.columns]);
  useFillHeight(scroller, [data.phase, runtime.rejected.length, q]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      const e = el.clientWidth > 767 ? rowEdges(el) : { before: false, after: false };
      setEdges((p) => (p.before === e.before && p.after === e.after ? p : e));
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [data.phase, config.columns]);
  const scrollRow = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    const col = el.querySelector<HTMLElement>('[data-column-key]');
    el.scrollTo({ left: rowTarget(dir, el, rowStep(col?.getBoundingClientRect().width ?? 272, 8, el.clientWidth)), behavior: 'smooth' });
  };

  if (runtime.locked) return null;

  const waiting = runtime.rt ? runtime.rt.outbox.list().length : 0;
  void runtime.version;
  const offline = !runtime.online || data.phase === 'offline';
  const search = data.board?.search;
  const dragCard = active ? cardOf(active.cardId) : undefined;
  const dragTargets = dragCard ? moves.targetsOf(dragCard) : [];

  const tabDrops: Record<string, TabDrop> = Object.fromEntries(
    config.columns.map((c) => [c.key, { state: !active ? 'idle' : dragTargets.find((x) => x.column === c.key)?.available ? 'ok' : 'no', over: active?.over === c.key } satisfies TabDrop]),
  );
  const money = (n: number) => formatKzt(f, n);
  const tabs = config.columns.map((c) => ({ key: c.key, title: titleOf(c), count: sorted[c.key]?.length ?? 0, more: data.cols[c.key]?.next != null }));
  const emptyBoard = data.phase === 'ready' && tabs.every((x) => x.count === 0) && !q && filters.length === 0 && extra.owner === '' && extra.callbackReason === '';

  const callSheetCard = moves.callSheet?.card;
  // Обзвон: строка в колонке записи — «Подтвердить явку · БР 24.10: осталось N» (РОП — ещё и счётчики)
  const confirmNotice = (col: BoardColumnConfig): ReactNode => {
    if (!confirmInfo || col.role !== 'agreed') return undefined;
    const events = confirmEventsFor(confirmInfo, col.eventTypes);
    if (events.length === 0) return undefined;
    const s = confirmInfo.summary;
    const args = { events: eventsText(events, config.eventLabels, t('chip.eventUnknown')), n: remainingOf(s), tried: s.tried, confirmed: s.confirmed };
    return (
      <p className="px-1 text-sm font-medium" style={{ color: 'var(--text-2)' }} data-testid="confirm-line">
        {config.manager ? t('confirm.lineManager', args) : t('confirm.line', args)}
      </p>
    );
  };
  // Шторка ответа после звонка по плитке обзвона (вместо «Итога звонка»), пока не выбрали «Другой итог…»
  const callCard = moves.callSheet ? (cardOf(moves.callSheet.card.id) ?? moves.callSheet.card) : null;
  const confirmAfterCall = !!(moves.callSheet && moves.callSheet.pending.draft.open && callCard && needsAnswer(callCard) && confirmInfo && otherFor !== moves.callSheet.pending.call.opId);
  const askCard = askFor ? cardOf(askFor.id) : undefined;
  // В окне переноса «Перезвон» — только причины, уместные карточке: новому лиду не «не пришёл» и не «пришёл, не купил»
  const moveCall = (() => {
    const card = moves.moveSheet?.card;
    if (!card) return config.call;
    const attended = ATTEND_KINDS.some((k) => attendedOf(card, k, config.eventBehaviors));
    return { ...config.call, outcomes: config.call.outcomes.map((o) => (o.kind === 'callback' ? { ...o, reasons: callbackReasonsFor(card, o.reasons, config.callbackReasonRules, attended, now) } : o)) };
  })();

  return (
    <Page width="full" className="max-md:gap-3" data-testid="board-screen">
      <h1 className="sr-only">{t('title')}</h1>
      {header}
      <BoardControls
        q={q}
        onQ={setQ}
        sort={sort}
        onSort={setSort}
        filters={filters}
        onToggleFilter={(f) => {
          setFilters((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]));
          // Включение «Подтвердить явку» открывает колонку записи (на телефоне — её вкладку)
          if (f === 'confirm' && !filters.includes('confirm') && confirmInfo) {
            const key = confirmColumnKey(config.columns, confirmInfo);
            if (key) selectTab(key);
          }
        }}
        canPurchases={config.canPurchases}
        confirmDay={confirmInfo !== undefined}
        attendLabels={config.attendLabels}
        manager={config.manager}
        extra={extra}
        onExtra={setExtra}
        reasonLabels={config.reasonLabels}
        active={activeCount({ q, filters, extra })}
        onReset={() => {
          setQ('');
          setFilters([]);
          setExtra(NO_EXTRA);
        }}
        sortApplies={isWorkingRole(config.columns.find((c) => c.key === activeTab)?.role ?? 'other')}
        rowNav={{ before: edges.before, after: edges.after, onPrev: () => scrollRow(-1), onNext: () => scrollRow(1) }}
      />

      {runtime.rejected.map((r) => (
        <Alert key={r.opId} tone="danger" title={t('outbox.rejected', { title: r.title || '—' })}>
          <Button variant="quiet" size="sm" onClick={() => void runtime.dismissRejected(r.opId)}>
            {t('outbox.dismiss')}
          </Button>
        </Alert>
      ))}
      {offline && data.phase === 'ready' && (
        <Alert tone="warning" data-testid="board-offline-banner">
          {t('offline.banner')}
        </Alert>
      )}
      {waiting > 0 && (
        <Alert tone="warning" data-testid="outbox-banner">
          {t('outbox.pending', { count: waiting })}
        </Alert>
      )}
      {runtime.rt && !runtime.rt.persistent && <Alert tone="warning">{t('outbox.volatile')}</Alert>}

      {moves.callSheet && !moves.callSheet.pending.draft.open && (
        <Alert tone="info" data-testid="call-pending-banner">
          <span>{t('call.pending', { name: moves.callSheet.card.name })}</span>
          <Button variant="quiet" size="sm" onClick={moves.reopenCallSheet} data-testid="call-resume">
            {t('call.resume')}
          </Button>
        </Alert>
      )}

      {search && <SearchResults matches={search.matches} short={search.short} titleOfColumn={titleOfKey} onOpen={setDrawerFor} />}

      {data.phase === 'loading' && (
        <p role="status" className="py-8 text-center" style={{ color: 'var(--text-2)' }}>
          {t('state.loading')}
        </p>
      )}
      {(data.phase === 'offline' || data.phase === 'error') && (
        <EmptyState
          icon={data.phase === 'offline' ? <WifiOff /> : undefined}
          title={data.phase === 'offline' ? t('offline.title') : t('state.errorTitle')}
          description={data.phase === 'offline' ? (waiting > 0 ? t('offline.textPending', { count: waiting }) : t('offline.text')) : t('state.errorText')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => void data.reload()} data-testid="board-retry">
                {t('state.retry')}
              </Button>
              <Button href="/call" data-testid="offline-call-next">
                {t('callNext')}
              </Button>
            </div>
          }
        />
      )}
      {data.phase === 'unavailable' && <EmptyState title={t('state.unavailableTitle')} description={t('state.unavailableText')} />}

      {data.phase === 'ready' && (
        <>
          <ColumnTabs label={t('tabs.label')} tabs={tabs} active={activeTab} onSelect={selectTab} drops={tabDrops} />
          {emptyBoard && <EmptyState title={t('state.emptyTitle')} description={t('state.emptyText')} />}
          <div
            ref={scroller}
            className="k-hscroll -mx-[var(--gutter)] flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-[var(--gutter)] pb-4 md:grid md:h-[calc(100dvh_-_var(--board-top,0px)_-_var(--space-section)_-_var(--bottom-nav-h))] md:snap-none md:items-stretch md:gap-[var(--board-gap)] md:overflow-y-hidden md:pb-0 md:[grid-template-columns:var(--board-tracks)] md:[grid-template-rows:minmax(0,1fr)]"
            style={{
              ['--board-tracks' as string]: trackTemplate(config.columns.map((c) => c.role)),
              ...(fadeMask(edges) ? { maskImage: fadeMask(edges), WebkitMaskImage: fadeMask(edges) } : {}),
            }}
            data-testid="board-columns"
          >
            {config.columns.map((col) => {
              const cards = sorted[col.key] ?? [];
              const state = data.cols[col.key];
              const tg = dragTargets.find((x) => x.column === col.key);
              return (
                <BoardColumn
                  key={col.key}
                  columnKey={col.key}
                  role={col.role}
                  event={col.emptyEvent || t('chip.eventUnknown')}
                  title={titleOf(col)}
                  count={cards.length}
                  hasMore={state?.next != null}
                  limited={sortLimited(sort, col.role, state?.cards.length ?? 0, state?.next != null)}
                  limit={SORT_LIMIT}
                  loadingMore={state?.loadingMore ?? false}
                  dropState={active ? (tg?.available ? 'ok' : 'no') : 'idle'}
                  over={active?.over === col.key}
                  notice={confirmNotice(col)}
                  summary={
                    col.role === 'client' && month ? (
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 px-1 text-sm" data-testid="purchases-summary">
                        <span style={{ color: 'var(--text-2)' }} data-testid="purchases-month">
                          {t('purchases.month', { count: month.count, sum: money(month.sumKzt) })}
                        </span>
                        <Link href="/board/purchases" className="font-semibold underline" data-testid="purchases-link">
                          {t('purchases.link')}
                        </Link>
                      </div>
                    ) : undefined
                  }
                  onMore={() => void data.more(col.key)}
                  empty={cards.length === 0}
                >
                  {cards.map((card) => {
                    const targets = moves.targetsOf(card);
                    return (
                      <LeadTile
                        key={card.id}
                        card={card}
                        role={col.role}
                        config={config}
                        tones={data.board?.tones ?? []}
                        now={now}
                        locked={moves.locked.has(card.id)}
                        highlighted={matchIds.has(card.id)}
                        callBlocked={callBlockedBy(moves.pendingCardId, card.id)}
                        canMenu={canMoveAnywhere(targets)}
                        dragging={active?.cardId === card.id}
                        attendBusy={attendance.busy.includes(card.id)}
                        onAttend={(c, kind) => void attendance.mark(c, kind)}
                        onOpen={setDrawerFor}
                        onCall={moves.startCall}
                        onChatOpened={reportOpened}
                        onMenu={moves.openMenu}
                        onPointerDown={(c, e) => drag.onPointerDown(c.id, e)}
                        onTouchStart={(c, e) => touch.onTouchStart(c.id, e)}
                        consumeClick={consumeClick}
                      />
                    );
                  })}
                </BoardColumn>
              );
            })}
          </div>
        </>
      )}

      {active && dragCard && (
        <div
          className="pointer-events-none fixed z-[70] max-w-64 rounded-[var(--radius-card)] border px-3 py-2 text-sm font-semibold"
          style={{ left: active.x + 12, top: active.y + 12, background: 'var(--surface)', borderColor: 'var(--brand)', boxShadow: 'var(--shadow-float)' }}
          data-testid="drag-ghost"
        >
          {dragCard.name}
        </div>
      )}

      {moves.menuFor && (
        <MoveMenu
          card={moves.menuFor}
          columns={config.columns}
          titleOf={titleOf}
          targets={moves.targetsOf(moves.menuFor)}
          outcomeLabel={agreedLabel}
          canCall={config.scope === 'own' && config.canMove && moves.menuFor.phone !== null && !moves.locked.has(moves.menuFor.id) && !callBlockedBy(moves.pendingCardId, moves.menuFor.id)}
          cardHref={cardHref(moves.menuFor, config.scope)}
          onPick={(tg) => moves.startMove(moves.menuFor!, tg.column)}
          onCall={(c) => {
            moves.closeMenu();
            moves.startCall(c);
          }}
          onClose={moves.closeMenu}
          {...(config.canMove && confirmInfo && needsAnswer(moves.menuFor)
            ? {
                confirm: {
                  online: runtime.online,
                  onYes: () => {
                    const c = moves.menuFor!;
                    moves.closeMenu();
                    void confirm.yes(c, { fromCall: false });
                  },
                  onNo: () => {
                    const c = moves.menuFor!;
                    moves.closeMenu();
                    setAskFor({ id: c.id, decline: true });
                  },
                },
              }
            : {})}
        />
      )}

      {moves.moveSheet && (
        <OutcomeSheet
          config={moveCall}
          heading={t('move.toTitle', { column: titleOfRole('callback') })}
          pending={moves.moveSheet.pending}
          phones={moves.moveSheet.pending.call.phones.map((p) => ({ id: p.id, label: p.masked }))}
          onChange={moves.patchMoveDraft}
          onClose={moves.closeMove}
          onSubmit={(d, f) => void moves.submitMove(d, f)}
          hasContact={moves.moveSheet.card.lprName !== ''}
          touches={moves.moveSheet.card.callbackTouches}
          booking={false}
          onBookingOpen={noop}
          onBookingBack={noop}
          onLater={noop}
          submitBooking={noopAsync}
          onBooked={noop}
          lockedKinds={CALLBACK_KINDS}
        />
      )}

      {moves.trashFor && (
        <TrashSheet
          card={moves.trashFor}
          call={config.call}
          columnTitle={titleOfRole('trash')}
          returnDays={config.notInterestedReturnDays}
          {...moves.trashChoices(moves.trashFor)}
          onPick={(pick) => void moves.pickTrash(moves.trashFor!, pick)}
          onClose={moves.closeTrash}
        />
      )}

      {moves.exitFor && <AgreedExitSheet card={moves.exitFor} config={config} columnTitle={titleOfRole('callback')} now={now} onSubmit={(r) => moves.submitExitCallback(moves.exitFor!, r)} onClose={moves.closeExit} />}

      {moves.exitTrashFor && (
        <TrashSheet
          card={moves.exitTrashFor}
          call={exitCallConfig(config.call)}
          columnTitle={titleOfRole('trash')}
          returnDays={config.notInterestedReturnDays}
          {...moves.exitTrashChoices()}
          onPick={(pick) => moves.pickExitTrash(moves.exitTrashFor!, pick)}
          onClose={moves.closeExitTrash}
        />
      )}

      {moves.callSheet && moves.callSheet.pending.draft.open && callSheetCard && !confirmAfterCall && (
        <OutcomeSheet
          config={config.call}
          pending={moves.callSheet.pending}
          phones={moves.callSheet.pending.call.phones.map((p) => ({ id: p.id, label: callSheetCard.phone?.digits ? formatKzPhone(callSheetCard.phone.digits) : p.masked }))}
          onChange={moves.patchCallDraft}
          onClose={moves.closeCallSheet}
          onSubmit={(d, f) => void moves.submitCall(d, f)}
          hasContact={callSheetCard.lprName !== ''}
          touches={callSheetCard.callbackTouches}
          booking={false}
          onBookingOpen={moves.continueOnCallScreen}
          onBookingBack={noop}
          onLater={(d, f) => void moves.submitCall(d, f, true)}
          submitBooking={noopAsync}
          onBooked={noop}
        />
      )}

      {confirmInfo && confirmAfterCall && moves.callSheet && callCard && (
        <ConfirmSheet
          card={callCard}
          config={config}
          declineReason={confirmInfo.declineReason}
          online={runtime.online}
          busy={confirm.busy}
          onYes={() => void confirm.yes(callCard, { fromCall: true })}
          onNoAnswer={() => {
            const def = config.call.outcomes.find((o) => o.kind === 'no_answer');
            if (def) void moves.submitCall(def, {});
          }}
          onOther={() => setOtherFor(moves.callSheet!.pending.call.opId)}
          onDecline={(at) => void confirm.decline(callCard, at, { fromCall: true })}
          onClose={moves.closeCallSheet}
        />
      )}

      {confirmInfo && askFor && askCard && (
        <ConfirmSheet
          card={askCard}
          config={config}
          declineReason={confirmInfo.declineReason}
          online={runtime.online}
          startInDecline={askFor.decline}
          busy={confirm.busy}
          onYes={() => void confirm.yes(askCard, { fromCall: false }).then((done) => done && setAskFor(null))}
          onDecline={(at) => void confirm.decline(askCard, at, { fromCall: false }).then((done) => done && setAskFor(null))}
          onClose={() => setAskFor(null)}
        />
      )}

      {drawerFor && (
        <LeadDrawer
          card={cardOf(drawerFor.id) ?? drawerFor}
          config={config}
          inlineEdit={config.call.callbackV2}
          columnTitle={drawerFor.column ? titleOfKey(drawerFor.column) : ''}
          fetchFn={runtime.safeFetch}
          onClose={() => setDrawerFor(null)}
          now={now}
          attendBusy={attendance.busy.includes(drawerFor.id)}
          onAttend={(c, kind) => void attendance.mark(c, kind)}
          locked={moves.locked.has(drawerFor.id)}
          callBlocked={callBlockedBy(moves.pendingCardId, drawerFor.id)}
          canMenu={canMoveAnywhere(moves.targetsOf(cardOf(drawerFor.id) ?? drawerFor))}
          onCall={(c) => {
            setDrawerFor(null);
            moves.startCall(c);
          }}
          onMove={(c) => {
            setDrawerFor(null);
            moves.openMenu(c);
          }}
          onChatOpened={reportOpened}
        />
      )}
    </Page>
  );
}
