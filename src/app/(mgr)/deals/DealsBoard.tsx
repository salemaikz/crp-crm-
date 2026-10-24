'use client';

// Доска продаж (B8, D-266): колонки открытых этапов воронки. Перенос: мгновенно + «Отменить» 5 с (отправка после окна),
// при нехватке данных — панель, на телефоне — «Переместить в…». Проверку обязательного делает сервер на каждом пути.
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Page, PageHeader, Select, useToast } from '@/ui/kit';
import type { BoardColumn, BoardStage, ClosedDeals, DealTile as Tile, DealsBoard as Board } from './types';
import { loadBoard, loadClosed, loadColumn, postStage, type StageExtras } from './api';
import { BoardTabs } from './BoardTabs';
import { appendPage, placeTile } from './boardState';
import type { MoveRequest } from './deferredMove';
import { DealTile } from './DealTile';
import { MovePanel } from './MovePanel';
import { MovePicker } from './MovePicker';
import { classifyMoveResponse, decideMove, panelFields, routeRefusal, type MoveDecision, type MoveVerdict } from './moveRules';
import { useDeferredMove } from './useDeferredMove';

const uuid = (): string => globalThis.crypto.randomUUID();
/** Часы устройства: вызывается только из обработчиков событий. */
const nowMs = (): number => Date.now();
/** Тост «Перенесено» живёт, пока не уйдёт запрос: его закрывает отправка, а не собственный таймер. */
const TOAST_HOLD_MS = 60_000;

type PanelState = { tile: Tile; target: BoardStage; nextStep: boolean; fields: string[] };

export function DealsBoard({ initial, timeZone, showCalling, opBoard = false }: { initial: Board; timeZone: string; showCalling: boolean; opBoard?: boolean }) {
  const t = useTranslations('deals.board');
  const router = useRouter();
  const toast = useToast();
  const [board, setBoard] = useState<Board>(initial);
  const [owner, setOwner] = useState('all');
  const [picker, setPicker] = useState<Tile | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Tile | null>(null);
  const [closed, setClosed] = useState<ClosedDeals | null>(null);
  const [failed, setFailed] = useState(false);

  const sendRef = useRef<(move: MoveRequest, o: { keepalive: boolean }) => void>(() => undefined);
  const dm = useDeferredMove((move, o) => sendRef.current(move, o));
  const dmRef = useRef(dm);
  const boardRef = useRef(board);
  const ownerRef = useRef(owner);
  const originals = useRef(new Map<string, Tile>());
  const toasts = useRef(new Map<string, string>());
  const inflight = useRef(0);
  const dirty = useRef(false);
  useEffect(() => {
    boardRef.current = board;
    ownerRef.current = owner;
    dmRef.current = dm;
  });

  const stages = board.pipeline.stages;
  const stageLabel = (key: string): string => stages.find((s) => s.key === key)?.label ?? key;
  const decide = (tile: Tile, target: string): MoveDecision => decideMove({ stages, can: board.can, fieldDefs: board.fieldDefs }, tile, target);

  const toLogin = () => window.location.replace('/login?next=/deals');
  const purchaseHref = (tile: Tile): string => `/deals/purchase/${encodeURIComponent(tile.cardId)}`;
  const loseHref = (tile: Tile): string => `/deals/${encodeURIComponent(tile.id)}`;
  const errorText = (code: string): string => (t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.generic'));

  // ---- Чтение -----------------------------------------------------------------------------------------------

  const reload = useCallback(
    async (over: { pipeline?: string; owner?: string } = {}) => {
      const res = await loadBoard(over.pipeline ?? boardRef.current.pipeline.key, over.owner ?? ownerRef.current);
      if (res.status === 401) return toLogin();
      if (res.data) {
        setBoard(res.data);
        setFailed(false);
        setClosed(null);
      } else {
        setFailed(true);
        toast.show({ message: t('errors.offline'), tone: 'danger' });
      }
    },
    [t, toast],
  );

  /** Доска перечитывается, когда нет переносов в пути: иначе ответ затёр бы локальные перемещения. */
  const settle = useCallback(() => {
    if (inflight.current > 0 || dmRef.current.pending() > 0) return;
    if (dirty.current) {
      dirty.current = false;
      void reload();
    }
  }, [reload]);

  // ---- Отправка переноса ------------------------------------------------------------------------------------

  const revert = useCallback((opId: string) => {
    const original = originals.current.get(opId);
    originals.current.delete(opId);
    if (original) setBoard((b) => ({ ...b, columns: placeTile(b.columns, original, original.stageKey) }));
  }, []);

  /**
   * Отказ сервера по коду (409/400): нехватка шага или полей — панель с недостающим, закрытие сделки — кнопка
   * «Покупка»/«Проигран», остальное — тост. Плитка к этому моменту уже возвращена на прежний этап.
   */
  const refusal = (code: string, fields: readonly string[], tile: Tile | undefined, target: BoardStage | undefined): boolean => {
    if (!tile || !target) return false;
    const known = (tile.missing[target.key] ?? []).filter((c) => c.startsWith('field:')).map((c) => c.slice('field:'.length));
    const r = routeRefusal(code, fields, known);
    if (r.kind === 'panel') {
      const keys = r.fields.filter((k) => boardRef.current.fieldDefs.some((d) => d.key === k && d.editable));
      if (!r.nextStep && keys.length === 0) return false;
      setPanelError(null);
      setPanel({ tile, target, nextStep: r.nextStep, fields: keys });
      return true;
    }
    if (r.kind === 'blocked') {
      toast.show({ message: t(`blocked.${r.reason}`), tone: 'info' });
      return true;
    }
    if (r.kind === 'purchase' || r.kind === 'lose') {
      toast.show({
        message: errorText(code),
        tone: 'info',
        durationMs: TOAST_HOLD_MS,
        undo: { label: t(r.kind === 'purchase' ? 'toast.purchase' : 'toast.lose'), onUndo: () => router.push(r.kind === 'purchase' ? purchaseHref(tile) : loseHref(tile)) },
      });
      return true;
    }
    return false;
  };

  const verdictToast = useCallback(
    (v: MoveVerdict, move: MoveRequest) => {
      const opId = move.opId;
      switch (v.kind) {
        case 'ok':
          originals.current.delete(opId);
          return;
        case 'stale':
          originals.current.delete(opId);
          dirty.current = true;
          toast.show({ message: t('errors.stale'), tone: 'info' });
          return;
        case 'login':
          return toLogin();
        case 'code': {
          const original = originals.current.get(opId);
          revert(opId);
          dirty.current = true;
          const target = boardRef.current.pipeline.stages.find((s) => s.key === move.stageKey);
          if (!refusal(v.code, v.fields, original, target)) toast.show({ message: errorText(v.code), tone: 'danger' });
          return;
        }
        case 'forbidden':
        case 'readonly':
          revert(opId);
          toast.show({ message: t(v.kind === 'forbidden' ? 'errors.forbidden' : 'errors.readonly'), tone: 'danger' });
          return;
        case 'network':
          revert(opId);
          toast.show({ message: t('errors.offline'), tone: 'danger' });
          return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revert, t, toast],
  );

  const sendMove = useCallback(
    async (move: MoveRequest, keepalive: boolean) => {
      inflight.current += 1;
      try {
        const res = await postStage(move, { nextStep: null }, keepalive);
        verdictToast(classifyMoveResponse(res.status, res.json), move);
      } finally {
        inflight.current -= 1;
        // После любого переноса доска перечитывается: версии, «чего не хватает» и значки пересчитаны сервером
        dirty.current = true;
        settle();
      }
    },
    [settle, verdictToast],
  );

  // Отправка по истечении окна: закрываем тост и шлём перенос
  useEffect(() => {
    sendRef.current = (move, o) => {
      const id = toasts.current.get(move.opId);
      if (id) toast.dismiss(id);
      toasts.current.delete(move.opId);
      void sendMove(move, o.keepalive);
    };
  });

  // ---- Перенос ----------------------------------------------------------------------------------------------

  const startInstant = (tile: Tile, target: BoardStage) => {
    const opId = uuid();
    const move: MoveRequest = { opId, dealId: tile.id, version: tile.version, stageKey: target.key, fromStageKey: tile.stageKey };
    const moved: Tile = { ...tile, stageKey: target.key, stageChangedAt: nowMs() };
    setBoard((b) => ({ ...b, columns: placeTile(b.columns, moved, target.key) }));
    originals.current.set(opId, tile);
    const replaced = dmRef.current.schedule(move);
    let original = tile;
    if (replaced) {
      // Тот же тайл переносят повторно в окне отмены: прежний перенос не уходит, откатываться надо к исходному
      original = originals.current.get(replaced.opId) ?? tile;
      originals.current.delete(replaced.opId);
      originals.current.set(opId, original);
      const old = toasts.current.get(replaced.opId);
      if (old) toast.dismiss(old);
      toasts.current.delete(replaced.opId);
    }
    if (original.stageKey === target.key) {
      // вернули на исходный этап: отправлять нечего
      dmRef.current.cancel(opId);
      originals.current.delete(opId);
      setBoard((b) => ({ ...b, columns: placeTile(b.columns, original, original.stageKey) }));
      return;
    }
    const id = toast.show({
      message: t('toast.moved', { stage: target.label }),
      tone: 'success',
      durationMs: TOAST_HOLD_MS,
      undo: {
        label: t('toast.undo'),
        onUndo: () => {
          const cancelled = dmRef.current.cancel(opId);
          toasts.current.delete(opId);
          if (cancelled) revert(opId);
          else toast.show({ message: t('toast.alreadySent'), tone: 'info' });
        },
      },
    });
    toasts.current.set(opId, id);
  };

  const requestMove = (tile: Tile, targetKey: string) => {
    const target = stages.find((s) => s.key === targetKey);
    if (!target) return;
    const d = decide(tile, targetKey);
    switch (d.kind) {
      case 'noop':
        return;
      case 'blocked':
        toast.show({ message: t(`blocked.${d.reason}`), tone: 'info' });
        return;
      case 'purchase':
      case 'lose':
        // Покупка — форма по карточке, проигрыш — действие на странице сделки (B6)
        router.push(d.kind === 'purchase' ? purchaseHref(tile) : loseHref(tile));
        return;
      case 'panel':
        setPanelError(null);
        setPanel({ tile, target, nextStep: d.nextStep, fields: d.fields });
        return;
      case 'instant':
        startInstant(tile, target);
        return;
    }
  };

  const submitPanel = async (extras: StageExtras) => {
    if (!panel) return;
    setPanelBusy(true);
    setPanelError(null);
    const { tile, target } = panel;
    const move: MoveRequest = { opId: uuid(), dealId: tile.id, version: tile.version, stageKey: target.key, fromStageKey: tile.stageKey };
    inflight.current += 1;
    try {
      const res = await postStage(move, extras, false);
      const v = classifyMoveResponse(res.status, res.json);
      if (v.kind === 'ok') {
        setPanel(null);
        dirty.current = true;
      } else if (v.kind === 'stale') {
        setPanel(null);
        dirty.current = true;
        toast.show({ message: t('errors.stale'), tone: 'info' });
      } else if (v.kind === 'login') {
        toLogin();
      } else if (v.kind === 'code') {
        const r = routeRefusal(v.code, v.fields);
        if (r.kind === 'purchase' || r.kind === 'lose') {
          setPanel(null);
          router.push(r.kind === 'purchase' ? purchaseHref(tile) : loseHref(tile));
        } else if (r.kind === 'panel' && ((r.nextStep && !panel.nextStep) || r.fields.some((k) => !panel.fields.includes(k)))) {
          // Данные плитки устарели: панель показывает то, чего сервер ещё требует
          const keys = [...new Set([...panel.fields, ...r.fields])].filter((k) => board.fieldDefs.some((d) => d.key === k && d.editable));
          setPanel({ tile, target, nextStep: panel.nextStep || r.nextStep, fields: keys });
          setPanelError(errorText(v.code));
        } else {
          setPanelError(errorText(v.code));
        }
      } else {
        setPanelError(t(v.kind === 'network' ? 'errors.offline' : v.kind === 'readonly' ? 'errors.readonly' : 'errors.forbidden'));
      }
    } finally {
      inflight.current -= 1;
      setPanelBusy(false);
      settle();
    }
  };

  // ---- Перетаскивание, «ещё», закрытые ----------------------------------------------------------------------

  const accepts = (target: string): boolean => {
    if (!dragging) return false;
    const d = decide(dragging, target);
    return d.kind !== 'noop' && d.kind !== 'blocked';
  };

  const more = async (col: BoardColumn) => {
    if (!col.nextCursor) return;
    const res = await loadColumn(board.pipeline.key, owner, col.stageKey, col.nextCursor);
    if (res.status === 401) return toLogin();
    if (res.data) setBoard((b) => ({ ...b, columns: appendPage(b.columns, res.data!) }));
    else toast.show({ message: t('errors.offline'), tone: 'danger' });
  };

  const showClosed = async () => {
    const res = await loadClosed(board.pipeline.key, owner, null);
    if (res.status === 401) return toLogin();
    if (res.data) setClosed(res.data);
    else toast.show({ message: t('errors.offline'), tone: 'danger' });
  };

  const openStages = stages.filter((s) => s.kind === 'open');
  const closedStages = stages.filter((s) => s.kind !== 'open');
  const empty = board.columns.every((c) => c.total === 0);

  return (
    <Page width="full" data-testid="deals-board">
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        tabs={showCalling ? <BoardTabs active="deals" showCalling opBoard={opBoard} /> : undefined}
        actions={
          <>
        {board.pipelines.length > 1 && (
          <Select className="w-52" aria-label={t('filters.pipeline')} value={board.pipeline.key} onChange={(e) => void reload({ pipeline: e.target.value })}>
            {board.pipelines.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        )}
        <Select
          className="w-56"
          aria-label={t('filters.owner')}
          value={owner}
          onChange={(e) => {
            setOwner(e.target.value);
            void reload({ owner: e.target.value });
          }}
          data-testid="owner-filter"
        >
          <option value="all">{t('filters.allOwners')}</option>
          {board.owners.map((o) => (
            <option key={o.userId} value={o.userId}>
              {o.name}
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          {t('filters.refresh')}
        </Button>
          </>
        }
      />

      {failed && <Alert tone="warning">{t('errors.offline')}</Alert>}
      {empty && <EmptyState title={t('empty.title')} description={t('empty.text')} />}

      <div
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none"
        style={{ scrollbarWidth: 'thin' }}
        data-testid="deals-columns"
      >
        {board.columns.map((col) => {
          const stage = openStages.find((s) => s.key === col.stageKey);
          const can = accepts(col.stageKey);
          return (
            <section
              key={col.stageKey}
              aria-label={stage?.label}
              className="flex w-[85%] min-w-[16rem] shrink-0 snap-start flex-col gap-2 rounded-xl p-2 md:w-72"
              style={{ background: 'var(--canvas)', border: '1px solid var(--border)', outline: dragging ? (can ? '2px dashed var(--brand)' : 'none') : 'none', opacity: dragging && !can && dragging.stageKey !== col.stageKey ? 0.5 : 1 }}
              onDragOver={(e) => {
                if (can) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) requestMove(dragging, col.stageKey);
                setDragging(null);
              }}
              data-testid={`col-${col.stageKey}`}
            >
              <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
                {stage?.label}
                <Badge tone="neutral" variant="count">{col.total}</Badge>
              </h2>
              <ul className="flex flex-col gap-2">
                {col.deals.map((d) => (
                  <DealTile
                    key={d.id}
                    tile={d}
                    timeZone={timeZone}
                    draggable={board.can.edit}
                    waiting={dm.waiting.has(d.id)}
                    onMove={setPicker}
                    onDragStart={setDragging}
                    onDragEnd={() => setDragging(null)}
                  />
                ))}
              </ul>
              {col.nextCursor && (
                <Button variant="secondary" size="sm" onClick={() => void more(col)}>
                  {t('more', { count: col.total - col.deals.length })}
                </Button>
              )}
            </section>
          );
        })}

        {closedStages.map((s) => {
          const can = accepts(s.key);
          return (
            <section
              key={s.key}
              aria-label={s.label}
              className="hidden w-48 shrink-0 flex-col gap-2 rounded-xl p-3 md:flex"
              style={{ background: 'var(--canvas)', border: '1px solid var(--border)', outline: dragging ? (can ? '2px dashed var(--brand)' : 'none') : 'none', opacity: dragging && !can ? 0.5 : 1 }}
              onDragOver={(e) => {
                if (can) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) requestMove(dragging, s.key);
                setDragging(null);
              }}
              data-testid={`col-${s.key}`}
            >
              <h2 className="text-sm font-semibold">{s.label}</h2>
              <p className="text-sm" style={{ color: 'var(--text-2)' }}>
                {t('closed.count', { count: s.kind === 'won' ? board.closed.won30d : board.closed.lost30d })}
              </p>
            </section>
          );
        })}
      </div>

      <div>
        <Button variant="secondary" size="sm" onClick={() => void showClosed()} data-testid="show-closed">
          {t('closed.show')}
        </Button>
      </div>
      {closed && (
        <ul className="grid gap-2 md:grid-cols-3" data-testid="closed-list">
          {closed.deals.length === 0 && <li style={{ color: 'var(--text-2)' }}>{t('closed.none')}</li>}
          {closed.deals.map((d) => (
            <li key={d.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
              <p className="font-semibold">{d.clientName}</p>
              <Badge tone={d.status === 'won' ? 'success' : 'danger'}>{stageLabel(d.stageKey)}</Badge>
            </li>
          ))}
        </ul>
      )}

      {picker && (
        <MovePicker
          clientName={picker.clientName}
          currentKey={picker.stageKey}
          stages={stages}
          decide={(key) => decide(picker, key)}
          onClose={() => setPicker(null)}
          onPick={(key) => {
            const tile = picker;
            setPicker(null);
            requestMove(tile, key);
          }}
        />
      )}

      {panel && (
        <MovePanel
          title={t('panel.title', { stage: panel.target.label })}
          nextStep={panel.nextStep}
          fields={panelFields(board.fieldDefs, panel.fields)}
          timeZone={timeZone}
          busy={panelBusy}
          error={panelError}
          onClose={() => setPanel(null)}
          onSubmit={(x) => void submitPanel(x)}
        />
      )}
    </Page>
  );
}
