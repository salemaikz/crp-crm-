// Доска оператора: в какой колонке карточка и куда её можно перенести (pipeline-v2 §2.1, §3.1).
// Колонка вычисляется, а не хранится. Чистые функции: время и права приходят параметрами.

import type { CardSnapshot, CardState, Ms } from './spec/types.js';

/** Колонка из `board.columns[]` пресета в срезе, нужном ядру (подписи — дело интерфейса). */
export interface BoardColumnDef {
  key: string;
  states: readonly CardState[];
  /** Только у колонки с `agreed`: виды записи (`booking.eventTypes[].key`). */
  eventTypes?: readonly string[];
  /** Для закрытых колонок: окно в днях, старые — через поиск и «Архив». */
  recentDays?: number;
  /** Быстрые причины переноса в колонку. */
  drop?: readonly { kind: string; reason: string }[];
  dropMore?: boolean;
}

export interface BoardSpec {
  columns: readonly BoardColumnDef[];
  /** Колонка для `agreed` без записи открытой сделки. */
  agreedFallback?: string;
}

/** Поля карточки, нужные доске. */
export type BoardCard = Pick<CardSnapshot, 'state' | 'holdReason' | 'ownerUserId' | 'attempts' | 'closedAt'>;

/** Статусы записи, которые определяют колонку «Договорились». */
export const COLUMN_BOOKING_STATUSES = ['registered', 'confirmed', 'attended', 'no_show'] as const;

/**
 * Запись текущего цикла (§2.1): последняя по `starts_at` запись открытой сделки карточки.
 * Выбирает слой БД; `dealIsOpen: false` — запись прежнего цикла, она не учитывается.
 */
export interface DealBooking {
  eventType: string;
  status: string;
  dealIsOpen: boolean;
}

const WORKING: readonly CardState[] = ['new', 'retry', 'callback'];
const CLOSED: readonly CardState[] = ['not_interested', 'not_target', 'do_not_call', 'written_off'];

/** Колонка для `agreed`: по виду записи открытой сделки, иначе `agreedFallback`. */
function agreedColumn(dealBooking: DealBooking | null, board: BoardSpec): BoardColumnDef | null {
  const agreedCols = board.columns.filter((c) => c.states.includes('agreed'));
  if (dealBooking !== null && dealBooking.dealIsOpen && (COLUMN_BOOKING_STATUSES as readonly string[]).includes(dealBooking.status)) {
    const byKind = agreedCols.find((c) => c.eventTypes?.includes(dealBooking.eventType) === true);
    if (byKind) return byKind;
  }
  const fallback = agreedCols.find((c) => c.key === board.agreedFallback);
  if (fallback) return fallback;
  // Ключ не задан: единственная колонка без видов (проверка набора это гарантирует).
  return agreedCols.find((c) => c.eventTypes === undefined) ?? agreedCols[0] ?? null;
}

/**
 * Ключ колонки карточки или `null`, если на доске её нет (задержана, в пуле, состояния нет ни в одной колонке).
 * Окно `recentDays` здесь не применяется: его считает выборка (`isRecentlyClosed`).
 */
export function columnOf(card: BoardCard, dealBooking: DealBooking | null, board: BoardSpec): string | null {
  if (WORKING.includes(card.state)) {
    // Тот же фильтр, что у очереди: задержанные не показываются; новая без владельца — в пуле.
    if (card.holdReason !== '') return null;
    if (card.state === 'new' && card.ownerUserId === null) return null;
  }
  if (card.state === 'agreed') return agreedColumn(dealBooking, board)?.key ?? null;
  return board.columns.find((c) => c.states.includes(card.state) && c.eventTypes === undefined)?.key ?? null;
}

/** Закрыта ли карточка в пределах `recentDays` колонки (колонка без окна — всегда да). */
export function isRecentlyClosed(card: Pick<BoardCard, 'closedAt'>, column: BoardColumnDef, now: Ms): boolean {
  if (column.recentDays === undefined) return true;
  if (card.closedAt === null) return false;
  return card.closedAt >= now - column.recentDays * 86_400_000;
}

// ---------- Перенос карточки между колонками ----------

/** Кто переносит. Права проверяет слой доступа; ядру нужны только признаки (§3.1). */
export interface DropActor {
  /** Есть `card.outcome` в охвате карточки. */
  canOutcome: boolean;
  /** Директор: цели переноса не показываются. */
  readOnly: boolean;
  /** Охват `space` (РОП): может то, что оператору нельзя. */
  scope: 'own' | 'space' | 'relation';
}

/** Что произойдёт при переносе (как именно, решает сервер по ядру; клиент только подсвечивает цели). */
export type DropActionKind =
  | 'outcome_callback' // итог «Перезвонить» / «Недозвон», очередь устройства
  | 'outcome_agreed' // итог «Договорились» + мастер записи (онлайн)
  | 'booking_wizard' // запись другого вида, состояние не меняется
  | 'purchase_form' // форма покупки (только РОП)
  | 'outcome_close' // итог закрытия, очередь устройства
  | 'write_off' // № 32, онлайн
  | 'close_from_menu' // № 11, № 12
  | 'agreed_exit' // № 33
  | 'reopen' // № 14
  | 'dnc_clear'; // № 15

export type DropBlocked = 'same_column' | 'not_allowed' | 'rop_only' | 'no_target' | 'pending_agreed_exit';

export interface DropTarget {
  column: string;
  available: boolean;
  /** Что случится; `null`, если перенос недоступен. */
  actions: DropActionKind[];
  /** Почему недоступно (для подсказки). */
  blocked: DropBlocked | null;
  /** Для закрытия: виды итога, доступные при переносе (пусто — любые из `drop`/`dropMore`). */
  onlyKinds?: string[];
  /** Для колонки закрытия из рабочего состояния: можно ли «Не отвечает» (№ 32) этому актору. */
  writeOffAllowed?: boolean;
}

/** № 33 включается линией C6; до этого переносы из «Договорились» в «Перезвон» и «Мусор: не отвечает» недоступны. */
export const AGREED_EXIT_READY = false;

type ColumnRole = 'new' | 'callback' | 'agreed' | 'client' | 'trash' | 'other';

function roleOf(c: BoardColumnDef): ColumnRole {
  const s = c.states;
  if (s.includes('agreed')) return 'agreed';
  if (s.includes('client')) return 'client';
  if (s.some((x) => CLOSED.includes(x))) return 'trash';
  if (s.includes('retry') || s.includes('callback')) return 'callback';
  if (s.includes('new')) return 'new';
  return 'other';
}

const no = (column: string, blocked: DropBlocked, extra: Partial<DropTarget> = {}): DropTarget => ({
  column,
  available: false,
  actions: [],
  blocked,
  ...extra,
});
const yes = (column: string, actions: DropActionKind[], extra: Partial<DropTarget> = {}): DropTarget => ({
  column,
  available: true,
  actions,
  blocked: null,
  ...extra,
});

/** Закрытая карточка → «Вернуть в обзвон» РОП: № 15 для «Не звонить», иначе № 14. */
function reopenKind(state: CardState): DropActionKind {
  return state === 'do_not_call' ? 'dnc_clear' : 'reopen';
}

/**
 * Цели переноса карточки по матрице §3.1. Пусто, если у актора нет `card.outcome` или он только читает.
 * Карточки вне колонок доски (задержанные, в пуле) переносить нельзя. Запись `dealBooking` нужна, чтобы знать
 * текущую колонку «Договорились»; для остальных состояний её можно не передавать.
 */
export function dropActions(card: BoardCard, board: BoardSpec, actor: DropActor, dealBooking: DealBooking | null = null): DropTarget[] {
  if (actor.readOnly || !actor.canOutcome) return [];
  const from = columnOf(card, dealBooking, board);
  const isLead = actor.scope === 'space';
  const writeOffAllowed = isLead || card.attempts >= 1;
  return board.columns.map((col): DropTarget => {
    const to = roleOf(col);
    if (from === null) return no(col.key, 'not_allowed');
    if (col.key === from) return no(col.key, 'same_column');
    // В «Новые» не переносит никто: возврат в пул — экран раздачи РОП.
    if (to === 'new' || to === 'other') return no(col.key, 'not_allowed');
    const fromRole = roleOf(board.columns.find((c) => c.key === from) as BoardColumnDef);

    switch (fromRole) {
      case 'new':
      case 'callback': // рабочие: «Новые» и «Перезвон»
        if (to === 'callback') return yes(col.key, ['outcome_callback']);
        if (to === 'agreed') return yes(col.key, ['outcome_agreed']);
        if (to === 'client') return isLead ? yes(col.key, ['purchase_form']) : no(col.key, 'rop_only');
        return yes(col.key, ['outcome_close', 'write_off'], { writeOffAllowed });
      case 'agreed':
        if (to === 'agreed') return yes(col.key, ['booking_wizard']);
        if (to === 'client') return isLead ? yes(col.key, ['purchase_form']) : no(col.key, 'rop_only');
        if (to === 'callback') {
          return AGREED_EXIT_READY ? yes(col.key, ['agreed_exit']) : no(col.key, 'pending_agreed_exit');
        }
        // «Мусор»: «Не целевой» и «Не звонить» — из меню; «Не нужны услуги», «Не отвечает» — № 33.
        return yes(col.key, AGREED_EXIT_READY ? ['close_from_menu', 'agreed_exit'] : ['close_from_menu'], {
          onlyKinds: AGREED_EXIT_READY ? undefined : ['not_target', 'do_not_call'],
        });
      case 'client':
        if (to === 'callback') return no(col.key, 'not_allowed'); // клиент вернётся сам (№ 34)
        if (to === 'agreed') return yes(col.key, ['booking_wizard']);
        if (to === 'trash') return yes(col.key, ['close_from_menu'], { onlyKinds: ['do_not_call'] });
        return no(col.key, 'not_allowed');
      case 'trash':
        if (to === 'callback') return isLead ? yes(col.key, [reopenKind(card.state)]) : no(col.key, 'rop_only');
        return no(col.key, 'not_allowed');
      default:
        return no(col.key, 'not_allowed');
    }
  });
}
