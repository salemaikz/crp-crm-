// Доски (B8): сделки по этапам воронки и вид «Обзвон». Только типы — безопасно для браузера (`import type`).
// Дизайн — docs/reports-plugins-design.md §4, решение D-266.

/** Чего не хватает сделке для перехода на этап. `field:<ключ>` — незаполненное обязательное поле этапа. */
export type MissingCode = 'booking' | 'attendance' | 'next_step' | `field:${string}`;

export interface BoardStage {
  key: string;
  label: string;
  kind: 'open' | 'won' | 'lost';
  order: number;
  staleDays: number | null;
}

export interface DealTileField {
  key: string;
  label: string;
  value: unknown;
}

export interface DealTile {
  id: string;
  version: number;
  stageKey: string;
  stageChangedAt: number;
  clientId: string;
  /** Карточка сделки: форма покупки открывается по ней (`/deals/purchase/[cardId]`). */
  cardId: string;
  clientName: string;
  contactName: string | null;
  /** Для показа: `+7 709 123 45 67`; нет права читать клиента — null. */
  phone: string | null;
  /** До двух полей с `showOn.kanban` (сначала сделка, затем клиент), по правам роли. */
  fields: DealTileField[];
  nextTask: { id: string; dueAt: number | null; title: string } | null;
  ownerName: string | null;
  badges: { needsRebook: boolean; staleDays: number | null };
  /** По каждому открытому этапу воронки; в «закрытых» плитках пусто. */
  missing: Record<string, MissingCode[]>;
}

export interface BoardColumn {
  stageKey: string;
  total: number;
  deals: DealTile[];
  /** Курсор «ещё» (`<stageChangedAt>:<id>`); null — всё загружено. */
  nextCursor: string | null;
}

/** Поле, которого может не хватать для этапа: панель «Переместить» рисует по нему ввод. */
export interface BoardFieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select';
  options: { key: string; label: string }[];
  /** false — роль поле не правит: ввод не показываем, а сервер всё равно отказал бы. */
  editable: boolean;
}

export interface DealsBoard {
  pipeline: { key: string; label: string; stages: BoardStage[] };
  pipelines: { key: string; label: string }[];
  columns: BoardColumn[];
  closed: { won30d: number; lost30d: number };
  owners: { userId: string; name: string }[];
  /** Поля, которых могут требовать открытые этапы. */
  fieldDefs: BoardFieldDef[];
  /** Что показать; решающая проверка — на сервере в каждом действии. */
  can: { edit: boolean; moveBack: boolean; purchase: boolean; lose: boolean };
}

export interface ClosedDeals {
  deals: (DealTile & { status: 'won' | 'lost' })[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Вид «Обзвон» (PROCESS 4.4)
// ---------------------------------------------------------------------------

export const CALLING_COLUMNS = ['new', 'retry', 'callback', 'agreed'] as const;
export type CallingState = (typeof CALLING_COLUMNS)[number];

export interface CallingPhone {
  id: string;
  /** Закрытый номер `+7 709 ••• •• 67`: цифры на доску не идут. */
  masked: string;
}

export interface CallingTile {
  cardId: string;
  version: number;
  state: CallingState;
  clientId: string;
  clientName: string;
  workerId: string | null;
  workerName: string | null;
  attempts: number;
  nextCallAt: number | null;
  lastOutcomeCode: string;
  lastOutcomeAt: number | null;
  /** ЛПР-контакт клиента для `agreement.contactId` итога «Договорились». */
  decisionMakerId: string | null;
  phones: CallingPhone[];
}

export interface CallingColumn {
  state: CallingState;
  total: number;
  cards: CallingTile[];
  /** Сколько карточек уже загружено; для «ещё» — `offset`. null — всё загружено. */
  nextOffset: number | null;
}

export interface CallingBoard {
  columns: CallingColumn[];
  /** Плитка «Закрыто»: карточки с закрытыми состояниями за 30 дней. */
  closed: number;
  workers: { userId: string; name: string }[];
  can: { move: boolean };
}
