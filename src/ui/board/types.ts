// Типы доски оператора: ответ сервера (контракт C5, src/server/domain/cards/board.ts) и настройки страницы.
// Только типы и константы: файл безопасен и для браузера, и для тестов.
import type { CallConfig, CallbackPreset } from '@/ui/call/types';

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
  /** Короткие подписи видов записи «групповая» и «индивидуальная» из пресета (значки «Был: …» и фильтры). */
  attendLabels: { attendedGroup: string; attendedIndividual: string };
  /** Есть `card.outcome` и зритель не только читает: переносить можно. */
  canMove: boolean;
  /** Охват карточек зрителя: у оператора `own`; цифры номеров и звонок с плитки — только при `own`, `wide` — РОП и шире. */
  scope: 'own' | 'wide';
  /** Признаки покупок и фильтр «Покупал» (`deal.read` с охватом роли). */
  canPurchases: boolean;
  /** Окно «Отменить» для переноса без звонка, мс. */
  undoMs: number;
  /**
   * Право отмечать явку (`booking.attend` у роли, не только чтение). Выдаётся правкой пресета, без кода: у оператора
   * по умолчанию его нет до ответа владельца (D-340), поэтому тумблеры «Был на …» у него только показывают признак.
   */
  canAttend: boolean;
  /** Поведение вида записи по ключу: связывает запись плитки с тумблером «групповая» / «индивидуальная». */
  eventBehaviors: Record<string, 'group' | 'individual'>;
  /** Окно № 33 (выход из «Договорились»): системные причины и срок после неявки из настроек. */
  agreedExit: AgreedExitConfig;
  /**
   * Доска РОП и директора (охват пространства): список сотрудников для фильтра и перенос РОП итогом `manual_entry` онлайн.
   * У доски оператора ключа нет.
   */
  manager?: { owners: { userId: string; name: string }[] };
}

/** Дополнительные фильтры доски пространства: сотрудник-владелец и причина перезвона (пусто — без фильтра). */
export interface BoardExtra {
  owner: string;
  callbackReason: string;
}
export const NO_EXTRA: BoardExtra = { owner: '', callbackReason: '' };

export interface AgreedExitConfig {
  /** Выход доступен: воронка v2 включена (`CALLBACK_V2`). */
  enabled: boolean;
  /** Причина неявки по виду записи (`reasons.callback[system=no_show].eventTypes`). */
  noShowReasons: Record<string, string>;
  /** Причина «пришёл, не купил» (`system=attended_no_purchase`); нет — не подставляется. */
  attendedReason: string | null;
  /** Срок после неявки (`booking.noShow.callbackAt`); нет — по касанию. */
  noShowCallback: CallbackPreset | null;
}
