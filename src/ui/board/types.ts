// Типы доски оператора: ответ сервера (контракт C5, src/server/domain/cards/board.ts) и настройки страницы.
// Только типы и константы: файл безопасен и для браузера, и для тестов.
import type { CallConfig } from '@/ui/call/types';

export type { BoardCardDto, BoardColumnDto, BoardColumnPage, BoardDto } from '@/server/domain/cards';

/** Роль колонки по её состояниям (зеркало ядра `calling.dropActions`; ядро в клиентский бандл не входит). */
export type ColumnRole = 'new' | 'callback' | 'agreed' | 'client' | 'trash' | 'other';

export type BoardSort = 'heat' | 'due' | 'new';
export const BOARD_SORTS: readonly BoardSort[] = ['heat', 'due', 'new'];

export type BoardFilter = 'today' | 'attendedGroup' | 'attendedIndividual' | 'noShow' | 'purchased';
export const BOARD_FILTERS: readonly BoardFilter[] = ['today', 'attendedGroup', 'attendedIndividual', 'noShow', 'purchased'];

/** Быстрая причина переноса в «Мусор» (`board.columns[].drop`) с подписью причины. */
export interface BoardDrop {
  kind: string;
  reason: string;
  label: string;
}

/** Причина с подписью (для «Другие причины…»). */
export interface BoardReason {
  key: string;
  label: string;
  needsText: boolean;
}

export interface BoardColumnConfig {
  key: string;
  /** Подпись из пресета; пусто — подпись состояния из локали. */
  label: string;
  role: ColumnRole;
  states: string[];
  drop: BoardDrop[];
  dropMore: boolean;
}

/** Всё, что доске нужно из настроек и прав. Приходит с сервера один раз; ПДн здесь нет. */
export interface BoardConfig {
  call: CallConfig;
  columns: BoardColumnConfig[];
  /** Причины списания (`reasons.written_off`) для «Не отвечает» (№ 32). */
  writeOffReasons: BoardReason[];
  /** Подписи причин перезвона по ключу (чип на плитке: «Подумает · касание 2»). */
  reasonLabels: Record<string, string>;
  /** Названия видов записи по ключу (`booking.eventTypes[]`), для чипа «запись …». */
  eventLabels: Record<string, string>;
  /** Есть `card.outcome` и зритель не только читает: переносить можно. */
  canMove: boolean;
  /** Охват карточек зрителя: у оператора `own`; цифры номеров и звонок с плитки — только при `own`, `wide` — РОП и шире. */
  scope: 'own' | 'wide';
  /** Признаки покупок и фильтр «Покупал» (`deal.read` с охватом роли). */
  canPurchases: boolean;
  /** Окно «Отменить» для переноса без звонка, мс. */
  undoMs: number;
}
