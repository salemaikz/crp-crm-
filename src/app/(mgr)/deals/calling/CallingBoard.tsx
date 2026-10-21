'use client';

// Вид «Обзвон» для РОП (B8, PROCESS 4.4, D-266): карточки с владельцем по состояниям. Перенос = итог: перетаскивание
// или «Переместить в…» открывает ту же шторку итога с видами итога цели; в ленте итог помечен «внесено вручную».
import { Phone } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WizardChoice } from '@/app/(op)/bookings/_wizard/choice';
import type { BookingWizardProps } from '@/app/(op)/bookings/_wizard/BookingWizard';
import type { WizardResult } from '@/app/(op)/bookings/_wizard/result';
import type { CallingBoard as Board, CallingColumn, CallingTile } from '../types';
import { bookingAgreement, laterAgreement, parseAgreementResponse } from '@/ui/call/agreement';
import { createCallApi } from '@/ui/call/api';
import { OutcomeSheet } from '@/ui/call/OutcomeSheet';
import type { PendingState } from '@/ui/call/pending';
import { EMPTY_DRAFT, type CallConfig, type OutcomeButton, type SheetDraft } from '@/ui/call/types';
import { buildRequest } from '@/ui/call/validate';
import { Alert, BottomSheet, Badge, Button, EmptyState, PageHeader, Select, useToast } from '@/ui/kit';
import { BoardTabs } from '../BoardTabs';
import { dropKinds, type DropTarget } from './dropRules';

const uuid = (): string => globalThis.crypto.randomUUID();
/** Часы устройства: вызывается только из обработчиков событий. */
const nowMs = (): number => Date.now();
const TARGETS: readonly DropTarget[] = ['new', 'retry', 'callback', 'agreed', 'closed'];

async function getBoard(worker: string): Promise<{ status: number; data: Board | null }> {
  try {
    const qs = worker === 'all' ? '' : `?owner=${encodeURIComponent(worker)}`;
    const res = await fetch(`/api/kanban/calling${qs}`, { cache: 'no-store', credentials: 'same-origin' });
    return { status: res.status, data: res.ok ? ((await res.json()) as Board) : null };
  } catch {
    return { status: 0, data: null };
  }
}

async function getMore(worker: string, state: string, offset: number): Promise<CallingColumn | null> {
  try {
    const p = new URLSearchParams({ state, offset: String(offset) });
    if (worker !== 'all') p.set('owner', worker);
    const res = await fetch(`/api/kanban/calling/column?${p}`, { cache: 'no-store', credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as CallingColumn) : null;
  } catch {
    return null;
  }
}

const codeOf = (json: unknown): string => {
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  return typeof o.code === 'string' ? o.code : typeof o.error === 'string' ? o.error : 'not_found';
};

type Move = { tile: CallingTile; target: DropTarget; opId: string; draft: SheetDraft; openedAt: number };

export function CallingBoard({ initial, config }: { initial: Board; config: CallConfig }) {
  const t = useTranslations('deals.board');
  const te = useTranslations('calls');
  const f = useFormatter();
  const toast = useToast();
  const [board, setBoard] = useState<Board>(initial);
  const [worker, setWorker] = useState('all');
  const [dragging, setDragging] = useState<CallingTile | null>(null);
  const [picker, setPicker] = useState<CallingTile | null>(null);
  const [move, setMove] = useState<Move | null>(null);
  const [booking, setBooking] = useState<{ def: OutcomeButton; fieldValues: Record<string, string> } | null>(null);
  const [failed, setFailed] = useState(false);
  const workerRef = useRef(worker);
  const api = useRef(createCallApi(() => ({})));
  useEffect(() => {
    workerRef.current = worker;
  });

  const reload = useCallback(
    async (w?: string) => {
      const res = await getBoard(w ?? workerRef.current);
      if (res.status === 401) return window.location.replace('/login?next=/deals/calling');
      if (res.data) {
        setBoard(res.data);
        setFailed(false);
      } else setFailed(true);
    },
    [],
  );

  const kindsFor = (tile: CallingTile, target: DropTarget) => (board.can.move ? dropKinds(tile.state, target) : []);

  const targetLabel = (target: DropTarget): string => t(`calling.state.${target}`);

  const startMove = (tile: CallingTile, target: DropTarget) => {
    const kinds = kindsFor(tile, target);
    if (kinds.length === 0) {
      toast.show({ message: t(board.can.move ? 'calling.cannotDrop' : 'blocked.readonly'), tone: 'info' });
      return;
    }
    const outcomes = config.outcomes.filter((o) => (kinds as readonly string[]).includes(o.kind));
    if (outcomes.length === 0) {
      toast.show({ message: t('calling.noOutcomes'), tone: 'danger' });
      return;
    }
    const first = tile.phones[0];
    // Единственный подходящий итог выбран сразу: РОП не нажимает лишний раз
    const draft: SheetDraft = { ...EMPTY_DRAFT, open: true, phoneId: first?.id ?? null, outcomeKey: outcomes.length === 1 ? outcomes[0]!.key : '' };
    setMove({ tile, target, opId: uuid(), draft, openedAt: nowMs() });
    setBooking(null);
  };

  const sheetConfig: CallConfig | null = move ? { ...config, outcomes: config.outcomes.filter((o) => (kindsFor(move.tile, move.target) as readonly string[]).includes(o.kind)) } : null;
  const pending: PendingState | null = move
    ? {
        call: {
          opId: move.opId,
          cardId: move.tile.cardId,
          clientId: move.tile.clientId,
          tappedAt: move.openedAt,
          title: move.tile.clientName,
          phoneId: move.tile.phones[0]?.id ?? null,
          phoneMasked: move.tile.phones[0]?.masked ?? '',
          phones: move.tile.phones,
        },
        draft: move.draft,
      }
    : null;

  const done = (message: string, tone: 'success' | 'info' = 'success') => {
    setMove(null);
    setBooking(null);
    toast.show({ message, tone });
    void reload();
  };

  const fail = (code: string) => {
    if (code === 'version_conflict') return toast.show({ message: t('errors.stale'), tone: 'danger' });
    toast.show({ message: te.has(`errors.${code}`) ? te(`errors.${code}`) : te('errors.not_found'), tone: 'danger' });
  };

  /** Карточку изменили с момента загрузки доски: плитка остаётся на месте, шторка закрывается, доска обновляется. */
  const rollback = (code: string) => {
    setMove(null);
    setBooking(null);
    fail(code);
    void reload();
  };

  /** Итог РОП: `via: 'manual_entry'`, без «Отменить» — подтверждение в шторке (D-266). */
  const request = (def: OutcomeButton, fieldValues: Record<string, string>, agreement?: ReturnType<typeof bookingAgreement>) => {
    if (!move) return null;
    return {
      ...buildRequest({ opId: move.opId, cardId: move.tile.cardId, def, draft: move.draft, tappedAt: null, now: Date.now(), online: true, fieldValues, ...(agreement ? { agreement } : {}) }),
      via: 'manual_entry' as const,
      seenVersion: move.tile.version,
    };
  };

  const submit = async (def: OutcomeButton, fieldValues: Record<string, string>, later = false) => {
    if (!move) return;
    const req = request(def, fieldValues, later ? laterAgreement(move.tile.decisionMakerId, config, Date.now()) : undefined);
    if (!req) return;
    try {
      const res = await api.current.postOutcome(req);
      if (res.status === 200) return done(t('calling.saved'));
      if (res.status === 401) return window.location.replace('/login?next=/deals/calling');
      if (res.status === 423) return toast.show({ message: t('errors.readonly'), tone: 'danger' });
      const code = codeOf(res.json);
      if (res.status === 409 && code === 'version_conflict') return rollback(code);
      fail(code);
      if (res.status === 409 || res.status === 404) void reload();
    } catch {
      toast.show({ message: t('errors.offline'), tone: 'danger' });
    }
  };

  const submitBooking: NonNullable<BookingWizardProps['submit']> = async (choice: WizardChoice): Promise<WizardResult> => {
    const b = booking;
    if (!move || !b) return { ok: false, code: 'handled' };
    const req = request(b.def, b.fieldValues, bookingAgreement(move.tile.decisionMakerId, choice));
    if (!req) return { ok: false, code: 'handled' };
    let res: Awaited<ReturnType<typeof api.current.postOutcome>>;
    try {
      res = await api.current.postOutcome(req);
    } catch {
      return { ok: false, code: 'network' };
    }
    const verdict = parseAgreementResponse(res.status, res.json);
    switch (verdict.kind) {
      case 'result':
        return verdict.result;
      case 'login':
        window.location.replace('/login?next=/deals/calling');
        return { ok: false, code: 'handled' };
      case 'fact_only':
        done(t('calling.factOnly'), 'info');
        return { ok: false, code: 'handled' };
      case 'rejected':
        if (verdict.code === 'version_conflict') {
          rollback(verdict.code);
          return { ok: false, code: 'handled' };
        }
        setBooking(null);
        fail(verdict.code);
        return { ok: false, code: 'handled' };
    }
  };

  const more = async (col: CallingColumn) => {
    if (col.nextOffset === null) return;
    const page = await getMore(worker, col.state, col.nextOffset);
    if (!page) return toast.show({ message: t('errors.offline'), tone: 'danger' });
    setBoard((b) => ({
      ...b,
      columns: b.columns.map((c) => (c.state === col.state ? { ...c, total: page.total, cards: [...c.cards, ...page.cards.filter((x) => !c.cards.some((y) => y.cardId === x.cardId))], nextOffset: page.nextOffset } : c)),
    }));
  };

  const accepts = (target: DropTarget): boolean => !!dragging && kindsFor(dragging, target).length > 0;
  const empty = board.columns.every((c) => c.total === 0);

  const dropProps = (target: DropTarget) => ({
    onDragOver: (e: React.DragEvent) => {
      if (accepts(target)) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragging) startMove(dragging, target);
      setDragging(null);
    },
  });
  const zoneStyle = (target: DropTarget) => ({
    background: 'var(--surface-2)',
    outline: dragging && accepts(target) ? '2px dashed var(--brand)' : 'none',
    opacity: dragging && !accepts(target) ? 0.5 : 1,
  });

  return (
    <main className="flex flex-col gap-3 px-4 py-3" data-testid="calling-board">
      <PageHeader title={t('calling.title')} lead={t('calling.lead')} />
      <BoardTabs active="calling" showCalling />
      <div className="flex items-center gap-2">
        <Select
          aria-label={t('calling.worker')}
          value={worker}
          onChange={(e) => {
            setWorker(e.target.value);
            void reload(e.target.value);
          }}
          data-testid="worker-filter"
        >
          <option value="all">{t('calling.allWorkers')}</option>
          {board.workers.map((w) => (
            <option key={w.userId} value={w.userId}>
              {w.name}
            </option>
          ))}
        </Select>
        <Button variant="quiet" size="sm" onClick={() => void reload()}>
          {t('filters.refresh')}
        </Button>
      </div>
      {failed && <Alert tone="warning">{t('errors.offline')}</Alert>}
      {empty && <EmptyState title={t('calling.empty.title')} description={t('calling.empty.text')} />}

      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none" data-testid="calling-columns">
        {board.columns.map((col) => (
          <section
            key={col.state}
            aria-label={targetLabel(col.state)}
            className="flex w-[85%] min-w-[16rem] shrink-0 snap-start flex-col gap-2 rounded-xl p-2 md:w-72"
            style={zoneStyle(col.state)}
            {...dropProps(col.state)}
            data-testid={`ccol-${col.state}`}
          >
            <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
              {targetLabel(col.state)}
              <Badge tone="neutral">{col.total}</Badge>
            </h2>
            <ul className="flex flex-col gap-2">
              {col.cards.map((c) => (
                <li
                  key={c.cardId}
                  className="rounded-lg border bg-[var(--surface)] p-3 shadow-sm"
                  style={{ borderColor: 'var(--border)' }}
                  draggable={board.can.move}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', c.cardId);
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging(c);
                  }}
                  onDragEnd={() => setDragging(null)}
                  data-testid="calling-tile"
                  data-card-id={c.cardId}
                >
                  <Link href={`/clients/${c.clientId}`} className="font-semibold leading-tight hover:underline">
                    {c.clientName}
                  </Link>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
                    {[c.workerName, t('calling.attempts', { count: c.attempts })].filter(Boolean).join(' · ')}
                  </p>
                  {c.nextCallAt !== null && (
                    <p className="mt-1 flex items-center gap-1 text-sm" style={{ color: 'var(--text-2)' }}>
                      <Phone aria-hidden="true" size={14} />
                      {f.dateTime(c.nextCallAt, { dateStyle: 'short', timeStyle: 'short', timeZone: config.timeZone })}
                    </p>
                  )}
                  {c.lastOutcomeCode && (
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-3)' }}>
                      {config.outcomes.find((o) => o.key === c.lastOutcomeCode)?.label ?? c.lastOutcomeCode}
                    </p>
                  )}
                  {board.can.move && (
                    <Button variant="quiet" size="sm" className="mt-2" onClick={() => setPicker(c)} data-testid="calling-move">
                      {t('actions.move')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {col.nextOffset !== null && (
              <Button variant="secondary" size="sm" onClick={() => void more(col)}>
                {t('more', { count: col.total - col.cards.length })}
              </Button>
            )}
          </section>
        ))}
        <section
          aria-label={targetLabel('closed')}
          className="hidden w-48 shrink-0 flex-col gap-2 rounded-xl p-3 md:flex"
          style={zoneStyle('closed')}
          {...dropProps('closed')}
          data-testid="ccol-closed"
        >
          <h2 className="text-sm font-semibold">{targetLabel('closed')}</h2>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            {t('closed.count', { count: board.closed })}
          </p>
        </section>
      </div>

      {picker && (
        <BottomSheet open onClose={() => setPicker(null)} closeLabel={t('panel.close')} title={t('picker.title')} description={picker.clientName}>
          <ul className="flex flex-col gap-2" data-testid="calling-picker">
            {TARGETS.filter((x) => x !== picker.state).map((target) => {
              const ok = kindsFor(picker, target).length > 0;
              return (
                <li key={target}>
                  <button
                    type="button"
                    className="k-btn k-btn--secondary w-full text-left"
                    style={{ justifyContent: 'space-between' }}
                    disabled={!ok}
                    onClick={() => {
                      const tile = picker;
                      setPicker(null);
                      startMove(tile, target);
                    }}
                    data-testid={`cpick-${target}`}
                  >
                    <span>{targetLabel(target)}</span>
                    {!ok && (
                      <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                        {t('calling.cannotDrop')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </BottomSheet>
      )}

      {move && sheetConfig && pending && (
        <OutcomeSheet
          config={sheetConfig}
          pending={pending}
          phones={move.tile.phones.map((p) => ({ id: p.id, label: p.masked }))}
          onChange={(patch) => setMove({ ...move, draft: { ...move.draft, ...patch } })}
          onClose={() => {
            setMove(null);
            setBooking(null);
          }}
          onSubmit={(d, fv) => void submit(d, fv)}
          hasContact={move.tile.decisionMakerId !== null}
          booking={booking !== null}
          onBookingOpen={(def, fieldValues) => setBooking({ def, fieldValues })}
          onBookingBack={() => setBooking(null)}
          onLater={(d, fv) => void submit(d, fv, true)}
          submitBooking={submitBooking}
          onBooked={() => done(t('calling.saved'))}
        />
      )}
    </main>
  );
}
