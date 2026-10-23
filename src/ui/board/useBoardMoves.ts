'use client';

// Переносы плиток и звонок с плитки (pipeline-v2 §3.2, §3.4, §9.3).
// - «Перезвон»: шторка итога (виды «Перезвонить» и «Не берёт») → очередь устройства (Outbox), окно «Отменить».
// - «Мусор»: быстрые причины → итог через очередь; «Не отвечает» — ручное списание № 32 онлайн, отправка через 5 с.
// - «Позвонить»: намерение звонка пишется на устройство до перехода по tel:, после возврата открывается шторка итога.
// Канал итога (`ui`/`offline` при намерении звонка, `board` без него) выбирает moves.viaFor; решает всё равно сервер.
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { laterAgreement } from '@/ui/call/agreement';
import { hasFreeText } from '@/ui/call/freeText';
import { clearPending, readPending, writePending, type PendingState } from '@/ui/call/pending';
import { EMPTY_DRAFT, type OutcomeButton, type PendingCall, type SheetDraft } from '@/ui/call/types';
import { useToast } from '@/ui/kit';
import { buildMoveRequest, lockedIds, moveTargets, planFor, quickTrash, moreTrash, trashDraft, type TrashChoice } from './moves';
import type { useBoardData } from './useBoardData';
import type { useBoardRuntime } from './useBoardRuntime';
import type { TrashPick } from './TrashSheet';
import type { BoardCardDto, BoardConfig } from './types';

type Data = ReturnType<typeof useBoardData>;
type Runtime = ReturnType<typeof useBoardRuntime>;

const uuid = (): string => globalThis.crypto.randomUUID();
/** Если звонилка не увела приложение в фон, шторка итога открывается сама через это время (как на экране «Звонить»). */
const OPEN_FALLBACK_MS = 1200;

interface Deferred {
  timer: ReturnType<typeof setTimeout>;
  send: (keepalive: boolean) => Promise<void>;
}

/** Шторка переноса в «Перезвон»: карточка и черновик. */
export interface MoveSheetState {
  card: BoardCardDto;
  pending: PendingState;
  /** Намерение звонка этой карточки, если было: его opId и момент нажатия уходят в итог. */
  intent: PendingState | null;
}

export function useBoardMoves(deps: { config: BoardConfig; userId: string; runtime: Runtime; data: Data; findCard: (id: string) => BoardCardDto | undefined }) {
  const { config, userId, runtime, data, findCard } = deps;
  const t = useTranslations('board');
  const toast = useToast();
  const router = useRouter();
  const call = config.call;

  const [menuFor, setMenuFor] = useState<BoardCardDto | null>(null);
  const [moveSheet, setMoveSheet] = useState<MoveSheetState | null>(null);
  const [trashFor, setTrashFor] = useState<BoardCardDto | null>(null);
  const [callSheet, setCallSheet] = useState<MoveSheetState | null>(null);
  const [deferredIds, setDeferredIds] = useState<string[]>([]);
  const deferred = useRef(new Map<string, Deferred>());
  const awayRef = useRef(false);
  const callSheetRef = useRef<MoveSheetState | null>(null);
  useEffect(() => {
    callSheetRef.current = callSheet;
  });

  const rt = runtime.rt;
  const locked = lockedIds(rt ? rt.outbox.cardIds() : [], deferredIds);
  void runtime.version;

  const targetsOf = useCallback((card: BoardCardDto) => moveTargets(card, config.columns, config.canMove), [config.columns, config.canMove]);

  // ---- общее: итог в очередь устройства --------------------------------------------------------------------------

  const enqueueOutcome = useCallback(
    async (card: BoardCardDto, def: OutcomeButton, draft: SheetDraft, intent: PendingState | null, opId: string, fieldValues: Record<string, string>, extra?: Partial<ReturnType<typeof buildMoveRequest>>): Promise<boolean> => {
      const r = runtime.rtRef.current;
      if (!r || runtime.lockedRef.current) return false;
      if (runtime.foreign()) {
        runtime.leave();
        return false;
      }
      const now = Date.now();
      const request = {
        ...buildMoveRequest({ card, def, draft, intent: intent ? { opId: intent.call.opId, tappedAt: intent.call.tappedAt } : null, opId, now, online: navigator.onLine, fieldValues, callbackV2: call.callbackV2 }),
        ...extra,
      };
      const textFields = new Set(Object.entries(call.outcomeFields).filter(([, f]) => f.type === 'text').map(([k]) => k));
      try {
        await r.outbox.enqueue({ request, title: card.name, kind: def.kind, undoMs: config.undoMs, freeText: hasFreeText(request, textFields) });
      } catch {
        toast.show({ message: t('toast.notSaved'), tone: 'danger' });
        return false;
      }
      const plan = planFor(card, def, draft, config.columns, now);
      if (plan) data.place({ cardId: card.id, column: plan.column, patch: plan.patch, opId: request.opId });
      // Намерение звонка «потрачено» этим итогом; отмена вернёт его на место
      if (intent) runtime.clearIntent();
      const undo = async () => {
        if (!(await r.outbox.cancel(request.opId))) {
          toast.show({ message: t('toast.alreadySent'), tone: 'info' });
          return;
        }
        data.unplaceCard(card.id);
        if (intent) writePending(window.localStorage, userId, intent);
        toast.show({ message: t('toast.undone'), tone: 'neutral' });
      };
      toast.show({ message: t('toast.moved', { name: card.name }), tone: 'success', ...(config.undoMs > 0 ? { undo: { label: t('toast.undo'), onUndo: () => void undo() }, durationMs: config.undoMs } : {}) });
      return true;
    },
    [runtime, call, config.undoMs, config.columns, data, toast, t, userId],
  );

  // ---- перенос в «Перезвон» --------------------------------------------------------------------------------------

  const syntheticPending = useCallback(
    (card: BoardCardDto, intent: PendingState | null): PendingState => {
      if (intent) return { call: intent.call, draft: { ...intent.draft, open: true } };
      const phones = card.phone ? [{ id: card.phone.id, masked: card.phone.masked }] : [];
      const pc: PendingCall = { opId: uuid(), cardId: card.id, clientId: card.clientId, tappedAt: 0, title: card.name, phoneId: card.phone?.id ?? null, phoneMasked: card.phone?.masked ?? '', phones };
      const lpr = card.lpr === 'yes' ? 'yes' : card.lpr === 'no' ? 'no' : '';
      return { call: pc, draft: { ...EMPTY_DRAFT, open: true, lpr, target: card.isTarget === 'yes', phoneId: card.phone?.id ?? null } };
    },
    [],
  );

  const startMove = useCallback(
    (card: BoardCardDto, column: string) => {
      const target = targetsOf(card).find((x) => x.column === column);
      if (!target?.available || !target.action) return;
      if (lockedIds(runtime.rtRef.current?.outbox.cardIds() ?? [], [...deferred.current.keys()]).has(card.id)) {
        toast.show({ message: t('toast.locked'), tone: 'info' });
        return;
      }
      setMenuFor(null);
      if (target.action === 'callback') {
        const intent = runtime.intentFor(card.id);
        setMoveSheet({ card, pending: syntheticPending(card, intent), intent });
      } else {
        setTrashFor(card);
      }
    },
    [targetsOf, runtime, toast, t, syntheticPending],
  );

  const patchMoveDraft = useCallback((patch: Partial<SheetDraft>) => setMoveSheet((s) => (s ? { ...s, pending: { ...s.pending, draft: { ...s.pending.draft, ...patch } } } : s)), []);

  const submitMove = useCallback(
    async (def: OutcomeButton, fieldValues: Record<string, string>) => {
      const s = moveSheet;
      if (!s) return;
      if (await enqueueOutcome(s.card, def, s.pending.draft, s.intent, s.pending.call.opId, fieldValues)) setMoveSheet(null);
    },
    [moveSheet, enqueueOutcome],
  );

  // ---- перенос в «Мусор» -----------------------------------------------------------------------------------------

  const trashColumn = config.columns.find((c) => c.role === 'trash') ?? null;
  const trashChoices = useCallback(
    (card: BoardCardDto): { quick: TrashChoice[]; more: TrashChoice[] } =>
      trashColumn
        ? { quick: quickTrash(trashColumn, call, config.writeOffReasons, card, config.scope), more: moreTrash(trashColumn, call, config.writeOffReasons, card, config.scope) }
        : { quick: [], more: [] },
    [trashColumn, call, config.writeOffReasons, config.scope],
  );

  /** Ручное списание № 32: онлайн, через 5 с (окно «Отменить»); при уходе со страницы отправляется сразу с keepalive. */
  const scheduleWriteOff = useCallback(
    (card: BoardCardDto, reason: string) => {
      if (!navigator.onLine) {
        toast.show({ message: t('toast.needNetwork'), tone: 'info' });
        return;
      }
      const opId = uuid();
      const plan = trashColumn ? { column: trashColumn.key, patch: { state: 'written_off', closedAt: Date.now(), closeReasonCode: reason, nextCallAt: null, fire: null } as Partial<BoardCardDto> } : null;
      if (plan) data.place({ cardId: card.id, column: plan.column, patch: plan.patch, opId });
      setDeferredIds((x) => [...x, card.id]);
      const finish = () => {
        deferred.current.delete(card.id);
        setDeferredIds((x) => x.filter((id) => id !== card.id));
      };
      const send = async (keepalive: boolean) => {
        if (!deferred.current.has(card.id)) return;
        clearTimeout(deferred.current.get(card.id)!.timer);
        // Больше не отменить: запись убираем сразу, чтобы повторный вызов (pagehide) не отправил её второй раз
        deferred.current.delete(card.id);
        try {
          const res = await fetch(`/api/cards/${encodeURIComponent(card.id)}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            keepalive,
            body: JSON.stringify({ opId, version: card.version, kind: 'written_off', reasonCode: reason, alsoDncPhoneIds: [] }),
          });
          if (res.ok) {
            data.unplaceOps([opId]);
            toast.show({ message: t('toast.writtenOff', { name: card.name }), tone: 'success' });
          } else if (res.status === 404) {
            data.unplaceOps([opId]);
            data.drop(card.id);
            toast.show({ message: t('toast.unavailable'), tone: 'danger' });
          } else if (res.status === 423) {
            data.unplaceOps([opId]);
            toast.show({ message: t('toast.readOnly'), tone: 'danger' });
          } else if (res.status === 409) {
            data.unplaceOps([opId]);
            const body = (await res.json().catch(() => null)) as { code?: string } | null;
            toast.show({ message: body?.code === 'write_off_needs_no_answer' ? t('trash.callFirst') : t('toast.changed'), tone: 'danger' });
          } else {
            data.unplaceOps([opId]);
            toast.show({ message: t('toast.failed'), tone: 'danger' });
          }
        } catch {
          data.unplaceOps([opId]);
          toast.show({ message: t('toast.needNetwork'), tone: 'info' });
        } finally {
          setDeferredIds((x) => x.filter((id) => id !== card.id));
          void data.reload();
        }
      };
      const timer = setTimeout(() => void send(false), config.undoMs);
      deferred.current.set(card.id, { timer, send });
      toast.show({
        message: t('toast.moved', { name: card.name }),
        tone: 'success',
        ...(config.undoMs > 0
          ? {
              undo: {
                label: t('toast.undo'),
                onUndo: () => {
                  const d = deferred.current.get(card.id);
                  if (!d) return toast.show({ message: t('toast.alreadySent'), tone: 'info' });
                  clearTimeout(d.timer);
                  finish();
                  data.unplaceOps([opId]);
                  toast.show({ message: t('toast.undone'), tone: 'neutral' });
                },
              },
              durationMs: config.undoMs,
            }
          : {}),
      });
    },
    [trashColumn, data, toast, t, config.undoMs],
  );

  // Уход со страницы: отложенные списания отправляются сразу (keepalive), как useDeferredMove на доске РОП
  useEffect(() => {
    const flushDeferred = () => {
      for (const d of [...deferred.current.values()]) void d.send(true);
    };
    window.addEventListener('pagehide', flushDeferred);
    const map = deferred.current;
    return () => {
      window.removeEventListener('pagehide', flushDeferred);
      for (const d of map.values()) void d.send(true);
    };
  }, []);

  const pickTrash = useCallback(
    async (card: BoardCardDto, pick: TrashPick) => {
      const c = pick.choice;
      if (c.kind === 'write_off') {
        scheduleWriteOff(card, c.reason);
        setTrashFor(null);
        return;
      }
      const def = call.outcomes.find((o) => o.kind === c.outcomeKind);
      if (!def) return;
      const intent = runtime.intentFor(card.id);
      const draft: SheetDraft = { ...trashDraft(def, c.reason, pick.lpr, pick.note, card.isTarget === 'yes'), phoneId: card.phone?.id ?? null };
      if (await enqueueOutcome(card, def, draft, intent, uuid(), {})) setTrashFor(null);
    },
    [call.outcomes, runtime, enqueueOutcome, scheduleWriteOff],
  );

  // ---- звонок с плитки -------------------------------------------------------------------------------------------

  const openCallSheet = useCallback(() => {
    const p = callSheetRef.current;
    if (p && !p.pending.draft.open) setCallSheet({ ...p, pending: { ...p.pending, draft: { ...p.pending.draft, open: true } } });
  }, []);

  /** «Позвонить» на плитке: намерение звонка пишется на устройство до перехода по tel: (запись синхронная). */
  const startCall = useCallback(
    (card: BoardCardDto) => {
      if (runtime.lockedRef.current) return;
      if (runtime.foreign()) return runtime.leave();
      if (!card.phone) return;
      const prev = runtime.intentFor(card.id);
      const pc: PendingCall = {
        opId: prev?.call.opId ?? uuid(),
        cardId: card.id,
        clientId: card.clientId,
        tappedAt: Date.now(),
        title: card.name,
        phoneId: card.phone.id,
        phoneMasked: card.phone.masked,
        phones: [{ id: card.phone.id, masked: card.phone.masked }],
      };
      const draft: SheetDraft = { ...(prev?.draft ?? { ...EMPTY_DRAFT, target: card.isTarget === 'yes' }), phoneId: card.phone.id, open: false };
      const next: PendingState = { call: pc, draft };
      writePending(window.localStorage, userId, next);
      awayRef.current = false;
      setCallSheet({ card, pending: next, intent: next });
      setTimeout(() => {
        if (document.visibilityState === 'visible' && callSheetRef.current?.pending.call.opId === pc.opId) openCallSheet();
      }, OPEN_FALLBACK_MS);
    },
    [runtime, userId, openCallSheet],
  );

  // Вернулись из звонилки: шторка итога открывается сама
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (callSheetRef.current) awayRef.current = true;
        return;
      }
      if (awayRef.current && callSheetRef.current) {
        awayRef.current = false;
        openCallSheet();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [openCallSheet]);

  // Приложение выгружали во время звонка: намерение звонка осталось на устройстве, шторка итога открывается сама.
  // Карточка берётся с доски; если её там нет, звонок доводит экран «Звонить».
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || data.phase !== 'ready' || !runtime.rt) return;
    const h = setTimeout(() => {
      restored.current = true;
      if (runtime.lockedRef.current || runtime.foreign()) return;
      const p = readPending(window.localStorage, userId);
      const card = p ? findCard(p.call.cardId) : undefined;
      if (p && card) setCallSheet({ card, pending: { ...p, draft: { ...p.draft, open: true } }, intent: p });
    }, 0);
    return () => clearTimeout(h);
  }, [data.phase, runtime, userId, findCard]);

  // Намерение звонка и черновик шторки сохраняются при каждом изменении (переживут выгрузку приложения)
  useEffect(() => {
    if (!callSheet || runtime.lockedRef.current) return;
    writePending(window.localStorage, userId, callSheet.pending);
  }, [callSheet, runtime.lockedRef, userId]);

  const patchCallDraft = useCallback((patch: Partial<SheetDraft>) => setCallSheet((s) => (s ? { ...s, pending: { ...s.pending, draft: { ...s.pending.draft, ...patch } } } : s)), []);
  const closeCallSheet = useCallback(() => patchCallDraft({ open: false }), [patchCallDraft]);

  const submitCall = useCallback(
    async (def: OutcomeButton, fieldValues: Record<string, string>, later = false) => {
      const s = callSheet;
      if (!s) return;
      const extra = later ? { agreement: laterAgreement(null, call, Date.now()) } : undefined;
      if (await enqueueOutcome(s.card, def, s.pending.draft, s.pending, s.pending.call.opId, fieldValues, extra)) {
        clearPending(window.localStorage, userId);
        setCallSheet(null);
      }
    },
    [callSheet, call, enqueueOutcome, userId],
  );

  /** «Договорились — записать»: запись ведёт экран «Звонить» (мастер записи); намерение и черновик сохранены. */
  const continueOnCallScreen = useCallback(() => {
    if (callSheetRef.current) writePending(window.localStorage, userId, callSheetRef.current.pending);
    router.push('/call');
  }, [router, userId]);

  return {
    locked,
    targetsOf,
    menuFor,
    openMenu: setMenuFor,
    closeMenu: () => setMenuFor(null),
    startMove,
    moveSheet,
    patchMoveDraft,
    closeMove: () => setMoveSheet(null),
    submitMove,
    trashFor,
    closeTrash: () => setTrashFor(null),
    trashChoices,
    pickTrash,
    startCall,
    callSheet,
    patchCallDraft,
    closeCallSheet,
    reopenCallSheet: openCallSheet,
    submitCall,
    continueOnCallScreen,
  };
}
