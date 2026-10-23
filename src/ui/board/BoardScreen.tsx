'use client';

// Доска оператора (pipeline-v2 §9.1–§9.4, этап Б). Ноутбук: колонки по 18 rem в ряд, перетаскивание мышью. Телефон: липкие
// вкладки колонок, свайп (scroll-snap), перенос через «⋯ → Перенести в…». Над доской — поиск, сортировка, фильтры.
// Охват карточек проверяет сервер в SQL каждого запроса; данные доски нигде не кэшируются.
import { WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatKzPhone } from '@/shared/tel';
import { OutcomeSheet } from '@/ui/call/OutcomeSheet';
import { Alert, Button, EmptyState, Page, ToastProvider } from '@/ui/kit';
import { AgreedExitSheet } from './AgreedExitSheet';
import { BoardColumn } from './BoardColumn';
import { BoardControls } from './BoardControls';
import { ColumnTabs, type TabDrop } from './ColumnTabs';
import { LeadDrawer } from './LeadDrawer';
import { LeadTile } from './LeadTile';
import { MoveMenu } from './MoveMenu';
import { SearchResults } from './SearchResults';
import { TrashSheet } from './TrashSheet';
import { CALLBACK_KINDS, callBlockedBy, canMoveAnywhere } from './moves';
import { isWorkingRole } from './columns';
import { SORT_LIMIT, sortCards, sortLimited } from './order';
import { useBoardData } from './useBoardData';
import { useBoardMoves } from './useBoardMoves';
import { useBoardRuntime } from './useBoardRuntime';
import { exitCallConfig } from './exit';
import { useAttendance } from './useAttendance';
import { useMonthPurchases } from './useMonthPurchases';
import { useMouseDrag } from './useMouseDrag';
import { useTouchDrag } from './useTouchDrag';
import type { BoardCardDto, BoardColumnConfig, BoardConfig, BoardFilter, BoardSort } from './types';

export function BoardScreen({ config, userId }: { config: BoardConfig; userId: string }) {
  return (
    <ToastProvider>
      <BoardScreenInner config={config} userId={userId} />
    </ToastProvider>
  );
}

const noop = () => undefined;
const noopAsync = async () => ({ ok: false as const, code: 'handled' as const });

function BoardScreenInner({ config, userId }: { config: BoardConfig; userId: string }) {
  const t = useTranslations('board');
  const f = useFormatter();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<BoardSort>('heat');
  const [filters, setFilters] = useState<BoardFilter[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [drawerFor, setDrawerFor] = useState<BoardCardDto | null>(null);
  const [activeTab, setActiveTab] = useState(config.columns[0]?.key ?? '');
  const scroller = useRef<HTMLDivElement>(null);
  const reloadRef = useRef<() => void>(noop);
  const dropOpsRef = useRef<(ops: readonly string[]) => void>(noop);

  const runtime = useBoardRuntime(userId, {
    onSettled: (sent, rejected) => {
      dropOpsRef.current([...sent, ...rejected]);
      reloadRef.current();
    },
    onPing: () => reloadRef.current(),
  });
  const data = useBoardData(q, filters, !runtime.locked, runtime.safeFetch);
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
  const moves = useBoardMoves({ config, userId, runtime, data, findCard: cardOf });
  const attendance = useAttendance({ config, runtime, data });
  const month = useMonthPurchases(config.canPurchases && config.scope === 'own', runtime.safeFetch);
  const titleOf = useCallback((c: BoardColumnConfig) => (c.label !== '' ? c.label : t(`state.${c.states[0] ?? 'new'}`)), [t]);
  const titleOfKey = (key: string | null) => {
    const c = config.columns.find((x) => x.key === key);
    return c ? titleOf(c) : '';
  };

  const matchIds = useMemo(() => new Set(data.board?.search?.matches.map((m) => m.id) ?? []), [data.board]);

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
  const money = (n: number) => f.number(n, { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 });
  const tabs = config.columns.map((c) => ({ key: c.key, title: titleOf(c), count: sorted[c.key]?.length ?? 0, more: data.cols[c.key]?.next != null }));
  const emptyBoard = data.phase === 'ready' && tabs.every((x) => x.count === 0) && !q && filters.length === 0;

  const callSheetCard = moves.callSheet?.card;

  return (
    <Page width="full" data-testid="board-screen">
      <h1 className="sr-only">{t('title')}</h1>
      <BoardControls
        q={q}
        onQ={setQ}
        sort={sort}
        onSort={setSort}
        filters={filters}
        onToggleFilter={(f) => setFilters((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]))}
        canPurchases={config.canPurchases}
        attendLabels={config.attendLabels}
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
            className="-mx-[var(--gutter)] flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-[var(--gutter)] pb-4 md:snap-none md:gap-4"
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
                  title={titleOf(col)}
                  count={cards.length}
                  hasMore={state?.next != null}
                  limited={sortLimited(sort, col.role, state?.cards.length ?? 0, state?.next != null)}
                  limit={SORT_LIMIT}
                  loadingMore={state?.loadingMore ?? false}
                  dropState={active ? (tg?.available ? 'ok' : 'no') : 'idle'}
                  over={active?.over === col.key}
                  summary={
                    col.role === 'client' && month ? (
                      <div className="flex items-baseline justify-between gap-2 px-1 text-sm" data-testid="purchases-summary">
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
                        tones={data.board?.tones ?? []}
                        now={now}
                        reasonLabels={config.reasonLabels}
                        eventLabels={config.eventLabels}
                        attendLabels={config.attendLabels}
                        locked={moves.locked.has(card.id)}
                        highlighted={matchIds.has(card.id)}
                        canCall={config.scope === 'own' && config.canMove}
                        callBlocked={callBlockedBy(moves.pendingCardId, card.id)}
                        canMenu={canMoveAnywhere(targets)}
                        dragging={active?.cardId === card.id}
                        attend={config}
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

      {moves.menuFor && <MoveMenu card={moves.menuFor} columns={config.columns} titleOf={titleOf} targets={moves.targetsOf(moves.menuFor)} onPick={(tg) => moves.startMove(moves.menuFor!, tg.column)} onClose={moves.closeMenu} />}

      {moves.moveSheet && (
        <OutcomeSheet
          config={config.call}
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
          {...moves.trashChoices(moves.trashFor)}
          onPick={(pick) => void moves.pickTrash(moves.trashFor!, pick)}
          onClose={moves.closeTrash}
        />
      )}

      {moves.exitFor && <AgreedExitSheet card={moves.exitFor} config={config} now={now} onSubmit={(r) => moves.submitExitCallback(moves.exitFor!, r)} onClose={moves.closeExit} />}

      {moves.exitTrashFor && (
        <TrashSheet
          card={moves.exitTrashFor}
          call={exitCallConfig(config.call)}
          {...moves.exitTrashChoices()}
          onPick={(pick) => moves.pickExitTrash(moves.exitTrashFor!, pick)}
          onClose={moves.closeExitTrash}
        />
      )}

      {moves.callSheet && moves.callSheet.pending.draft.open && callSheetCard && (
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

      {drawerFor && (
        <LeadDrawer
          card={cardOf(drawerFor.id) ?? drawerFor}
          inlineEdit={config.call.callbackV2}
          columnTitle={drawerFor.column ? titleOfKey(drawerFor.column) : ''}
          fetchFn={runtime.safeFetch}
          onClose={() => setDrawerFor(null)}
          attend={config}
          attendLabels={config.attendLabels}
          now={now}
          attendBusy={attendance.busy.includes(drawerFor.id)}
          onAttend={(c, kind) => void attendance.mark(c, kind)}
        />
      )}
    </Page>
  );
}
