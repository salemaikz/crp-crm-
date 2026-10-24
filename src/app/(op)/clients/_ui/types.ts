// Типы данных, которые страница клиентов передаёт клиентским компонентам. Совпадают по форме с DTO
// домена (проверяет TypeScript при передаче props), но не импортируют его: файлы с 'use client'
// не видят ядро и src/server (tests/unit/layers.test.ts).

export type Label = { ru: string; kk?: string };
export type FieldValue = string | number | boolean | string[];

export type FieldView = {
  key: string;
  type: string;
  label: Label;
  access: 'edit' | 'read';
  options: Array<{ key: string; label: Label; archived: boolean }>;
  value: FieldValue | null;
  href: string | null;
  showOn: { card: boolean; kanban: boolean; list: boolean };
  archived: boolean;
};

export type PhoneView = {
  id: string;
  e164: string;
  ext: string;
  kind: 'mobile' | 'landline' | 'unknown';
  working: boolean;
  primary: boolean;
  contactId: string | null;
  hasWhatsapp: 'yes' | 'no' | 'unknown';
};

export type ContactView = {
  id: string;
  name: string;
  position: string;
  isDecisionMaker: boolean;
  callHint: string;
  note: string;
  fields: { fields: FieldView[] };
};

export type LegalFormOption = { key: string; label: Label };

export type ClientFieldsView = {
  id: string;
  name: string;
  legalForm: string;
  orgId: string;
  region: string;
  address: string;
  email: string;
  emailHref: string | null;
  website: string;
  websiteHref: string | null;
  can: { edit: boolean; editIdentity: boolean };
  fields: { fields: FieldView[] };
};

export type FeedItemView = {
  id: string;
  kind: string;
  group: string;
  at: number;
  actor: { id: string; name: string } | null;
  refType: string;
  refId: string;
  dealId: string | null;
  data: Record<string, unknown>;
  /** Сообщение мессенджера (kind = 'message'): текст, удалено ли, статус доставки. */
  message?: { text: string | null; deleted: boolean; status: string | null };
  /** Заметка события `note.created` (текст берётся из notes при чтении). */
  note: NoteView | null;
  /** Звонок (kind = 'call'): причина, срок перезвона, текст заметки; `null` — нет, отменён или не виден. */
  call: CallView | null;
  /** Вид мероприятия записи или точность срока задачи (для подписи события). */
  ref: { eventTypeKey?: string; duePrecision?: 'time' | 'day' } | null;
};

export type CallView = {
  note: string;
  reasonCode: string;
  callbackAt: number | null;
  callbackPrecision: 'time' | 'day';
};

export type NoteView = {
  id: string;
  body: string;
  pinned: boolean;
  dealId: string | null;
  authorName: string | null;
  createdAt: number;
};

export type DealView = {
  id: string;
  pipelineKey: string;
  stageKey: string;
  status: 'open' | 'won' | 'lost';
  serviceTypeKey: string;
  /** `null` — сумма скрыта от отдела передачи (D-300). */
  amountKzt: number | null;
  createdAt: number;
  wonAt: number | null;
  lostAt: number | null;
  lostReasonCode: string;
  ownerName: string | null;
};

/** Подписи справочников настроек (этапы `воронка:этап`, услуги, виды мероприятий, отделы). */
export type CatalogView = {
  stages: Record<string, Label>;
  pipelines: Record<string, Label>;
  serviceTypes: Record<string, Label>;
  eventTypes: Record<string, Label>;
  teams: Record<string, Label>;
};

/**
 * Подписи для ленты (простые данные: уходят из серверной страницы в клиентский компонент):
 * поля (`client:key`, `contact:key`), варианты (`client:key:option`, формы собственности `legal_form:key`),
 * номера и контакты по id.
 */
export type FeedLabels = {
  fields: Record<string, string>;
  options: Record<string, string>;
  phones: Record<string, string>;
  contacts: Record<string, string>;
  /** Итоги звонков: ключ итога → подпись. */
  outcomes: Record<string, string>;
  /** Причины итогов: `итог:причина` → подпись. */
  reasons: Record<string, string>;
  /** Виды мероприятий: ключ → короткая подпись. */
  events: Record<string, string>;
  /** Этапы сделок: ключ этапа → подпись. */
  stages: Record<string, string>;
  /** Состояние карточки → подпись колонки доски (пусто — доски в пресете нет). */
  columns: Record<string, string>;
  /** Пояс установки: время событий показывается в нём. */
  timeZone: string;
};
