// Куда можно перенести плитку и каким запросом (pipeline-v2 §3.1–§3.2, этап Б). Клиент только подсвечивает цели;
// решение принимает сервер по ядру. До этапа В переносятся только плитки рабочих колонок («Новые», «Перезвон»):
// в «Перезвон» итогом очереди устройства, в «Мусор» — итогом по причине или ручным списанием № 32.
import { isWorkingRole } from './columns';
import { buildRequest } from '@/ui/call/validate';
import type { PendingState } from '@/ui/call/pending';
import { EMPTY_DRAFT, type CallConfig, type OutcomeButton, type OutcomeKind, type OutcomeRequest, type PendingCall, type SheetDraft } from '@/ui/call/types';
import type { BoardCardDto, BoardColumnConfig, BoardConfig, BoardReason } from './types';

export type MoveAction = 'callback' | 'trash' | 'agreedCallback' | 'agreedTrash';
export type MoveBlocked = 'same' | 'later' | 'viewer' | 'manual' | 'offline';

/** Условия переноса, зависящие от устройства и настроек: выход из «Договорились» (№ 33) работает только онлайн. */
export interface MoveContext {
  /** Воронка v2 включена: окно № 33 доступно. */
  agreedExit?: boolean;
  online?: boolean;
}

export interface MoveTarget {
  column: string;
  available: boolean;
  action: MoveAction | null;
  blocked: MoveBlocked | null;
}

/** Виды итога окна «Перезвон»: «Перезвонить» и «Не берёт» (§3.4). */
export const CALLBACK_KINDS: readonly OutcomeKind[] = ['callback', 'no_answer'];

/** Цели переноса плитки. Пусто, если переносить нельзя вовсе (директор, нет права, плитка не из рабочих колонок). */
export function moveTargets(card: BoardCardDto, columns: readonly BoardColumnConfig[], canMove: boolean, scope: BoardConfig['scope'] = 'own', ctx: MoveContext = {}): MoveTarget[] {
  const from = columns.find((c) => c.key === card.column);
  return columns.map((col): MoveTarget => {
    if (!canMove) return { column: col.key, available: false, action: null, blocked: 'viewer' };
    if (!from || col.key === from.key) return { column: col.key, available: false, action: null, blocked: 'same' };
    // «Договорились» (этап В, № 33): в «Перезвон» и «Мусор» без звонка, онлайн; записать на другой вид — мастер в карточке
    if (from.role === 'agreed' && ctx.agreedExit === true && (col.role === 'callback' || col.role === 'trash')) {
      if (ctx.online === false) return { column: col.key, available: false, action: null, blocked: 'offline' };
      return { column: col.key, available: true, action: col.role === 'callback' ? 'agreedCallback' : 'agreedTrash', blocked: null };
    }
    // Откуда: только «Новые» и «Перезвон»; остальные колонки открываются через карточку клиента
    if (!isWorkingRole(from.role)) return { column: col.key, available: false, action: null, blocked: 'later' };
    // Итог с доски (`via = board`) принимает сервер только при охвате own; РОП вносит итог за оператора в карточке клиента
    // (manual_entry онлайн, §3.2), поэтому «Перезвон» ему погашен, а в «Мусор» остаётся ручное списание № 32.
    if (col.role === 'callback') return scope === 'wide' ? { column: col.key, available: false, action: null, blocked: 'manual' } : { column: col.key, available: true, action: 'callback', blocked: null };
    if (col.role === 'trash') return { column: col.key, available: true, action: 'trash', blocked: null };
    return { column: col.key, available: false, action: null, blocked: 'later' };
  });
}

/** Есть ли у плитки хоть одна доступная цель (показывать ли «⋯ → Перенести в…»). */
export const canMoveAnywhere = (targets: readonly MoveTarget[]): boolean => targets.some((t) => t.available);

// ---------- «Мусор» ----------

export type TrashChoice =
  | { kind: 'outcome'; outcomeKind: OutcomeKind; reason: string; label: string; needsText: boolean }
  | { kind: 'write_off'; reason: string; label: string; needsText: false; blocked: 'call_first' | null };

/** Оператору «Не отвечает» (№ 32) доступно только после недозвона (`attempts ≥ 1`); РОП — всегда. */
export function writeOffBlocked(card: BoardCardDto, scope: BoardConfig['scope']): 'call_first' | null {
  return scope === 'wide' || card.attempts >= 1 ? null : 'call_first';
}

const OUTCOME_TRASH: readonly OutcomeKind[] = ['not_interested', 'not_target', 'do_not_call'];

function outcomeChoice(call: CallConfig, kind: string, reason: string): TrashChoice | null {
  const def = call.outcomes.find((o) => o.kind === kind);
  if (!def || !(OUTCOME_TRASH as readonly string[]).includes(kind)) return null;
  const r = def.reasons.find((x) => x.key === reason);
  return { kind: 'outcome', outcomeKind: def.kind, reason, label: r?.label ?? reason, needsText: r?.needsText ?? false };
}

/** Быстрые причины колонки «Мусор» (`drop`) в порядке пресета; неизвестные пары пропускаются. */
export function quickTrash(column: BoardColumnConfig, call: CallConfig, writeOff: readonly BoardReason[], card: BoardCardDto, scope: BoardConfig['scope']): TrashChoice[] {
  const out: TrashChoice[] = [];
  for (const d of column.drop) {
    if (d.kind === 'written_off') {
      const r = writeOff.find((x) => x.key === d.reason);
      // Причина с текстом: в теле /close пока нет комментария, поэтому на доске её не предлагаем (списание — в карточке клиента)
      if (r?.needsText) continue;
      const label = r?.label ?? d.label;
      out.push({ kind: 'write_off', reason: d.reason, label, needsText: false, blocked: writeOffBlocked(card, scope) });
    } else if (scope !== 'wide') {
      // Итогом из «Мусора» переносит только оператор со своими карточками (см. moveTargets)
      const c = outcomeChoice(call, d.kind, d.reason);
      if (c) out.push(c);
    }
  }
  return out;
}

/** «Другие причины…»: все ручные причины видов «Не интересует», «Не целевой», «Полный отказ» и списания, кроме быстрых. */
export function moreTrash(column: BoardColumnConfig, call: CallConfig, writeOff: readonly BoardReason[], card: BoardCardDto, scope: BoardConfig['scope']): TrashChoice[] {
  if (!column.dropMore) return [];
  const quick = new Set(quickTrash(column, call, writeOff, card, scope).map((c) => `${c.kind === 'outcome' ? c.outcomeKind : 'written_off'}:${c.reason}`));
  const out: TrashChoice[] = [];
  for (const kind of scope === 'wide' ? [] : OUTCOME_TRASH) {
    const def = call.outcomes.find((o) => o.kind === kind);
    for (const r of def?.reasons ?? []) if (!quick.has(`${kind}:${r.key}`)) out.push({ kind: 'outcome', outcomeKind: kind, reason: r.key, label: r.label, needsText: r.needsText });
  }
  for (const r of writeOff) if (!r.needsText && !quick.has(`written_off:${r.key}`)) out.push({ kind: 'write_off', reason: r.key, label: r.label, needsText: false, blocked: writeOffBlocked(card, scope) });
  return out;
}

// ---------- Запрос итога ----------

/** Канал итога (§3.2): было намерение звонка этой карточки — звонок (`ui`/`offline`), иначе перенос без звонка (`board`). */
export function viaFor(hasCallIntent: boolean, online: boolean): OutcomeRequest['via'] {
  if (!hasCallIntent) return 'board';
  return online ? 'ui' : 'offline';
}

export interface MoveRequestInput {
  card: BoardCardDto;
  def: OutcomeButton;
  draft: SheetDraft;
  /** Намерение звонка этой карточки на устройстве (нажатие «Позвонить» на плитке или на экране «Звонить»). */
  intent: Pick<PendingCall, 'opId' | 'tappedAt'> | null;
  opId: string;
  now: number;
  online: boolean;
  fieldValues?: Record<string, string>;
  callbackV2: boolean;
}

/** Итог переноса: тот же запрос, что у шторки «Звонить», с каналом по §3.2. */
export function buildMoveRequest(i: MoveRequestInput): OutcomeRequest {
  const base = buildRequest({
    opId: i.intent?.opId ?? i.opId,
    cardId: i.card.id,
    def: i.def,
    draft: i.draft,
    tappedAt: i.intent?.tappedAt ?? null,
    now: i.now,
    online: i.online,
    ...(i.fieldValues ? { fieldValues: i.fieldValues } : {}),
    callbackV2: i.callbackV2,
  });
  return { ...base, via: viaFor(i.intent !== null, i.online) };
}

/** Черновик для переноса в «Мусор»: вид и причина выбраны, остальное по умолчанию. */
export function trashDraft(def: OutcomeButton, reason: string, lpr: '' | 'yes' | 'no', note: string, target: boolean): SheetDraft {
  return { ...EMPTY_DRAFT, outcomeKey: def.key, reasonCode: reason, lpr, note, target };
}

/**
 * «Позвонить» на плитке погашена, пока на устройстве висит намерение звонка другой карточки (PROCESS 2.5): иначе новое
 * намерение затёрло бы прежнее, и тот звонок не попал бы на сервер. Своя плитка остаётся рабочей (повторный набор).
 */
export const callBlockedBy = (pendingCardId: string | null, cardId: string): boolean => pendingCardId !== null && pendingCardId !== cardId;

/** Шторка звонка остаётся, если итог ушёл по другой карточке; итог по карточке шторки «тратит» её намерение. */
export const keepsCallSheet = (sheetCardId: string | null, spentCardId: string): boolean => sheetCardId !== null && sheetCardId !== spentCardId;

/** «Отменить» итога, потратившего намерение звонка: шторка возвращается открытой, как на экране «Звонить». */
export function restoredCallSheet<C>(card: C, intent: PendingState): { card: C; pending: PendingState; intent: PendingState } {
  return { card, pending: { ...intent, draft: { ...intent.draft, open: true } }, intent };
}

/** Код ошибки ответа сервера (`{ error }`, см. CardActionError.body); `null`, если тела нет. */
export function errorCodeOf(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : null;
}

/** Плитка заблокирована, пока по ней есть итог в очереди устройства или отложенный перенос (§3.2). */
export function lockedIds(outboxCardIds: readonly string[], deferredCardIds: readonly string[]): Set<string> {
  return new Set([...outboxCardIds, ...deferredCardIds]);
}

// ---------- Раскладка «в уме» ----------

export interface PlacementPlan {
  column: string;
  patch: Partial<BoardCardDto>;
}

/**
 * Куда плитка переедет на экране сразу после подтверждения итога (до ответа сервера). `null` — плитка остаётся на месте
 * и обновится после отправки (например, «Номер не работает»). Окончательную колонку определяет сервер: после отправки
 * доска перечитывается.
 */
export function planFor(card: BoardCardDto, def: Pick<OutcomeButton, 'kind'>, draft: Pick<SheetDraft, 'reasonCode' | 'callbackAt' | 'callbackPrecision'>, columns: readonly BoardColumnConfig[], now: number): PlacementPlan | null {
  const callbackCol = columns.find((c) => c.role === 'callback');
  const trashCol = columns.find((c) => c.role === 'trash');
  switch (def.kind) {
    case 'callback':
      return callbackCol
        ? { column: callbackCol.key, patch: { state: 'callback', callbackReason: draft.reasonCode, callbackTouches: card.callbackTouches + 1, nextCallAt: draft.callbackAt, nextCallPrecision: draft.callbackPrecision ?? 'time', fire: null } }
        : null;
    case 'no_answer':
      return callbackCol ? { column: callbackCol.key, patch: { state: 'retry', attempts: card.attempts + 1, fire: null } } : null;
    case 'not_interested':
    case 'not_target':
    case 'do_not_call':
      return trashCol ? { column: trashCol.key, patch: { state: def.kind, closedAt: now, closeReasonCode: draft.reasonCode, nextCallAt: null, fire: null } } : null;
    default:
      return null;
  }
}
